/**
 * Wire schemas + decoders for Pi's per-session JSONL session log.
 *
 * All Pi format knowledge lives here. The file shell (index.ts) reads a session
 * file, hands each parsed line over, and this module decodes it into a typed
 * `PiRecord`; the reducer (reduce.ts) folds those records into a canonical
 * Session. Decoding is pure (no IO), so it belongs with the decoders.
 *
 * Pi (`@earendil-works/pi-coding-agent`, binary `pi`) writes one append-only
 * JSONL file per session at
 * `~/.pi/agent/sessions/<cwd-slug>/<ISO-timestamp>_<uuidv7>.jsonl`. Resuming
 * with `--continue` appends to the same file; nothing is ever rewritten.
 *
 * Line 1 is the session header
 * `{type:"session", version, id, timestamp, cwd[, parentSession]}` — the only
 * source of the session id and project path. It carries no title, model, or git
 * branch.
 *
 * Every later line is an entry `{type, id:<8-hex>, parentId:<8-hex|null>,
 * timestamp:<ISO>}` plus per-type fields. Entries form a DAG: `parentId` chains
 * them, and a second child of the same parent is a branch (see reduce.ts for
 * the traversal policy). Entry types:
 *   - `message`               — nests an AgentMessage under `.message` (below).
 *   - `model_change`          — `{provider, modelId}`; the active model changed.
 *   - `thinking_level_change` — `{thinkingLevel}`; inert for the canonical build.
 *   - `session_info`          — `{name}`; the only source of a session title.
 *   - `compaction`            — `{summary, firstKeptEntryId, tokensBefore, …}`.
 *   - `branch_summary`        — `{fromId, summary, …}`.
 *   - `label`                 — `{targetId, label}`; inert.
 *   - `custom` / `custom_message` — extension payloads; inert.
 *
 * `.message` roles (Pi's AgentMessage union):
 *   - `user`          — `{content, timestamp}`; content is a string or a
 *     `(text|image)` block array. The message-level `timestamp` is Unix ms,
 *     while the entry-level one is ISO — both are preserved in rawEvents.
 *   - `assistant`     — `{api, provider, model, responseId, content, usage,
 *     stopReason, rawStopReason, timestamp[, errorMessage]}`; content blocks are
 *     `{type:"thinking",thinking}` | `{type:"text",text}` |
 *     `{type:"toolCall",id,name,arguments}` — `arguments` is already an object,
 *     never a JSON string.
 *   - `toolResult`    — a SEPARATE entry `{toolCallId, toolName, content,
 *     isError, timestamp[, details]}`, correlated to its call by `toolCallId`.
 *   - `bashExecution` — the TUI's `!cmd` shell escape:
 *     `{command, output, exitCode, cancelled, truncated, excludeFromContext}`.
 *     Not a model tool call; the user ran it and Pi fed the output back.
 *   - `custom` / `branchSummary` / `compactionSummary` — documented variants the
 *     capture did not exercise; decoded permissively (summaries survive, custom
 *     payloads are skipped with a warning) and always kept in rawEvents.
 *
 * Usage is per assistant message: `{input, output, cacheRead, cacheWrite,
 * reasoning, totalTokens, cost:{input,output,cacheRead,cacheWrite,total}}`.
 * There is no session-level aggregate, so transcript totals are summed. The
 * canonical schema has no cost field, so `cost` survives only in rawEvents.
 *
 * Turn end is explicit per assistant message: `stopReason ∈ stop | length |
 * toolUse | error | aborted` (the capture exercised stop, toolUse, and error).
 * An errored turn is persisted as an assistant message with `stopReason:"error"`,
 * empty content, an `errorMessage`, and zeroed usage.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Decoded records — the reducer's input vocabulary
// ---------------------------------------------------------------------------

/** One tool call issued by an assistant message (`{type:"toolCall"}` block). */
export interface PiToolCall {
  callId: string;
  name: string;
  args: unknown;
}

/** Per-assistant-message token usage (Pi's `usage`, cost excluded). */
export interface PiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

