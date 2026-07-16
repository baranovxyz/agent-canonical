/**
 * Kilo Code transcript parser — public surface.
 *
 * Kilo Code is an explicit fork of OpenCode and stores conversation data in a
 * compatible set of SQLite `session` / `message` / `part` rows whose `data`
 * columns hold the same nested JSON shape as opencode.db. A capture-derived
 * fixture covers the reader-facing row fields and nested
 * `message.data` shape ({role, modelID, providerID,
 * tokens:{input,output,reasoning,cache:{read,write}}, time:{created,completed},
 * finish}), identical `part` types (text / tool / patch / step-*), and tool
 * calls as single in-place-updated `part` rows correlated by `callID` — exactly
 * opencode's model. (Kilo also writes lifecycle-only `session_message` rows and
 * an event-sourced `event` log; neither carries the conversation, so both are
 * ignored.)
 *
 * Because the reader-facing row shape is compatible, this parser reuses
 * opencode's DB shell and only varies the *identity* stamped on the canonical
 * Session (cli `"kilo"`, id prefix `"kilo"`, `kilo_patch` synthetic tool name).
 * If a future Kilo release drifts its storage format, split this into its own
 * decoder/reducer at that point. A fork relationship alone does not establish
 * format compatibility; verify the persisted shape before sharing a parser.
 *
 * @example
 *   import { parseSessionFromDb, listSessionIds } from "agent-canonical/parsers/kilo";
 *   for (const id of listSessionIds(db)) {
 *     const r = parseSessionFromDb(db, id, "/path/to/kilo.db");
 *   }
 */

import type { Session } from "../../schemas/session.js";
import {
  type OpencodeDb,
  parseSessionFromDb as parseOpencodeSessionFromDb,
  type ReducerIdentity,
} from "../opencode/index.js";
import type { ParseResult } from "../types.js";

/**
 * Structural SQLite handle for `kilo.db`. Same shape as `OpencodeDb` (Kilo
 * reuses opencode's `session` / `message` / `part` schema).
 */
export type KiloDb = OpencodeDb;

/** Canonical identity stamped on Kilo sessions. */
const KILO_IDENTITY: ReducerIdentity = {
  cli: "kilo",
  idPrefix: "kilo",
  patchToolName: "kilo_patch",
  patchLabel: "Kilo patch",
};

/**
 * Parse one Kilo session from an open `kilo.db`.
 *
 * Synchronous. Fails when the session id is absent or the assembled session has
 * no usable messages; malformed rows add warnings and are skipped.
 */
export function parseSessionFromDb(
  db: KiloDb,
  sessionId: string,
  rawPath: string,
): ParseResult<Session> {
  return parseOpencodeSessionFromDb(db, sessionId, rawPath, KILO_IDENTITY);
}

/** List all session ids in a Kilo DB, oldest first (opencode's `session` table). */
export { listSessionIds } from "../opencode/index.js";
