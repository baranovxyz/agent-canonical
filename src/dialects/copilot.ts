import type { DialectDescriptor } from "./types.js";

/**
 * copilot: GitHub Copilot CLI's per-session event stream (`@github/copilot`,
 * binary `copilot`).
 *
 * Each session is a directory `~/.copilot/session-state/<uuid>/` whose
 * `events.jsonl` is the lossless source of truth: one typed event per line,
 * envelope `{type, data, id, timestamp, parentId}`, `parentId`-chained in
 * emission order. The event vocabulary — `session.start` (sessionId,
 * copilotVersion, `context`), `session.model_change`, `user.message`,
 * `assistant.message` (content, `toolRequests[]`, optional `reasoningText`,
 * per-message `outputTokens`), `tool.execution_start` / `tool.execution_complete`
 * (result + `success`, paired by `toolCallId`), and `session.shutdown`
 * (per-model `modelMetrics.usage` totals) — is decoded into a canonical Session.
 * A tool call is issued in an `assistant.message` and its output arrives later in
 * a `tool.execution_complete`, so tool correlation is cross-event by
 * `toolCallId`. This is a genuinely new, file-based decoder — an event stream,
 * not cline's message array or the opencode/goose tabular stores.
 *
 * The sibling per-session `session.db` holds only transient todos/inbox, and the
 * top-level `~/.copilot/session-store.db` is a derived FTS index (sessions /
 * turns / assistant-usage), so neither is authoritative; the JSONL is read
 * directly.
 *
 * Turn-end is explicit: every assistant turn is bracketed by
 * `assistant.turn_start` / `assistant.turn_end`, and the session ends with a
 * `session.shutdown` carrying the usage aggregate. Per-message usage is
 * output-only (`outputTokens`); session input/cache/reasoning totals live only
 * in the shutdown event. No abort marker was observed in the store.
 *
 * BYOK note: driven via a custom provider (`COPILOT_PROVIDER_BASE_URL`), the
 * assistant `model` is the provider-prefixed wire model; a GitHub-authenticated
 * session records Copilot's own model id.
 *
 * Config lives at `~/.copilot`.
 */
export const copilot: DialectDescriptor = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
  binary: "copilot",
  transcriptStore: {
    kind: "jsonl",
    root: "~/.copilot/session-state",
    pathPattern: "<sessionId>/events.jsonl",
    watermarkAxis: "byte-offset",
  },
  turnEnd: {
    kind: "explicit",
    description:
      "each assistant turn is bracketed by assistant.turn_start / assistant.turn_end; the session ends with a session.shutdown event carrying the per-model usage aggregate",
  },
  configPaths: {
    globalDir: "~/.copilot",
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
    cliVersions: ["1.0.70"],
    storeSchemaVersion: "1",
  },
};
