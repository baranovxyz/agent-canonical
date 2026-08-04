import type { DialectDescriptor } from "./types.js";

/**
 * pi: Pi's append-only per-session JSONL log
 * (`@earendil-works/pi-coding-agent`, binary `pi`).
 *
 * Each session is one file at
 * `~/.pi/agent/sessions/<cwd-slug>/<ISO-timestamp>_<uuidv7>.jsonl` — note the
 * extra cwd-slug directory level between the store root and the file.
 * `--continue` appends to the same file, so one file is the session's whole
 * history. Line 1 is the header `{type:"session", version, id, timestamp, cwd}`
 * (no title, model, or git branch); every later line is an entry
 * `{type, id:<8-hex>, parentId:<8-hex|null>, timestamp:<ISO>}` plus per-type
 * fields: `message`, `model_change`, `thinking_level_change`, `session_info`
 * (the only title source), `compaction`, `branch_summary`, `label`, `custom`,
 * `custom_message`.
 *
 * A `message` entry nests an AgentMessage under `.message` whose role is
 * `user` | `assistant` | `toolResult` | `bashExecution` (plus documented
 * `custom` / `branchSummary` / `compactionSummary`). Assistant content blocks
 * are `{type:"thinking"|"text"|"toolCall"}`, with `arguments` already an object.
 * Tool results are separate entries correlated by `toolCallId`, so tool
 * correlation is cross-record. `bashExecution` records the TUI's `!cmd` shell
 * escape (`command`/`output`/`exitCode`/`cancelled`/`truncated`), which the user
 * ran rather than the model.
 *
 * Entries form a DAG: a second child of the same `parentId` is an in-place
 * branch and nothing is rewritten, so an abandoned branch stays in the file
 * alongside the active path.
 *
 * Turn end is explicit per assistant message: `stopReason ∈ stop | length |
 * toolUse | error | aborted`. An errored turn is persisted as an assistant
 * message with `stopReason:"error"`, empty content, an `errorMessage`, and
 * zeroed usage. `aborted` is documented upstream but was not observed in the
 * validated capture, so no abort marker is advertised.
 *
 * Usage is per assistant message
 * (`{input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost}`) with
 * no session-level aggregate, so totals are summed. The provider is
 * per-message too; OpenRouter is built in via `OPENROUTER_API_KEY`.
 *
 * Config lives at `~/.pi`.
 */
export const pi: DialectDescriptor = {
  id: "pi",
  displayName: "Pi",
  binary: "pi",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.pi/agent/sessions",
    pathPattern: "<cwd-slug>/<ISO-timestamp>_<sessionId>.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "explicit",
    description:
      'each assistant message carries stopReason (stop | length | toolUse | error | aborted); an errored turn persists stopReason:"error" with an errorMessage and zeroed usage',
  },
  configPaths: {
    globalDir: "~/.pi",
  },
  capabilities: {
    incrementalRead: false,
    explicitTurnEnd: true,
    abortSignalOnDisk: false,
    questionAwaitingOnDisk: false,
    permissionAwaitingOnDisk: false,
    perMessageUsage: true,
  },
  validatedAgainst: {
    cliVersions: ["0.83.0"],
    storeSchemaVersion: "3",
  },
};
