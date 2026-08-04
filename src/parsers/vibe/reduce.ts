/**
 * Pure session reducer for Mistral Vibe session logs.
 *
 * Takes the decoded `messages.jsonl` records (in file order) plus the decoded
 * `meta.json` sidecar and folds them into a canonical Session. No IO — the file
 * shell (index.ts) does the reads and hands records here.
 *
 * Reduction decisions specific to Vibe's store:
 *   - **No message carries a timestamp.** `messages.jsonl` records hold no time
 *     field of any kind, so `Message.ts` is left UNSET rather than back-filled
 *     from the session window: spreading `meta.json`'s `start_time` across every
 *     message would fabricate an ordering fact the store does not have. The
 *     session window itself (`startedAt` / `endedAt`) comes from the sidecar,
 *     which is the only place Vibe records time. This is the sharper constraint
 *     for a corpus than the (also absent) per-message token counts: without a
 *     per-message clock, nothing downstream can window a Vibe transcript.
 *   - **`reasoning_content` is inline on the assistant record**, not a separate
 *     line. It becomes its own `role:"thinking"` message emitted BEFORE the
 *     assistant text from the same record — stream order, the same shape every
 *     other dialect's thinking blocks reduce to — and is excluded from the
 *     assistant text so reasoning is never counted twice.
 *   - Tool correlation is cross-record: an assistant record's `tool_calls[].id`
 *     pairs with a later `role:"tool"` record's `tool_call_id`. Results are
 *     indexed first, then attached at the call site, so a tool record never
 *     emits a message of its own.
 *   - **A denied tool call is preserved as a cancelled call, not dropped.** When
 *     the user refuses a call, Vibe writes a `role:"tool"` record with the
 *     `tool_result` key ABSENT and `content` set to the sentinel
 *     `<user_cancellation>User cancelled the operation.</user_cancellation>`.
 *     That text is what the model actually received, so it is kept as the call's
 *     output and the call is marked `exitCode: 1`. A persisted result whose own
 *     `cancelled` flag is true is treated the same way. Dropping the call would
 *     erase the refusal; scoring it as a success would misreport it.
 *   - **`exitCode` is only set where the store states one.** `bash` results
 *     carry `output.returncode`, which maps straight through; a cancelled call
 *     is `1`. Every other tool records no status field — Vibe has no per-tool
 *     `is_error` — so their `exitCode` stays unset rather than assuming success.
 *   - **`injected` messages are kept at their recorded role.** The flag marks
 *     content Vibe itself added rather than the user typing it, but Vibe sends
 *     the message to the model under that role regardless
 *     (only the flag itself is stripped from the API payload). No injected
 *     message appeared in the validated capture, so re-roling or dropping them
 *     would be a policy built on zero observations. The flag survives verbatim
 *     in `rawEvents` for a consumer that wants to exclude CLI-authored turns.
 *   - **Turn end is derived, and it never sets a session status.** A turn closes
 *     on an assistant record that has content and no `tool_calls`; there is no
 *     terminal record and no status field anywhere in the store. `meta.json` is
 *     rewritten after every turn, so its `end_time` is "when the last turn
 *     ended", not "when the session finished" — the session is resumable and a
 *     quiet tail is not a completion. `status` is therefore left unset, for
 *     failed sessions too: an API error persists nothing at all (the user line
 *     is the whole file), so failure is indistinguishable from a session the
 *     user simply walked away from.
 *   - **Usage is session-level only.** `stats.session_prompt_tokens` →
 *     `inputTokens`, `session_completion_tokens` → `outputTokens`,
 *     `session_cached_tokens` → `cacheReadTokens`. The cached figure is the
 *     cached SHARE of the provider's prompt total, so `inputTokens` and
 *     `cacheReadTokens` overlap here by construction; netting them out would
 *     invent a breakdown Vibe never recorded. `session_cost` is a real number
 *     with no canonical home, as are the `tool_calls_*` tallies and the
 *     `last_turn_*` snapshot; all stay in `meta.json` beside
 *     `transcript.rawPath`.
 *   - **Model resolution goes through the config.** `config.active_model` is a
 *     local alias; `config.models[<alias>].name` is the upstream slug. The
 *     config dump is the CURRENT effective config, so only a session's last
 *     model is knowable and a mid-session switch is unrecoverable. An alias that
 *     does not resolve is reported as-is.
 *   - **Session linkage is one-directional.** `parent_session_id` maps to
 *     `parentSessionId`, which is the linkage the canonical schema models. The
 *     reverse index (`child_sessions[]`, each `{session_id, tool_call_id, agent,
 *     relative_path}`) has no canonical field and is not needed: a corpus that
 *     ingests the children recovers the same edges from their own
 *     `parentSessionId`.
 *   - `meta.json`'s `system_prompt` is NOT emitted as a message. Vibe
 *     deliberately keeps system messages out of `messages.jsonl`, so the
 *     transcript stays the conversation.
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
  stableStringify,
} from "../shared.js";
import type { IssueCollector } from "../types.js";
import type {
  VibeMessageRecord,
  VibeSessionMeta,
  VibeToolCall,
  VibeToolResult,
} from "./records.js";

/** Canonical id prefix stamped on Vibe sessions: `vibe--<sessionId>`. */
const ID_PREFIX = "vibe";

