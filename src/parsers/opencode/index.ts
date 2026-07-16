/**
 * opencode transcript parser — two storage backends.
 *
 * 1. File-based (older opencode): session JSON + per-message directory +
 *    per-message part directory under a shared dataRoot.
 *
 * 2. SQLite-based (opencode ≥ v1.4): single `opencode.db` with
 *    `session` / `message` / `part` tables.
 *
 * Both shells feed the shared `buildSession` reducer; format knowledge
 * lives once.
 *
 * Exported API:
 *   parseSessionFile        — async, file-based
 *   parseSessionFromDb      — sync, DB-based
 *   listSessionIds          — sync, infallible
 *   OpencodeDb              — structural DB handle (no better-sqlite3 dep)
 *   OpencodeParseOptions    — option bag
 *   buildSession            — pure reducer
 *   decodePart / decodeMessage / decodeSession — pure decoders (re-exported)
 */

// Incremental turn-event reader.
export { readEventsSince, snapshotCursor } from "./incremental.js";
export type { MessageRecord, SessionRecord } from "./records.js";
export { decodeMessage, decodePart, decodeSession } from "./records.js";
export type { RawMessageBundle, ReducerIdentity } from "./reduce.js";
// Pure reducer, identity default, and decoders exposed for direct consumer use.
// Forks that reuse opencode's storage engine (e.g. Kilo Code) import
// `parseSessionFromDb` + `ReducerIdentity` and pass their own identity.
export { buildSession, OPENCODE_IDENTITY } from "./reduce.js";
export type { OpencodeDb, OpencodeParseOptions } from "./shells.js";
export {
  listSessionIds,
  parseSessionFile,
  parseSessionFromDb,
} from "./shells.js";
