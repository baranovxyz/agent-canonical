import type { DialectDescriptor } from "./types.js";

/**
 * cline: Cline's per-session JSON store (the `@cline/cli` binary is `clite`).
 *
 * Each session is a directory `~/.cline/data/sessions/<id>/` holding two files:
 * `<id>.messages.json` (the versioned `messages-contract-v1` payload —
 * `{version, updated_at, agent, sessionId, messages[], system_prompt?}`) and
 * `<id>.json` (session-level metadata: model, provider, cwd, title, status,
 * started/ended timestamps). A `sessions.db` SQLite beside the dirs indexes
 * session metadata only (no messages), so the JSON files are the source of truth.
 *
 * Content is Anthropic-native — each message's `content` is an array of `{type,…}`
 * blocks with exactly four `type` values: `text`, `thinking`, `tool_use`
 * (`{id,name,input}`), and `tool_result` (`{tool_use_id,content,is_error?}`).
 * There is no `"tool"` role: a `tool_result` rides on a `role:"user"` message and
 * correlates to its `tool_use` (on an earlier assistant message) by `tool_use_id`.
 * Per-message usage lives in `metrics` (`{inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens, cost}`) on the terminal assistant message of
 * a turn; timestamps are epoch ms. This is a genuinely new, file-based decoder —
 * it reuses neither opencode's tabular store nor goose's serde union.
 *
 * Turn-end is derived: the terminal assistant message of a completed turn carries
 * `modelInfo` + `metrics`, but the store persists no per-turn terminal token, and
 * a turn may end with no assistant message on failure. The store carries no abort
 * marker.
 *
 * Config lives at `~/.cline/data/settings`.
 */
export const cline: DialectDescriptor = {
  id: "cline",
  displayName: "Cline",
  // The @cline/cli package installs its binary as `clite`, not `cline`.
  binary: "clite",
  transcriptStore: {
    kind: "json",
    root: "~/.cline/data/sessions",
    pathPattern: "<sessionId>/<sessionId>.messages.json",
    watermarkAxis: "row-time-created",
  },
  turnEnd: {
    kind: "derived",
    description:
      "terminal assistant message of a turn carries modelInfo + metrics (messages-contract-v1); no per-turn terminal token, and a failed turn may end with no assistant message",
  },
  configPaths: {
    globalDir: "~/.cline/data/settings",
  },
  capabilities: {
    incrementalRead: false,
    explicitTurnEnd: false,
    abortSignalOnDisk: false,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: true,
  },
  validatedAgainst: {
    cliVersions: ["0.0.13"],
    storeSchemaVersion: "messages-contract-v1",
  },
};
