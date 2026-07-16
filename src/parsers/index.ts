/**
 * Shared parser vocabulary — dialect-independent types used by every
 * `/parsers/<cli>` entry: Result-with-issues, turn-scoped canonical
 * events, and incremental-read cursors.
 *
 * Dialect-specific decoders and parse/read shells live behind their own
 * subpaths (`agent-canonical/parsers/<cli>`); SQLite handles stay confined to
 * the opencode and kilo entries.
 */

export type {
  DbCursor,
  FileCursor,
  IncrementalRead,
  TurnEvent,
} from "./turn-events.js";
export {
  fail,
  IssueCollector,
  MAX_WARNINGS,
  ok,
  type ParseIssue,
  type ParseResult,
} from "./types.js";
