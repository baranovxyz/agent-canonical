/**
 * Pure session reducer for Pi session logs.
 *
 * Takes the decoded JSONL records (in file order) and folds them into a
 * canonical Session. No IO — the file shell (index.ts) does the read and hands
 * records here.
 *
 * Reduction decisions specific to Pi's store:
 *   - **Traversal is file order, not active-path.** Pi entries form a DAG
 *     (`id`/`parentId`) and support in-place branching: a second child of the
 *     same parent starts a new branch and nothing earlier is rewritten. Pi's own
 *     reader walks back from the current leaf, so it displays only the active
 *     path. This reducer instead keeps every entry, in file order — the same
 *     policy the claude-code parser applies to its `uuid`/`parentUuid` DAG —
 *     because a transcript corpus records what actually happened, including the
 *     tokens spent on an abandoned branch. The full `id`/`parentId` chain stays
 *     verbatim in `rawEvents`, so a consumer that wants only the active path can
 *     reconstruct it.
 *   - Tool results are cross-record. A call is issued as a `toolCall` block on
 *     an assistant message; its output arrives in a later `toolResult` entry,
 *     paired by `toolCallId`. Every result is indexed first, then attached to
 *     the call that made it.
 *   - `thinking` blocks become their own `role:"thinking"` message in stream
 *     order, before the assistant message they preceded, and are excluded from
 *     the assistant text.
 *   - `bashExecution` is the TUI's `!cmd` shell escape — the user ran it, not
 *     the model. It becomes a `role:"user"` message whose text is the literal
 *     `!command` typed, carrying one synthetic `pi_bash` tool call with the
 *     captured output and exit code. (`cancelled`, `truncated`, and
 *     `excludeFromContext` have no canonical home and survive in `rawEvents`.)
 *   - An errored turn (`stopReason:"error"`, empty content, zeroed usage) keeps
 *     its `errorMessage` as a `role:"system"` message, and a session whose last
 *     assistant turn errored is reported as `status:"failed"`. Nothing else sets
 *     a status: a Pi file is append-only and `--continue` reopens it, so a
 *     quiet tail does not mean the session completed.
 *   - There is no session-level usage aggregate, so transcript totals are the
 *     sum of per-message `usage`. Pi's `cost` object has no canonical field and
 *     survives only in `rawEvents`.
 *   - Timestamps: canonical `ts`/`startedAt`/`endedAt` are unix seconds, taken
 *     from the entry-level ISO timestamp (the message-level Unix-ms one is the
 *     request start and is kept only in `rawEvents`).
 */

import type { Session } from "../../schemas/session.js";
import type {
  Message,
  MessageUsage,
  RawEvent,
  ToolCall,
} from "../../schemas/transcript.js";
import { SCHEMA_VERSION } from "../../schemas/version.js";
import {
  buildContentHash,
  deriveTitle,
  hashArgs,
  OUTPUT_PREVIEW_MAX,
  sha256Hex,
} from "../shared.js";
import type { IssueCollector } from "../types.js";
import type { PiRecord, PiToolCall } from "./records.js";

/** Canonical id prefix stamped on Pi sessions: `pi--<sessionId>`. */
const ID_PREFIX = "pi";

/** Synthetic tool name for the TUI's `!cmd` shell escape (`bashExecution`). */
const BASH_TOOL_NAME = "pi_bash";

