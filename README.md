<p align="center">
  <h1 align="center">agent-canonical</h1>
  <p align="center">
    One canonical session shape for every AI coding-agent CLI.
    <br />
    Zod schemas, per-CLI dialect knowledge, and incremental turn events — parsed once, shared everywhere.
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-canonical"><img src="https://img.shields.io/npm/v/agent-canonical.svg?style=flat-square" alt="npm version" /></a>
  <a href="https://github.com/baranovxyz/agent-canonical/actions"><img src="https://img.shields.io/github/actions/workflow/status/baranovxyz/agent-canonical/ci.yml?branch=main&style=flat-square&label=tests" alt="CI" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/agent-canonical"><img src="https://img.shields.io/node/v/agent-canonical?style=flat-square" alt="Node version" /></a>
</p>

---

## The problem

Every coding-agent CLI persists its sessions in its own on-disk format. Claude Code writes JSONL
with per-block message events and a `stop_reason` on the terminal assistant record. Codex writes a
differently-shaped JSONL with `event_msg` records. OpenCode, Kilo Code, and Goose each store
sessions in SQLite, with three different table layouts. Cursor, Gemini, Qwen, Cline, GitHub Copilot
CLI, Pi, Factory Droid, and Mistral Vibe each have their own file or directory conventions again —
some append-only, some rewritten in place, some split across sidecar metadata files.

Any tool that wants to read a session — a memory layer, an automation that watches a CLI's replies,
a dashboard — either vendors one CLI's format knowledge or re-implements it from scratch. Every
copy drifts independently as each CLI ships new versions.

## The solution

agent-canonical is the one package that owns this knowledge, so no consumer vendors or
re-implements it and copies cannot drift:

- **Canonical schemas** (`agent-canonical/schemas`) — a `Session` (one running or completed CLI
  instance) wrapping a `Transcript` (its messages, tool calls, and token usage), as Zod schemas
  with inferred TypeScript types.
- **Dialect descriptors** (`agent-canonical/dialects`) — a pure-data record per CLI: where its
  transcript store lives, how turn-end is signaled, what its capabilities are. Zero runtime
  dependencies.
- **Parsers** (`agent-canonical/parsers/<cli>`), one per CLI, each layered as a pure event decoder
  plus a pure session reducer behind a thin `parseSessionFile` (or, for the SQLite dialects,
  `parseSessionFromDb`/`listSessionIds` over a structural DB handle — no native SQLite import in
  this package). Every fallible call returns `ParseResult<T>` — `{success, data, issues}` — never
  `null`, never throw-by-default. A malformed line degrades to a recorded warning and the parse
  continues.
- **Incremental turn events** — four dialects also export `snapshotCursor`/`readEventsSince`, which
  decode only the turn-scoped events (`user`, `assistant`, `thinking`, `tool-call`, `turn-end`, …)
  appended since a cursor, without re-parsing the whole store. This is the seam a live consumer —
  reply capture, turn-end detection — runs as a predicate over, instead of re-implementing per-CLI
  format knowledge itself.

## Install

```bash
npm install agent-canonical
```

`zod` is a peer dependency (`^4.4.3`). The package ships compiled ESM with type declarations, one
entry per subpath export — there is no default export.

## Quick start

Parse a session file into the canonical shape:

```ts
import { writeFile } from "node:fs/promises";
import { parseSessionFile } from "agent-canonical/parsers/claude-code";

// Any Claude Code transcript is one JSON object per line.
await writeFile(
  "session.jsonl",
  [
    JSON.stringify({
      type: "user",
      sessionId: "demo-1",
      uuid: "u1",
      message: { role: "user", content: "list the repo root" },
      timestamp: "2026-04-01T10:00:01.000Z",
    }),
    JSON.stringify({
      type: "assistant",
      sessionId: "demo-1",
      uuid: "a1",
      parentUuid: "u1",
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Reading the repo root." }],
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: "end_turn",
      },
      timestamp: "2026-04-01T10:00:05.000Z",
    }),
  ].join("\n"),
);

const result = await parseSessionFile("session.jsonl");
if (result.success) {
  console.log(result.data.cli);                       // "claude-code"
  console.log(result.data.transcript.messages.length); // 2
} else {
  console.error(result.issues);
}
```

Read only what a CLI appended since the last check, as canonical turn events:

```ts
import { appendFile } from "node:fs/promises";
import {
  snapshotCursor,
  readEventsSince,
} from "agent-canonical/parsers/claude-code";

// Snapshot the cursor right before dispatching a prompt, so the next read
// sees only what the CLI appends for this turn.
const cursor = await snapshotCursor("session.jsonl");

await appendFile(
  "session.jsonl",
  `${JSON.stringify({
    type: "assistant",
    sessionId: "demo-1",
    uuid: "a2",
    parentUuid: "u1",
    message: {
      role: "assistant",
      model: "claude-sonnet-4",
      content: [{ type: "text", text: "Three entries at root." }],
      stop_reason: "end_turn",
    },
    timestamp: "2026-04-01T10:00:10.000Z",
  })}\n`,
);

const read = await readEventsSince("session.jsonl", cursor);
if (read.success) {
  for (const event of read.data.events) {
    console.log(event.kind); // "assistant", then "turn-end"
  }
}
```

