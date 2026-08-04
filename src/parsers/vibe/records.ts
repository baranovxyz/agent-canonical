/**
 * Wire schemas + decoders for Mistral Vibe's per-session store.
 *
 * All Vibe format knowledge lives here. The file shell (index.ts) reads the two
 * files a session directory holds and hands each parsed value over; the reducer
 * (reduce.ts) folds the typed records into a canonical Session. Decoding is pure
 * (no IO), so it belongs with the decoders.
 *
 * Vibe (`mistral-vibe` on PyPI, binary `vibe`, open source) writes each session
 * as a directory under `~/.vibe/logs/session/`, named
 * `<prefix>_<YYYYmmdd_HHMMSS>_<first-8-of-uuid>` (prefix is configurable and
 * defaults to `session`), holding exactly two files:
 *   - `messages.jsonl` — one raw OpenAI chat-completions message per line.
 *   - `meta.json`      — the session sidecar, rewritten atomically after every
 *     turn (temp file + rename).
 * A `.last_session/<tty>` pointer file sits at the store root beside the session
 * directories; it holds a session uuid, not session content, and is ignored.
 *
 * `messages.jsonl` lines are pydantic dumps with `exclude_none`, so an absent
 * key is the norm rather than the exception, and NOTHING in the file carries a
 * timestamp, a per-message token count, or a per-message model. Roles are
 * `user` | `assistant` | `tool`; the system prompt is deliberately not written
 * to the JSONL (it lives in `meta.json`'s `system_prompt`). Line flavors:
 *   - text turn      — `{role, content, injected, message_id}`.
 *   - reasoning turn — the same, plus `reasoning_content` and
 *     `reasoning_message_id` INLINE on the assistant record (`reasoning_state`
 *     and `reasoning_signature` are declared upstream but were unset here).
 *   - tool call      — an assistant record with NO `content` key and
 *     `tool_calls: [{id, index, function: {name, arguments}, type, presentation}]`,
 *     where `arguments` is a JSON **string**, not an object.
 *   - tool result    — `{role: "tool", content, name, tool_call_id, tool_result}`
 *     with `tool_result: {output, duration, cancelled, presentation}`. `content`
 *     is the pretty text the model saw; `output` is the tool-specific structured
 *     payload (for `bash`: `{command, stdout, stderr, returncode}`).
 *   - denied tool    — `{role: "tool", content, name, tool_call_id}` with NO
 *     `tool_result` key at all, and `content` set to the sentinel
 *     `<user_cancellation>User cancelled the operation.</user_cancellation>`.
 * A turn whose API call errored persists nothing: only the user line survives.
 *
 * `presentation` (on a tool call and inside `tool_result`) is a pure UI sidecar
 * — verbs, summaries, and status strings for the TUI. It is never decoded into
 * canonical fields; it survives verbatim in `rawEvents`.
 *
 * Tool correlation is cross-record: an assistant record's `tool_calls[].id`
 * pairs with a later `role:"tool"` record's `tool_call_id`.
 *
 * `meta.json` carries everything the JSONL does not: `session_id` (the full
 * uuid, of which the directory name keeps only the first 8 characters),
 * `parent_session_id`, `start_time` / `end_time` (ISO-8601 with offset and
 * microseconds), `git_commit`, `git_branch`, `environment.working_directory`,
 * `username`, `child_sessions` (subagent links), `title` + `title_source`,
 * `agent_profile`, `stats` (session-cumulative tokens plus a `last_turn_*`
 * snapshot and tool-call tallies), `total_messages`,
 * `last_message_fingerprint`, `tools_available`, the full effective `config`,
 * and `system_prompt`. There is no schema or format version field anywhere.
 *
 * The model is recoverable only through the config: `config.active_model` is an
 * ALIAS, and `config.models` maps alias → `{name, provider, …}`, so the upstream
 * slug is `config.models[config.active_model].name`. Because the config dump is
 * the CURRENT effective config, only the last model of a session is knowable —
 * a mid-session model switch leaves no trace.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Decoded records — the reducer's input vocabulary
// ---------------------------------------------------------------------------

/** One decoded entry from an assistant record's `tool_calls` array. */
export interface VibeToolCall {
  /** `tool_calls[].id`; pairs with a later tool record's `tool_call_id`. */
  callId?: string;
  /** Position within the assistant record's `tool_calls` array. */
  index?: number;
  name: string;
  /** `function.arguments` verbatim — Vibe stores it as a JSON string. */
  argumentsRaw?: string;
  /** `argumentsRaw` parsed as JSON; undefined when absent or malformed. */
  args?: unknown;
}

