/**
 * Pure line decoder for the Claude Code JSONL transcript format.
 *
 * Knows the wire format only — no IO, no session assembly.
 * A future incremental reader can import `decodeLine` directly
 * without pulling in the session reducer or IO shell.
 *
 * Claude Code JSONL format summary
 * - One JSON object per line; object has a `type` field.
 * - Semantic types: "user", "assistant".
 * - Metadata/bookkeeping types are in SKIP_TYPES (skipped silently).
 * - Any other unknown type is skipped with a warning.
 * - "assistant" lines may re-emit the same message.id 2–3 times (old
 *   format) or split one Anthropic API message across per-block events
 *   sharing the same message.id (a newer 2026 per-block format).
 *   The reducer handles dedup + merge; the decoder is per-line only.
 */

import { z } from "zod";
import type { IssueCollector } from "../types.js";

// ---------------------------------------------------------------------------
// Wire-format schemas (permissive — only fields the parser consumes)
// ---------------------------------------------------------------------------

const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
});

const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().default(""),
});

const ThinkingPartSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string().default(""),
});

const ToolUsePartSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
});

const ToolResultInnerSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
});

const ToolResultPartSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(ToolResultInnerSchema)]).optional(),
  is_error: z.boolean().optional(),
});

// A single content part — permissive: unknown type values are kept as a passthrough
// object so the reducer can skip them without crashing.
const ContentPartSchema = z.union([
  TextPartSchema,
  ThinkingPartSchema,
  ToolUsePartSchema,
  ToolResultPartSchema,
  // Fallback: any other object shape — reducer will ignore unrecognized types.
  z.record(z.string(), z.unknown()),
]);
type ContentPart = z.infer<typeof ContentPartSchema>;

const MessageFieldSchema = z.object({
  id: z.string().optional(),
  role: z.string().optional(),
  model: z.string().optional(),
  content: z.union([z.string(), z.array(ContentPartSchema)]).optional(),
  usage: UsageSchema.optional(),
  stop_reason: z.string().nullable().optional(),
});

