/**
 * Pure line decoder for the Qwen Code JSONL transcript format.
 *
 * Qwen Code (a Gemini-CLI fork) writes a hybrid format: a Claude-Code-style
 * per-line envelope (`uuid`/`parentUuid`/`type`/`cwd`/`gitBranch`/`timestamp`)
 * wrapping a Gemini-style message body (`message.parts` of
 * `text`/`functionCall`/`functionResponse`, `role: "model"`, `usageMetadata`
 * token counts). This module knows the wire format only — no IO, no session
 * assembly.
 *
 * Record `type`s the reducer cares about:
 *   - "user":        a user turn (`message.parts[].text`)
 *   - "assistant":   model reply — text parts, optional `thought:true` parts,
 *                    and `functionCall` parts (tool calls); `model` +
 *                    `usageMetadata`
 *   - "tool_result": a tool result on its own record, correlated to the
 *                    assistant's `functionCall` by call id
 *                    (`toolCallResult.callId`); output text lives in
 *                    `toolCallResult.resultDisplay` or the `functionResponse`
 *   - "system":      attribution/telemetry snapshots — captured for rawEvents,
 *                    but produce no message
 */

import { z } from "zod";
import type { MessageUsage } from "../../schemas/transcript.js";
import type { IssueCollector } from "../types.js";

// ---------------------------------------------------------------------------
// Wire-format schemas — permissive; only consumed fields modeled, extras
// stripped. All-but-nothing optional so malformed records degrade to skip
// rather than abort.
// ---------------------------------------------------------------------------

const PartSchema = z.object({
  text: z.string().optional(),
  thought: z.boolean().optional(),
  functionCall: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      args: z.unknown().optional(),
    })
    .optional(),
  functionResponse: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
      response: z.unknown().optional(),
    })
    .optional(),
});
type Part = z.infer<typeof PartSchema>;

const MessageSchema = z.object({
  role: z.string().optional(),
  parts: z.array(PartSchema).optional(),
});

const UsageMetadataSchema = z.object({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  thoughtsTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional(),
  cachedContentTokenCount: z.number().optional(),
});

const ToolCallResultSchema = z.object({
  callId: z.string().optional(),
  status: z.string().optional(),
  resultDisplay: z.unknown().optional(),
});

/** Full line schema — only fields the parser reads. Extra fields are stripped. */
const RawLineSchema = z.object({
  type: z.string().optional(),
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  timestamp: z.string().optional(),
  model: z.string().optional(),
  subtype: z.string().optional(),
  message: MessageSchema.optional(),
  usageMetadata: UsageMetadataSchema.nullable().optional(),
  toolCallResult: ToolCallResultSchema.optional(),
});
type RawLine = z.infer<typeof RawLineSchema>;

// ---------------------------------------------------------------------------
// Decoded event vocabulary — what the reducer sees
// ---------------------------------------------------------------------------

/** Envelope metadata every record carries (Qwen has no header line). */
export interface QwenMeta {
  sessionId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
}

/** A tool call decoded off an assistant record's functionCall part. */
export interface DecodedToolCall {
  name: string;
  args: unknown;
  callId: string | undefined;
}

export interface DecodedUser {
  kind: "user";
  seq: number;
  ts: number | undefined;
  meta: QwenMeta;
  text: string;
}

export interface DecodedAssistant {
  kind: "assistant";
  seq: number;
  ts: number | undefined;
  meta: QwenMeta;
  model: string | undefined;
  text: string;
  /** Concatenated `thought:true` part text (assistant reasoning). */
  thoughtText: string;
  toolCalls: DecodedToolCall[];
  usage: MessageUsage | undefined;
}

export interface DecodedToolResult {
  kind: "tool_result";
  seq: number;
  ts: number | undefined;
  meta: QwenMeta;
  callId: string | undefined;
  resultText: string;
  /** From `status`: success→0, error→1, otherwise undefined. */
  exitCode: number | undefined;
}

/** A line we capture for rawEvents but produce no message from. */
export interface DecodedSkip {
  kind: "skip";
  seq: number;
  ts: number | undefined;
  meta: QwenMeta;
  lineType: string | undefined;
}

/** A line that failed JSON.parse or top-level schema validation. */
export interface DecodedMalformed {
  kind: "malformed";
  seq: number;
}

export type DecodedEvent =
  | DecodedUser
  | DecodedAssistant
  | DecodedToolResult
  | DecodedSkip
  | DecodedMalformed;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EMPTY_META: QwenMeta = {
  sessionId: undefined,
  cwd: undefined,
  gitBranch: undefined,
};

/** Semantic record types; everything else (system, …) is captured but skipped. */
const SEMANTIC_TYPES = new Set(["user", "assistant", "tool_result"]);

function parseTs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

function metaOf(obj: RawLine): QwenMeta {
  return { sessionId: obj.sessionId, cwd: obj.cwd, gitBranch: obj.gitBranch };
}