/** Entry-level metadata every non-header line carries. */
export interface PiEntryMeta {
  /** 8-hex entry id; unique within the file. */
  entryId?: string;
  /** 8-hex id of the entry this one continues, or null at the root. */
  parentId?: string | null;
  /** Entry-level ISO timestamp, as epoch ms. */
  tsMs?: number;
}

/** The per-type payload of one decoded line. */
export type PiRecordBody =
  | {
      kind: "header";
      sessionId?: string;
      storeVersion?: number;
      cwd?: string;
      parentSessionPath?: string;
    }
  | { kind: "modelChange"; model: string; provider?: string }
  | { kind: "sessionInfo"; name: string }
  | { kind: "user"; text: string; messageTsMs?: number }
  | {
      kind: "assistant";
      text: string;
      thinking: string[];
      toolCalls: PiToolCall[];
      model?: string;
      provider?: string;
      stopReason?: string;
      errorMessage?: string;
      usage?: PiUsage;
      messageTsMs?: number;
    }
  | {
      kind: "toolResult";
      callId: string;
      toolName?: string;
      output: string;
      isError: boolean;
    }
  | {
      kind: "bashExecution";
      command: string;
      output: string;
      exitCode?: number;
      cancelled: boolean;
      truncated: boolean;
    }
  /** A summary-bearing record: compaction / branch_summary, entry or message. */
  | { kind: "summary"; text: string; summaryKind: string }
  /** A recognized-but-inert line (thinking_level_change, label, custom, …). */
  | { kind: "other"; type: string };

/** One decoded line, in file order. */
export type PiRecord = PiEntryMeta & PiRecordBody;

// ---------------------------------------------------------------------------
// Wire schemas — declare only what we read; passthrough the unstable rest
// ---------------------------------------------------------------------------

/** The envelope every line shares (the header has no id/parentId). */
const EntryEnvelopeSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    parentId: z.union([z.string(), z.null()]).optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const SessionHeaderSchema = z
  .object({
    version: z.number().optional(),
    id: z.string().optional(),
    cwd: z.string().optional(),
    parentSession: z.string().optional(),
  })
  .passthrough();

const ModelChangeSchema = z
  .object({
    provider: z.string().optional(),
    modelId: z.string().optional(),
  })
  .passthrough();

const SessionInfoSchema = z
  .object({ name: z.string().optional() })
  .passthrough();

const SummaryEntrySchema = z
  .object({ summary: z.string().optional() })
  .passthrough();

const TextBlockSchema = z
  .object({ type: z.literal("text"), text: z.string().optional() })
  .passthrough();

const ThinkingBlockSchema = z
  .object({ type: z.literal("thinking"), thinking: z.string().optional() })
  .passthrough();

const ToolCallBlockSchema = z
  .object({
    type: z.literal("toolCall"),
    id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.unknown().optional(),
  })
  .passthrough();

/** Any content block; unknown block types survive via passthrough. */
const ContentBlockSchema = z.union([
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolCallBlockSchema,
  z.object({ type: z.string() }).passthrough(),
]);

/** `content` is a plain string or a block array, depending on the role. */
const ContentSchema = z.union([z.string(), z.array(ContentBlockSchema)]);

const UsageSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cacheRead: z.number().optional(),
    cacheWrite: z.number().optional(),
    reasoning: z.number().optional(),
    totalTokens: z.number().optional(),
  })
  .passthrough();

const AgentMessageSchema = z
  .object({
    role: z.string(),
    content: ContentSchema.optional(),
    timestamp: z.number().optional(),
    // assistant
    provider: z.string().optional(),
    model: z.string().optional(),
    stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
    usage: UsageSchema.optional(),
    // toolResult
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    // bashExecution
    command: z.string().optional(),
    output: z.string().optional(),
    exitCode: z.number().optional(),
    cancelled: z.boolean().optional(),
    truncated: z.boolean().optional(),
    // branchSummary / compactionSummary
    summary: z.string().optional(),
  })
  .passthrough();

const MessageEntrySchema = z
  .object({ message: AgentMessageSchema.optional() })
  .passthrough();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse an ISO timestamp to epoch ms, or undefined when malformed/absent. */
