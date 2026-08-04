/**
 * Wire schemas + decoders for Factory Droid's per-session JSONL store.
 *
 * All Droid format knowledge lives here. The file shell (index.ts) reads a
 * session file plus its sibling settings file and hands each parsed value over;
 * the reducer (reduce.ts) folds the typed records into a canonical Session.
 * Decoding is pure (no IO), so it belongs with the decoders.
 *
 * Droid (Factory AI's closed-source `droid` binary, shipped as a Bun-compiled
 * executable) writes each session as two sibling files under
 * `~/.factory/sessions/<dash-slug-cwd>/`:
 *   - `<uuid>.jsonl`         — the conversation, appended line by line.
 *   - `<uuid>.settings.json` — session-level settings + token usage. A
 *     byte-identical `<uuid>.settings.json.bak` sits beside it and is ignored.
 * The directory slug is the realpath of the session's cwd with `/` replaced by
 * `-`, so `/home/u/project` becomes `-home-u-project`.
 *
 * The JSONL has exactly three line envelopes:
 *   - `session_start` — line 1:
 *     `{type, id, title, owner, version, cwd, hostId, isSessionTitleManuallySet}`.
 *     It carries NO timestamp, so session timing comes from message lines only.
 *   - `message`       — `{type, id, timestamp, message, parentId?}`; `parentId`
 *     is absent on the first message and otherwise chains the messages into a
 *     linked list (the store's fork support re-parents from a mid-list id).
 *   - `agent_turn_outcome` — `{type, turnId, reason, resultKind}`, also with NO
 *     timestamp. `turnId` is the id of the user message that opened the turn and
 *     `reason` is `completed` or `error`, so turn end is explicit on disk.
 *
 * `message.message` is Anthropic Messages-API shaped and comes in four flavors:
 *   - user prompt        — `{role:"user", content, interactionMode}`.
 *   - assistant reply    — `{role:"assistant", content, openaiMessageId, modelId,
 *     reasoningEffort, chatCompletionReasoningField,
 *     chatCompletionReasoningContent}`. The two `chatCompletionReasoning*` fields
 *     duplicate the `thinking` content block verbatim, so only the block is read.
 *   - tool result        — `{role:"user", content:[tool_result blocks]}`; results
 *     correlate to their `tool_use` by `tool_use_id`, Anthropic-style.
 *   - injected context   — `{role:"user", visibility:"llm_only"}` on a message
 *     whose id is `context-<turnId>`: the system-reminder bundle Droid injects
 *     ahead of a user turn (date, skills, subagents, system info, and the
 *     session-start environment commands rendered as prose). Never typed by the
 *     user; see reduce.ts for the drop policy.
 * `visibility` is `llm_only` | `user_only` | `both`, or absent (both).
 *
 * Content blocks are `{type:"thinking", thinking, signature, signatureProvider,
 * durationMs?}` | `{type:"text", text}` | `{type:"tool_use", id, name, input}` |
 * `{type:"tool_result", tool_use_id, is_error, content}`.
 *
 * There is NO per-message token usage. The sibling settings file holds the
 * session-level totals: `tokenUsage` (this session) and `inclusiveTokenUsage`
 * (this session plus the children in `childInclusiveTokenUsageBySessionId`),
 * each `{inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens,
 * thinkingTokens, factoryCredits}`, alongside `lastCallTokenUsage`,
 * `assistantActiveTimeMs`, `autonomyLevel`/`autonomyMode`, `providerLock`,
 * `reasoningEffort`, and `model`.
 *
 * `model` in the settings file is an ALIAS, not an upstream slug: a BYOK model
 * is recorded as `custom:<displayName>-<index>`, and the per-message `modelId`
 * echoes the same alias rather than the provider's own model id. The upstream
 * model is therefore unrecoverable from the store — the alias is what a parser
 * can honestly report. `modelId` is typed nullable (a null was not observed in
 * the validated capture, but the field is accepted as null defensively).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Decoded records — the reducer's input vocabulary
// ---------------------------------------------------------------------------

/** One decoded content block from a message's `content` array. */
export type DroidContent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; durationMs?: number }
  | { kind: "toolUse"; callId: string; name: string; args: unknown }
  | { kind: "toolResult"; callId: string; output: string; isError: boolean }
  | { kind: "other"; type: string };

/** The per-type payload of one decoded line. */
export type DroidRecordBody =
  | {
      kind: "header";
      sessionId?: string;
      title?: string;
      owner?: string;
      hostId?: string;
      cwd?: string;
      storeVersion?: number;
      titleManuallySet?: boolean;
    }
  | {
      kind: "message";
      messageId?: string;
      parentId?: string;
      role: string;
      /** `llm_only` | `user_only` | `both`; absent means both. */
      visibility?: string;
      interactionMode?: string;
      /** Model alias echoed on this message; absent when the store had none. */
      modelId?: string;
      reasoningEffort?: string;
      contents: DroidContent[];
    }
  | {
      kind: "turnOutcome";
      /** Id of the user message that opened the turn. */
      turnId: string;
      /** `completed` | `error`. */
      reason: string;
      resultKind?: string;
    }
  /** A recognized-but-inert line type. */
  | { kind: "other"; type: string };