/** The `tool_result` object on a tool record that actually ran. */
export interface VibeToolResult {
  /** Tool-specific structured payload (`bash` → command/stdout/stderr/returncode). */
  output: Record<string, unknown>;
  /** Wall-clock seconds the tool ran, as recorded. */
  durationSec?: number;
  /** Vibe's own cancellation flag on a result it still persisted. */
  cancelled: boolean;
}

/** One decoded `messages.jsonl` line. */
export interface VibeMessageRecord {
  /** `user` | `assistant` | `tool`, or whatever else the store held. */
  role: string;
  /** `content`; absent on an assistant record that only issues tool calls. */
  text?: string;
  /** `reasoning_content`, inline on the assistant record that produced it. */
  reasoning?: string;
  reasoningMessageId?: string;
  messageId?: string;
  /** True when Vibe itself added this message, rather than the user typing it. */
  injected: boolean;
  /** Tool name, on a `role:"tool"` record. */
  toolName?: string;
  /** `tool_call_id`, on a `role:"tool"` record. */
  toolCallId?: string;
  /** Empty unless this is an assistant record issuing calls. */
  toolCalls: VibeToolCall[];
  /** Absent on a denied call — the key itself is missing from the line. */
  toolResult?: VibeToolResult;
}

/** Session-cumulative counters from `meta.json`'s `stats`. */
export interface VibeSessionStats {
  /** `session_prompt_tokens` — the provider's prompt total for the session. */
  promptTokens: number;
  /** `session_completion_tokens`. */
  completionTokens: number;
  /** `session_cached_tokens` — the cached share of the prompt total. */
  cachedTokens: number;
  /** `steps` — agent loop iterations, not turns. */
  steps: number;
  /** `session_cost` in dollars; priced from the CURRENT model's rates. */
  cost: number;
  toolCallsAgreed: number;
  toolCallsRejected: number;
  toolCallsFailed: number;
  toolCallsSucceeded: number;
}

/** One `child_sessions` entry: a subagent session spawned from a tool call. */
export interface VibeChildSessionLink {
  sessionId: string;
  /** The tool call that spawned it. */
  toolCallId?: string;
  /** Agent profile name the child ran under. */
  agent?: string;
  relativePath?: string;
}

/** Decoded `meta.json` — the session sidecar. */
export interface VibeSessionMeta {
  /** Full session uuid; the directory name keeps only its first 8 characters. */
  sessionId?: string;
  parentSessionId?: string;
  /** `start_time` as epoch ms. */
  startedAtMs?: number;
  /** `end_time` as epoch ms. */
  endedAtMs?: number;
  gitBranch?: string;
  /** Commit HEAD was on; the canonical schema has no field for it. */
  gitCommit?: string;
  workingDirectory?: string;
  username?: string;
  title?: string;
  /** `auto` when Vibe derived the title, `manual` when the user set it. */
  titleSource?: string;
  /** `agent_profile.name` — the profile the session ran under. */
  agentProfile?: string;
  /** `total_messages` — Vibe's own count of non-system messages. */
  totalMessages?: number;
  /** `config.active_model` — a local alias, not an upstream slug. */
  modelAlias?: string;
  /** `config.models[<alias>].name`, when the alias resolves. */
  modelName?: string;
  stats?: VibeSessionStats;
  childSessions: VibeChildSessionLink[];
}

/** Sentinel Vibe writes as the content of a tool call the user refused. */
export const USER_CANCELLATION_MARKER = "<user_cancellation>";

/** Filenames a Vibe session directory holds. */
export const MESSAGES_FILENAME = "messages.jsonl";
export const METADATA_FILENAME = "meta.json";

// ---------------------------------------------------------------------------
// Wire schemas — declare only what we read; passthrough the unstable rest
// ---------------------------------------------------------------------------

/** Several fields are typed nullable so one null cannot sink a whole decode. */
const nullableString = z.union([z.string(), z.null()]).optional();
const nullableNumber = z.union([z.number(), z.null()]).optional();

const FunctionCallSchema = z
  .object({
    name: nullableString,
    /** A JSON string, per the OpenAI wire format — never an object. */
    arguments: nullableString,
  })
  .passthrough();

const ToolCallSchema = z
  .object({
    id: nullableString,
    index: nullableNumber,
    function: FunctionCallSchema.optional(),
    type: nullableString,
  })
  .passthrough();

const ToolResultSchema = z
  .object({
    output: z.record(z.string(), z.unknown()).optional(),
    duration: nullableNumber,
    cancelled: z.union([z.boolean(), z.null()]).optional(),
  })
  .passthrough();

