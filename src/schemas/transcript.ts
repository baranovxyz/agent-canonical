import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

/**
 * Transcript: the recorded entity — what a CLI wrote to its on-disk session
 * store, normalized. Core tier (always present): messages with tool calls, a
 * stable content hash, and token totals. Lossless tier (rawEvents,
 * messageParts, per-message usage, ToolCall.outputFull): present when the
 * source dialect provides it; snapshot consumers may omit it.
 */

export const ToolCallSchema = z.object({
  name: z.string(),
  args: z.unknown().optional(),
  argsHash: z.string(),
  argsPreview: z.string(),
  outputPreview: z.string().optional(),
  /** Lossless tier: full untruncated tool output. */
  outputFull: z.string().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
  outputSha: z.string().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** ID used by the source to pair tool_use with tool_result (e.g. cc toolUseID). */
  callId: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** Lossless tier: one raw source event, verbatim. */
export const RawEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  eventType: z.string().optional(),
  ts: z.number().int().nonnegative().optional(),
  rawJson: z.string(),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

/**
 * Lossless tier: one source-faithful message part. Parts keep the source
 * CLI's own decomposition (e.g. cc content blocks include `thinking` and
 * `tool_use`); lossy projections such as A2A Parts are handled by consumers.
 */
export const MessagePartSchema = z.object({
  sourceSeq: z.number().int().nonnegative(),
  partIdx: z.number().int().nonnegative(),
  turn: z.number().int().positive().optional(),
  role: z.string(),
  partType: z.string(),
  text: z.string().optional(),
  toolName: z.string().optional(),
  toolCallIdx: z.number().int().nonnegative().optional(),
  payloadJson: z.string(),
  includedInMessageText: z.boolean().default(false),
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

/**
 * Core conversational roles only. Assistant reasoning blocks use the
 * `thinking` role so viewers can fold them independently.
 */
export const RoleSchema = z.enum([
  "user",
  "assistant",
  "thinking",
  "system",
  "subagent",
]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Per-message token usage, same accounting as the transcript-level totals.
 * Every field optional: only assistant messages from dialects with
 * per-message usage (see DialectCapabilities.perMessageUsage) carry it.
 */
export const MessageUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
});
export type MessageUsage = z.infer<typeof MessageUsageSchema>;

export const MessageSchema = z.object({
  turn: z.number().int().positive(),
  role: RoleSchema,
  author: z.string().optional(),
  /** Unix seconds. */
  ts: z.number().int().nonnegative().optional(),
  text: z.string(),
  toolCalls: z.array(ToolCallSchema).default([]),
  /** Lossless tier: per-message token usage where the source exposes it. */
  usage: MessageUsageSchema.optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const TranscriptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  messages: z.array(MessageSchema).default([]),
  /** Stable hash of the normalized content; dedupe/idempotency key. */
  contentHash: z.string(),
  /** Source store this transcript was parsed from (file or DB path). */
  rawPath: z.string().optional(),
  /** Redactions applied to this transcript's text fields (post-parse). */
  redactionCount: z.number().int().nonnegative().optional(),
  /**
   * Cumulative token usage across the transcript. All fields optional —
   * not every dialect emits every breakdown (codex tracks reasoning tokens;
   * Anthropic tracks cache read/creation; opencode emits both).
   */
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheCreationTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  /** Count of turns the user explicitly aborted (esc / cancel / interrupt). */
  abortedTurns: z.number().int().nonnegative().optional(),
  /** Lossless tier: raw source events, verbatim. */
  rawEvents: z.array(RawEventSchema).optional(),
  /** Lossless tier: source-faithful message parts. */
  messageParts: z.array(MessagePartSchema).optional(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