/** One decoded line, in file order. Only `message` lines carry a timestamp. */
export type DroidRecord = DroidRecordBody & { tsMs?: number };

/** Session-level token usage, from one usage object in the settings file. */
export interface DroidTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
}

/** Decoded `<uuid>.settings.json` — optional enrichment. */
export interface DroidSessionSettings {
  /** Model alias (`custom:<displayName>-<index>` under BYOK), never a slug. */
  model?: string;
  reasoningEffort?: string;
  interactionMode?: string;
  autonomyLevel?: string;
  autonomyMode?: string;
  providerLock?: string;
  assistantActiveTimeMs?: number;
  /** This session's own totals (`tokenUsage`). */
  usage?: DroidTokenUsage;
  /** Totals including child sessions (`inclusiveTokenUsage`). */
  inclusiveUsage?: DroidTokenUsage;
  /** Ids from `childInclusiveTokenUsageBySessionId`, in file order. */
  childSessionIds: string[];
}

/** `visibility` value marking a message Droid injected for the model only. */
export const VISIBILITY_LLM_ONLY = "llm_only";
/** `visibility` value marking a notice rendered to the user only. */
export const VISIBILITY_USER_ONLY = "user_only";

// ---------------------------------------------------------------------------
// Wire schemas — declare only what we read; passthrough the unstable rest
// ---------------------------------------------------------------------------

/** The envelope every line shares; only `message` lines carry a timestamp. */
const LineEnvelopeSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    parentId: z.string().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const SessionStartSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    owner: z.string().optional(),
    version: z.number().optional(),
    cwd: z.string().optional(),
    hostId: z.string().optional(),
    isSessionTitleManuallySet: z.boolean().optional(),
  })
  .passthrough();

const TurnOutcomeSchema = z
  .object({
    turnId: z.string().optional(),
    reason: z.string().optional(),
    resultKind: z.string().optional(),
  })
  .passthrough();

const ContentBlockSchema = z.object({ type: z.string() }).passthrough();

/** `content` is a block array; a bare string is accepted defensively. */
const ContentSchema = z.union([z.string(), z.array(z.unknown())]);

// Several message fields are typed nullable so one null value cannot sink the
// whole message decode (`modelId` in particular is only ever an alias).
const nullableString = z.union([z.string(), z.null()]).optional();

const AgentMessageSchema = z
  .object({
    role: z.string(),
    content: ContentSchema.optional(),
    visibility: nullableString,
    interactionMode: nullableString,
    modelId: nullableString,
    reasoningEffort: nullableString,
    openaiMessageId: nullableString,
  })
  .passthrough();

const MessageLineSchema = z
  .object({ message: AgentMessageSchema.optional() })
  .passthrough();

const TokenUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheCreationTokens: z.number().optional(),
    thinkingTokens: z.number().optional(),
  })
  .passthrough();

