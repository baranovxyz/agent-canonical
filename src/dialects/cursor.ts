import type { DialectDescriptor } from "./types.js";

/**
 * cursor (binary `cursor-agent`): JSONL store with Anthropic-shaped records.
 * Whole records are appended atomically at turn-end (the user record flushes
 * together with the first assistant record — no char-streaming). There are no
 * tool_result records; tool output is echoed into the next assistant record's
 * text. No explicit turn-terminal field exists, so turn end is derived from
 * record structure.
 */
export const cursor: DialectDescriptor = {
  id: "cursor",
  displayName: "Cursor CLI",
  binary: "cursor-agent",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.cursor/projects",
    pathPattern: "<slug>/agent-transcripts/<session-id>/<session-id>.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "explicit",
    description:
      'a {"type":"turn_ended","status":…} control record is appended after the final assistant record; status "success" completes, any other status aborts. Turns torn down before it flushes fall back to the derived rule (latest assistant record after the prompt anchor is text-only), which is emitted as an inferred signal',
    abortDescription:
      'the same turn_ended record with a non-"success" status ("aborted" and "error" observed)',
  },
  configPaths: {
    globalDir: "~/.cursor",
  },
  capabilities: {
    incrementalRead: true,
    explicitTurnEnd: true,
    abortSignalOnDisk: true,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: false,
  },
};
