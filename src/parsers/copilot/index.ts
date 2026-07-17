/**
 * GitHub Copilot CLI transcript parser — public surface.
 *
 * Copilot CLI (`@github/copilot`, binary `copilot`) writes each session as a
 * directory `~/.copilot/session-state/<uuid>/`. Its `events.jsonl` is the
 * lossless source of truth: one typed event per line, envelope
 * `{ type, data, id, timestamp, parentId }`. This shell reads that file, decodes
 * each line, builds raw events, and reduces. All Copilot format knowledge lives
 * in records.ts (decoders) and reduce.ts (reducer).
 *
 * This is a genuinely new, file-based decoder — a typed event stream, not the
 * message-array shape of cline or the tabular stores of opencode/goose. The
 * sibling per-session `session.db` holds only transient todos/inbox and the
 * top-level `session-store.db` is a derived FTS index, so the JSONL is read
 * directly and neither DB is touched.
 *
 * @example
 *   import { parseSessionFile } from "agent-canonical/parsers/copilot";
 *   const r = await parseSessionFile("/path/to/<uuid>/events.jsonl");
 *   if (r.success) console.log(r.data.id);
 */

import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Session } from "../../schemas/session.js";
import type { RawEvent } from "../../schemas/transcript.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import type { CopilotEvent } from "./records.js";
import { decodeEvent } from "./records.js";
import { buildSession } from "./reduce.js";

export type {
  CopilotEvent,
  CopilotToolRequest,
  CopilotToolResult,
  CopilotUsageTotals,
} from "./records.js";
export { decodeEvent } from "./records.js";
export { buildSession } from "./reduce.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `.../<uuid>/events.jsonl` → `<uuid>` (the session id when the store omits one). */
function sessionIdFromPath(eventsPath: string): string {
  return basename(dirname(eventsPath));
}

/**
 * Parse one Copilot session from its `events.jsonl` path into a canonical
 * Session. The session id comes from the `session.start` event, falling back to
 * the parent directory name.
 *
 * Failure cases:
 *   - Events file read error → fail with an error issue.
 *   - Zero decodable events → fail with an error issue.
 *   - Zero usable messages after reduction → fail with an error issue.
 */
export async function parseSessionFile(
  eventsPath: string,
): Promise<ParseResult<Session>> {
  const collector = new IssueCollector();

  let text: string;
  try {
    text = await readFile(eventsPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `failed to read copilot events file: ${message}`,
        path: eventsPath,
      },
    ]);
  }

  const events: CopilotEvent[] = [];
  const rawEvents: RawEvent[] = [];
  let seq = 0;
  let sessionIdFromStore: string | undefined;

  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      collector.warn("skipping malformed copilot event line", {
        path: eventsPath,
      });
      continue;
    }

    const eventType =
      isRecord(obj) && typeof obj.type === "string" ? obj.type : "unknown";
    const tsMs =
      isRecord(obj) && typeof obj.timestamp === "string"
        ? Date.parse(obj.timestamp)
        : Number.NaN;
    rawEvents.push({
      seq,
      eventType,
      ...(Number.isNaN(tsMs) ? {} : { ts: Math.floor(tsMs / 1000) }),
      rawJson: trimmed,
    });
    seq += 1;

    const decoded = decodeEvent(obj);
    if (decoded === null) continue;
    if (decoded.kind === "sessionStart" && decoded.sessionId)
      sessionIdFromStore = decoded.sessionId;
    events.push(decoded);
  }

  if (events.length === 0) {
    return fail([
      {
        severity: "error",
        message: "copilot events file has no decodable events",
        path: eventsPath,
      },
    ]);
  }

  const sessionId = sessionIdFromStore ?? sessionIdFromPath(eventsPath);

  const session = buildSession(
    events,
    sessionId,
    eventsPath,
    rawEvents,
    collector,
  );
  if (!session) {
    return fail([
      {
        severity: "error",
        message: "copilot session produced zero messages",
        path: eventsPath,
      },
    ]);
  }

  return ok(session, collector.list());
}
