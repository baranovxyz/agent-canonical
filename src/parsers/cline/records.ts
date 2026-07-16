/**
 * Wire schemas + decoders for Cline's per-session JSON store.
 *
 * All Cline format knowledge lives here. The file shell (index.ts) reads the two
 * JSON files a session dir holds and hands their parsed objects over; the reducer
 * (reduce.ts) consumes the typed records this module produces. Decoding is pure
 * (no IO), so it belongs with the decoders.
 *
 * Cline (the `@cline/cli` binary is `clite`) writes each session as a directory
 * `~/.cline/data/sessions/<id>/` with two files:
 *   - `<id>.messages.json` — the versioned `messages-contract-v1` payload:
 *     `{ version, updated_at, agent, sessionId, messages[], system_prompt? }`.
 *   - `<id>.json` — session-level metadata (model, provider, cwd, title, status,
 *     started/ended timestamps). Optional enrichment; the messages file alone is
 *     enough to identify and reduce a session.
 *
 * Content is Anthropic-native (NOT the opencode/goose shapes): each message's
 * `content` is an array of `{type,…}` blocks with exactly four `type` values —
 * `text`, `thinking`, `tool_use` (`{id,name,input}`), `tool_result`
 * (`{tool_use_id,content,is_error?}`). There is no `"tool"` role: a `tool_result`
 * rides on a `role:"user"` message and correlates to its `tool_use` (on an
 * earlier assistant message) by `tool_use_id`. Per-message usage lives in
 * `metrics` on the terminal assistant message of a turn; timestamps are epoch ms.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Decoded records — the reducer's input vocabulary
// ---------------------------------------------------------------------------

/** Per-message usage, lifted from an assistant message's `metrics`. */
export interface ClineMetrics {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** One decoded content block from a message's `content` array. */
export type ClineContent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolUse"; callId: string; name: string; args: unknown }
  | { kind: "toolResult"; callId: string; output: string; isError: boolean }
  | { kind: "other"; type: string };

/** One decoded message from the messages file, in stream order. */
export interface ClineMessageRecord {
  /** Stable message id; falls back to a positional id when absent. */
  id: string;
  role: string;
  /** Epoch milliseconds (`ts`). */
  tsMs?: number;
  /** Model id from `modelInfo.id` (assistant messages). */
  modelId?: string;
  /** Terminal assistant message of a turn carries this; others do not. */
  metrics?: ClineMetrics;
  contents: ClineContent[];
}

/** Decoded messages file. */
export interface ClineMessagesFile {
  sessionId?: string;
  agent?: string;
  messages: ClineMessageRecord[];
}

/** Decoded session metadata (`<id>.json`) — optional enrichment. */
export interface ClineSessionMeta {
  sessionId?: string;
  model?: string;
  provider?: string;
  projectPath?: string;
  title?: string;
  status?: string;
  /** Epoch milliseconds, parsed from the ISO `started_at`/`ended_at`. */
  startedAtMs?: number;
  endedAtMs?: number;
}

// ---------------------------------------------------------------------------
// Wire schemas — declare only what we read; passthrough the unstable rest
// ---------------------------------------------------------------------------

const ContentBlockSchema = z.object({ type: z.string() }).passthrough();

const ModelInfoSchema = z.object({ id: z.string().optional() }).passthrough();

const MetricsSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
  })
  .passthrough();

const MessageSchema = z
  .object({
    id: z.string().optional(),
    role: z.string(),
    content: z.array(z.unknown()),
    ts: z.number().optional(),
    modelInfo: ModelInfoSchema.optional(),
    metrics: MetricsSchema.optional(),
  })
  .passthrough();

const MessagesFileSchema = z
  .object({
    sessionId: z.string().optional(),
    agent: z.string().optional(),
    messages: z.array(z.unknown()),
  })
  .passthrough();

// A running session leaves `ended_at` null, and the store may null other
// optional fields; accept null so one null value never sinks the whole parse.
const nullableString = z.union([z.string(), z.null()]).optional();

const MetaFileSchema = z
  .object({
    session_id: nullableString,
    model: nullableString,
    provider: nullableString,
    cwd: nullableString,
    workspace_root: nullableString,
    started_at: nullableString,
    ended_at: nullableString,
    status: nullableString,
    metadata: z
      .object({ title: nullableString, model: nullableString })
      .passthrough()
      .optional(),
  })
  .passthrough();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Content block decoding
// ---------------------------------------------------------------------------

/**
 * Normalize a single `tool_result.content` element to text. The contract types
 * `content` as `unknown`: the shell/read tools emit an array of
 * `{query,result,success}` objects while the golden fixture uses a plain string,
 * and Anthropic-native `{type:"text",text}` blocks are also valid.
 */
function normalizeToolResultItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (isRecord(item)) {
    if (typeof item.text === "string") return item.text;
    if (typeof item.result === "string") return item.result;
    return JSON.stringify(item);
  }
  return item == null ? "" : String(item);
}

