/**
 * Pure session reducer for Factory Droid session logs.
 *
 * Takes the decoded JSONL records (in file order) plus the optional decoded
 * settings record and folds them into a canonical Session. No IO — the file
 * shell (index.ts) does the reads and hands records here.
 *
 * Reduction decisions specific to Droid's store:
 *   - **Injected context is dropped from the conversation.** Droid prepends each
 *     user turn with a synthetic `role:"user"` message
 *     (`visibility:"llm_only"`, id `context-<turnId>`) carrying its
 *     system-reminder bundle: current date, the skill and subagent catalogs, OS
 *     info, and the session-start environment commands rendered as prose. Nobody
 *     said any of it, so it is not a canonical message; it stays verbatim in
 *     `rawEvents` for anyone reconstructing the exact model input. `visibility`
 *     is the load-bearing signal, not the id prefix. The prose form is also why
 *     nothing here mines that bundle for git branch or model facts — parsing
 *     English for metadata would invent data the store does not structurally
 *     carry, so `gitBranch` is left unset.
 *   - **`visibility:"user_only"` notices become `role:"system"` messages.**
 *     Droid persists provider/config failures ("BYOK Error: 402 …") as
 *     `role:"user"` messages that were rendered to the human but never sent to
 *     the model. They are real session events, so they survive — but as system
 *     notices, because scoring them as user prompts would corrupt any count of
 *     what the user actually asked. A notice with `visibility:"both"` was in the
 *     model's context as a user-role message, so it stays a user message.
 *   - Tool results are cross-message. A `tool_use` block lands on an assistant
 *     message; its `tool_result` arrives on a later `role:"user"` message, paired
 *     by `tool_use_id` (Anthropic convention). Every result is indexed first,
 *     then attached to the call that made it, so a user message carrying only
 *     tool results emits no user message.
 *   - `thinking` blocks become their own `role:"thinking"` message in stream
 *     order, excluded from the assistant text. The assistant message's
 *     `chatCompletionReasoningContent` duplicates the same text and is ignored,
 *     so reasoning is never emitted twice.
 *   - **Turn end is explicit**: each turn closes with an `agent_turn_outcome`
 *     line whose `turnId` is the user message that opened it. A trailing
 *     `reason:"error"` outcome reports the session as `status:"failed"`; a
 *     trailing `completed` sets no status, because a completed turn only ends a
 *     turn — the file is append-only and `droid --resume` reopens it, so a quiet
 *     tail is not a finished session. Per-turn outcomes have no canonical home
 *     and stay in `rawEvents`, where `turnId` still resolves to a message id.
 *   - **Usage is session-level only** — Droid records no per-message tokens. The
 *     totals come from the sibling settings file's `tokenUsage`, this session's
 *     own spend. `inclusiveTokenUsage` rolls up the child sessions listed in
 *     `childInclusiveTokenUsageBySessionId`; using it would double-count every
 *     child a corpus also ingests, so it is decoded but not summed here.
 *   - **Model is an alias.** Droid records `custom:<displayName>-<index>` for a
 *     BYOK model in both the settings file and the per-message `modelId`, which
 *     echoes the alias rather than the provider's model id. The alias is
 *     reported as-is; the upstream slug is not recoverable from the store, so it
 *     is not guessed, and a null `modelId` simply leaves the model unset.
 *   - Timestamps: only `message` lines carry one (ISO-8601 UTC ms). The header
 *     and the turn-outcome lines have none, so session timing is the message
 *     window, in unix seconds.
 */

import type { Session } from "../../schemas/session.js";
import type { Message, RawEvent, ToolCall } from "../../schemas/transcript.js";
import { SCHEMA_VERSION } from "../../schemas/version.js";
import {
  buildContentHash,
  deriveTitle,
  hashArgs,
  OUTPUT_PREVIEW_MAX,
  sha256Hex,
} from "../shared.js";
import type { IssueCollector } from "../types.js";
import type {
  DroidContent,
  DroidRecord,
  DroidSessionSettings,
} from "./records.js";
import { VISIBILITY_LLM_ONLY, VISIBILITY_USER_ONLY } from "./records.js";

/** Canonical id prefix stamped on Droid sessions: `droid--<sessionId>`. */
const ID_PREFIX = "droid";

/** `agent_turn_outcome.reason` value marking a failed turn. */
const OUTCOME_ERROR = "error";

type ToolResultContent = Extract<DroidContent, { kind: "toolResult" }>;