const SettingsFileSchema = z
  .object({
    model: nullableString,
    reasoningEffort: nullableString,
    interactionMode: nullableString,
    autonomyLevel: nullableString,
    autonomyMode: nullableString,
    providerLock: nullableString,
    assistantActiveTimeMs: z.number().optional(),
    tokenUsage: TokenUsageSchema.optional(),
    inclusiveTokenUsage: TokenUsageSchema.optional(),
    childInclusiveTokenUsageBySessionId: z
      .record(z.string(), z.unknown())
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
 * Normalize one `tool_result.content` element to text. The capture always used
 * a plain string, but the Anthropic shape allows `{type:"text",text}` blocks
 * too, so both are accepted.
 */
function normalizeToolResultItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (isRecord(item)) {
    if (typeof item.text === "string") return item.text;
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

function decodeContentBlock(raw: unknown): DroidContent {
  const parsed = ContentBlockSchema.safeParse(raw);
  if (!parsed.success) return { kind: "other", type: "unknown" };
  const block = parsed.data;

  switch (block.type) {
    case "text": {
      return {
        kind: "text",
        text: typeof block.text === "string" ? block.text : "",
      };
    }
    case "thinking": {
      const out: DroidContent = {
        kind: "thinking",
        text: typeof block.thinking === "string" ? block.thinking : "",
      };
      if (typeof block.durationMs === "number")
        out.durationMs = block.durationMs;
      return out;
    }
    case "tool_use": {
      return {
        kind: "toolUse",
        callId: typeof block.id === "string" ? block.id : "",
        name: typeof block.name === "string" ? block.name : "",
        args: block.input ?? {},
      };
    }
    case "tool_result": {
      return {
        kind: "toolResult",
        callId: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
        output: normalizeToolResultContent(block.content),
        isError: block.is_error === true,
      };
    }
    default:
      return { kind: "other", type: block.type };
  }
}

/** Decode a `content` value (block array, or a bare string) into blocks. */
function decodeContent(content: unknown): DroidContent[] {
  const parsed = ContentSchema.safeParse(content);
  if (!parsed.success) return [];
  if (typeof parsed.data === "string")
    return parsed.data ? [{ kind: "text", text: parsed.data }] : [];
  return parsed.data.map(decodeContentBlock);
}

// ---------------------------------------------------------------------------
// Line + settings decoders
// ---------------------------------------------------------------------------

/** Parse an ISO timestamp to epoch ms, or undefined when malformed/absent. */
function decodeIsoMs(iso: string | undefined): number | undefined {
  if (typeof iso !== "string" || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Decode one raw JSONL line into a typed `DroidRecord`. Returns null when the
 * envelope is unrecognizable or a `message` line carries no message payload
 * (the shell records a warning and skips it). Unmodeled line types decode to
 * `{kind:"other"}` and are inert in the reducer.
 */
export function decodeLine(raw: unknown): DroidRecord | null {
  const envelope = LineEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return null;
  const { type, id, parentId, timestamp } = envelope.data;
  const tsMs = decodeIsoMs(timestamp);

  switch (type) {
    case "session_start": {
      const parsed = SessionStartSchema.safeParse(raw);
      const body: Extract<DroidRecordBody, { kind: "header" }> = {
        kind: "header",
      };
      if (parsed.success) {
        const h = parsed.data;
        if (typeof h.id === "string") body.sessionId = h.id;
        if (typeof h.title === "string") body.title = h.title;
        if (typeof h.owner === "string") body.owner = h.owner;
        if (typeof h.hostId === "string") body.hostId = h.hostId;
        if (typeof h.cwd === "string") body.cwd = h.cwd;
        if (typeof h.version === "number") body.storeVersion = h.version;
        if (typeof h.isSessionTitleManuallySet === "boolean")
          body.titleManuallySet = h.isSessionTitleManuallySet;
      }
      return tsMs !== undefined ? { ...body, tsMs } : body;
    }
    case "agent_turn_outcome": {
      const parsed = TurnOutcomeSchema.safeParse(raw);
      if (!parsed.success || typeof parsed.data.turnId !== "string")
        return { kind: "other", type };
      const body: Extract<DroidRecordBody, { kind: "turnOutcome" }> = {
        kind: "turnOutcome",
        turnId: parsed.data.turnId,
        reason:
          typeof parsed.data.reason === "string" ? parsed.data.reason : "",
      };
      if (typeof parsed.data.resultKind === "string")
        body.resultKind = parsed.data.resultKind;
      return tsMs !== undefined ? { ...body, tsMs } : body;
    }
    case "message": {
      const parsed = MessageLineSchema.safeParse(raw);
      if (!parsed.success || parsed.data.message === undefined) return null;
      const m = parsed.data.message;
      const body: Extract<DroidRecordBody, { kind: "message" }> = {
        kind: "message",
        role: m.role,
        contents: decodeContent(m.content),
      };
      if (typeof id === "string") body.messageId = id;
      if (typeof parentId === "string") body.parentId = parentId;
      if (typeof m.visibility === "string") body.visibility = m.visibility;
      if (typeof m.interactionMode === "string")
        body.interactionMode = m.interactionMode;
      if (typeof m.modelId === "string") body.modelId = m.modelId;
      if (typeof m.reasoningEffort === "string")
        body.reasoningEffort = m.reasoningEffort;
      return tsMs !== undefined ? { ...body, tsMs } : body;
    }
    default:
      return { kind: "other", type };
  }
}

/** Decode one usage object, or undefined when it is absent/unreadable. */
function decodeUsage(raw: unknown): DroidTokenUsage | undefined {
  if (raw === undefined) return undefined;
  const parsed = TokenUsageSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const u = parsed.data;
  return {
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheCreationTokens: u.cacheCreationTokens ?? 0,
    thinkingTokens: u.thinkingTokens ?? 0,
  };
}

/**
 * Decode the sibling `<uuid>.settings.json`. Returns an empty settings record
 * when the shape is unrecognizable — the settings file is enrichment, and a
 * session still parses from its JSONL alone.
 */
export function decodeSettingsFile(raw: unknown): DroidSessionSettings {
  const parsed = SettingsFileSchema.safeParse(raw);
  if (!parsed.success) return { childSessionIds: [] };
  const s = parsed.data;
  const settings: DroidSessionSettings = {
    childSessionIds: Object.keys(s.childInclusiveTokenUsageBySessionId ?? {}),
  };
  if (s.model != null) settings.model = s.model;
  if (s.reasoningEffort != null) settings.reasoningEffort = s.reasoningEffort;
  if (s.interactionMode != null) settings.interactionMode = s.interactionMode;
  if (s.autonomyLevel != null) settings.autonomyLevel = s.autonomyLevel;
  if (s.autonomyMode != null) settings.autonomyMode = s.autonomyMode;
  if (s.providerLock != null) settings.providerLock = s.providerLock;
  if (typeof s.assistantActiveTimeMs === "number")
    settings.assistantActiveTimeMs = s.assistantActiveTimeMs;
  const usage = decodeUsage(s.tokenUsage);
  if (usage !== undefined) settings.usage = usage;
  const inclusive = decodeUsage(s.inclusiveTokenUsage);
  if (inclusive !== undefined) settings.inclusiveUsage = inclusive;
  return settings;
}
