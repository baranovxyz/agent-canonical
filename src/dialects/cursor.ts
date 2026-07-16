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
    kind: "derived",
    description:
      "no terminal marker on disk; derived — the latest assistant record after the prompt anchor is text-only (no tool_use part)",
  },
  configPaths: {
    globalDir: "~/.cursor",
  },
  capabilities: {
    incrementalRead: true,
    explicitTurnEnd: false,
    abortSignalOnDisk: false,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: false,
  },
};
