import type { DialectDescriptor } from "./types.js";

/**
 * opencode: SQLite store (session / message / part tables; each row's `data`
 * column is a nested JSON string). Rows insert with monotonic time_created;
 * opencode touches the user message's time_updated after the assistant turn
 * completes, so watermarking is on time_created. `/clear` creates a NEW
 * session row — re-resolve the session id at capture time.
 */
export const opencode: DialectDescriptor = {
  id: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  transcriptStore: {
    kind: "sqlite",
    root: "~/.local/share/opencode",
    pathPattern: "opencode.db",
    watermarkAxis: "row-time-created",
  },
  turnEnd: {
    kind: "explicit",
    description:
      'assistant message.data.finish is non-empty and not "tool-calls", with no decoded tool part; raw finish is the signal',
    abortDescription: 'message.data.error.name == "MessageAbortedError"',
  },
  configPaths: {
    globalDir: "~/.config/opencode",
  },
  capabilities: {
    incrementalRead: true,
    explicitTurnEnd: true,
    abortSignalOnDisk: true,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: true,
  },
};
