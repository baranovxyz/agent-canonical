/**
 * Wire schemas + decoders for GitHub Copilot CLI's per-session event stream.
 *
 * All Copilot format knowledge lives here. The file shell (index.ts) reads the
 * session dir's `events.jsonl`, hands each parsed line over, and this module
 * decodes it into a typed `CopilotEvent`; the reducer (reduce.ts) folds those
 * events into a canonical Session. Decoding is pure (no IO), so it belongs with
 * the decoders.
 *
 * GitHub Copilot CLI (`@github/copilot`, binary `copilot`) writes each session
 * as a directory `~/.copilot/session-state/<uuid>/` whose `events.jsonl` is the
 * lossless source of truth. Every line is an envelope
 * `{ type, data, id, timestamp, parentId }` — a typed event, `parentId`-chained
 * in emission order. The sibling `session.db` holds only transient todos/inbox
 * and `~/.copilot/session-store.db` is a derived FTS index, so neither is read.
 *
 * The event vocabulary this decoder consumes:
 *   - `session.start`    — sessionId, copilotVersion, store `version`, startTime,
 *     and `context` (cwd / gitRoot / branch).
 *   - `session.model_change` — the active model id.
 *   - `user.message`     — the user's prompt (`content`; `transformedContent`
 *     carries injected reminders and is ignored).
 *   - `assistant.message`— assistant `content`, optional `reasoningText`
 *     (present only for reasoning models), `toolRequests[]`
 *     (`{toolCallId,name,arguments}` — the tool calls this message issued), the
 *     `model`, and per-message `outputTokens`.
 *   - `tool.execution_complete` — a tool call's result (`{content,detailedContent}`)
 *     and `success`, correlated to its request by `toolCallId`.
 *   - `session.shutdown` — per-model `modelMetrics.usage` aggregate (the only
 *     source of session input/cache/reasoning totals; per-message usage is
 *     output-only).
 *
 * `tool.execution_start` restates the request's name + args, so it is preserved
 * losslessly in `rawEvents` but not consumed here; `system.message`,
 * `assistant.turn_start`, and `assistant.turn_end` are likewise inert for the
 * canonical build.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Decoded records — the reducer's input vocabulary
// ---------------------------------------------------------------------------

/** One tool call requested by an assistant message (`toolRequests[]`). */
export interface CopilotToolRequest {
  callId: string;
  name: string;
  args: unknown;
}

/** A tool call's result, from a `tool.execution_complete` event. */
export interface CopilotToolResult {
  callId: string;
  output: string;
  success: boolean;
}

/** Summed per-model usage lifted from `session.shutdown.modelMetrics`. */
export interface CopilotUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/** One decoded event line, in emission order. */
export type CopilotEvent =
  | {
      kind: "sessionStart";
      sessionId?: string;
      copilotVersion?: string;
      storeVersion?: number;
      startedAtMs?: number;
      cwd?: string;
      gitRoot?: string;
      branch?: string;
    }
  | { kind: "modelChange"; model: string }
  | { kind: "userMessage"; text: string; tsMs?: number }
  | {
      kind: "assistantMessage";
      text: string;
      reasoningText?: string;
      model?: string;
      outputTokens?: number;
      toolRequests: CopilotToolRequest[];
      tsMs?: number;
    }
  | { kind: "toolComplete"; result: CopilotToolResult }
  | {
      kind: "shutdown";
      totals: CopilotUsageTotals;
      shutdownType?: string;
      tsMs?: number;
    }
  | { kind: "other"; type: string };

// ---------------------------------------------------------------------------
// Wire schemas — declare only what we read; passthrough the unstable rest
// ---------------------------------------------------------------------------

