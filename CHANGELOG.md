# Changelog

Notable agent-canonical changes only. Detailed implementation notes belong in commit history.

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