/** Visible text: concatenate `text` parts, skipping `thought:true` parts. */
function flattenText(parts: Part[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text ?? "")
    .join("");
}

/** Assistant reasoning: concatenate `thought:true` part text. */
function flattenThoughts(parts: Part[] | undefined): string {
  if (!parts) return "";
  return parts
    .filter((p) => p.thought === true && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n\n");
}

function decodeToolCalls(parts: Part[] | undefined): DecodedToolCall[] {
  if (!parts) return [];
  const calls: DecodedToolCall[] = [];
  for (const p of parts) {
    const fc = p.functionCall;
    if (!fc) continue;
    calls.push({
      name: typeof fc.name === "string" && fc.name ? fc.name : "tool",
      args: fc.args,
      callId: fc.id,
    });
  }
  return calls;
}

function decodeUsage(
  usage: z.infer<typeof UsageMetadataSchema> | null | undefined,
): MessageUsage | undefined {
  if (!usage) return undefined;
  const out: MessageUsage = {};
  if (typeof usage.promptTokenCount === "number")
    out.inputTokens = usage.promptTokenCount;
  if (typeof usage.candidatesTokenCount === "number")
    out.outputTokens = usage.candidatesTokenCount;
  if (typeof usage.cachedContentTokenCount === "number")
    out.cacheReadTokens = usage.cachedContentTokenCount;
  if (typeof usage.thoughtsTokenCount === "number")
    out.reasoningTokens = usage.thoughtsTokenCount;
  return Object.keys(out).length > 0 ? out : undefined;
}

function statusToExit(status: string | undefined): number | undefined {
  if (status === "success") return 0;
  if (status === "error") return 1;
  return undefined;
}

/**
 * Resolve a tool result's output text. Prefer the structured
 * `functionResponse.response` (`{output}` string or the whole object), which
 * matches the model's own view; fall back to the `resultDisplay` string.
 */
function resolveResultText(
  parts: Part[] | undefined,
  resultDisplay: unknown,
): string {
  if (parts) {
    for (const p of parts) {
      const response = p.functionResponse?.response;
      if (response === undefined) continue;
      if (typeof response === "string") return response;
      if (response !== null && typeof response === "object") {
        const output = (response as Record<string, unknown>).output;
        if (typeof output === "string") return output;
        return JSON.stringify(response);
      }
    }
  }
  if (typeof resultDisplay === "string") return resultDisplay;
  return "";
}

function firstFunctionResponseId(
  parts: Part[] | undefined,
): string | undefined {
  if (!parts) return undefined;
  for (const p of parts) {
    const id = p.functionResponse?.id;
    if (typeof id === "string") return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/** Re-exported for consumers that need to introspect the decoded wire shape. */
export type { Part, RawLine };

/**
 * Decode one raw JSONL line into a `DecodedEvent`. Never throws.
 * Malformed JSON → `DecodedMalformed`. Non-semantic well-formed lines
 * (e.g. `system`) → `DecodedSkip`.
 */
export function decodeLine(
  rawLine: string,
  seq: number,
  issues: IssueCollector,
): DecodedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    issues.warn(`seq ${seq}: JSON parse failed — line skipped`, { seq });
    return { kind: "malformed", seq };
  }

  const result = RawLineSchema.safeParse(parsed);
  if (!result.success) {
    issues.warn(`seq ${seq}: line schema validation failed — line skipped`, {
      seq,
    });
    return {
      kind: "skip",
      seq,
      ts: undefined,
      meta: EMPTY_META,
      lineType: undefined,
    };
  }

  const obj = result.data;
  const ts = parseTs(obj.timestamp);
  const meta = metaOf(obj);
  const lineType = obj.type;

  if (!lineType || !SEMANTIC_TYPES.has(lineType)) {
    return { kind: "skip", seq, ts, meta, lineType };
  }

  if (lineType === "user") {
    const text = flattenText(obj.message?.parts);
    // A user record with no visible text (e.g. an empty envelope) carries no
    // message; keep it in rawEvents but skip it as a turn.
    if (text === "") return { kind: "skip", seq, ts, meta, lineType };
    return { kind: "user", seq, ts, meta, text };
  }

  if (lineType === "assistant") {
    return {
      kind: "assistant",
      seq,
      ts,
      meta,
      model: obj.model,
      text: flattenText(obj.message?.parts),
      thoughtText: flattenThoughts(obj.message?.parts),
      toolCalls: decodeToolCalls(obj.message?.parts),
      usage: decodeUsage(obj.usageMetadata),
    };
  }

  // lineType === "tool_result"
  const callId =
    obj.toolCallResult?.callId ?? firstFunctionResponseId(obj.message?.parts);
  return {
    kind: "tool_result",
    seq,
    ts,
    meta,
    callId,
    resultText: resolveResultText(
      obj.message?.parts,
      obj.toolCallResult?.resultDisplay,
    ),
    exitCode: statusToExit(obj.toolCallResult?.status),
  };
}
