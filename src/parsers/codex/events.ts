/**
 * Codex JSONL line decoder: Zod schemas + typed event discriminated union.
 *
 * Each line in a codex rollout file is `{ timestamp?, type, payload }`.
 * This module parses one raw JSON string into a typed DecodedEvent — the
 * only place in the codex parser that knows the wire format.
 *
 * Exported separately so a future incremental / tail reader can reuse the
 * decoder without importing the full IO shell.
 */

import { z } from "zod";
import type { IssueCollector } from "../types.js";

// ---------------------------------------------------------------------------
// Permissive wire schemas: only fields the reducer consumes are modeled, and
// all fields except discriminants are optional.
// ---------------------------------------------------------------------------

const ContentPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const MessagePayloadSchema = z.object({
  type: z.literal("message"),
  role: z.string().optional(),
  content: z.array(ContentPartSchema).optional(),
});

const FunctionCallPayloadSchema = z.object({
  type: z.literal("function_call"),
  name: z.string().optional(),
  arguments: z.string().optional(),
  call_id: z.string().optional(),
});

const FunctionCallOutputPayloadSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string().optional(),
  output: z.union([z.string(), z.array(ContentPartSchema)]).optional(),
});

const CustomToolCallPayloadSchema = z.object({
  type: z.literal("custom_tool_call"),
  name: z.string().optional(),
  input: z.string().optional(),
  call_id: z.string().optional(),
  status: z.string().optional(),
});

const CustomToolCallOutputPayloadSchema = z.object({
  type: z.literal("custom_tool_call_output"),
  call_id: z.string().optional(),
  output: z.union([z.string(), z.array(ContentPartSchema)]).optional(),
});

const WebSearchCallPayloadSchema = z.object({
  type: z.literal("web_search_call"),
  status: z.string().optional(),
  action: z
    .object({
      type: z.string().optional(),
      query: z.string().optional(),
      queries: z.array(z.string()).optional(),
    })
    .optional(),
});

const ReasoningPartSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const ReasoningPayloadSchema = z.object({
  type: z.literal("reasoning"),
  reasoning_text: z.string().optional(),
  summary: z.array(ReasoningPartSchema).optional(),
});

const SessionMetaPayloadSchema = z.object({
  id: z.string().optional(),
  cwd: z.string().optional(),
  cli_version: z.string().optional(),
  originator: z.string().optional(),
});

const TurnContextPayloadSchema = z.object({
  model: z.string().optional(),
});

const EventMsgTokenCountPayloadSchema = z.object({
  type: z.literal("token_count"),
  info: z
    .object({
      total_token_usage: z
        .object({
          input_tokens: z.number().optional(),
          output_tokens: z.number().optional(),
          cached_input_tokens: z.number().optional(),
          reasoning_output_tokens: z.number().optional(),
        })
        .optional(),
    })
    .nullable()
    .optional(),
});

const EventMsgExecCommandEndPayloadSchema = z.object({
  type: z.literal("exec_command_end"),
  call_id: z.string().optional(),
  exit_code: z.number().optional(),
});

const _EventMsgTurnAbortedPayloadSchema = z.object({
  type: z.literal("turn_aborted"),
});

/** Raw top-level line schema — loose typing so malformed lines warn+skip. */
const RawLineSchema = z.object({
  timestamp: z.string().optional(),
  type: z.string().optional(),
  payload: z.unknown().optional(),
});

// ---------------------------------------------------------------------------
// Typed decoded events — what the reducer sees
// ---------------------------------------------------------------------------

export type DecodedSessionMeta = {
  kind: "session_meta";
  ts: number | undefined;
  id: string | undefined;
  cwd: string | undefined;
  originator: string | undefined;
};

export type DecodedTurnContext = {
  kind: "turn_context";
  ts: number | undefined;
  model: string | undefined;
};

export type DecodedEventMsgTokenCount = {
  kind: "event_msg_token_count";
  ts: number | undefined;
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  reasoningOutputTokens: number | undefined;
};

export type DecodedEventMsgExecCommandEnd = {
  kind: "event_msg_exec_command_end";
  ts: number | undefined;
  callId: string;
  exitCode: number;
};

export type DecodedEventMsgTurnAborted = {
  kind: "event_msg_turn_aborted";
  ts: number | undefined;
};

export type DecodedEventMsgTaskComplete = {
  kind: "event_msg_task_complete";
  ts: number | undefined;
};

export type DecodedMessage = {
  kind: "response_message";
  ts: number | undefined;
  role: "user" | "assistant";
  text: string;
};

export type DecodedFunctionCall = {
  kind: "response_function_call";
  ts: number | undefined;
  name: string;
  parsedArgs: unknown;
  callId: string;
};

export type DecodedFunctionCallOutput = {
  kind: "response_function_call_output";
  ts: number | undefined;
  callId: string;
  text: string;
};

export type DecodedCustomToolCall = {
  kind: "response_custom_tool_call";
  ts: number | undefined;
  name: string;
  input: string;
  callId: string;
};

