# Changelog

Notable agent-canonical changes only. Detailed implementation notes belong in commit history.

## 0.4.0 - 2026-09-02

- Decode cursor-agent's `{"type":"turn_ended","status":…}` control record as the authoritative
  turn-end signal instead of inferring completion from message shape alone, which could not express
  an abort and misfired on mid-turn text-only records (46 of 335 captured transcripts). The
  content-shape check remains as a fallback for turns torn down before the record flushes (17 of
  335). Canonical turn-end events now carry an optional `confidence` field (`"explicit"` or
  `"inferred"`, absent meaning explicit); the other three incremental dialects are unaffected.
- Stop reading codex's post-interrupt `<turn_aborted>` notice — a synthetic `role:"user"` record
  wrapping the tag, injected immediately before the real turn-end event — as an ordinary user turn.
  Every consumer that scopes a turn up to the next `user` event was stopping the scan one record
  early and never reaching the abort behind it, so an interrupted codex turn could sit unresolved
  for its full read budget despite an explicit `turn_aborted` already on disk.
- Read claude-code's synthetic interrupt marker (`[Request interrupted by user]` /
  `[Request interrupted by user for tool use]`, matched as an exact whole record, never a
  substring) as an aborted `turn-end` event instead of an ordinary operator turn, so an interrupted
  claude-code turn resolves from the transcript instead of exhausting its read budget and falling
  back to a pane heuristic.
- Add a `background-work` canonical event for claude-code: a terminal `stop_reason` paired with a
  `system`/`turn_duration` record whose `pendingBackgroundAgentCount` is still positive emits
  `background-work` instead of `turn-end`, so a turn that dispatched background agents is not
  reported complete while they remain outstanding. A terminal `stop_reason` with no ledger record
  yet — the two are separate appends about 100ms apart — emits nothing at all within a bounded
  freshness window (a missing record there is inconclusive, not a confirmed zero) and only degrades
  to an ordinary `turn-end` once that window has passed, so a session that never writes the ledger
  still completes normally.
- Stop emitting a `user` turn event for claude-code records the CLI itself flags `isMeta` — its own
  synthetic injections, e.g. the skill body appended when a Skill loads. Because every `user` event
  is a turn boundary, one of these synthetic records could close the turn window before the turn's
  own terminal signal was reached, stranding a completed reply as "still in progress." The session
  reducer is unaffected; only the turn-scoped incremental event stream changes. `DecodedUserText`
  and `DecodedUserArray` gained a new `isMeta` field reporting the raw flag.
- Add exact-version Codex transcript certification evidence for 0.141.0 and 0.150.1.
  Certification uses strict evidence-only schemas, exhaustive handled/ignored/unclassified record
  accounting, semantic scenario assertions, and full/incremental parity while the production
  decoder remains forward-tolerant.
- Reformatted under Biome 2.5.8 (test-file argument wrapping only; no behavior change).

## 0.3.0 - 2026-08-04

- Added a `/parsers/vibe` entry for Mistral Vibe (`mistral-vibe` on PyPI, binary `vibe`). Vibe
  writes each session as a DIRECTORY under `~/.vibe/logs/session/`, named
  `<prefix>_<YYYYmmdd_HHMMSS>_<first-8-of-uuid>`, holding `messages.jsonl` (one raw OpenAI
  chat-completions message per line, dumped with `exclude_none`) and `meta.json` (the sidecar,
  rewritten atomically after every turn). `parseSessionFile` accepts either the directory or its
  `messages.jsonl`. Reasoning is INLINE on the assistant record (`reasoning_content`), so it becomes
  its own `thinking` message ahead of that record's reply; a tool call is an assistant record whose
  `function.arguments` is a JSON string, correlated to a later `role:"tool"` record by
  `tool_call_id`. A call the user refused is a tool record with the `tool_result` key ABSENT and
  `content` set to `<user_cancellation>User cancelled the operation.</user_cancellation>` — kept as
  a cancelled call carrying that text, with `exitCode` 1. `exitCode` is otherwise set only from a
  `bash` result's `returncode`, the one status the store states. NOTHING in `messages.jsonl` carries
  a timestamp, a token count, or a model, so `Message.ts` is left unset rather than back-filled, and
  session identity, timing, cwd, git branch, cumulative tokens, and model all come from `meta.json`
  — the model via `config.active_model` (an alias) resolved through `config.models[<alias>].name`.
  Turn end is derived (an assistant record with content and no `tool_calls`) and never sets a
  session status: the sidecar is rewritten every turn and an API-errored turn persists nothing at
  all. Incremental reading is unavailable despite the JSONL shape — the writer takes a full-file
  rewrite path for a rewind or an edited tail. Validated against Vibe 2.23.3 (the store carries no
  schema or format version field).
