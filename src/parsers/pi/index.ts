/**
 * Pi transcript parser — public surface.
 *
 * Pi (`@earendil-works/pi-coding-agent`, binary `pi`) writes one append-only
 * JSONL file per session at
 * `~/.pi/agent/sessions/<cwd-slug>/<ISO-timestamp>_<uuidv7>.jsonl`. Line 1 is
 * the session header; every later line is a `parentId`-chained entry, so a
 * session's whole history — including in-place branches — lives in that one
 * file. `--continue` appends to it rather than starting a new file.
 *
 * This shell reads the file, decodes each line, builds the lossless raw-event
 * array (one entry per line), and reduces. All Pi format knowledge lives in
 * records.ts (decoders) and reduce.ts (reducer).
 *
 * @example
 *   import { parseSessionFile } from "agent-canonical/parsers/pi";
 *   const r = await parseSessionFile("/path/to/2026-01-01T00-00-00-000Z_<id>.jsonl");
 *   if (r.success) console.log(r.data.id);
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Session } from "../../schemas/session.js";
import type { RawEvent } from "../../schemas/transcript.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import type { PiRecord } from "./records.js";
import { decodeEntry } from "./records.js";
import { buildSession } from "./reduce.js";

export type {
  PiEntryMeta,
  PiRecord,
  PiRecordBody,
  PiToolCall,
  PiUsage,
} from "./records.js";
export { decodeEntry } from "./records.js";
export { buildSession } from "./reduce.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `<ISO-timestamp>_<uuidv7>.jsonl` → `<uuidv7>`, the fallback session id when
 * the header line is missing or unreadable.
 */
function sessionIdFromPath(filePath: string): string {
  const name = basename(filePath).replace(/\.jsonl$/, "");
  // The ISO prefix dashes its separators, so the first underscore starts the
  // id — split there rather than at the last one, which would truncate an id
  // that contains underscores.
  const underscore = name.indexOf("_");
  return underscore >= 0 ? name.slice(underscore + 1) : name;
}

/**
 * Raw-event type for one line: the entry `type`, refined to `message:<role>`
 * for message entries so a consumer can tell a user turn from an assistant
 * turn, a tool result, or a `!cmd` shell escape without re-parsing.
 */
function rawEventType(obj: unknown): string | undefined {
  if (!isRecord(obj) || typeof obj.type !== "string") return undefined;
  if (obj.type !== "message") return obj.type;
  const message = obj.message;
  if (isRecord(message) && typeof message.role === "string")
    return `message:${message.role}`;
  return "message";
}

/**
 * Parse one Pi session file into a canonical Session. The session id comes from
 * the header line's `id`, falling back to the uuid in the filename.
 *
 * Failure cases:
 *   - File read error → fail with an error issue.
 *   - Zero decodable entries → fail with an error issue.
 *   - Zero usable messages after reduction → fail with an error issue.
 */
export async function parseSessionFile(
  filePath: string,
): Promise<ParseResult<Session>> {
  const collector = new IssueCollector();

  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `failed to read pi session file: ${message}`,
        path: filePath,
      },
    ]);
  }

  const records: PiRecord[] = [];
  const rawEvents: RawEvent[] = [];
  let seq = 0;
  let sessionIdFromHeader: string | undefined;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      collector.warn("skipping malformed pi session line", {
        seq,
        path: filePath,
      });
      continue;
    }

    const eventType = rawEventType(obj);
    const tsMs =
      isRecord(obj) && typeof obj.timestamp === "string"
        ? Date.parse(obj.timestamp)
        : Number.NaN;
    const rawEvent: RawEvent = { seq, rawJson: trimmed };
    if (eventType !== undefined) rawEvent.eventType = eventType;
    if (!Number.isNaN(tsMs)) rawEvent.ts = Math.floor(tsMs / 1000);
    rawEvents.push(rawEvent);
    seq += 1;

    const decoded = decodeEntry(obj);
    if (decoded === null) {
      collector.warn("skipping undecodable pi entry", {
        seq: seq - 1,
        path: filePath,
      });
      continue;
    }
    if (decoded.kind === "header" && decoded.sessionId)
      sessionIdFromHeader = decoded.sessionId;
    records.push(decoded);
  }

  if (records.length === 0) {
    return fail([
      {
        severity: "error",
        message: "pi session file has no decodable entries",
        path: filePath,
      },
    ]);
  }

  const sessionId = sessionIdFromHeader ?? sessionIdFromPath(filePath);

  const session = buildSession(
    records,
    sessionId,
    filePath,
    rawEvents,
    collector,
  );
  if (!session) {
    return fail([
      {
        severity: "error",
        message: "pi session produced zero messages",
        path: filePath,
      },
    ]);
  }

  return ok(session, collector.list());
}