/** Epoch ms → unix seconds. */
function msToSec(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Attach a captured output blob to a tool call (preview + hash + full). */
function attachOutput(tc: ToolCall, output: string): void {
  if (output.length === 0) return;
  tc.outputBytes = Buffer.byteLength(output, "utf8");
  tc.outputSha = sha256Hex(output);
  tc.outputPreview = output.slice(0, OUTPUT_PREVIEW_MAX);
  tc.outputFull = output;
}

/** Build a ToolCall from a `toolCall` block, filling in its paired result. */
function buildToolCall(
  call: PiToolCall,
  result: Extract<PiRecord, { kind: "toolResult" }> | undefined,
): ToolCall {
  const { argsHash, argsPreview } = hashArgs(call.args);
  const tc: ToolCall = {
    name: call.name,
    args: call.args,
    argsHash,
    argsPreview,
  };
  if (call.callId) tc.callId = call.callId;
  if (result) {
    attachOutput(tc, result.output);
    // Pi's per-tool error signal is `isError`; the store carries no numeric
    // exit code for model tool calls, so derive one.
    tc.exitCode = result.isError ? 1 : 0;
  }
  return tc;
}

/** Build the synthetic `pi_bash` tool call for a `bashExecution` record. */
function buildBashToolCall(
  rec: Extract<PiRecord, { kind: "bashExecution" }>,
): ToolCall {
  const args = { command: rec.command };
  const { argsHash, argsPreview } = hashArgs(args);
  const tc: ToolCall = {
    name: BASH_TOOL_NAME,
    args,
    argsHash,
    argsPreview,
  };
  if (rec.entryId) tc.callId = rec.entryId;
  attachOutput(tc, rec.output);
  if (rec.exitCode !== undefined) tc.exitCode = rec.exitCode;
  return tc;
}

/**
 * Build a canonical Session from a Pi session log.
 *
 * @param records   Decoded entries in file order.
 * @param sessionId Resolved session id (header id, or the filename fallback).
 * @param rawPath   Source `.jsonl` path; written to transcript.rawPath.
 * @param rawEvents Pre-built raw-event array from the shell.
 * @param collector Issue collector for degraded-decode warnings.
 * @returns Session, or null when no usable messages survive.
 */
export function buildSession(
  records: PiRecord[],
  sessionId: string,
  rawPath: string,
  rawEvents: RawEvent[],
  collector: IssueCollector,
): Session | null {
  if (!sessionId) {
    collector.error("pi session missing id", { path: rawPath });
    return null;
  }

  // Pass 1: index every tool result by its call id. Results follow their call
  // in file order today, but indexing first keeps branch reordering safe.
  const resultsByCallId = new Map<
    string,
    Extract<PiRecord, { kind: "toolResult" }>
  >();
  for (const rec of records) {
    if (rec.kind === "toolResult") resultsByCallId.set(rec.callId, rec);
  }

  const out: Message[] = [];
  let turn = 0;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let projectPath: string | undefined;
  let title: string | undefined;
  let modelFromAssistant: string | undefined;
  let modelFromChange: string | undefined;
  let lastAssistantErrored = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;

  const noteTime = (ts: number | undefined) => {
    if (ts === undefined) return;
    startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
    endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
  };

  const push = (
    role: Message["role"],
    text: string,
    ts: number | undefined,
    toolCalls: ToolCall[] = [],
  ): Message => {
    turn += 1;
    const m: Message = { turn, role, text, toolCalls };
    if (ts !== undefined) m.ts = ts;
    out.push(m);
    return m;
  };

  for (const rec of records) {
    const ts = rec.tsMs !== undefined ? msToSec(rec.tsMs) : undefined;
    noteTime(ts);

    switch (rec.kind) {
      case "header": {
        if (rec.cwd !== undefined) projectPath = rec.cwd;
        break;
      }
      case "modelChange": {
        modelFromChange = rec.model;
        break;
      }
      case "sessionInfo": {
        // `session_info` is the only title source; the newest name wins.
        if (rec.name) title = rec.name;
        break;
      }
      case "summary": {
        const text = rec.text.trim();
        if (text) push("system", text, ts);
        break;
      }
      case "user": {
        const text = rec.text.trim();
        if (text) push("user", text, ts);
        break;
      }
      case "bashExecution": {
        // The user's `!cmd` escape: keep what they typed as the message text.
        push("user", `!${rec.command}`, ts, [buildBashToolCall(rec)]);
        break;
      }
      case "assistant": {
        if (rec.model) modelFromAssistant = rec.model;
        lastAssistantErrored = rec.stopReason === "error";

        if (rec.usage) {
          inputTokens += rec.usage.inputTokens;
          outputTokens += rec.usage.outputTokens;
          cacheReadTokens += rec.usage.cacheReadTokens;
          cacheCreationTokens += rec.usage.cacheWriteTokens;
          reasoningTokens += rec.usage.reasoningTokens;
        }
        const usage: MessageUsage | undefined = rec.usage
          ? {
              inputTokens: rec.usage.inputTokens,
              outputTokens: rec.usage.outputTokens,
              cacheReadTokens: rec.usage.cacheReadTokens,
              cacheCreationTokens: rec.usage.cacheWriteTokens,
              reasoningTokens: rec.usage.reasoningTokens,
            }
          : undefined;

        // Thinking precedes the reply it reasoned toward.
        let lastThinking: Message | undefined;
        for (const thinking of rec.thinking) {
          const text = thinking.trim();
          if (text) lastThinking = push("thinking", text, ts);
        }

        const toolCalls = rec.toolCalls.map((call) =>
          buildToolCall(
            call,
            call.callId ? resultsByCallId.get(call.callId) : undefined,
          ),
        );

        const text = rec.text.trim();
        let assistantMsg: Message | undefined;
        if (text.length > 0 || toolCalls.length > 0)
          assistantMsg = push("assistant", text, ts, toolCalls);

        // Usage belongs to the assistant message; when a turn produced only
        // reasoning it lands on the last thinking message instead.
        if (usage !== undefined) {
          if (assistantMsg) assistantMsg.usage = usage;
          else if (lastThinking) lastThinking.usage = usage;
        }

        // An errored turn persists its message but no content.
        if (rec.errorMessage) push("system", rec.errorMessage, ts);
        break;
      }
      // toolResult is consumed at its call site; `other` records are inert.
      default:
        break;
    }
  }

  if (out.length === 0) return null;

  const id = `${ID_PREFIX}--${sessionId}`;
  const contentHash = buildContentHash(id, out);

  const result: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "pi",
    externalId: sessionId,
    transcript: {
      schemaVersion: SCHEMA_VERSION,
      messages: out,
      contentHash,
      rawPath,
      rawEvents,
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    },
  };

  if (projectPath !== undefined) result.projectPath = projectPath;
  const model = modelFromAssistant ?? modelFromChange;
  if (model !== undefined) result.model = model;
  const resolvedTitle = title ?? deriveTitle(out);
  if (resolvedTitle) result.title = resolvedTitle;
  if (lastAssistantErrored) result.status = "failed";
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (endedAt !== undefined) result.endedAt = endedAt;

  return result;
}