- Added a `/parsers/droid` entry for Factory Droid (binary `droid`). Droid writes each session as
  two sibling files under `~/.factory/sessions/<dash-slug-cwd>/`: an appended `<uuid>.jsonl` and a
  `<uuid>.settings.json` (a byte-identical `.settings.json.bak` sits beside it and is ignored). The
  JSONL has three line envelopes — `session_start` (line 1, no timestamp), `message`
  (`{id, timestamp, message, parentId?}`), and `agent_turn_outcome`
  (`{turnId, reason, resultKind}`, no timestamp), which makes turn end explicit on disk. Message
  content is Anthropic Messages-API shaped (`thinking` / `text` / `tool_use` / `tool_result`), so
  `thinking` becomes its own message and a tool result on a later user message correlates to its
  call by `tool_use_id`. A `visibility` field splits the single message stream three ways: the
  conversation, the `llm_only` system-reminder bundle Droid injects ahead of each user turn (dropped
  from canonical messages, kept verbatim in `rawEvents`), and `user_only` notices shown to the human
  but never sent to the model (kept as `system` messages). A trailing `agent_turn_outcome` of
  `reason:"error"` marks the session `failed`; a trailing `completed` sets no status. There is no
  per-message usage — totals come from the settings file's `tokenUsage`, deliberately not the
  child-inclusive rollup — and `model` is an alias (`custom:<displayName>-<index>` under BYOK),
  reported as recorded because the upstream slug is not in the store. Validated against Droid
  0.187.0 (`session_start.version` 2).
- Added a `/parsers/pi` entry for Pi (`@earendil-works/pi-coding-agent`, binary `pi`). Pi writes one
  append-only JSONL file per session at
  `~/.pi/agent/sessions/<cwd-slug>/<ISO-timestamp>_<uuidv7>.jsonl`, with `--continue` appending to
  the same file. Line 1 is the header `{type:"session", version, id, timestamp, cwd}`; every later
  line is an entry `{type, id, parentId, timestamp}` — `message`, `model_change`,
  `thinking_level_change`, `session_info` (the only title source), `compaction`, `branch_summary`,
  `label`, `custom`, `custom_message`. A `message` entry nests an AgentMessage whose role is `user`,
  `assistant`, `toolResult`, or `bashExecution`; assistant content blocks are
  `thinking` / `text` / `toolCall` (with `arguments` already an object), and tool results are
  separate entries correlated by `toolCallId`. `thinking` becomes its own message, and the TUI's
  `!cmd` shell escape (`bashExecution`) becomes a user message carrying a synthetic `pi_bash` tool
  call. Entries form a branching DAG (`id`/`parentId`); the reducer keeps every entry in file order,
  as the claude-code parser does, so an abandoned branch is still accounted for, and the full chain
  stays verbatim in `rawEvents`. Usage is per assistant message
  (`{input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost}`) with no session
  aggregate, so transcript totals are summed; `cost` has no canonical field and survives only in
  `rawEvents`. Turn-end is explicit (`stopReason ∈ stop | length | toolUse | error | aborted`), and
  an errored turn keeps its `errorMessage` as a system message with `status:"failed"`. Validated
  against Pi 0.83.0 (store `version` 3).

## 0.2.1 - 2026-08-03

- Combine the bounded Codex rollout-family materializer from 0.2.0 with the corrected fork token
  accounting from 0.1.8, including aggregate cache-write token coverage, while preserving both
  contracts on one monotonic release line.

## 0.2.0 - 2026-07-31

- Add the `/materializers` export for bounded Codex rollout-family discovery and deterministic
  verbatim native JSONL projection. The collector anchors to one exact root rollout, follows
  transitive `parentSessionId` edges, rejects missing successful spawns and changing selected
  files, and fails closed on malformed JSONL or orphan, reordered, and contradictory child-start
  evidence. Unknown but valid JSON records remain preserved. Unrelated session bytes are ignored;
  each selected file is capped at 64 MiB and the family at 256 MiB.
- Report aggregate token fields together with the exact session IDs that omitted each field, so a
  consumer cannot mistake partial accounting for a complete total. Other CLI source materializers
  and dynamic workflow semantics remain unsupported in this version.

## 0.1.8 - 2026-08-03

- Exclude inherited Codex token deltas when a forked rollout retains only the child's session
  metadata but replays earlier task history with child-restamped event timestamps.
- Omit aggregate token usage when a Codex session changes model instead of pricing every request as
  the first model.

## 0.1.7 - 2026-08-02

- Correct Codex usage accounting for forked sessions by summing current-task request deltas,
  deduplicating repeated cumulative snapshots, preserving cache-write tokens, and omitting
  inherited usage when reliable current-task request deltas are unavailable.

## 0.1.6 - 2026-07-17