## Supported CLIs

| CLI | Store | Full parse | Incremental | Turn-end signal |
| --- | --- | --- | --- | --- |
| Claude Code | JSONL | yes | yes | explicit — `stop_reason` ∈ `{end_turn, stop_sequence, max_tokens}` |
| Codex CLI | JSONL | yes | yes | explicit — `event_msg` `task_complete` / `turn_aborted` |
| OpenCode | SQLite | yes | yes | explicit — non-`tool-calls` `finish`, or `MessageAbortedError` |
| Cursor CLI (`cursor-agent`) | JSONL | yes | yes | explicit — `{"type":"turn_ended",…}` record, with a derived fallback for turns torn down before it flushes |
| Gemini CLI | JSONL | yes | no | unavailable — no reliable live terminal fact |
| Qwen Code | JSONL | yes | no | unavailable — no reliable live terminal fact |
| Kilo Code | SQLite | yes | no | explicit — shares OpenCode's `finish` signal (Kilo is an OpenCode-compatible fork) |
| Goose | SQLite | yes | no | derived — final assistant text row with no pending tool request |
| Cline | JSON (2 files) | yes | no | derived — terminal assistant message carries `modelInfo` + metrics |
| GitHub Copilot CLI | JSONL | yes | no | explicit — `assistant.turn_end` bracket + `session.shutdown` |
| Pi | JSONL | yes | no | explicit — per-message `stopReason` |
| Factory Droid | JSONL + JSON | yes | no | explicit — per-turn `agent_turn_outcome` |
| Mistral Vibe | JSONL (in a per-session directory) | yes | no | derived — assistant record with content and no tool calls |

"Full parse" reads a complete store into one canonical `Session`. "Incremental" is the
`snapshotCursor`/`readEventsSince` pair; a CLI without it is full-store-only today — either its
turn-end fact isn't reliable enough to act on live (Gemini, Qwen), or nothing has needed the live
path from it yet. Kilo and Goose take a structural DB handle rather than importing a native SQLite
driver, so no subpath in this package resolves a native module.

## Subpath exports

| Subpath | Exports |
| --- | --- |
| `agent-canonical/schemas` | `Session`, `Transcript`, `Message`, `ToolCall`, `Settings`, `Artifact` — Zod schemas and inferred types. No dependency besides the `zod` peer. |
| `agent-canonical/dialects` | `DIALECTS`, `getDialect(id)` — the pure-data descriptor per CLI (store location, turn-end signal, capabilities, validated-baseline provenance). Zero dependencies. |
| `agent-canonical/materializers` | Bounded Codex rollout-family discovery: from one root rollout, finds every linked child session (by `parentSessionId`) up to a byte/day/count budget, and returns a deterministic verbatim source plan. |
| `agent-canonical/parsers` | Shared vocabulary: `ParseResult<T>`, `IssueCollector`, and the `TurnEvent`/cursor types every `<cli>` entry uses. |
| `agent-canonical/parsers/<cli>` | One entry per CLI in the table above — `parseSessionFile` (or `parseSessionFromDb` + `listSessionIds`), plus `snapshotCursor`/`readEventsSince` where incremental reads are supported. `<cli>` is one of `claude-code`, `codex`, `opencode`, `cursor`, `gemini`, `qwen`, `kilo`, `goose`, `cline`, `copilot`, `pi`, `droid`, `vibe`. |

## Who uses it

[Agentmine](https://github.com/baranovxyz/agentmine) ingests session transcripts through these same
parsers to build a queryable local SQLite corpus across every supported CLI. AgentSync's own
automation for driving and observing coding-agent CLI sessions consumes the incremental turn-event
stream for reply capture and turn-end detection. Both projects read one shared source of
transcript-format truth instead of maintaining their own per-CLI readers.

## Versioning and compatibility

This package is pre-1.0: a minor version bump may still change parser output or add a breaking
schema field as a CLI's on-disk format is better understood. Pin an exact version rather than a
range, and read `CHANGELOG.md` before upgrading — it calls out every release that changes decoded
output. Each dialect descriptor also records the CLI version(s) and on-disk store version its parser
has been checked against (`validatedAgainst`), separate from the package's own semver: parsers stay
permissive and version-agnostic, so an unrecognized store version degrades to warnings rather than a
hard failure.

Requires Node.js >=18 and `zod` `^4.4.3` as a peer dependency.

## Links

- [npm package](https://www.npmjs.com/package/agent-canonical)
- [GitHub repository](https://github.com/baranovxyz/agent-canonical)
- [Agentmine](https://github.com/baranovxyz/agentmine) — the local session corpus built on these parsers
- [AgentSync](https://github.com/baranovxyz/agentsync) — the config-sync CLI this package's sibling project ships alongside
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
