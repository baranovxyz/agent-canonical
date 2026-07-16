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
 * Store path: `~/.local/share/goose/sessions/sessions.db` (Linux and macOS;
 * WAL — read on the CLI host for a consistent view). Config lives at
 * `~/.config/goose/config.yaml`.
 */
export const goose: DialectDescriptor = {
  id: "goose",
  displayName: "Goose",
  binary: "goose",
  transcriptStore: {
    kind: "sqlite",
    root: "~/.local/share/goose/sessions",
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
