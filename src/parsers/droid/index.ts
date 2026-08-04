/**
 * Factory Droid transcript parser — public surface.
 *
 * Droid (Factory AI's closed-source `droid` binary) writes each session as a
 * pair of sibling files under `~/.factory/sessions/<dash-slug-cwd>/`:
 * `<uuid>.jsonl` (the conversation, appended line by line) and
 * `<uuid>.settings.json` (session-level settings + token usage). A
 * byte-identical `<uuid>.settings.json.bak` sits beside the settings file and is
 * ignored. The slug is the realpath of the session cwd with `/` replaced by `-`.
 *
 * This shell reads the JSONL, decodes each line, discovers the sibling settings
 * file, builds the lossless raw-event array (one entry per decoded line), and
 * reduces. All Droid format knowledge lives in records.ts (decoders) and
 * reduce.ts (reducer).
 *
 * The settings file is read for the session-level facts the JSONL does not carry
 * (model alias, token totals) but is not a raw event: `rawEvents` mirrors the
 * JSONL exactly, one entry per line, so a consumer can count lines from it. The
 * settings blob itself stays on disk next to `transcript.rawPath`.
 *
 * @example
 *   import { parseSessionFile } from "agent-canonical/parsers/droid";
 *   const r = await parseSessionFile("/path/to/<uuid>.jsonl");
 *   if (r.success) console.log(r.data.id);
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Session } from "../../schemas/session.js";
import type { RawEvent } from "../../schemas/transcript.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import type { DroidRecord } from "./records.js";
import { decodeLine, decodeSettingsFile } from "./records.js";
import { buildSession } from "./reduce.js";

export type {
  DroidContent,
  DroidRecord,
  DroidRecordBody,
  DroidSessionSettings,
  DroidTokenUsage,
} from "./records.js";
export {
  decodeLine,
  decodeSettingsFile,
  VISIBILITY_LLM_ONLY,
  VISIBILITY_USER_ONLY,
} from "./records.js";
export { buildSession } from "./reduce.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `<uuid>.jsonl` → `<uuid>`, the fallback id when the header carries none. */
function sessionIdFromPath(filePath: string): string {
  return basename(filePath).replace(/\.jsonl$/, "");
}

/**
 * Raw-event type for one line: the line `type`, refined to `message:<role>` for
 * message lines so a consumer can tell a user turn from an assistant turn
 * without re-parsing.
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
 * Parse one Droid session file into a canonical Session. The session id comes
 * from the `session_start` line's `id`, falling back to the uuid in the
 * filename. The sibling `<uuid>.settings.json` is read when present for the
 * model alias and session-level token totals; the session parses without it.
 *
 * Failure cases:
 *   - File read error → fail with an error issue.
 *   - Zero decodable lines → fail with an error issue.
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
        message: `failed to read droid session file: ${message}`,
        path: filePath,
      },
    ]);
  }

  const records: DroidRecord[] = [];
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
      collector.warn("skipping malformed droid session line", {
        seq,
        path: filePath,
      });
      continue;
    }

    const decoded = decodeLine(obj);
    if (decoded === null) {
      collector.warn("skipping undecodable droid session line", {
        seq,
        path: filePath,
      });
      continue;
    }

    const eventType = rawEventType(obj);
    const rawEvent: RawEvent = { seq, rawJson: trimmed };
    if (eventType !== undefined) rawEvent.eventType = eventType;
    if (decoded.tsMs !== undefined)
      rawEvent.ts = Math.floor(decoded.tsMs / 1000);
    rawEvents.push(rawEvent);
    seq += 1;

    if (decoded.kind === "header" && decoded.sessionId)
      sessionIdFromHeader = decoded.sessionId;
    records.push(decoded);
  }

  if (records.length === 0) {
    return fail([
      {
        severity: "error",
        message: "droid session file has no decodable lines",
        path: filePath,
      },
    ]);
  }

  // Optional sibling settings file: `<uuid>.jsonl` → `<uuid>.settings.json`.
  // The `.bak` copy beside it is byte-identical and deliberately ignored.
  const settingsPath = filePath.replace(/\.jsonl$/, ".settings.json");
  let settings: ReturnType<typeof decodeSettingsFile> | undefined;
  if (settingsPath !== filePath) {
    try {
      settings = decodeSettingsFile(
        JSON.parse(await readFile(settingsPath, "utf8")),
      );
    } catch {
      settings = undefined; // absent/unreadable settings are non-fatal
    }
  }

  const sessionId = sessionIdFromHeader ?? sessionIdFromPath(filePath);

  const session = buildSession(
    records,
    settings,
    sessionId,
    filePath,
    rawEvents,
    collector,
  );
  if (!session) {
    return fail([
      {
        severity: "error",
        message: "droid session produced zero messages",
        path: filePath,
      },
    ]);
  }

  return ok(session, collector.list());
}
