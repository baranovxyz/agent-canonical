import type { DialectDescriptor } from "./types.js";

/**
 * qwen: Qwen Code JSONL store. Qwen Code is a Gemini-CLI fork, but its
 * transcript format is a hybrid: a Claude-Code-style per-line envelope
 * (`uuid`/`parentUuid` message tree, `type`, `cwd`, `gitBranch`, ISO
 * `timestamp`) wrapping a Gemini-style message body (`message.parts[]` of
 * `text`/`functionCall`/`functionResponse`, `role: "model"` for the assistant,
 * and `usageMetadata` token counts). There is NO metadata header line — the
 * file opens with the first conversational record.
 *
 * Record `type`s: `user`, `assistant`, `tool_result` (its own record,
 * correlated to the assistant's `functionCall` by call id), and `system`
 * (attribution/telemetry snapshots — non-conversational, skipped). Assistant
 * records carry per-message `usageMetadata` {promptTokenCount,
 * candidatesTokenCount, thoughtsTokenCount, cachedContentTokenCount}, so
 * per-message usage is available. No explicit turn-end marker lives in the
 * store, and whether a tool_result follows is not knowable at the assistant
 * record boundary, so the package does not expose an incremental reader.
 *
 * Store path: `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl`
 * (`QWEN_HOME` overrides the root). The `<sanitized-cwd>` is a Claude-Code-style
 * slug of the working directory; `<sessionId>` is a UUID.
 */
export const qwen: DialectDescriptor = {
  id: "qwen",
  displayName: "Qwen Code",
  binary: "qwen",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.qwen/projects",
    pathPattern: "<sanitized-cwd>/chats/<sessionId>.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "unavailable",
    description:
      "no reliable live terminal fact; determining whether tool_result follows requires later records",
  },
  configPaths: {
    globalDir: "~/.qwen",
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