/** Exit code stamped on a call the user refused or Vibe marked cancelled. */
const CANCELLED_EXIT_CODE = 1;

/** What a tool record contributed, once paired with its call. */
interface ToolOutcome {
  /** The pretty text Vibe fed back to the model. */
  content: string;
  result?: VibeToolResult;
  /** True when `tool_result` was absent, or present with `cancelled` set. */
  cancelled: boolean;
}

/** Epoch ms → unix seconds. */
function msToSec(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * Output text for a tool call: the record's `content` is what the model saw, so
 * it wins. A result with no content falls back to stable JSON of the structured
 * `output` rather than reporting nothing.
 */
function outcomeText(outcome: ToolOutcome): string {
  if (outcome.content.length > 0) return outcome.content;
  const output = outcome.result?.output;
  if (output === undefined || Object.keys(output).length === 0) return "";
  return stableStringify(output);
}

/** Build a canonical ToolCall from a decoded call plus its paired outcome. */
function buildToolCall(
  call: VibeToolCall,
  outcome: ToolOutcome | undefined,
): ToolCall {
  // Fall back to the raw `arguments` string when it did not parse as JSON, so
  // the hash still distinguishes two different malformed payloads.
  const argsValue = call.args ?? call.argumentsRaw;
  const { argsHash, argsPreview } = hashArgs(argsValue);
  const tc: ToolCall = { name: call.name, argsHash, argsPreview };
  if (call.args !== undefined) tc.args = call.args;
  if (call.callId !== undefined) tc.callId = call.callId;
  if (outcome === undefined) return tc;

  const text = outcomeText(outcome);
  if (text.length > 0) {
    tc.outputFull = text;
    tc.outputPreview = text.slice(0, OUTPUT_PREVIEW_MAX);
    tc.outputBytes = Buffer.byteLength(text, "utf8");
    tc.outputSha = sha256Hex(text);
  }
  const durationSec = outcome.result?.durationSec;
  if (durationSec !== undefined && durationSec >= 0)
    tc.durationMs = Math.round(durationSec * 1000);

  if (outcome.cancelled) {
    tc.exitCode = CANCELLED_EXIT_CODE;
    return tc;
  }
  // Only `bash` states an exit status; nothing else in the store does.
  const returncode = outcome.result?.output.returncode;
  if (typeof returncode === "number" && Number.isInteger(returncode))
    tc.exitCode = returncode;
  return tc;
}

/** Canonical role for a decoded record, or null when it is not a message. */
function canonicalRole(role: string): Message["role"] | null {
  if (role === "assistant") return "assistant";
  if (role === "user") return "user";
  if (role === "system") return "system";
  return null;
}

/**
 * Build a canonical Session from a Vibe session directory.
 *
 * @param records   Decoded `messages.jsonl` lines in file order.
 * @param meta      Decoded `meta.json`, or undefined when absent/unreadable.
 * @param sessionId Resolved session id (meta `session_id`, or the directory name).
 * @param rawPath   Source `messages.jsonl` path; written to transcript.rawPath.
 * @param rawEvents Pre-built raw-event array from the shell.
 * @param collector Issue collector for degraded-decode warnings.
 * @returns Session, or null when no usable messages survive.
 */
export function buildSession(
  records: VibeMessageRecord[],
  meta: VibeSessionMeta | undefined,
  sessionId: string,
  rawPath: string,
  rawEvents: RawEvent[],
  collector: IssueCollector,
): Session | null {
  if (!sessionId) {
    collector.error("vibe session missing id", { path: rawPath });
    return null;
  }

  // Pass 1: index every tool record by the call id it answers. A result always
  // lands on a later line than the call that produced it.
  const outcomeByCallId = new Map<string, ToolOutcome>();
  for (const rec of records) {
    if (rec.role !== "tool" || rec.toolCallId === undefined) continue;
    outcomeByCallId.set(rec.toolCallId, {
      content: rec.text ?? "",
      // A missing `tool_result` key is Vibe's denied-call shape.
      cancelled: rec.toolResult === undefined || rec.toolResult.cancelled,
      ...(rec.toolResult !== undefined ? { result: rec.toolResult } : {}),
    });
  }

  const out: Message[] = [];
  let turn = 0;

  for (const rec of records) {
    // Tool records are consumed at their call site, never emitted.
    if (rec.role === "tool") continue;

    const role = canonicalRole(rec.role);
    if (role === null) {
      collector.warn(`skipping vibe message with unknown role "${rec.role}"`, {
        path: rawPath,
      });
      continue;
    }

    // Reasoning rides inline on the assistant record; it precedes the reply.
    const reasoning = rec.reasoning?.trim() ?? "";
    if (reasoning.length > 0) {
      turn += 1;
      out.push({ turn, role: "thinking", text: reasoning, toolCalls: [] });
    }

    const toolCalls = rec.toolCalls.map((call) =>
      buildToolCall(
        call,
        call.callId !== undefined
          ? outcomeByCallId.get(call.callId)
          : undefined,
      ),
    );
    const text = rec.text?.trim() ?? "";
    if (text.length === 0 && toolCalls.length === 0) continue;

    turn += 1;
    out.push({ turn, role, text, toolCalls });
  }

  if (out.length === 0) return null;

  const id = `${ID_PREFIX}--${sessionId}`;
  const stats = meta?.stats;
  const result: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "vibe",
    externalId: sessionId,
    transcript: {
      schemaVersion: SCHEMA_VERSION,
      messages: out,
      contentHash: buildContentHash(id, out),
      rawPath,
      rawEvents,
      ...(stats && stats.promptTokens > 0
        ? { inputTokens: stats.promptTokens }
        : {}),
      ...(stats && stats.completionTokens > 0
        ? { outputTokens: stats.completionTokens }
        : {}),
      ...(stats && stats.cachedTokens > 0
        ? { cacheReadTokens: stats.cachedTokens }
        : {}),
    },
  };

  if (meta?.workingDirectory !== undefined)
    result.projectPath = meta.workingDirectory;
  if (meta?.gitBranch !== undefined) result.gitBranch = meta.gitBranch;
  if (meta?.username !== undefined) result.author = meta.username;
  if (meta?.agentProfile !== undefined) result.agentType = meta.agentProfile;
  if (meta?.parentSessionId !== undefined)
    result.parentSessionId = `${ID_PREFIX}--${meta.parentSessionId}`;
  const model = meta?.modelName ?? meta?.modelAlias;
  if (model !== undefined) result.model = model;
  const title = meta?.title ?? deriveTitle(out);
  if (title) result.title = title;
  if (meta?.startedAtMs !== undefined)
    result.startedAt = msToSec(meta.startedAtMs);
  if (meta?.endedAtMs !== undefined) result.endedAt = msToSec(meta.endedAtMs);

  return result;
}
