/**
 * Gemini CLI JSONL line decoder: Zod wire schemas + typed event union.
 *
 * A Gemini session file is JSONL. The first line is a ConversationRecord
 * metadata header (`sessionId`, `projectHash`, `startTime`, `directories`,
 * `kind`, optionally an embedded legacy `messages[]`). Subsequent lines are
 * one of:
 *   - a MessageRecord (`type` in user|gemini|info|error|warning),
 *   - a `{ "$set": {...} }` metadata-update record, or
 *   - a `{ "$rewindTo": "<message-id>" }` edit-history record.
 *
 * This module is the only place that knows the wire format; the reducer sees
 * pre-normalized DecodedEvents. Exported separately so a decoder can be reused
 * without the IO shell.
 */

import { z } from "zod";
import type { MessageUsage, Role } from "../../schemas/transcript.js";
import type { IssueCollector } from "../types.js";

// ---------------------------------------------------------------------------
// Permissive wire schemas — only fields the reducer consumes are modeled; all
// but discriminants are optional so malformed records warn+skip rather than
// abort. Unknown keys are ignored (zod strips them by default).
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

/** PartListUnion: a plain string, a single Part, or an array of Parts. */
const PartListUnionSchema = z.union([
  z.string(),
  z.array(PartSchema),
  PartSchema,
]);

const ToolCallRecordSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  args: z.unknown().optional(),
  result: PartListUnionSchema.nullable().optional(),
  resultDisplay: z.unknown().optional(),
  status: z.string().optional(),
  timestamp: z.string().optional(),
});

const ThoughtSchema = z.object({
  subject: z.string().optional(),
  description: z.string().optional(),
});

const TokensSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  cached: z.number().optional(),
  thoughts: z.number().optional(),
  tool: z.number().optional(),
  total: z.number().optional(),
});

const MessageRecordSchema = z.object({
  id: z.string(),
  timestamp: z.string().optional(),
  type: z.string().optional(),
  content: PartListUnionSchema.optional(),
  toolCalls: z.array(ToolCallRecordSchema).optional(),
  thoughts: z.array(ThoughtSchema).optional(),
  tokens: TokensSchema.nullable().optional(),
  model: z.string().optional(),
});

const MetaRecordSchema = z.object({
  sessionId: z.string().optional(),
  projectHash: z.string().optional(),
  startTime: z.string().optional(),
  lastUpdated: z.string().optional(),
  directories: z.array(z.string()).optional(),
  kind: z.string().optional(),
  summary: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
});

const SetRecordSchema = z.object({
  $set: z
    .object({
      directories: z.array(z.string()).optional(),
      lastUpdated: z.string().optional(),
      summary: z.string().optional(),
      messages: z.array(z.unknown()).optional(),
    })
    .optional(),
});

