import type { DialectDescriptor } from "./types.js";

/**
 * vibe: Mistral Vibe's per-session directory of `messages.jsonl` + `meta.json`
 * (`mistral-vibe` on PyPI, binary `vibe`, open source).
 *
 * Each session is a DIRECTORY under `~/.vibe/logs/session/`, named
 * `<prefix>_<YYYYmmdd_HHMMSS>_<first-8-of-uuid>` (the prefix is configurable and
 * defaults to `session`), holding `messages.jsonl` and `meta.json`. Only the
 * first 8 characters of the session uuid reach the directory name, so the full
 * id lives in the sidecar. A `.last_session/<tty>` pointer file sits at the
 * store root beside the session directories and holds a uuid, not content.
 *
 * `messages.jsonl` is a raw OpenAI chat-completions message per line, dumped
 * with `exclude_none` — absent keys are the norm. Roles are `user` |
 * `assistant` | `tool`; the system prompt is deliberately excluded and kept in
 * `meta.json` instead. Reasoning is INLINE on the assistant record
 * (`reasoning_content` + `reasoning_message_id`), a tool call is an assistant
 * record with no `content` and a `tool_calls` array whose `function.arguments`
 * is a JSON string, and a tool result is a `role:"tool"` record correlated by
 * `tool_call_id`. A call the user refused is a `role:"tool"` record with the
 * `tool_result` key absent and `content` set to
 * `<user_cancellation>User cancelled the operation.</user_cancellation>`. The
 * `presentation` object on calls and results is a pure TUI sidecar. A turn whose
 * API call errored persists nothing at all — only the user line remains.
 *
 * NOTHING in `messages.jsonl` carries a timestamp, a per-message token count, or
 * a per-message model. All session-level facts live in `meta.json`:
 * `session_id`, `parent_session_id`, `start_time` / `end_time`, `git_commit`,
 * `git_branch`, `environment.working_directory`, `username`, `child_sessions`,
 * `title` + `title_source`, `agent_profile`, `stats` (session-cumulative
 * tokens, cost, and tool-call tallies plus a `last_turn_*` snapshot),
 * `total_messages`, `last_message_fingerprint`, `tools_available`, the full
 * effective `config`, and `system_prompt`. The store carries NO schema or
 * format version field.
 *
 * Model is recoverable only through the config: `config.active_model` is a local
 * alias and `config.models[<alias>].name` is the upstream slug. The dump is the
 * CURRENT effective config, so a mid-session model switch is unrecoverable.
 *
 * Turn end is derived: a turn closes on an assistant record that has content and
 * no `tool_calls`. There is no terminal record and no status field, and
 * `meta.json` is rewritten after every turn, so `end_time` means "when the last
 * turn ended", not "when the session finished".
 *
 * Incremental reading is unavailable despite the JSONL shape: the writer appends
 * only while the new message list extends the persisted one, and takes a
 * full-file rewrite path for a rewind or an edited tail, which can invalidate a
 * byte-offset watermark mid-session.
 *
 * Config lives at `~/.vibe`.
 */
export const vibe: DialectDescriptor = {
  id: "vibe",
  displayName: "Mistral Vibe",
  binary: "vibe",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.vibe/logs/session",
    pathPattern: "<prefix>_<timestamp>_<short-sessionId>/messages.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "derived",
    description:
      "a turn closes on an assistant record that has content and no tool_calls; the store has no terminal record and no status field",
    abortDescription:
      "cancellation is tool-scoped, not turn-scoped: a refused call is a role:\"tool\" record with no tool_result key and content '<user_cancellation>User cancelled the operation.</user_cancellation>'",
  },
  configPaths: {
    globalDir: "~/.vibe",
  },
  capabilities: {
    incrementalRead: false,
    explicitTurnEnd: false,
    // The only cancellation marker is tool-scoped; no aborted-TURN fact exists.
    abortSignalOnDisk: false,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: false,
  },
  validatedAgainst: {
    // The store carries no schema or format version field, so none is recorded.
    cliVersions: ["2.23.3"],
  },
};