/** Full line schema — only fields the parser reads. Extra fields are stripped. */
const RawLineSchema = z.object({
  type: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  uuid: z.string().optional(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  version: z.string().optional(),
  timestamp: z.string().optional(),
  isSidechain: z.boolean().optional(),
  message: MessageFieldSchema.optional(),
});
type RawLine = z.infer<typeof RawLineSchema>;

// ---------------------------------------------------------------------------
// Decoded event vocabulary
// ---------------------------------------------------------------------------

/** Metadata extracted from a "user" line with text content. */
export interface DecodedUserText {
  kind: "user_text";
  seq: number;
  ts: number | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  isSidechain: boolean;
  agentId: string | undefined;
  /** The raw text content. */
  text: string;
}

/** A tool_result part resolved from a "user" line with array content. */
export interface DecodedToolResult {
  toolUseId: string;
  content: string | Array<{ type?: string; text?: string }> | undefined;
  isError: boolean;
}

/** A "user" line whose content is an array (tool_results ± user text). */
export interface DecodedUserArray {
  kind: "user_array";
  seq: number;
  ts: number | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  isSidechain: boolean;
  agentId: string | undefined;
  textParts: string[];
  toolResults: DecodedToolResult[];
}

/**
 * A "user" line that is wrapper-only (DROP_WRAPPERS) — carry for rawEvents but skip for messages.
 *
 * Still carries session-level metadata so wrapper lines before the first
 * conversational turn can establish timestamps, branch, and session identity.
 */
export interface DecodedUserSkipped {
  kind: "user_skipped";
  seq: number;
  ts: number | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  isSidechain: boolean;
  agentId: string | undefined;
}

/** A single assistant content block decoded from one event (per-block or full-array). */
export interface DecodedAssistantBlock {
  blockType: "thinking" | "text" | "tool_use";
  blockKey: string; // unique dedup key: "thinking:<text>", "text:<text>", "tool_use:<callId>"
  // For text blocks:
  text?: string;
  // For thinking blocks:
  thinkingText?: string;
  // For tool_use blocks:
  toolName?: string;
  toolInput?: unknown;
  callId?: string;
}

/** A "assistant" line decoded into its parts + metadata. */
export interface DecodedAssistant {
  kind: "assistant";
  seq: number;
  ts: number | undefined;
  sessionId: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  isSidechain: boolean;
  agentId: string | undefined;
  model: string | undefined;
  messageId: string | undefined;
  usage:
    | {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        cacheReadTokens: number | undefined;
        cacheCreationTokens: number | undefined;
      }
    | undefined;
  blocks: DecodedAssistantBlock[];
  /** `null` in the wire format (API-error/synthetic) is normalized to `undefined`. */
  stopReason: string | undefined;
}

/** A line we capture for rawEvents but produce no message from. */
export interface DecodedSkip {
  kind: "skip";
  seq: number;
  ts: number | undefined;
  lineType: string | undefined;
}

/** A line that failed JSON.parse. */
export interface DecodedMalformed {
  kind: "malformed";
  seq: number;
}

export type DecodedEvent =
  | DecodedUserText
  | DecodedUserArray
  | DecodedUserSkipped
  | DecodedAssistant
  | DecodedSkip
  | DecodedMalformed;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Type guard: narrows `v` to `Record<string, unknown>` without `as` casts. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_TYPES = new Set([
  "progress",
  "file-history-snapshot",
  "queue-operation",
  "permission-mode",
  "attachment",
  "last-prompt",
  "system",
]);

const DROP_WRAPPERS = [
  "<local-command-",
  "<command-",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<persisted-output>",
  "<system-reminder>",
  "<task-notification>",
  "<retrieval>",
] as const;

function isWrapperOnly(text: string): boolean {
  const t = text.trimStart();
  return DROP_WRAPPERS.some((w) => t.startsWith(w));
}

function parseTs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

/** Re-exported for consumers that need to introspect the decoded wire shape. */
export type { ContentPart, RawLine };

/**
 * Decode one raw JSONL line (string) into a `DecodedEvent`.
 * Never throws. Malformed JSON → `DecodedMalformed`. Unknown-but-valid
 * types that are not in SKIP_TYPES → `DecodedSkip` with a warning.
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
    // Shouldn't happen for our permissive schema, but handle it gracefully.
    issues.warn(`seq ${seq}: line schema validation failed — line skipped`, {
      seq,
    });
    return { kind: "skip", seq, ts: undefined, lineType: undefined };
  }

  const obj: RawLine = result.data;
  const ts = parseTs(obj.timestamp);
  const lineType = obj.type;

  // Bookkeeping types — capture for rawEvents, no message output.
  if (!lineType || SKIP_TYPES.has(lineType)) {
    return { kind: "skip", seq, ts, lineType };
  }

  // Non-semantic types that are not in SKIP_TYPES (e.g. "mode", "ai-title",
  // "worktree-state", "pr-link", "custom-title", "agent-name") are silently
  // skipped. Warnings are reserved for malformed content, not well-formed
  // bookkeeping-only lines.
  if (lineType !== "user" && lineType !== "assistant") {
    return { kind: "skip", seq, ts, lineType };
  }

  const meta = {
    sessionId: obj.sessionId,
    cwd: obj.cwd,
    gitBranch: obj.gitBranch,
    isSidechain: obj.isSidechain === true,
    agentId: obj.agentId,
  };

  // ---- ASSISTANT ----
  if (lineType === "assistant") {
    const msg = obj.message;
    const content = msg?.content;
    const rawUsage = msg?.usage;
    const usage = rawUsage
      ? {
          inputTokens: rawUsage.input_tokens,
          outputTokens: rawUsage.output_tokens,
          cacheReadTokens: rawUsage.cache_read_input_tokens,
          cacheCreationTokens: rawUsage.cache_creation_input_tokens,
        }
      : undefined;

    const blocks: DecodedAssistantBlock[] = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isRecord(part)) continue;
        const p = part;
        if (p.type === "thinking") {
          const thinkingText = typeof p.thinking === "string" ? p.thinking : "";
          blocks.push({
            blockType: "thinking",
            blockKey: `thinking:${thinkingText}`,
            thinkingText,
          });
        } else if (p.type === "text") {
          const text = typeof p.text === "string" ? p.text : "";
          blocks.push({
            blockType: "text",
            blockKey: `text:${text}`,
            text,
          });
        } else if (p.type === "tool_use") {
          const callId = typeof p.id === "string" ? p.id : "";
          blocks.push({
            blockType: "tool_use",
            blockKey: `tool_use:${callId}`,
            toolName: typeof p.name === "string" ? p.name : "",
            toolInput: p.input,
            callId,
          });
        }
        // Other block types (e.g. "tool_result" inside assistant — unusual) skipped.
      }
    }
    // If content is undefined or not array — no blocks, reducer will decide fate.

    const rawStopReason = msg?.stop_reason;
    const stopReason =
      typeof rawStopReason === "string" ? rawStopReason : undefined;

    return {
      kind: "assistant",
      seq,
      ts,
      ...meta,
      model: msg?.model,
      messageId: msg?.id,
      usage,
      blocks,
      stopReason,
    };
  }

  // ---- USER ----
  const msg = obj.message;
  const content = msg?.content;

  if (content === undefined) {
    return { kind: "skip", seq, ts, lineType: "user" };
  }

  if (typeof content === "string") {
    if (isWrapperOnly(content)) {
      // Carry session-level metadata even for wrapper-only lines so the reducer
      // can update timestamps and branch information from them.
      return { kind: "user_skipped", seq, ts, ...meta };
    }
    return {
      kind: "user_text",
      seq,
      ts,
      ...meta,
      text: content,
    };
  }

  if (!Array.isArray(content)) {
    issues.warn(
      `seq ${seq}: user line has non-string, non-array content — skipped`,
      { seq },
    );
    return { kind: "skip", seq, ts, lineType: "user" };
  }

  // Array content: may have text parts and/or tool_results.
  const textParts: string[] = [];
  const toolResults: DecodedToolResult[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const p = part;
    if (p.type === "text") {
      textParts.push(typeof p.text === "string" ? p.text : "");
    } else if (p.type === "tool_result") {
      const toolUseId = typeof p.tool_use_id === "string" ? p.tool_use_id : "";
      toolResults.push({
        toolUseId,
        content: p.content as
          | string
          | Array<{ type?: string; text?: string }>
          | undefined,
        isError: p.is_error === true,
      });
    }
  }

  return {
    kind: "user_array",
    seq,
    ts,
    ...meta,
    textParts,
    toolResults,
  };
}
