import type { DialectDescriptor } from "./types.js";

/**
 * claude-code: JSONL store, eager line-by-line flush. Each assistant turn is
 * logged 2–3× with identical message.id (dedup by id). Most `type:"user"`
 * events are tool_result wrappers, not real operator turns. No
 * assistant-level abort marker exists — tool-gate interrupts surface only as
 * synthetic user tool_results.
 */
export const claudeCode: DialectDescriptor = {
  id: "claude-code",
  displayName: "Claude Code",
  binary: "claude",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.claude/projects",
    pathPattern: "<encoded-cwd>/<session-id>.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "explicit",
    description:
      'assistant message.stop_reason in {"end_turn","stop_sequence","max_tokens"}; "tool_use" means still working',
  },
  configPaths: {
    globalDir: "~/.claude",
  },
  capabilities: {
    incrementalRead: true,
    explicitTurnEnd: true,
    abortSignalOnDisk: false,
    questionAwaitingOnDisk: true,
    permissionAwaitingOnDisk: false,
    perMessageUsage: true,
  },
};