export type DecodedCustomToolCallOutput = {
  kind: "response_custom_tool_call_output";
  ts: number | undefined;
  callId: string;
  text: string;
  exitCode: number | undefined;
  durationMs: number | undefined;
};

export type DecodedWebSearchCall = {
  kind: "response_web_search_call";
  ts: number | undefined;
  queries: string[];
  completed: boolean;
};

export type DecodedReasoning = {
  kind: "response_reasoning";
  ts: number | undefined;
  /** Extracted reasoning text, already stripped of markdown prefix. Empty = caller skips. */
  text: string;
};

/** Caller skips this event; seq still captured for rawEvents. */
export type DecodedSkip = { kind: "skip"; ts: number | undefined };

export type DecodedEvent =
  | DecodedSessionMeta
  | DecodedTurnContext
  | DecodedEventMsgTokenCount
  | DecodedEventMsgExecCommandEnd
  | DecodedEventMsgTurnAborted
  | DecodedEventMsgTaskComplete
  | DecodedMessage
  | DecodedFunctionCall
  | DecodedFunctionCallOutput
  | DecodedCustomToolCall
  | DecodedCustomToolCallOutput
  | DecodedWebSearchCall
  | DecodedReasoning
  | DecodedSkip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/**
 * Flatten a tool output that can be a plain string or an array of
 * `{text:"..."}` parts (multimodal). Returns "" for missing/unknown.
 */
function flattenOutput(
  raw: string | Array<z.infer<typeof ContentPartSchema>> | undefined,
): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * custom_tool_call_output carries a JSON string payload. Parse it; fall back
 * gracefully to treating the whole string as the output text.
 */
function parseCustomToolOutput(raw: string): {
  text: string;
  exitCode: number | undefined;
  durationMs: number | undefined;
} {
  try {
    const parsed: unknown = JSON.parse(raw);
    const CustomOutputSchema = z.object({
      output: z.string().optional(),
      metadata: z
        .object({
          exit_code: z.number().optional(),
          duration_seconds: z.number().optional(),
        })
        .optional(),
    });
    const r = CustomOutputSchema.safeParse(parsed);
    if (!r.success)
      return { text: raw, exitCode: undefined, durationMs: undefined };
    const exit = r.data.metadata?.exit_code;
    const durationSeconds = r.data.metadata?.duration_seconds;
    return {
      text: typeof r.data.output === "string" ? r.data.output : raw,
      exitCode: typeof exit === "number" ? exit : undefined,
      durationMs:
        typeof durationSeconds === "number" && Number.isFinite(durationSeconds)
          ? Math.round(durationSeconds * 1000)
          : undefined,
    };
  } catch {
    return { text: raw, exitCode: undefined, durationMs: undefined };
  }
}

// ---------------------------------------------------------------------------
// Main decoder
// ---------------------------------------------------------------------------

/**
 * Decode one raw JSONL line into a typed DecodedEvent.
 *
 * - Malformed JSON → warn + return skip
 * - Unknown top-level type → skip (no warn; new Codex versions may add types)
 * - Known type with missing required fields → warn + return skip
 */