const RewindRecordSchema = z.object({
  $rewindTo: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Typed decoded events — what the reducer sees
// ---------------------------------------------------------------------------

/** A tool call, normalized off a ToolCallRecord. */
export interface DecodedToolCall {
  name: string;
  args: unknown;
  callId: string | undefined;
  /** Flattened result / resultDisplay text ("" when the call had no output). */
  resultText: string;
  /** From `status`: success→0, error→1, otherwise undefined. */
  exitCode: number | undefined;
}

/** A message record, normalized to a canonical role with flattened text. */
export interface DecodedMessageRecord {
  id: string;
  ts: number | undefined;
  role: Role;
  text: string;
  /** Concatenated thought subjects/descriptions (assistant records only). */
  thoughtsText: string;
  toolCalls: DecodedToolCall[];
  usage: MessageUsage | undefined;
  model: string | undefined;
}

export interface DecodedSessionMeta {
  kind: "session_meta";
  ts: number | undefined;
  lastUpdatedTs: number | undefined;
  sessionId: string | undefined;
  directories: string[] | undefined;
  sessionKind: string | undefined;
  summary: string | undefined;
  /** Legacy single-file transcripts embed messages on the header record. */
  embedded: DecodedMessageRecord[];
}

export interface DecodedMessage {
  kind: "message";
  ts: number | undefined;
  record: DecodedMessageRecord;
}

export interface DecodedSet {
  kind: "set";
  ts: number | undefined;
  lastUpdatedTs: number | undefined;
  directories: string[] | undefined;
  summary: string | undefined;
  /** Full message checkpoint; when present it replaces all prior messages. */
  messages: DecodedMessageRecord[] | undefined;
}

export interface DecodedRewind {
  kind: "rewind";
  ts: number | undefined;
  toId: string | undefined;
}

/** Caller skips this line; seq still captured for rawEvents. */
export interface DecodedSkip {
  kind: "skip";
  ts: number | undefined;
}

export type DecodedEvent =
  | DecodedSessionMeta
  | DecodedMessage
  | DecodedSet
  | DecodedRewind
  | DecodedSkip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Map a Gemini record `type` to a canonical role; undefined = drop the record. */
function mapRole(type: string | undefined): Role | undefined {
  switch (type) {
    case "user":
      return "user";
    case "gemini":
      return "assistant";
    case "info":
    case "error":
    case "warning":
      return "system";
    default:
      return undefined;
  }
}

/**
 * Flatten a PartListUnion to text: concatenate `text` parts (Gemini's own
 * reconstruction joins with ""), skipping `thought` parts and function
 * call/response parts (tool calls are read from the separate `toolCalls`
 * array).
 */
function flattenContent(content: string | Part | Part[] | undefined): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .filter((p) => p && typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text ?? "")
    .join("");
}

function flattenThoughts(
  thoughts: Array<z.infer<typeof ThoughtSchema>> | undefined,
): string {
  if (!Array.isArray(thoughts)) return "";
  return thoughts
    .map((t) => {
      const subject = typeof t.subject === "string" ? t.subject.trim() : "";
      const description =
        typeof t.description === "string" ? t.description.trim() : "";
      if (subject && description) return `${subject}: ${description}`;
      return subject || description;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Flatten a tool `result` PartListUnion (functionResponse.response or text). */
function flattenResultParts(
  result: string | Part | Part[] | null | undefined,
): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  const parts = Array.isArray(result) ? result : [result];
  const chunks: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (typeof p.text === "string" && p.text) {
      chunks.push(p.text);
      continue;
    }
    const response = p.functionResponse?.response;
    if (response !== undefined) {
      chunks.push(
        typeof response === "string" ? response : JSON.stringify(response),
      );
    }
  }
  return chunks.join("\n");
}

function flattenToolResult(
  result: string | Part | Part[] | null | undefined,
  resultDisplay: unknown,
): string {
  const text = flattenResultParts(result);
  if (text) return text;
  if (typeof resultDisplay === "string") return resultDisplay;
  return "";
}

function statusToExit(status: string | undefined): number | undefined {
  if (status === "success") return 0;
  if (status === "error") return 1;
  return undefined;
}

function decodeUsage(
  tokens: z.infer<typeof TokensSchema> | null | undefined,
): MessageUsage | undefined {
  if (!tokens) return undefined;
  const usage: MessageUsage = {};
  if (typeof tokens.input === "number") usage.inputTokens = tokens.input;
  if (typeof tokens.output === "number") usage.outputTokens = tokens.output;
  if (typeof tokens.cached === "number") usage.cacheReadTokens = tokens.cached;
  if (typeof tokens.thoughts === "number")
    usage.reasoningTokens = tokens.thoughts;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function decodeToolCall(
  tc: z.infer<typeof ToolCallRecordSchema>,
): DecodedToolCall {
  return {
    name: typeof tc.name === "string" && tc.name ? tc.name : "tool",
    args: tc.args,
    callId: tc.id,
    resultText: flattenToolResult(tc.result, tc.resultDisplay),
    exitCode: statusToExit(tc.status),
  };
}

/**
 * Decode one raw message record (standalone line or embedded legacy entry).
 * Returns null for records whose `type` is not a known role.
 */
function decodeMessageRecord(
  raw: unknown,
  seq: number,
  collector: IssueCollector,
): DecodedMessageRecord | null {
  const r = MessageRecordSchema.safeParse(raw);
  if (!r.success) {
    collector.warn(`line ${seq}: malformed message record — skipped`, { seq });
    return null;
  }
  const role = mapRole(r.data.type);
  if (role === undefined) return null;
  return {
    id: r.data.id,
    ts: parseTs(r.data.timestamp),
    role,
    text: flattenContent(r.data.content),
    thoughtsText: role === "assistant" ? flattenThoughts(r.data.thoughts) : "",
    toolCalls: (r.data.toolCalls ?? []).map(decodeToolCall),
    usage: decodeUsage(r.data.tokens),
    model: r.data.model,
  };
}

// ---------------------------------------------------------------------------
// Main decoder
// ---------------------------------------------------------------------------

/**
 * Decode one raw JSONL line into a typed DecodedEvent.
 *
 * - Malformed JSON → warn + skip
 * - Metadata header (`sessionId` present) → session_meta (+ embedded messages)
 * - `$rewindTo` / `$set` → their update events
 * - `type` present → message (null decode → skip)
 * - anything else → skip (no warn; forward-compatible)
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

  if (obj === null || typeof obj !== "object") {
    collector.warn(`line ${seq}: unexpected line shape — skipped`, { seq });
    return { kind: "skip", ts: undefined };
  }

  if ("$rewindTo" in obj) {
    const r = RewindRecordSchema.safeParse(obj);
    return {
      kind: "rewind",
      ts: undefined,
      toId: r.success ? r.data.$rewindTo : undefined,
    };
  }

  if ("$set" in obj) {
    const r = SetRecordSchema.safeParse(obj);
    const set = r.success ? r.data.$set : undefined;
    return {
      kind: "set",
      ts: undefined,
      lastUpdatedTs: parseTs(set?.lastUpdated),
      directories: set?.directories,
      summary: set?.summary,
      messages:
        set?.messages === undefined
          ? undefined
          : set.messages
              .map((message) => decodeMessageRecord(message, seq, collector))
              .filter(
                (message): message is DecodedMessageRecord => message !== null,
              ),
    };
  }

  if ("sessionId" in obj) {
    const r = MetaRecordSchema.safeParse(obj);
    if (!r.success) {
      collector.warn(`line ${seq}: malformed session metadata — skipped`, {
        seq,
      });
      return { kind: "skip", ts: undefined };
    }
    const embedded = (r.data.messages ?? [])
      .map((message) => decodeMessageRecord(message, seq, collector))
      .filter((message): message is DecodedMessageRecord => message !== null);
    return {
      kind: "session_meta",
      ts: parseTs(r.data.startTime),
      lastUpdatedTs: parseTs(r.data.lastUpdated),
      sessionId: r.data.sessionId,
      directories: r.data.directories,
      sessionKind: r.data.kind,
      summary: r.data.summary,
      embedded,
    };
  }

  if ("type" in obj) {
    const record = decodeMessageRecord(obj, seq, collector);
    if (record === null) return { kind: "skip", ts: undefined };
    return { kind: "message", ts: record.ts, record };
  }

  return { kind: "skip", ts: undefined };
}
