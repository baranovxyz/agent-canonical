/**
 * Wire schemas + decoders for Goose's `sessions.db` rows.
 *
 * All Goose format knowledge lives here. The DB shell (index.ts) runs SQL and
 * hands raw rows over; the reducer (reduce.ts) consumes the typed records this
 * module produces. JSON.parse of the embedded `content_json` / `metadata_json`
 * columns happens here — it is pure (no IO), so it belongs with the decoders.
 *
 * Goose (Rust) stores each turn as one `messages` row whose `content_json` is a
 * serde-serialized `Vec<MessageContent>` — a `{type, …}`-tagged, camelCase
 * union. The variants we decode (verified against a capture-derived Goose
 * 1.43.0 fixture and the `goose-provider-types` message enum):
 *   - text           → { type:"text", text }
 *   - thinking       → { type:"thinking", thinking, signature }
 *   - toolRequest    → { type:"toolRequest", id, toolCall:{status,value:{name,arguments}} }
 *   - toolResponse   → { type:"toolResponse", id, toolResult:{status,value:{content,structuredContent,isError}} }
 * Everything else (image, toolConfirmationRequest, actionRequired,
 * frontendToolRequest, redactedThinking, systemNotification) is decoded as an
 * inert `other` block — skipped from canonical text but preserved verbatim in
 * `rawEvents`.
 *
 * Tool correlation is cross-row: the `toolRequest` lands in a `role:"assistant"`
 * row, and its `toolResponse` lands in a *later* `role:"user"` row (Anthropic
 * convention), paired by the shared `id` (the tool `callId`).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Decoded records — the reducer's input vocabulary
// ---------------------------------------------------------------------------

/** Per-message usage, lifted from `metadata_json.usage` on assistant rows. */
export interface GooseUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

/** One decoded content block from a message's `content_json` array. */
export type GooseContent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolRequest"; callId: string; name: string; args: unknown }
  | {
      kind: "toolResponse";
      callId: string;
      output: string;
      exitCode?: number;
      isError: boolean;
    }
  | { kind: "other"; type: string };

/** One decoded `messages` row. `pk` is the autoincrement id (ordering key). */
export interface GooseMessageRecord {
  pk: number;
  messageId?: string;
  role: string;
  /** Unix seconds (`created_timestamp`). */
  ts?: number;
  usage?: GooseUsage;
  contents: GooseContent[];
}

/** One decoded `sessions` row. */
export interface GooseSessionRecord {
  id: string;
  name?: string;
  description?: string;
  sessionType?: string;
  workingDir?: string;
  model?: string;
  providerName?: string;
  parentId?: string;
  /** Unix seconds. */
  createdAt?: number;
  updatedAt?: number;
}

// ---------------------------------------------------------------------------
// Wire schemas — declare only what we read; passthrough the unstable rest
// ---------------------------------------------------------------------------

const nullableString = z.union([z.string(), z.null()]).optional();
const nullableNumber = z.union([z.number(), z.null()]).optional();

const SessionRowSchema = z
  .object({
    id: z.string(),
    name: nullableString,
    description: nullableString,
    session_type: nullableString,
    working_dir: nullableString,
    created_at: nullableString,
    updated_at: nullableString,
    provider_name: nullableString,
    model_config_json: nullableString,
    parent_session_id: nullableString,
  })
  .passthrough();

const MessageRowSchema = z
  .object({
    id: z.number(),
    message_id: nullableString,
    session_id: z.string(),
    role: z.string(),
    content_json: z.string(),
    created_timestamp: nullableNumber,
    metadata_json: nullableString,
  })
  .passthrough();

export const SessionIdRowSchema = z.object({ id: z.string() });

// ---------------------------------------------------------------------------
// Content block decoding
// ---------------------------------------------------------------------------

const ContentBlockSchema = z.object({ type: z.string() }).passthrough();

const ToolCallValueSchema = z
  .object({
    name: z.string(),
    arguments: z.unknown().optional(),
  })
  .passthrough();

