import type { DialectDescriptor } from "./types.js";

/**
 * codex: JSONL "rollout" store. The first line of every rollout is a
 * `session_meta` event carrying `cwd`. Every user turn is bracketed by
 * task_started and either task_complete or turn_aborted, yielding an explicit
 * lifecycle boundary.
 */
export const codex: DialectDescriptor = {
  id: "codex",
  displayName: "Codex CLI",
  binary: "codex",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.codex/sessions",
    pathPattern: "<yyyy>/<mm>/<dd>/rollout-<ts>-<session-id>.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "explicit",
    description: 'event_msg with payload.type == "task_complete"',
    abortDescription: 'event_msg with payload.type == "turn_aborted"',
  },
  configPaths: {
    globalDir: "~/.codex",
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
