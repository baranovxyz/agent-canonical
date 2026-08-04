import type { DialectDescriptor } from "./types.js";

/**
 * droid: Factory Droid's per-session JSONL log plus sibling settings file
 * (Factory AI's closed-source `droid` binary, shipped Bun-compiled).
 *
 * Each session is two files under `~/.factory/sessions/<dash-slug-cwd>/`:
 * `<uuid>.jsonl` (the conversation, appended line by line) and
 * `<uuid>.settings.json` (session-level settings + token usage). A
 * byte-identical `<uuid>.settings.json.bak` sits beside the settings file and
 * carries nothing extra. The directory slug is the realpath of the session cwd
 * with `/` replaced by `-`, so `/home/u/project` becomes `-home-u-project`.
 *
 * The JSONL has three line envelopes: `session_start` (line 1:
 * `{id, title, owner, version, cwd, hostId, isSessionTitleManuallySet}`, no
 * timestamp), `message` (`{id, timestamp, message, parentId?}` — a `parentId`
 * linked list that re-parents on fork), and `agent_turn_outcome`
 * (`{turnId, reason, resultKind}`, no timestamp).
 *
 * `message.message` is Anthropic Messages-API shaped: content blocks are
 * `thinking` / `text` / `tool_use` / `tool_result`, and a tool result rides on a
 * later `role:"user"` message correlated by `tool_use_id`, so tool correlation
 * is cross-message. A `visibility` field (`llm_only` | `user_only` | `both`)
 * separates three things the store keeps in one stream: the conversation, the
 * `llm_only` system-reminder bundle Droid injects ahead of each user turn (id
 * `context-<turnId>`; skills, subagents, and environment facts rendered as
 * prose), and `user_only` error notices shown to the human but never sent to
 * the model.
 *
 * Turn end is explicit: every turn closes with an `agent_turn_outcome` whose
 * `turnId` is the user message that opened it and whose `reason` is `completed`
 * or `error`. No abort marker was observed, and an interrupted turn was not
 * exercised by the validated capture.
 *
 * Usage is session-level only — there are no per-message tokens. The settings
 * file holds `tokenUsage` (this session) and `inclusiveTokenUsage` (plus the
 * children in `childInclusiveTokenUsageBySessionId`), each
 * `{inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
 * thinkingTokens, factoryCredits}`. Its `model` is an alias
 * (`custom:<displayName>-<index>` under BYOK), never an upstream slug, and the
 * per-message `modelId` echoes that same alias.
 *
 * Config lives at `~/.factory`.
 */
export const droid: DialectDescriptor = {
  id: "droid",
  displayName: "Factory Droid",
  binary: "droid",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.factory/sessions",
    pathPattern: "<dash-slug-cwd>/<sessionId>.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "explicit",
    description:
      "each turn closes with an agent_turn_outcome line whose turnId is the user message that opened it and whose reason is completed | error",
  },
  configPaths: {
    globalDir: "~/.factory",
  },
  capabilities: {
    incrementalRead: false,
    explicitTurnEnd: true,
    abortSignalOnDisk: false,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: false,
  },
  validatedAgainst: {
    cliVersions: ["0.187.0"],
    storeSchemaVersion: "2",
  },
};
