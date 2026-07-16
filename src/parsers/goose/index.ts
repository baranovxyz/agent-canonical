/**
 * Goose transcript parser — public surface.
 *
 * Goose (Rust, AAIF/Linux Foundation) stores every session in a single global
 * SQLite store at `~/.local/share/goose/sessions/sessions.db` (WAL, schema v15
 * as of Goose 1.43.0). Unlike opencode/kilo (nested `part` rows) or the JSONL
 * dialects, Goose keeps one `messages` row per turn whose `content_json` column
 * is a serde-serialized `Vec<MessageContent>` — a `{type,…}`-tagged union — and
 * per-message usage in `metadata_json.usage` rather than the (null) `tokens`
 * column. It is therefore a genuinely new decoder + reducer, not a fork reuse.
 *
 * This is a thin IO shell: run SQL, hand raw rows to the decoders (records.ts),
 * reduce (reduce.ts), assemble. All Goose format knowledge lives in those two.
 *
 * The store is WAL-mode: read it on the CLI host for a consistent view (a torn
 * copy of `sessions.db` without its `-wal` sibling reads back empty).
 *
 * @example
 *   import { parseSessionFromDb, listSessionIds } from "agent-canonical/parsers/goose";
 *   for (const id of listSessionIds(db)) {
 *     const r = parseSessionFromDb(db, id, "/path/to/sessions.db");
 *   }
 */

import type { Session } from "../../schemas/session.js";
import type { RawEvent } from "../../schemas/transcript.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import type { GooseMessageRecord } from "./records.js";
import {
  decodeMessageRow,
  decodeSessionRow,
  SessionIdRowSchema,
} from "./records.js";
import { buildSession } from "./reduce.js";

export type { GooseMessageRecord, GooseSessionRecord } from "./records.js";
export { decodeMessageRow, decodeSessionRow } from "./records.js";
export { buildSession } from "./reduce.js";

/**
 * Minimal structural DB handle — the subset of better-sqlite3 / node:sqlite this
 * parser uses. Consumers open and own the connection.
 */
export interface GooseDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

const SESSION_COLUMNS =
  "id, name, description, session_type, working_dir, created_at, updated_at, provider_name, model_config_json, parent_session_id";
const MESSAGE_COLUMNS =
  "id, message_id, session_id, role, content_json, created_timestamp, metadata_json";

/**
 * Parse one Goose session from an open `sessions.db`.
 *
 * Synchronous. Fails when the session id is absent or the assembled session has
 * no usable messages; malformed rows add warnings and are skipped.
 */
export function parseSessionFromDb(
  db: GooseDb,
  sessionId: string,
  rawPath: string,
): ParseResult<Session> {
  const collector = new IssueCollector();

  const sessionRowRaw = db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .get(sessionId);

  if (sessionRowRaw === undefined || sessionRowRaw === null) {
    return fail([
      {
        severity: "error",
        message: `Session id ${sessionId} not found in DB`,
        path: rawPath,
      },
    ]);
  }

  const session = decodeSessionRow(sessionRowRaw);
  if (!session) {
    return fail([
      {
        severity: "error",
        message: `Session row for ${sessionId} has unexpected shape`,
        path: rawPath,
      },
    ]);
  }

  const messageRowsRaw = db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? ORDER BY id`,
    )
    .all(sessionId);

  const messages: GooseMessageRecord[] = [];
  const rawEvents: RawEvent[] = [
    { seq: 0, eventType: "session", rawJson: JSON.stringify(sessionRowRaw) },
  ];
  let seq = 1;
  for (const raw of messageRowsRaw) {
    const decoded = decodeMessageRow(raw);
    if (!decoded) {
      collector.warn("Skipping malformed message row", { path: rawPath });
      continue;
    }
    messages.push(decoded);
    rawEvents.push({
      seq,
      eventType: `message:${decoded.role}`,
      ...(decoded.ts !== undefined ? { ts: decoded.ts } : {}),
      rawJson: JSON.stringify(raw),
    });
    seq += 1;
  }

  if (messages.length === 0) {
    return fail([
      {
        severity: "error",
        message: `Session ${sessionId} has no message rows`,
        path: rawPath,
      },
    ]);
  }

  const result = buildSession(session, messages, rawPath, rawEvents, collector);
  if (!result) {
    collector.error(`Session ${sessionId} has no usable messages`, {
      path: rawPath,
    });
    return fail(collector.list());
  }

  return ok(result, collector.list());
}

/**
 * List all Goose session ids, oldest first (`sessions.created_at`).
 * Infallible: driver errors propagate naturally; schema-reject rows are skipped.
 */
export function listSessionIds(db: GooseDb): string[] {
  const rows = db.prepare("SELECT id FROM sessions ORDER BY created_at").all();
  const ids: string[] = [];
  for (const row of rows) {
    const parsed = SessionIdRowSchema.safeParse(row);
    if (parsed.success) ids.push(parsed.data.id);
  }
  return ids;
}