function decodeIsoMs(iso: string | undefined): number | undefined {
  if (typeof iso !== "string" || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Flatten a `content` value (string or block array) to its text parts. */
function flattenText(content: unknown): string {
  const parsed = ContentSchema.safeParse(content);
  if (!parsed.success) return "";
  if (typeof parsed.data === "string") return parsed.data;
  const parts: string[] = [];
  for (const block of parsed.data) {
    if (block.type === "text" && typeof block.text === "string" && block.text)
      parts.push(block.text);
  }
  return parts.join("\n\n");
}

function decodeUsage(raw: unknown): PiUsage | undefined {
  const parsed = UsageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const u = parsed.data;
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    cacheWriteTokens: u.cacheWrite ?? 0,
    reasoningTokens: u.reasoning ?? 0,
  };
}

/** Decode an assistant `content` array into thinking / text / tool calls. */
function decodeAssistantContent(content: unknown): {
  text: string;
  thinking: string[];
  toolCalls: PiToolCall[];
} {
  const thinking: string[] = [];
  const toolCalls: PiToolCall[] = [];
  const textParts: string[] = [];

  const parsed = ContentSchema.safeParse(content);
  if (!parsed.success) return { text: "", thinking, toolCalls };
  if (typeof parsed.data === "string")
    return { text: parsed.data, thinking, toolCalls };

  for (const raw of parsed.data) {
    if (raw.type === "thinking") {
      const block = ThinkingBlockSchema.safeParse(raw);
      const text = block.success ? (block.data.thinking ?? "") : "";
      if (text) thinking.push(text);
    } else if (raw.type === "text") {
      const block = TextBlockSchema.safeParse(raw);
      const text = block.success ? (block.data.text ?? "") : "";
      if (text) textParts.push(text);
    } else if (raw.type === "toolCall") {
      const block = ToolCallBlockSchema.safeParse(raw);
      if (!block.success) continue;
      const { id, name } = block.data;
      if (typeof name !== "string" || name.length === 0) continue;
      toolCalls.push({
        callId: typeof id === "string" ? id : "",
        name,
        args: block.data.arguments ?? {},
      });
    }
  }

  return { text: textParts.join("\n\n"), thinking, toolCalls };
}

/** Decode one `.message` payload into a record body, or null when unusable. */
function decodeAgentMessage(
  raw: unknown,
): { body: PiRecordBody; messageTsMs?: number } | null {
  const parsed = AgentMessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const messageTsMs = typeof m.timestamp === "number" ? m.timestamp : undefined;

  switch (m.role) {
    case "user": {
      const body: PiRecordBody = { kind: "user", text: flattenText(m.content) };
      if (messageTsMs !== undefined) body.messageTsMs = messageTsMs;
      return { body, messageTsMs };
    }
    case "assistant": {
      const { text, thinking, toolCalls } = decodeAssistantContent(m.content);
      const body: Extract<PiRecordBody, { kind: "assistant" }> = {
        kind: "assistant",
        text,
        thinking,
        toolCalls,
      };
      if (typeof m.model === "string") body.model = m.model;
      if (typeof m.provider === "string") body.provider = m.provider;
      if (typeof m.stopReason === "string") body.stopReason = m.stopReason;
      if (typeof m.errorMessage === "string" && m.errorMessage)
        body.errorMessage = m.errorMessage;
      const usage = decodeUsage(m.usage);
      if (usage !== undefined) body.usage = usage;
      if (messageTsMs !== undefined) body.messageTsMs = messageTsMs;
      return { body, messageTsMs };
    }
    case "toolResult": {
      if (typeof m.toolCallId !== "string" || m.toolCallId.length === 0)
        return null;
      const body: Extract<PiRecordBody, { kind: "toolResult" }> = {
        kind: "toolResult",
        callId: m.toolCallId,
        output: flattenText(m.content),
        isError: m.isError === true,
      };
      if (typeof m.toolName === "string") body.toolName = m.toolName;
      return { body, messageTsMs };
    }
    case "bashExecution": {
      const body: Extract<PiRecordBody, { kind: "bashExecution" }> = {
        kind: "bashExecution",
        command: typeof m.command === "string" ? m.command : "",
        output: typeof m.output === "string" ? m.output : "",
        cancelled: m.cancelled === true,
        truncated: m.truncated === true,
      };
      if (typeof m.exitCode === "number") body.exitCode = m.exitCode;
      return { body, messageTsMs };
    }
    case "branchSummary":
    case "compactionSummary": {
      const text = typeof m.summary === "string" ? m.summary : "";
      if (!text) return { body: { kind: "other", type: m.role }, messageTsMs };
      return {
        body: { kind: "summary", text, summaryKind: m.role },
        messageTsMs,
      };
    }
    default:
      // `custom` and any future role: inert here, lossless in rawEvents.
      return {
        body: { kind: "other", type: `message:${m.role}` },
        messageTsMs,
      };
  }
}

// ---------------------------------------------------------------------------
// Entry decoder
// ---------------------------------------------------------------------------

/**
 * Decode one raw JSONL line into a typed `PiRecord`. Returns null when the
 * envelope is unrecognizable or a `message` entry carries no usable payload
 * (the shell records a warning and skips it). Unmodeled entry types decode to
 * `{kind:"other"}` and are inert in the reducer.
 */
export function decodeEntry(raw: unknown): PiRecord | null {
  const envelope = EntryEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;
  const { type, id, parentId, timestamp } = envelope.data;

  const meta: PiEntryMeta = {};
  if (typeof id === "string") meta.entryId = id;
  if (parentId !== undefined) meta.parentId = parentId;
  const tsMs = decodeIsoMs(timestamp);
  if (tsMs !== undefined) meta.tsMs = tsMs;

  switch (type) {
    case "session": {
      const parsed = SessionHeaderSchema.safeParse(raw);
      const body: Extract<PiRecordBody, { kind: "header" }> = {
        kind: "header",
      };
      if (parsed.success) {
        if (typeof parsed.data.id === "string") body.sessionId = parsed.data.id;
        if (typeof parsed.data.version === "number")
          body.storeVersion = parsed.data.version;
        if (typeof parsed.data.cwd === "string") body.cwd = parsed.data.cwd;
        if (typeof parsed.data.parentSession === "string")
          body.parentSessionPath = parsed.data.parentSession;
      }
      return { ...meta, ...body };
    }
    case "model_change": {
      const parsed = ModelChangeSchema.safeParse(raw);
      if (!parsed.success || typeof parsed.data.modelId !== "string")
        return { ...meta, kind: "other", type };
      const body: Extract<PiRecordBody, { kind: "modelChange" }> = {
        kind: "modelChange",
        model: parsed.data.modelId,
      };
      if (typeof parsed.data.provider === "string")
        body.provider = parsed.data.provider;
      return { ...meta, ...body };
    }
    case "session_info": {
      const parsed = SessionInfoSchema.safeParse(raw);
      if (!parsed.success || typeof parsed.data.name !== "string")
        return { ...meta, kind: "other", type };
      return { ...meta, kind: "sessionInfo", name: parsed.data.name };
    }
    case "compaction":
    case "branch_summary": {
      const parsed = SummaryEntrySchema.safeParse(raw);
      const text =
        parsed.success && typeof parsed.data.summary === "string"
          ? parsed.data.summary
          : "";
      if (!text) return { ...meta, kind: "other", type };
      return { ...meta, kind: "summary", text, summaryKind: type };
    }
    case "message": {
      const parsed = MessageEntrySchema.safeParse(raw);
      if (!parsed.success || parsed.data.message === undefined) return null;
      const decoded = decodeAgentMessage(parsed.data.message);
      if (decoded === null) return null;
      // Fall back to the message-level Unix-ms timestamp when the entry-level
      // ISO one is absent.
      if (meta.tsMs === undefined && decoded.messageTsMs !== undefined)
        meta.tsMs = decoded.messageTsMs;
      return { ...meta, ...decoded.body };
    }
    default:
      // thinking_level_change, label, custom, custom_message, and anything new.
      return { ...meta, kind: "other", type };
  }
}
