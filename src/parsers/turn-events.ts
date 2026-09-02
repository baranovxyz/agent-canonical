/**
 * Canonical turn-scoped event vocabulary + incremental-read cursors.
 *
 * An incremental read returns the canonical events appended to a CLI's
 * transcript store since a cursor — the seam that lets consumers (reply-capture
 * and turn-end detection) run as predicates over canonical events instead of
 * re-implementing per-CLI format knowledge.
 *
 * Boundary: the package computes cursors and decodes events; file watching,
 * polling loops, and cursor *persistence* stay application-side.
 */

/**
 * One canonical event on a session's turn-scoped stream.
 *
 * - `user` / `assistant` / `thinking` — message text events. Emitted only
 *   when their text is non-empty after trimming; orchestrator-injected wrapper
 *   lines (command echoes, tool_result carriers) produce no `user` event,
 *   so every `user` event is a genuine operator turn boundary.
 * - `tool-call` — the agent invoked a tool. Surfaced so consumers can
 *   observe what a session is doing/asking mid-turn (e.g. claude-code
 *   AskUserQuestion blocks land here the moment they are emitted).
 * - `background-work` — the dialect's own record says work it dispatched is
 *   still outstanding at what would otherwise be a terminal signal
 *   claude-code's assistant `stop_reason ∈ {end_turn,
 *   stop_sequence, max_tokens}` paired with a `system`/`turn_duration`
 *   record whose `pendingBackgroundAgentCount` is still positive. Emitted
 *   INSTEAD OF a `turn-end` for that record — a turn is not over while its
 *   own transcript still reports outstanding work, so this event kind exists
 *   precisely so no `turn-end` is produced here. `count` is always > 0.
 * - `turn-end` — the dialect's terminal signal, decoded as an event fact:
 *   claude-code assistant `stop_reason` ∈ {end_turn, stop_sequence,
 *   max_tokens}; codex `event_msg` `task_complete` / `turn_aborted`;
 *   opencode `error.name == "MessageAbortedError"` or a non-`"tool-calls"`
 *   assistant finish with no decoded tool part; cursor-agent's
 *   `{"type":"turn_ended","status":…}` record. `signal` carries the raw
 *   per-CLI marker name.
 *
 *   `confidence` separates a marker the CLI wrote from one the parser
 *   inferred. Absent means `"explicit"` — the dialect stated the turn was
 *   over. `"inferred"` means the dialect wrote no marker and the event comes
 *   from a content heuristic, which can fire before the agent has actually
 *   yielded; consumers that must not end a turn early should require an
 *   independent signal (e.g. an idle pane) before honouring one.
 */
export type TurnEvent =
  | { kind: "user"; ts?: number; text: string }
  | { kind: "assistant"; ts?: number; text: string }
  | { kind: "thinking"; ts?: number; text: string }
  | { kind: "tool-call"; ts?: number; name: string; callId?: string }
  | { kind: "background-work"; ts?: number; count: number }
  | {
      kind: "turn-end";
      ts?: number;
      outcome: "completed" | "aborted";
      signal: string;
      confidence?: "explicit" | "inferred";
    };

/**
 * Cursor for file-backed stores (claude-code / codex / cursor JSONL).
 *
 * Keyed to file identity: a read against a different `path` (the CLI
 * rotated to a new file, e.g. claude-code on `/clear`) or a file shorter
 * than `offsetBytes` (truncation) resets safely to offset 0. Only
 * newline-terminated lines are consumed — an unterminated trailing line
 * (mid-append) is left for the next read, so `offsetBytes` always lands
 * on a line boundary.
 */
export interface FileCursor {
  kind: "file";
  path: string;
  offsetBytes: number;
}

/**
 * Cursor for the opencode SQLite store.
 *
 * Watermarks on `message.time_created` (epoch ms), NOT `time_updated`:
 * opencode touches the user message's `time_updated` AFTER the assistant
 * turn completes, so a `time_updated` watermark would silently exclude
 * the assistant rows sandwiched between dispatch and that post-turn touch.
 * `time_created` is monotonic on insert and cleanly partitions the past
 * from the new turn. Rows are re-read (`time_created > sinceMs`) on every
 * call because opencode updates assistant rows in place — the terminal
 * `finish` lands by row update, not by a new row.
 */
export interface DbCursor {
  kind: "db";
  sessionId: string;
  sinceMs: number;
}

/** Successful payload of an incremental read. */
export interface IncrementalRead<C> {
  events: TurnEvent[];
  /**
   * Cursor positioned after the last consumed event. Consumers that poll a
   * fixed turn-start cursor (per-turn watermark) may ignore it; consumers
   * that tail a store persist it between reads.
   */
  nextCursor: C;
}