const MessageLineSchema = z
  .object({
    role: z.string(),
    content: nullableString,
    injected: z.union([z.boolean(), z.null()]).optional(),
    reasoning_content: nullableString,
    reasoning_message_id: nullableString,
    message_id: nullableString,
    name: nullableString,
    tool_call_id: nullableString,
    tool_calls: z.union([z.array(z.unknown()), z.null()]).optional(),
    tool_result: z.unknown().optional(),
  })
  .passthrough();

const StatsSchema = z
  .object({
    steps: nullableNumber,
    session_prompt_tokens: nullableNumber,
    session_completion_tokens: nullableNumber,
    session_cached_tokens: nullableNumber,
    session_cost: nullableNumber,
    tool_calls_agreed: nullableNumber,
    tool_calls_rejected: nullableNumber,
    tool_calls_failed: nullableNumber,
    tool_calls_succeeded: nullableNumber,
  })
  .passthrough();

const ChildSessionSchema = z
  .object({
    session_id: z.string(),
    tool_call_id: nullableString,
    agent: nullableString,
    relative_path: nullableString,
  })
  .passthrough();

const ModelEntrySchema = z
  .object({ name: nullableString, alias: nullableString })
  .passthrough();

/**
 * `config.models` is a mapping of alias → model entry. An array of entries is
 * accepted too: the alias also rides inside each entry, so a future list form
 * still resolves.
 */
const ModelsSchema = z.union([
  z.record(z.string(), ModelEntrySchema),
  z.array(ModelEntrySchema),
]);

const ConfigSchema = z
  .object({
    active_model: nullableString,
    models: ModelsSchema.optional(),
  })
  .passthrough();

