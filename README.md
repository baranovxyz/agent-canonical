# agent-canonical

One package that owns the canonical session shape and every piece of per-CLI transcript-format
knowledge for AI coding agents, so no consumer vendors or re-implements format knowledge and
copies cannot drift.

## Install

```bash
npm install agent-canonical
```

`zod` is a peer dependency (`^4.4.3`). The package ships compiled ESM with type
declarations, one entry per subpath export — e.g.
`import { … } from "agent-canonical/schemas"`.

## Subpath exports

- `agent-canonical/schemas` — zod schemas + inferred types for the canonical entities: `Session`
  (live CLI instance) wrapping `Transcript` (recorded messages / tool calls / lossless tier),
  plus `Settings` and `Artifact` stubs. No runtime dependency besides zod (peer, `^4.4.3`).
- `agent-canonical/dialects` — pure-data descriptors, one per supported CLI (claude-code, codex,
  opencode, cursor, gemini, qwen, kilo, goose): transcript store locations, turn-end signals, config
  paths, capability flags, and an optional `validatedAgainst` provenance record (the CLI version(s)
  and store schema version a captured session confirmed the parser against). Zero dependencies.
- `agent-canonical/parsers/<cli>` — one entry per CLI (claude-code, codex, opencode, cursor,
  gemini, qwen, kilo, goose) turning that CLI's on-disk transcript store into a canonical `Session`.
  Layered: a pure event decoder + a pure session reducer per dialect, with `parseSessionFile`
  (and, for the SQLite dialects, `parseSessionFromDb`/`listSessionIds` over a structural DB handle —
  no `better-sqlite3` import) as thin shells. Kilo Code is an OpenCode fork whose `kilo.db` has an
  OpenCode-compatible reader shape, so the kilo entry reuses opencode's DB shell + reducer and only
  varies the stamped identity (cli/id-prefix/patch name). Goose keeps a single global `sessions.db`
  with a serde `{type,…}`-tagged content union and cross-row tool correlation, so its entry is a
  genuinely new decoder + reducer. Every fallible call returns
  `ParseResult<T>` ({success, data, issues} — never `null`, never throw-by-default). Golden tests
  use synthetic or capture-derived fixtures whose identifiers and provenance are explicit
  placeholders.

Every dialect supports full-store parsing. Claude Code, Codex, OpenCode, and Cursor also export
`snapshotCursor` / `readEventsSince` because their stores provide a reliable live event boundary.
Gemini, Qwen, Kilo, and Goose are full-store-only. Gemini and Qwen advertise
`turnEnd.kind: "unavailable"`, so live consumers can select a bounded fallback instead of treating
an intermediate record as turn-end. Kilo has an explicit on-disk turn-end signal and Goose a derived
one, but both entries expose only the full-store parser pair.

The opencode, kilo, and goose parsers take a structural DB handle instead of importing
`better-sqlite3`, so no subpath resolves a native module; native deps always stay external.
