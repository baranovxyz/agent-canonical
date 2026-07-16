import type { DialectDescriptor } from "./types.js";

/**
 * kilo: Kilo Code's SQLite store. Kilo Code is an explicit OpenCode fork and
 * uses an OpenCode-compatible storage shape — a single `kilo.db` with
 * `session` / `message` / `part` tables, each row's `data` column a nested JSON
 * string in the same shape as opencode.db (verified by the sanitized,
 * capture-derived Kilo 7.4.9 fixture). The turn-end and per-message-usage
 * signals match opencode: a nonempty assistant `message.data.finish` other
 * than `"tool-calls"` completes a turn only when no decoded tool part remains. Each
 * assistant row carries `tokens` {input, output, reasoning, cache:{read,write}}.
 *
 * Kilo additionally writes a lifecycle-only `session_message` table
 * (agent/model-switch events) and an event-sourced `event` log; neither holds
 * the conversation, so the parser reads only `session`/`message`/`part`.
 *
 * Store path: `~/.local/share/kilo/kilo.db` (WAL mode). Config lives at
 * `~/.config/kilo/kilo.jsonc` (OpenCode-shaped JSONC).
 */
export const kilo: DialectDescriptor = {
  id: "kilo",
  displayName: "Kilo Code",
  binary: "kilo",
  transcriptStore: {
    kind: "sqlite",
    root: "~/.local/share/kilo",
    pathPattern: "kilo.db",
    watermarkAxis: "row-time-created",
  },
  turnEnd: {
    kind: "explicit",
    description:
      'assistant message.data.finish is non-empty and not "tool-calls", with no decoded tool part; raw finish is the signal',
    abortDescription: 'message.data.error.name == "MessageAbortedError"',
  },
  configPaths: {
    globalDir: "~/.config/kilo",
  },
  capabilities: {
    // The kilo entry exports only the full-store parse pair, not the
    // snapshotCursor/readEventsSince incremental readers (opencode's could apply
    // to kilo's compatible reader shape, but they are not wired here).
    incrementalRead: false,
    explicitTurnEnd: true,
    abortSignalOnDisk: true,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: true,
  },
  validatedAgainst: {
    cliVersions: ["7.4.9"],
  },
};
