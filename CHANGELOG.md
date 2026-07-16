# Changelog

Notable agent-canonical changes only. Detailed implementation notes belong in commit history.

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