/** Epoch ms → unix seconds. */
function msToSec(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Build a ToolCall from a `tool_use` block, filling output from its result. */
function buildToolCall(
  use: Extract<DroidContent, { kind: "toolUse" }>,
  result: ToolResultContent | undefined,
): ToolCall {
  const { argsHash, argsPreview } = hashArgs(use.args);
  const tc: ToolCall = {
    name: use.name,
    args: use.args,
    argsHash,
    argsPreview,
  };
  if (use.callId) tc.callId = use.callId;

  if (result) {
    if (result.output) {
      tc.outputBytes = Buffer.byteLength(result.output, "utf8");
      tc.outputSha = sha256Hex(result.output);
      tc.outputPreview = result.output.slice(0, OUTPUT_PREVIEW_MAX);
      tc.outputFull = result.output;
    }
    // Droid's per-tool error signal is `is_error`; the store carries no numeric
    // exit code for a tool call, so derive one from it.
    tc.exitCode = result.isError ? 1 : 0;
  }
  return tc;
}

/**
 * Canonical role for a decoded Droid message, or null when the message is not
 * conversation at all (the injected `llm_only` context bundle).
 */
function canonicalRole(
  role: string,
  visibility: string | undefined,
): Message["role"] | null {
  if (visibility === VISIBILITY_LLM_ONLY) return null;
  if (role === "assistant") return "assistant";
  if (role !== "user") return null;
  return visibility === VISIBILITY_USER_ONLY ? "system" : "user";
}

/**
 * Build a canonical Session from a Droid session log.
 *
 * @param records   Decoded lines in file order.
 * @param settings  Decoded `<uuid>.settings.json`, or undefined when absent.
 * @param sessionId Resolved session id (header id, or the filename fallback).
 * @param rawPath   Source `.jsonl` path; written to transcript.rawPath.
 * @param rawEvents Pre-built raw-event array from the shell.
 * @param collector Issue collector for degraded-decode warnings.
 * @returns Session, or null when no usable messages survive.
 */
export function buildSession(
  records: DroidRecord[],
  settings: DroidSessionSettings | undefined,
  sessionId: string,
  rawPath: string,
  rawEvents: RawEvent[],
  collector: IssueCollector,
): Session | null {
  if (!sessionId) {
    collector.error("droid session missing id", { path: rawPath });
    return null;
  }

  // Pass 1: index every tool result by its call id. Results ride on a later
  // user message than the call, so correlation has to be cross-message.
  const resultsByCallId = new Map<string, ToolResultContent>();
  for (const rec of records) {
    if (rec.kind !== "message") continue;
    for (const block of rec.contents) {
      if (block.kind === "toolResult" && block.callId)
        resultsByCallId.set(block.callId, block);
    }
  }

  const out: Message[] = [];
  let turn = 0;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let title: string | undefined;
  let owner: string | undefined;
  let projectPath: string | undefined;
  let modelFromMessage: string | undefined;
  let lastOutcomeReason: string | undefined;

  for (const rec of records) {
    if (rec.kind === "header") {
      if (rec.title) title = rec.title;
      if (rec.owner) owner = rec.owner;
      if (rec.cwd !== undefined) projectPath = rec.cwd;
      continue;
    }
    if (rec.kind === "turnOutcome") {
      lastOutcomeReason = rec.reason;
      continue;
    }
    if (rec.kind !== "message") continue;

    const role = canonicalRole(rec.role, rec.visibility);
    if (role === null) continue;
    if (role === "assistant" && modelFromMessage === undefined && rec.modelId)
      modelFromMessage = rec.modelId;

    const ts = rec.tsMs !== undefined ? msToSec(rec.tsMs) : undefined;
    if (ts !== undefined) {
      startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
      endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
    }

    // Walk blocks in stream order, staging emissions so a thinking block keeps
    // its position relative to the surrounding text and tool calls.
    type EmitItem =
      | { kind: "text"; text: string }
      | { kind: "thinking"; text: string }
      | { kind: "tool"; tc: ToolCall };
    const emissions: EmitItem[] = [];

    for (const block of rec.contents) {
      if (block.kind === "text") {
        if (block.text) emissions.push({ kind: "text", text: block.text });
      } else if (block.kind === "thinking") {
        const text = block.text.trim();
        if (text) emissions.push({ kind: "thinking", text });
      } else if (block.kind === "toolUse") {
        const result = block.callId
          ? resultsByCallId.get(block.callId)
          : undefined;
        emissions.push({ kind: "tool", tc: buildToolCall(block, result) });
      }
      // toolResult blocks are consumed at the tool_use site; `other` is inert.
    }

    const textBuf: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const item of emissions) {
      if (item.kind === "thinking") {
        turn += 1;
        const tm: Message = {
          turn,
          role: "thinking",
          text: item.text,
          toolCalls: [],
        };
        if (ts !== undefined) tm.ts = ts;
        out.push(tm);
      } else if (item.kind === "text") {
        textBuf.push(item.text);
      } else {
        toolCalls.push(item.tc);
      }
    }

    const text = textBuf.join("\n\n").trim();
    if (text.length === 0 && toolCalls.length === 0) {
      // A user message of pure tool results, or an empty assistant message.
      continue;
    }

    turn += 1;
    const m: Message = { turn, role, text, toolCalls };
    if (ts !== undefined) m.ts = ts;
    out.push(m);
  }

  if (out.length === 0) return null;

  const id = `${ID_PREFIX}--${sessionId}`;
  const contentHash = buildContentHash(id, out);
  // Session-level totals only; `inclusiveTokenUsage` is deliberately not used.
  const usage = settings?.usage;

  const result: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "droid",
    externalId: sessionId,
    transcript: {
      schemaVersion: SCHEMA_VERSION,
      messages: out,
      contentHash,
      rawPath,
      rawEvents,
      ...(usage && usage.inputTokens > 0
        ? { inputTokens: usage.inputTokens }
        : {}),
      ...(usage && usage.outputTokens > 0
        ? { outputTokens: usage.outputTokens }
        : {}),
      ...(usage && usage.cacheReadTokens > 0
        ? { cacheReadTokens: usage.cacheReadTokens }
        : {}),
      ...(usage && usage.cacheCreationTokens > 0
        ? { cacheCreationTokens: usage.cacheCreationTokens }
        : {}),
      ...(usage && usage.thinkingTokens > 0
        ? { reasoningTokens: usage.thinkingTokens }
        : {}),
    },
  };

  if (projectPath !== undefined) result.projectPath = projectPath;
  const model = settings?.model ?? modelFromMessage;
  if (model !== undefined) result.model = model;
  const resolvedTitle = title ?? deriveTitle(out);
  if (resolvedTitle) result.title = resolvedTitle;
  if (owner !== undefined) result.author = owner;
  if (lastOutcomeReason === OUTCOME_ERROR) result.status = "failed";
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (endedAt !== undefined) result.endedAt = endedAt;

  return result;
}
