import type { DialectDescriptor } from "./types.js";

/**
 * goose: Goose's global SQLite session store (Rust; AAIF/Linux Foundation).
 *
 * A single `sessions.db` (WAL, schema v15 as of Goose 1.43.0) holds every
 * session. One `messages` row per turn carries a `content_json` column — a
 * serde-serialized `Vec<MessageContent>` (`{type,…}`-tagged, camelCase union of
 * text / thinking / toolRequest / toolResponse / image / …). Tool calls are
 * cross-row: a `toolRequest` block lands in a `role:"assistant"` row and its
 * `toolResponse` in a later `role:"user"` row, paired by the tool `callId`.
 *
 * Per-message token usage lives in `metadata_json.usage`
 * ({inputTokens, outputTokens, cacheReadTokens, cost, costSource}) on assistant
 * rows — NOT in the `messages.tokens` column, which Goose leaves null. A
 * sibling `usage_ledger` table carries the same per-LLM-call cost attribution.
 *
 * Turn-end is derived: Goose persists no per-turn terminal token, so a turn
 * ends structurally at the final assistant text row with no pending tool
 * request. The store carries no abort marker.
 *
 * Goose 1.43 resolves its data directory through `Paths::data_dir()`: current
 * Unix/macOS installs use the XDG data directory (normally
 * `~/.local/share/goose`), Windows uses
 * `%APPDATA%\Block\goose\data`, and `GOOSE_PATH_ROOT` overrides all of
 * those with `<GOOSE_PATH_ROOT>/data`. Older macOS installations may retain
 * `~/Library/Application Support/Block/goose/data` for compatibility. The DB
 * is always `sessions/sessions.db` below that data directory (WAL — read on
 * the CLI host for a consistent view). Config is resolved by the matching
 * Goose path helper rather than from the transcript-store descriptor.
 */
export const goose: DialectDescriptor = {
  id: "goose",
  displayName: "Goose",
  binary: "goose",
  transcriptStore: {
    kind: "sqlite",
    root: "<Goose data dir>/sessions",
    pathPattern: "sessions.db",
    watermarkAxis: "row-time-created",
  },
  turnEnd: {
    kind: "derived",
    description:
      "final assistant text row with no pending toolRequest; Goose persists no per-turn terminal token",
  },
  configPaths: {
    globalDir: "~/.config/goose",
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
    cliVersions: ["1.43.0"],
    storeSchemaVersion: "15",
  },
};