const MetaFileSchema = z
  .object({
    session_id: nullableString,
    parent_session_id: nullableString,
    start_time: nullableString,
    end_time: nullableString,
    git_commit: nullableString,
    git_branch: nullableString,
    environment: z
      .union([z.record(z.string(), z.unknown()), z.null()])
      .optional(),
    username: nullableString,
    title: nullableString,
    title_source: nullableString,
    total_messages: nullableNumber,
    agent_profile: z
      .union([z.record(z.string(), z.unknown()), z.null()])
      .optional(),
    child_sessions: z.union([z.array(z.unknown()), z.null()]).optional(),
    stats: z.unknown().optional(),
    config: z.unknown().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Message decoding
// ---------------------------------------------------------------------------

/**
 * Parse a `function.arguments` JSON string. Vibe always writes an object, but a
 * truncated or non-JSON value must degrade to "no decoded args" rather than
 * throw — the raw string is kept either way.
 */
function parseArguments(raw: string | undefined): unknown {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function decodeToolCall(raw: unknown): VibeToolCall | null {
  const parsed = ToolCallSchema.safeParse(raw);
  if (!parsed.success) return null;
  const tc = parsed.data;
  const fnName = tc.function?.name;
  const call: VibeToolCall = { name: typeof fnName === "string" ? fnName : "" };
  if (typeof tc.id === "string") call.callId = tc.id;
  if (typeof tc.index === "number") call.index = tc.index;
  const rawArgs = tc.function?.arguments;
  if (typeof rawArgs === "string") {
    call.argumentsRaw = rawArgs;
    const args = parseArguments(rawArgs);
    if (args !== undefined) call.args = args;
  }
  return call;
}

/** Decode a `tool_result` object, or undefined when the key is absent/unusable. */
function decodeToolResult(raw: unknown): VibeToolResult | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = ToolResultSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const out: VibeToolResult = {
    output: r.output ?? {},
    cancelled: r.cancelled === true,
  };
  if (typeof r.duration === "number") out.durationSec = r.duration;
  return out;
}

/**
 * Decode one raw `messages.jsonl` line into a typed record. Returns null when
 * the line is not a message object at all (the shell records a warning and
 * skips it).
 */
export function decodeMessageLine(raw: unknown): VibeMessageRecord | null {
  const parsed = MessageLineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;

  const record: VibeMessageRecord = {
    role: m.role,
    injected: m.injected === true,
    toolCalls: [],
  };
  if (typeof m.content === "string") record.text = m.content;
  if (typeof m.reasoning_content === "string")
    record.reasoning = m.reasoning_content;
  if (typeof m.reasoning_message_id === "string")
    record.reasoningMessageId = m.reasoning_message_id;
  if (typeof m.message_id === "string") record.messageId = m.message_id;
  if (typeof m.name === "string") record.toolName = m.name;
  if (typeof m.tool_call_id === "string") record.toolCallId = m.tool_call_id;
  for (const rawCall of m.tool_calls ?? []) {
    const call = decodeToolCall(rawCall);
    if (call !== null) record.toolCalls.push(call);
  }
  const toolResult = decodeToolResult(m.tool_result);
  if (toolResult !== undefined) record.toolResult = toolResult;
  return record;
}

// ---------------------------------------------------------------------------
// Metadata decoding
// ---------------------------------------------------------------------------

/** Parse an ISO timestamp to epoch ms, or undefined when malformed/absent. */
function decodeIsoMs(iso: string | null | undefined): number | undefined {
  if (typeof iso !== "string" || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

function decodeStats(raw: unknown): VibeSessionStats | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = StatsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const s = parsed.data;
  const num = (v: number | null | undefined): number =>
    typeof v === "number" ? v : 0;
  return {
    promptTokens: num(s.session_prompt_tokens),
    completionTokens: num(s.session_completion_tokens),
    cachedTokens: num(s.session_cached_tokens),
    steps: num(s.steps),
    cost: num(s.session_cost),
    toolCallsAgreed: num(s.tool_calls_agreed),
    toolCallsRejected: num(s.tool_calls_rejected),
    toolCallsFailed: num(s.tool_calls_failed),
    toolCallsSucceeded: num(s.tool_calls_succeeded),
  };
}

/**
 * Resolve the model from the effective config: `active_model` is an alias into
 * `config.models`, whose entry carries the upstream `name`. Returns the alias
 * even when it does not resolve — the alias is what the store recorded, and
 * guessing a slug would invent data.
 */
function decodeModel(raw: unknown): { alias?: string; name?: string } {
  if (raw === undefined || raw === null) return {};
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return {};
  const alias = parsed.data.active_model;
  if (typeof alias !== "string" || alias.length === 0) return {};

  const models = parsed.data.models;
  let name: string | undefined;
  if (Array.isArray(models)) {
    const hit = models.find((e) => e.alias === alias);
    if (typeof hit?.name === "string") name = hit.name;
  } else if (models !== undefined) {
    const hit = models[alias];
    if (typeof hit?.name === "string") name = hit.name;
  }
  return name !== undefined ? { alias, name } : { alias };
}

function decodeChildSessions(raw: unknown): VibeChildSessionLink[] {
  if (!Array.isArray(raw)) return [];
  const links: VibeChildSessionLink[] = [];
  for (const entry of raw) {
    const parsed = ChildSessionSchema.safeParse(entry);
    if (!parsed.success) continue;
    const link: VibeChildSessionLink = { sessionId: parsed.data.session_id };
    if (typeof parsed.data.tool_call_id === "string")
      link.toolCallId = parsed.data.tool_call_id;
    if (typeof parsed.data.agent === "string") link.agent = parsed.data.agent;
    if (typeof parsed.data.relative_path === "string")
      link.relativePath = parsed.data.relative_path;
    links.push(link);
  }
  return links;
}

/**
 * Decode `meta.json`. Returns an empty record when the shape is unrecognizable
 * — the sidecar is enrichment, and a session still parses from its JSONL alone.
 */
export function decodeMetaFile(raw: unknown): VibeSessionMeta {
  const parsed = MetaFileSchema.safeParse(raw);
  if (!parsed.success) return { childSessions: [] };
  const m = parsed.data;

  const meta: VibeSessionMeta = {
    childSessions: decodeChildSessions(m.child_sessions),
  };
  if (typeof m.session_id === "string") meta.sessionId = m.session_id;
  if (typeof m.parent_session_id === "string")
    meta.parentSessionId = m.parent_session_id;
  const startedAtMs = decodeIsoMs(m.start_time);
  if (startedAtMs !== undefined) meta.startedAtMs = startedAtMs;
  const endedAtMs = decodeIsoMs(m.end_time);
  if (endedAtMs !== undefined) meta.endedAtMs = endedAtMs;
  if (typeof m.git_branch === "string") meta.gitBranch = m.git_branch;
  if (typeof m.git_commit === "string") meta.gitCommit = m.git_commit;
  if (typeof m.username === "string") meta.username = m.username;
  if (typeof m.title === "string") meta.title = m.title;
  if (typeof m.title_source === "string") meta.titleSource = m.title_source;
  if (typeof m.total_messages === "number")
    meta.totalMessages = m.total_messages;

  const cwd = m.environment?.working_directory;
  if (typeof cwd === "string") meta.workingDirectory = cwd;
  const profile = m.agent_profile?.name;
  if (typeof profile === "string") meta.agentProfile = profile;

  const stats = decodeStats(m.stats);
  if (stats !== undefined) meta.stats = stats;
  const model = decodeModel(m.config);
  if (model.alias !== undefined) meta.modelAlias = model.alias;
  if (model.name !== undefined) meta.modelName = model.name;
  return meta;
}
