/**
 * Cline transcript parser — public surface.
 *
 * Cline (`@cline/cli`, binary `clite`) writes each session as a directory
 * `~/.cline/data/sessions/<id>/` holding two JSON files: `<id>.messages.json`
 * (the versioned `messages-contract-v1` payload) and `<id>.json` (session-level
 * metadata). This shell reads the messages file, reads the sibling metadata file
 * when present (optional enrichment), builds raw events, and reduces. All Cline
 * format knowledge lives in records.ts (decoders) and reduce.ts (reducer).
 *
 * Content is Anthropic-native (`text` / `thinking` / `tool_use` / `tool_result`
 * blocks) but the per-session two-JSON-file envelope is Cline's own — it reuses
 * neither opencode's tabular store nor goose's serde union, so this is a
 * genuinely new, file-based decoder. A `sessions.db` SQLite index sits beside
 * the session dirs but carries only session-level metadata, not messages; the
 * JSON files are self-sufficient and generation-agnostic, so we read them.
 *
 * @example
 *   import { parseSessionFile } from "agent-canonical/parsers/cline";
 *   const r = await parseSessionFile("/path/to/<id>/<id>.messages.json");
 *   if (r.success) console.log(r.data.id);
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { Session } from "../../schemas/session.js";
import type { RawEvent } from "../../schemas/transcript.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import { decodeMessagesFile, decodeMetaFile } from "./records.js";
import { buildSession } from "./reduce.js";

export type {
  ClineContent,
  ClineMessageRecord,
  ClineMessagesFile,
  ClineSessionMeta,
} from "./records.js";
export {
  decodeMessage,
  decodeMessagesFile,
  decodeMetaFile,
  stripUserInputWrapper,
} from "./records.js";
export { buildSession } from "./reduce.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `<id>.messages.json` → `<id>` (the session id used when the file omits one). */
function sessionIdFromPath(messagesPath: string): string {
  return basename(messagesPath).replace(/\.messages\.json$/, "");
}

/**
 * Parse one Cline session from its `<id>.messages.json` path into a canonical
 * Session. The sibling `<id>.json` metadata file is read when present for model,
 * project path, title, status, and timestamps; the session parses without it.
 *
 * Failure cases:
 *   - Messages file read/JSON error → fail with an error issue.
 *   - Messages file shape unrecognizable → fail with an error issue.
 *   - Zero usable messages after reduction → fail with an error issue.
 */
export async function parseSessionFile(
  messagesPath: string,
): Promise<ParseResult<Session>> {
  const collector = new IssueCollector();

  let text: string;
  try {
    text = await readFile(messagesPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `failed to read cline messages file: ${message}`,
        path: messagesPath,
      },
    ]);
  }

  let rawObj: unknown;
  try {
    rawObj = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `failed to parse cline messages JSON: ${message}`,
        path: messagesPath,
      },
    ]);
  }

  const file = decodeMessagesFile(rawObj);
  if (file === null) {
    return fail([
      {
        severity: "error",
        message: "cline messages file has unexpected shape",
        path: messagesPath,
      },
    ]);
  }

  // Optional sibling metadata file: `<id>.messages.json` → `<id>.json`.
  const metaPath = messagesPath.replace(/\.messages\.json$/, ".json");
  let metaRaw: unknown;
  if (metaPath !== messagesPath) {
    try {
      metaRaw = JSON.parse(await readFile(metaPath, "utf8"));
    } catch {
      metaRaw = undefined; // absent/unreadable metadata is non-fatal
    }
  }
  const meta = metaRaw !== undefined ? decodeMetaFile(metaRaw) : undefined;

  const sessionId =
    file.sessionId ?? meta?.sessionId ?? sessionIdFromPath(messagesPath);

  // Lossless raw events: the metadata file (when present) then one per message.
  const rawEvents: RawEvent[] = [];
  let seq = 0;
  if (metaRaw !== undefined) {
    rawEvents.push({
      seq,
      eventType: "session",
      rawJson: JSON.stringify(metaRaw),
    });
    seq += 1;
  }
  const rawMessages =
    isRecord(rawObj) && Array.isArray(rawObj.messages) ? rawObj.messages : [];
  for (const rawMsg of rawMessages) {
    const role =
      isRecord(rawMsg) && typeof rawMsg.role === "string"
        ? rawMsg.role
        : "unknown";
    const tsMs =
      isRecord(rawMsg) && typeof rawMsg.ts === "number" ? rawMsg.ts : undefined;
    rawEvents.push({
      seq,
      eventType: `message:${role}`,
      ...(tsMs !== undefined ? { ts: Math.floor(tsMs / 1000) } : {}),
      rawJson: JSON.stringify(rawMsg),
    });
    seq += 1;
  }

  const session = buildSession(
    file,
    meta,
    sessionId,
    messagesPath,
    rawEvents,
    collector,
  );
  if (!session) {
    return fail([
      {
        severity: "error",
        message: "cline session produced zero messages",
        path: messagesPath,
      },
    ]);
  }

  return ok(session, collector.list());
}