- Added a `/parsers/copilot` entry for GitHub Copilot CLI (`@github/copilot`, binary `copilot`).
  Copilot writes each session as a directory `~/.copilot/session-state/<uuid>/` whose
  `events.jsonl` is the lossless source of truth: one typed event per line, envelope
  `{type, data, id, timestamp, parentId}`. The decoded vocabulary — `session.start`,
  `session.model_change`, `user.message`, `assistant.message` (content, `toolRequests[]`, optional
  `reasoningText`, per-message `outputTokens`), `tool.execution_complete` (result + `success`,
  paired by `toolCallId`), and `session.shutdown` (per-model `modelMetrics.usage` totals) — folds
  into a canonical Session. Tool correlation is cross-event (a call is issued in an
  `assistant.message` and its output arrives later in a `tool.execution_complete`); `reasoningText`
  becomes a `thinking` message. Per-message usage is output-only, so transcript totals come from
  the shutdown aggregate, falling back to summed per-message output when no shutdown event was
  written. A genuinely new, file-based decoder — a typed event stream, not cline's message array or
  the opencode/goose tabular stores. Turn-end is explicit (`assistant.turn_end` + `session.shutdown`).
  Validated against Copilot 1.0.70 (store `version` 1). The sibling per-session `session.db`
  (transient todos/inbox) and the top-level `session-store.db` (a derived FTS index) are not read.

## 0.1.5 - 2026-07-16

- Corrected Cline's dialect descriptor to advertise the current `@cline/cli` binary, `cline`.
  The parser remains validated against the 0.0.13 `messages-contract-v1` capture; that preview
  release installed the earlier `clite` binary name.

## 0.1.4 - 2026-07-16

- Added a `/parsers/cline` entry for Cline (`@cline/cli`, binary `clite`). Cline writes each session
  as a directory `~/.cline/data/sessions/<id>/` with two JSON files: `<id>.messages.json` (the
  versioned `messages-contract-v1` payload) and `<id>.json` (session metadata). Content is
  Anthropic-native — `content` is an array of `text` / `thinking` / `tool_use` / `tool_result`
  blocks, with `tool_result` riding on a `role:"user"` message and correlating to its `tool_use`
  (on an earlier assistant message) by `tool_use_id`. Per-message usage lives in `metrics` on the
  terminal assistant message of a turn; timestamps are epoch ms. It reuses neither opencode's
  tabular store nor goose's serde union — a genuinely new, file-based decoder. A new `json` store
  kind covers the per-session JSON-object envelope.
- Corrected Goose's store descriptor to represent the data directory resolved by Goose 1.43's path
  helper instead of claiming one Linux path applies everywhere. Current Unix/macOS installs use
  XDG data paths, Windows uses `%APPDATA%\Block\goose\data`, `GOOSE_PATH_ROOT` moves data under
  `<GOOSE_PATH_ROOT>/data`, and older macOS installs may retain the legacy Application Support path.

## 0.1.3 - 2026-07-16

- Added a `/parsers/goose` entry for Goose (Rust; AAIF/Linux Foundation). Goose keeps a single
  global `sessions.db` (SQLite, WAL, schema v15) with one row per turn; `content_json` is a serde
  `{type,…}`-tagged content union (`text` / `thinking` / `toolRequest` / `toolResponse` / …) and
  per-message usage lives in `metadata_json.usage`, not the (null) `tokens` column. Unlike the
  opencode/kilo lineage, tool calls are cross-row — a `toolRequest` in an assistant row pairs with a
  `toolResponse` in a later user row by `callID` — so this is a genuinely new decoder + reducer, not
  a fork reuse.
- Dialect descriptors gained an optional `validatedAgainst` field recording the CLI version(s) and
  on-disk store schema version a captured session confirmed the parser against (populated for goose,
  kilo, and qwen). Parsers stay version-agnostic and permissive; the field documents the tested
  baseline so drift past it is visible.

## 0.1.2 - 2026-07-16

- Preserve Codex collaboration lineage as direct `parentSessionId` edges, classify spawned workers
  by role or path, and identify Guardian review sessions while leaving user roots untyped.

## 0.1.1 - 2026-07-16

- Add the Kilo Code dialect and `/parsers/kilo` export. Kilo reuses the OpenCode SQLite reader
  and reducer while preserving Kilo-specific session and patch identities.
- Treat an OpenCode assistant turn as complete for any non-`"tool-calls"` finish when no decoded
  tool-call part remains, while preserving abort and in-progress behavior.

## 0.1.0 - 2026-07-14

- First npm packaging. `tsup` build emits `dist` (ESM + `.d.ts`) with one entry per subpath
  export; the published `exports` map resolves to `dist`.
- Zod 4 (`^4.4.3`) is the sole runtime peer; packed declarations and export paths are verified
  against that contract.
- Canonical session/transcript schemas (`/schemas`), per-CLI dialect descriptors (`/dialects`),
  and parsers (`/parsers`, `/parsers/<cli>`) for claude-code, codex, opencode, cursor, Gemini CLI,
  and Qwen Code.
- Incremental readers are capability-based: claude-code, codex, opencode, and cursor expose them;
  Gemini and Qwen remain full-store-only because their stores have no trustworthy live terminal
  fact.