export function decodeLine(
  rawLine: string,
  seq: number,
  collector: IssueCollector,
): DecodedEvent {
  let obj: unknown;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    collector.warn(`line ${seq}: invalid JSON — skipped`, { seq });
    return { kind: "skip", ts: undefined };
  }

  const lineResult = RawLineSchema.safeParse(obj);
  if (!lineResult.success) {
    collector.warn(`line ${seq}: unexpected line shape — skipped`, { seq });
    return { kind: "skip", ts: undefined };
  }

  const line = lineResult.data;
  const ts = parseTs(line.timestamp);

  switch (line.type) {
    case "session_meta": {
      const r = SessionMetaPayloadSchema.safeParse(line.payload);
      if (!r.success) {
        collector.warn(
          `line ${seq}: malformed session_meta payload — skipped`,
          { seq },
        );
        return { kind: "skip", ts };
      }
      return {
        kind: "session_meta",
        ts,
        id: r.data.id,
        cwd: r.data.cwd,
        originator: r.data.originator,
      };
    }

    case "turn_context": {
      const r = TurnContextPayloadSchema.safeParse(line.payload);
      if (!r.success) return { kind: "skip", ts };
      return { kind: "turn_context", ts, model: r.data.model };
    }

    case "event_msg": {
      // event_msg has multiple sub-types; parse leniently
      const typeResult = z
        .object({ type: z.string().optional() })
        .safeParse(line.payload);
      const subType = typeResult.success ? typeResult.data.type : undefined;

      if (subType === "token_count") {
        const r = EventMsgTokenCountPayloadSchema.safeParse(line.payload);
        if (!r.success) return { kind: "skip", ts };
        const usage = r.data.info?.total_token_usage;
        return {
          kind: "event_msg_token_count",
          ts,
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          cachedInputTokens: usage?.cached_input_tokens,
          reasoningOutputTokens: usage?.reasoning_output_tokens,
        };
      }

      if (subType === "exec_command_end") {
        const r = EventMsgExecCommandEndPayloadSchema.safeParse(line.payload);
        if (
          !r.success ||
          typeof r.data.call_id !== "string" ||
          typeof r.data.exit_code !== "number"
        ) {
          return { kind: "skip", ts };
        }
        return {
          kind: "event_msg_exec_command_end",
          ts,
          callId: r.data.call_id,
          exitCode: r.data.exit_code,
        };
      }

      if (subType === "turn_aborted") {
        return { kind: "event_msg_turn_aborted", ts };
      }

      if (subType === "task_complete") {
        return { kind: "event_msg_task_complete", ts };
      }

      return { kind: "skip", ts };
    }

    case "compacted":
      return { kind: "skip", ts };

    case "response_item": {
      const payloadTypeResult = z
        .object({ type: z.string().optional() })
        .safeParse(line.payload);
      if (!payloadTypeResult.success) {
        return { kind: "skip", ts };
      }

      switch (payloadTypeResult.data.type) {
        case "message": {
          const r = MessagePayloadSchema.safeParse(line.payload);
          if (!r.success) {
            collector.warn(`line ${seq}: malformed message payload — skipped`, {
              seq,
            });
            return { kind: "skip", ts };
          }
          const role = r.data.role;
          if (role !== "user" && role !== "assistant") {
            // developer / system messages intentionally dropped
            return { kind: "skip", ts };
          }
          const text = (r.data.content ?? [])
            .map((p) => (typeof p.text === "string" ? p.text : ""))
            .filter(Boolean)
            .join("\n\n");
          if (!text) return { kind: "skip", ts };
          return { kind: "response_message", ts, role, text };
        }

        case "function_call": {
          const r = FunctionCallPayloadSchema.safeParse(line.payload);
          if (!r.success || !r.data.call_id || !r.data.name) {
            collector.warn(`line ${seq}: malformed function_call — skipped`, {
              seq,
            });
            return { kind: "skip", ts };
          }
          let parsedArgs: unknown = r.data.arguments;
          if (typeof r.data.arguments === "string") {
            try {
              parsedArgs = JSON.parse(r.data.arguments);
            } catch {
              // Leave non-JSON arguments as their original string value.
            }
          }
          return {
            kind: "response_function_call",
            ts,
            name: r.data.name,
            parsedArgs,
            callId: r.data.call_id,
          };
        }

        case "function_call_output": {
          const r = FunctionCallOutputPayloadSchema.safeParse(line.payload);
          if (!r.success || !r.data.call_id) {
            collector.warn(
              `line ${seq}: malformed function_call_output — skipped`,
              { seq },
            );
            return { kind: "skip", ts };
          }
          return {
            kind: "response_function_call_output",
            ts,
            callId: r.data.call_id,
            text: flattenOutput(r.data.output),
          };
        }

        case "custom_tool_call": {
          const r = CustomToolCallPayloadSchema.safeParse(line.payload);
          if (!r.success || !r.data.call_id || !r.data.name) {
            collector.warn(
              `line ${seq}: malformed custom_tool_call — skipped`,
              { seq },
            );
            return { kind: "skip", ts };
          }
          return {
            kind: "response_custom_tool_call",
            ts,
            name: r.data.name,
            input: r.data.input ?? "",
            callId: r.data.call_id,
          };
        }

        case "custom_tool_call_output": {
          const r = CustomToolCallOutputPayloadSchema.safeParse(line.payload);
          if (!r.success || !r.data.call_id) {
            collector.warn(
              `line ${seq}: malformed custom_tool_call_output — skipped`,
              { seq },
            );
            return { kind: "skip", ts };
          }
          const { text, exitCode, durationMs } = parseCustomToolOutput(
            flattenOutput(r.data.output),
          );
          return {
            kind: "response_custom_tool_call_output",
            ts,
            callId: r.data.call_id,
            text,
            exitCode,
            durationMs,
          };
        }

        case "web_search_call": {
          const r = WebSearchCallPayloadSchema.safeParse(line.payload);
          if (!r.success) return { kind: "skip", ts };
          const queries =
            r.data.action?.queries ??
            (r.data.action?.query ? [r.data.action.query] : []);
          return {
            kind: "response_web_search_call",
            ts,
            queries,
            completed: r.data.status === "completed",
          };
        }

        case "reasoning": {
          const r = ReasoningPayloadSchema.safeParse(line.payload);
          if (!r.success) return { kind: "skip", ts };
          // Prefer reasoning_text, then fall back to summary entries.
          let text = (r.data.reasoning_text ?? "").trim();
          if (!text && Array.isArray(r.data.summary)) {
            text = r.data.summary
              .map((s) => (typeof s.text === "string" ? s.text : ""))
              .filter(Boolean)
              .join("\n\n")
              .trim();
          }
          // Empty reasoning (empty summary[]) → skip; emits nothing (both families agree)
          return { kind: "response_reasoning", ts, text };
        }

        default:
          return { kind: "skip", ts };
      }
    }

    default:
      // Unknown top-level type (e.g. future Codex versions) — silently skip
      return { kind: "skip", ts };
  }
}