/** Normalize a whole `tool_result.content` (string | array | object) to text. */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(normalizeToolResultItem).join("\n");
  if (isRecord(content)) return normalizeToolResultItem(content);
  return content == null ? "" : String(content);
}

function decodeContentBlock(raw: unknown): ClineContent {
  const parsed = ContentBlockSchema.safeParse(raw);
  if (!parsed.success) return { kind: "other", type: "unknown" };
  const block = parsed.data;

  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      return { kind: "text", text };
    }
    case "thinking": {
      const text = typeof block.thinking === "string" ? block.thinking : "";
      return { kind: "thinking", text };
    }
    case "tool_use": {
      const callId = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      return { kind: "toolUse", callId, name, args: block.input ?? {} };
    }
    case "tool_result": {
      const callId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const output = normalizeToolResultContent(block.content);
      const isError = block.is_error === true;
      return { kind: "toolResult", callId, output, isError };
    }
    default:
      return { kind: "other", type: block.type };
  }
}

// ---------------------------------------------------------------------------
// Message + file decoders
// ---------------------------------------------------------------------------

/** Cline wraps a user prompt in `<user_input mode="…">…</user_input>`. */
const USER_INPUT_WRAPPER = /^<user_input\b[^>]*>([\s\S]*)<\/user_input>$/;

/** Strip the `<user_input …>` wrapper Cline adds to user prompts. */
export function stripUserInputWrapper(text: string): string {
  const m = USER_INPUT_WRAPPER.exec(text.trim());
  return m ? (m[1] ?? "") : text;
}

/**
 * Decode one raw message. Returns null when the row shape is unrecognizable or
 * lacks a `content` array (the shell logs a warning and skips it). `index` seeds
 * the positional fallback id when the message carries none.
 */
export function decodeMessage(
  raw: unknown,
  index: number,
): ClineMessageRecord | null {
  const parsed = MessageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;

  const rec: ClineMessageRecord = {
    id: row.id ?? `msg_${index}`,
    role: row.role,
    contents: row.content.map(decodeContentBlock),
  };
  if (typeof row.ts === "number") rec.tsMs = row.ts;
  if (row.modelInfo?.id !== undefined) rec.modelId = row.modelInfo.id;
  if (row.metrics !== undefined) {
    const m: ClineMetrics = {};
    if (typeof row.metrics.inputTokens === "number")
      m.inputTokens = row.metrics.inputTokens;
    if (typeof row.metrics.outputTokens === "number")
      m.outputTokens = row.metrics.outputTokens;
    if (typeof row.metrics.cacheReadTokens === "number")
      m.cacheReadTokens = row.metrics.cacheReadTokens;
    if (typeof row.metrics.cacheWriteTokens === "number")
      m.cacheWriteTokens = row.metrics.cacheWriteTokens;
    if (Object.keys(m).length > 0) rec.metrics = m;
  }
  return rec;
}

/** Decode the messages file. Malformed messages are dropped (shell warns). */
export function decodeMessagesFile(raw: unknown): ClineMessagesFile | null {
  const parsed = MessagesFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const messages: ClineMessageRecord[] = [];
  parsed.data.messages.forEach((m, i) => {
    const decoded = decodeMessage(m, i);
    if (decoded) messages.push(decoded);
  });
  const file: ClineMessagesFile = { messages };
  if (parsed.data.sessionId !== undefined)
    file.sessionId = parsed.data.sessionId;
  if (parsed.data.agent !== undefined) file.agent = parsed.data.agent;
  return file;
}

/** Parse an ISO timestamp to epoch ms, or undefined when malformed/absent. */
function decodeIsoMs(iso: string | null | undefined): number | undefined {
  if (typeof iso !== "string" || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Decode the optional session metadata file (`<id>.json`). */
export function decodeMetaFile(raw: unknown): ClineSessionMeta {
  const parsed = MetaFileSchema.safeParse(raw);
  if (!parsed.success) return {};
  const row = parsed.data;
  const meta: ClineSessionMeta = {};
  if (row.session_id != null) meta.sessionId = row.session_id;
  if (row.model != null) meta.model = row.model;
  else if (row.metadata?.model != null) meta.model = row.metadata.model;
  if (row.provider != null) meta.provider = row.provider;
  const projectPath = row.workspace_root ?? row.cwd;
  if (projectPath != null) meta.projectPath = projectPath;
  if (row.metadata?.title != null) meta.title = row.metadata.title;
  if (row.status != null) meta.status = row.status;
  const startedAtMs = decodeIsoMs(row.started_at);
  if (startedAtMs !== undefined) meta.startedAtMs = startedAtMs;
  const endedAtMs = decodeIsoMs(row.ended_at);
  if (endedAtMs !== undefined) meta.endedAtMs = endedAtMs;
  return meta;
}