/** serde `Result` shape: `{status:"success",value}` | `{status:"error",error}`. */
const ResultEnvelopeSchema = z
  .object({
    status: z.string().optional(),
    value: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

const ToolResultValueSchema = z
  .object({
    content: z.array(z.unknown()).optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .passthrough();

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Join the `text` fragments of an MCP content array. */
function joinContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (isRecord(item) && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function decodeContentBlock(raw: unknown): GooseContent {
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
    case "toolRequest": {
      const id = typeof block.id === "string" ? block.id : "";
      const envelope = ResultEnvelopeSchema.safeParse(block.toolCall);
      if (envelope.success) {
        const call = ToolCallValueSchema.safeParse(envelope.data.value);
        if (call.success) {
          return {
            kind: "toolRequest",
            callId: id,
            name: call.data.name,
            args: call.data.arguments ?? {},
          };
        }
      }
      // Unparseable / errored tool request: keep as inert (lossless via rawEvents).
      return { kind: "other", type: "toolRequest" };
    }
    case "toolResponse": {
      const id = typeof block.id === "string" ? block.id : "";
      const envelope = ResultEnvelopeSchema.safeParse(block.toolResult);
      if (!envelope.success) return { kind: "other", type: "toolResponse" };
      if (
        envelope.data.status === "error" ||
        envelope.data.value === undefined
      ) {
        const output =
          typeof envelope.data.error === "string"
            ? envelope.data.error
            : JSON.stringify(envelope.data.error ?? "");
        return { kind: "toolResponse", callId: id, output, isError: true };
      }
      const value = ToolResultValueSchema.safeParse(envelope.data.value);
      if (!value.success) return { kind: "other", type: "toolResponse" };
      const output = joinContentText(value.data.content);
      const isError = value.data.isError === true;
      let exitCode: number | undefined;
      if (isRecord(value.data.structuredContent)) {
        const ec = value.data.structuredContent.exit_code;
        if (typeof ec === "number") exitCode = ec;
      }
      if (exitCode === undefined) exitCode = isError ? 1 : 0;
      return { kind: "toolResponse", callId: id, output, exitCode, isError };
    }
    default:
      return { kind: "other", type: block.type };
  }
}

// ---------------------------------------------------------------------------
// Row decoders
// ---------------------------------------------------------------------------

/** Read `model_config_json` → the underlying provider model id, if present. */
function decodeModel(
  modelConfigJson: string | null | undefined,
): string | undefined {
  if (typeof modelConfigJson !== "string" || modelConfigJson.length === 0)
    return undefined;
  try {
    const cfg: unknown = JSON.parse(modelConfigJson);
    if (isRecord(cfg) && typeof cfg.model_name === "string")
      return cfg.model_name;
  } catch {
    // malformed config — model stays undefined
  }
  return undefined;
}

/** SQLite `CURRENT_TIMESTAMP` text ("YYYY-MM-DD HH:MM:SS", UTC) → unix seconds. */
function decodeSqliteTimestamp(
  ts: string | null | undefined,
): number | undefined {
  if (typeof ts !== "string" || ts.length === 0) return undefined;
  const ms = Date.parse(`${ts.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** Decode a raw `sessions` row. Returns null only when the row lacks an id. */
export function decodeSessionRow(raw: unknown): GooseSessionRecord | null {
  const parsed = SessionRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;

  const rec: GooseSessionRecord = { id: row.id };
  if (row.name) rec.name = row.name;
  if (row.description) rec.description = row.description;
  if (row.session_type) rec.sessionType = row.session_type;
  if (row.working_dir) rec.workingDir = row.working_dir;
  if (row.provider_name) rec.providerName = row.provider_name;
  if (row.parent_session_id) rec.parentId = row.parent_session_id;
  const model = decodeModel(row.model_config_json);
  if (model !== undefined) rec.model = model;
  const createdAt = decodeSqliteTimestamp(row.created_at);
  if (createdAt !== undefined) rec.createdAt = createdAt;
  const updatedAt = decodeSqliteTimestamp(row.updated_at);
  if (updatedAt !== undefined) rec.updatedAt = updatedAt;
  return rec;
}

const UsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
  })
  .passthrough();

const MetadataSchema = z
  .object({ usage: UsageSchema.optional() })
  .passthrough();

function decodeUsage(
  metadataJson: string | null | undefined,
): GooseUsage | undefined {
  if (typeof metadataJson !== "string" || metadataJson.length === 0)
    return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(metadataJson);
  } catch {
    return undefined;
  }
  const parsed = MetadataSchema.safeParse(raw);
  if (!parsed.success || parsed.data.usage === undefined) return undefined;
  const u = parsed.data.usage;
  const usage: GooseUsage = {};
  if (typeof u.inputTokens === "number") usage.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === "number") usage.outputTokens = u.outputTokens;
  if (typeof u.cacheReadTokens === "number")
    usage.cacheReadTokens = u.cacheReadTokens;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Decode a raw `messages` row into a typed record with decoded content blocks.
 * Returns null when the row shape is unrecognisable or `content_json` is not a
 * JSON array (the shell logs a warning and skips it).
 */
export function decodeMessageRow(raw: unknown): GooseMessageRecord | null {
  const parsed = MessageRowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;

  let contentRaw: unknown;
  try {
    contentRaw = JSON.parse(row.content_json);
  } catch {
    return null;
  }
  if (!Array.isArray(contentRaw)) return null;

  const contents = contentRaw.map(decodeContentBlock);
  const rec: GooseMessageRecord = {
    pk: row.id,
    role: row.role,
    contents,
  };
  if (row.message_id) rec.messageId = row.message_id;
  if (typeof row.created_timestamp === "number") rec.ts = row.created_timestamp;
  const usage = decodeUsage(row.metadata_json);
  if (usage !== undefined) rec.usage = usage;
  return rec;
}
