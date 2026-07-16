import type { DialectDescriptor } from "./types.js";

/**
 * gemini: Gemini CLI JSONL store. The first line is a session-metadata record
 * (ConversationRecord: sessionId, projectHash, startTime, directories, kind);
 * subsequent lines are per-message records (`type` in
 * user|gemini|info|error|warning), plus `$set` metadata-update and `$rewindTo`
 * edit-history records. Assistant (`gemini`) messages carry per-message
 * `tokens` {input, output, cached, thoughts, tool} and a `toolCalls` array with
 * enriched results, so per-message usage is available. Token and tool updates
 * append same-id revisions, so no individual record is a reliable turn-end
 * marker and the package does not expose an incremental reader.
 *
 * Store path: `~/.gemini/tmp/<project-id>/chats/session-<ts>-<id8>.jsonl`
 * (subagents nest under `chats/<parent-id>/<session-id>.jsonl`). Default
 * 30-day retention prunes old transcripts.
 */
export const gemini: DialectDescriptor = {
  id: "gemini",
  displayName: "Gemini CLI",
  binary: "gemini",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.gemini/tmp",
    pathPattern: "<project-id>/chats/session-<ts>-<id8>.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "unavailable",
    description:
      "no reliable live terminal fact; same-id token and tool revisions can follow any gemini record",
  },
  configPaths: {
    globalDir: "~/.gemini",
  },
  capabilities: {
    incrementalRead: false,
    explicitTurnEnd: false,
    abortSignalOnDisk: false,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: true,
  },
};