/** The line envelope every event shares. */
const EnvelopeSchema = z
  .object({
    type: z.string(),
    data: z.unknown(),
    id: z.string().optional(),
    timestamp: z.string().optional(),
    parentId: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const ContextSchema = z
  .object({
    cwd: z.string().optional(),
    gitRoot: z.string().optional(),
    branch: z.string().optional(),
  })
  .passthrough();

const SessionStartDataSchema = z
  .object({
    sessionId: z.string().optional(),
    copilotVersion: z.string().optional(),
    version: z.number().optional(),
    startTime: z.string().optional(),
    context: ContextSchema.optional(),
  })
  .passthrough();

const ModelChangeDataSchema = z
  .object({ newModel: z.string().optional() })
  .passthrough();

const UserMessageDataSchema = z
  .object({ content: z.string().optional() })
  .passthrough();

const ToolRequestSchema = z
  .object({
    toolCallId: z.string().optional(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
  })
  .passthrough();

const AssistantMessageDataSchema = z
  .object({
    content: z.string().optional(),
    reasoningText: z.string().optional(),
    model: z.string().optional(),
    outputTokens: z.number().optional(),
    toolRequests: z.array(z.unknown()).optional(),
  })
  .passthrough();

const ToolResultSchema = z
  .object({
    content: z.unknown().optional(),
    detailedContent: z.unknown().optional(),
  })
  .passthrough();

const ToolCompleteDataSchema = z
  .object({
    toolCallId: z.string().optional(),
    success: z.boolean().optional(),
    result: z.union([ToolResultSchema, z.string(), z.null()]).optional(),
  })
  .passthrough();

const UsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
  })
  .passthrough();

const ModelMetricsEntrySchema = z
  .object({ usage: UsageSchema.optional() })
  .passthrough();

const ShutdownDataSchema = z
  .object({
    shutdownType: z.string().optional(),
    modelMetrics: z.record(z.string(), ModelMetricsEntrySchema).optional(),
  })
  .passthrough();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse an ISO timestamp to epoch ms, or undefined when malformed/absent. */
function decodeIsoMs(iso: string | null | undefined): number | undefined {
  if (typeof iso !== "string" || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

// ---------------------------------------------------------------------------
// Tool-result content normalization
// ---------------------------------------------------------------------------

/** Normalize a `tool.execution_complete` result payload to text. */
function normalizeToolOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (isRecord(result)) {
    // Prefer the fuller `detailedContent`; fall back to `content`.
    for (const key of ["detailedContent", "content"] as const) {
      const v = result[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v))
        return v
          .map((item) =>
            typeof item === "string"
              ? item
              : isRecord(item) && typeof item.text === "string"
                ? item.text
                : JSON.stringify(item),
          )
          .join("\n");
    }
  }
  return result == null ? "" : String(result);
}

/** Decode one tool request from an assistant message's `toolRequests[]`. */
function decodeToolRequest(raw: unknown): CopilotToolRequest | null {
  const parsed = ToolRequestSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  return {
    callId: typeof row.toolCallId === "string" ? row.toolCallId : "",
    name: typeof row.name === "string" ? row.name : "",
    args: row.arguments ?? {},
  };
}

// ---------------------------------------------------------------------------
// Event decoder
// ---------------------------------------------------------------------------

/**
 * Decode one raw event line into a typed `CopilotEvent`. Returns null when the
 * envelope shape is unrecognizable (the shell logs a warning and skips it).
 * Unmodeled event types decode to `{kind:"other"}` and are inert in the reducer.
 */
export function decodeEvent(raw: unknown): CopilotEvent | null {
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;
  const { type, data, timestamp } = envelope.data;
  const tsMs = decodeIsoMs(timestamp);

  switch (type) {
    case "session.start": {
      const d = SessionStartDataSchema.safeParse(data);
      if (!d.success) return { kind: "other", type };
      const ev: Extract<CopilotEvent, { kind: "sessionStart" }> = {
        kind: "sessionStart",
      };
      if (d.data.sessionId !== undefined) ev.sessionId = d.data.sessionId;
      if (d.data.copilotVersion !== undefined)
        ev.copilotVersion = d.data.copilotVersion;
      if (typeof d.data.version === "number") ev.storeVersion = d.data.version;
      const startedAtMs = decodeIsoMs(d.data.startTime);
      if (startedAtMs !== undefined) ev.startedAtMs = startedAtMs;
      if (d.data.context?.cwd !== undefined) ev.cwd = d.data.context.cwd;
      if (d.data.context?.gitRoot !== undefined)
        ev.gitRoot = d.data.context.gitRoot;
      if (d.data.context?.branch !== undefined)
        ev.branch = d.data.context.branch;
      return ev;
    }
    case "session.model_change": {
      const d = ModelChangeDataSchema.safeParse(data);
      if (d.success && typeof d.data.newModel === "string")
        return { kind: "modelChange", model: d.data.newModel };
      return { kind: "other", type };
    }
    case "user.message": {
      const d = UserMessageDataSchema.safeParse(data);
      const text =
        d.success && typeof d.data.content === "string" ? d.data.content : "";
      const ev: Extract<CopilotEvent, { kind: "userMessage" }> = {
        kind: "userMessage",
        text,
      };
      if (tsMs !== undefined) ev.tsMs = tsMs;
      return ev;
    }
    case "assistant.message": {
      const d = AssistantMessageDataSchema.safeParse(data);
      if (!d.success) return { kind: "other", type };
      const toolRequests: CopilotToolRequest[] = [];
      for (const rawReq of d.data.toolRequests ?? []) {
        const req = decodeToolRequest(rawReq);
        if (req) toolRequests.push(req);
      }
      const ev: Extract<CopilotEvent, { kind: "assistantMessage" }> = {
        kind: "assistantMessage",
        text: typeof d.data.content === "string" ? d.data.content : "",
        toolRequests,
      };
      if (typeof d.data.reasoningText === "string" && d.data.reasoningText)
        ev.reasoningText = d.data.reasoningText;
      if (typeof d.data.model === "string") ev.model = d.data.model;
      if (typeof d.data.outputTokens === "number")
        ev.outputTokens = d.data.outputTokens;
      if (tsMs !== undefined) ev.tsMs = tsMs;
      return ev;
    }
    case "tool.execution_complete": {
      const d = ToolCompleteDataSchema.safeParse(data);
      if (!d.success || typeof d.data.toolCallId !== "string")
        return { kind: "other", type };
      return {
        kind: "toolComplete",
        result: {
          callId: d.data.toolCallId,
          output: normalizeToolOutput(d.data.result),
          success: d.data.success !== false,
        },
      };
    }
    case "session.shutdown": {
      const d = ShutdownDataSchema.safeParse(data);
      const totals: CopilotUsageTotals = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      };
      if (d.success && d.data.modelMetrics) {
        for (const entry of Object.values(d.data.modelMetrics)) {
          const u = entry.usage;
          if (!u) continue;
          totals.inputTokens += u.inputTokens ?? 0;
          totals.outputTokens += u.outputTokens ?? 0;
          totals.cacheReadTokens += u.cacheReadTokens ?? 0;
          totals.cacheCreationTokens += u.cacheWriteTokens ?? 0;
          totals.reasoningTokens += u.reasoningTokens ?? 0;
        }
      }
      const ev: Extract<CopilotEvent, { kind: "shutdown" }> = {
        kind: "shutdown",
        totals,
      };
      if (d.success && typeof d.data.shutdownType === "string")
        ev.shutdownType = d.data.shutdownType;
      if (tsMs !== undefined) ev.tsMs = tsMs;
      return ev;
    }
    default:
      return { kind: "other", type };
  }
}
