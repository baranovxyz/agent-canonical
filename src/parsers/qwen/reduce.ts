/**
 * Pure session reducer for the Qwen Code parser: DecodedEvent stream → Session.
 *
 * Qwen writes one complete record per message (unlike Claude Code, which
 * re-emits one message.id across per-block streaming events), so the reducer is
 * a single linear pass:
 *   - user / assistant records become messages;
 *   - an assistant record's `thought` text becomes its own role:"thinking"
 *     message, ordered before the visible reply;
 *   - `functionCall` parts become tool calls, correlated to their `tool_result`
 *     record (a separate line) by call id — the result folds its output into
 *     the assistant's ToolCall, not a standalone message;
 *   - `system` records are dropped (captured only in rawEvents).
 *
 * Turn numbers are assigned in a final pass so numbering stays gap-free.
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
import type { DecodedEvent, DecodedToolCall, QwenMeta } from "./events.js";

// Message before its final turn number is assigned.
type PendingMessage = Omit<Message, "turn">;

export interface ReduceResult {
  sessionId: string | undefined;
  projectPath: string | undefined;
  gitBranch: string | undefined;
  model: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  messages: Message[];
  rawEvents: RawEvent[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

function buildToolCall(dtc: DecodedToolCall): ToolCall {
  const { argsHash, argsPreview } = hashArgs(dtc.args);
  const tc: ToolCall = {
    name: dtc.name,
    args: dtc.args,
    argsHash,
    argsPreview,
  };
  if (dtc.callId !== undefined) tc.callId = dtc.callId;
  return tc;
}

/**
 * Fold a decoded Qwen event stream into a `ReduceResult`. Pure — the only
 * side effect is `collector` warnings (accepted for symmetry; the decoder
 * emits the per-line issues).
 */
export function reduceEvents(
  events: DecodedEvent[],
  rawLines: string[],
  _collector: IssueCollector,
): ReduceResult {
  let sessionId: string | undefined;
  let projectPath: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let startedAt: number | undefined;
  let endedAt: number | undefined;

  const messages: PendingMessage[] = [];
  const rawEvents: RawEvent[] = [];
  // functionCall id → its ToolCall, awaiting the matching tool_result record.
  const pendingToolCalls = new Map<string, ToolCall>();

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let reasoningTokens = 0;

  const foldTs = (ts: number | undefined): void => {
    if (ts === undefined || !Number.isFinite(ts)) return;
    startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
    endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
  };

  const absorbMeta = (meta: QwenMeta): void => {
    sessionId ??= meta.sessionId;
    projectPath ??= meta.cwd;
    gitBranch ??= meta.gitBranch;
  };

  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq];
    if (event === undefined) continue;
    const rawLine = rawLines[seq];

    // Lossless rawEvents tier + session-level metadata from every record.
    if (event.kind !== "malformed") {
      foldTs(event.ts);
      absorbMeta(event.meta);
      if (rawLine !== undefined) {
        const rawEv: RawEvent = { seq, rawJson: rawLine };
        if (event.ts !== undefined && Number.isFinite(event.ts))
          rawEv.ts = event.ts;
        const et = rawEventType(event);
        if (et !== undefined) rawEv.eventType = et;
        rawEvents.push(rawEv);
      }
    } else if (rawLine !== undefined) {
      rawEvents.push({ seq, rawJson: rawLine });
    }

    switch (event.kind) {
      case "user": {
        const msg: PendingMessage = {
          role: "user",
          text: event.text,
          toolCalls: [],
        };
        if (event.ts !== undefined) msg.ts = event.ts;
        messages.push(msg);
        break;
      }
      case "assistant": {
        if (model === undefined && event.model) model = event.model;

        // Reasoning becomes its own thinking message, before the reply.
        if (event.thoughtText) {
          const thinking: PendingMessage = {
            role: "thinking",
            text: event.thoughtText,
            toolCalls: [],
          };
          if (event.ts !== undefined) thinking.ts = event.ts;
          messages.push(thinking);
        }

        const toolCalls = event.toolCalls.map(buildToolCall);
        for (const tc of toolCalls) {
          if (tc.callId !== undefined) pendingToolCalls.set(tc.callId, tc);
        }

        // Usage sums into the session totals regardless of body presence.
        if (event.usage) {
          inputTokens += event.usage.inputTokens ?? 0;
          outputTokens += event.usage.outputTokens ?? 0;
          cacheReadTokens += event.usage.cacheReadTokens ?? 0;
          reasoningTokens += event.usage.reasoningTokens ?? 0;
        }

        const hasBody = event.text.length > 0 || toolCalls.length > 0;
        if (!hasBody) break; // thoughts-only record: the thinking message stands alone

        const msg: PendingMessage = {
          role: "assistant",
          text: event.text,
          toolCalls,
        };
        if (event.ts !== undefined) msg.ts = event.ts;
        if (event.usage) msg.usage = event.usage;
        messages.push(msg);
        break;
      }
      case "tool_result": {
        if (event.callId === undefined) break;
        const tc = pendingToolCalls.get(event.callId);
        if (!tc) break;
        const text = event.resultText;
        tc.outputPreview = text.slice(0, OUTPUT_PREVIEW_MAX);
        tc.outputFull = text;
        tc.outputBytes = Buffer.byteLength(text, "utf8");
        tc.outputSha = sha256Hex(text);
        if (event.exitCode !== undefined) tc.exitCode = event.exitCode;
        pendingToolCalls.delete(event.callId);
        break;
      }
      case "skip":
      case "malformed":
        break;
    }
  }

  const finalMessages: Message[] = messages.map((m, i) => ({
    turn: i + 1,
    ...m,
  }));

  return {
    sessionId,
    projectPath,
    gitBranch,
    model,
    startedAt,
    endedAt,
    messages: finalMessages,
    rawEvents,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    reasoningTokens,
  };
}

/**
 * Assemble the canonical Session from the reducer output. Returns undefined
 * when the session cannot be built (no sessionId or no messages).
 */
export function assembleSession(
  result: ReduceResult,
  filePath: string,
): Session | undefined {
  if (!result.sessionId) return undefined;
  if (result.messages.length === 0) return undefined;

  const id = `qw--${result.sessionId}`;
  const contentHash = buildContentHash(id, result.messages);

  const session: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "qwen",
    externalId: result.sessionId,
    transcript: {
      schemaVersion: SCHEMA_VERSION,
      messages: result.messages,
      contentHash,
      rawPath: filePath,
      rawEvents: result.rawEvents,
    },
  };

  if (result.projectPath !== undefined)
    session.projectPath = result.projectPath;
  if (result.gitBranch !== undefined) session.gitBranch = result.gitBranch;
  if (result.model !== undefined) session.model = result.model;
  if (result.startedAt !== undefined) session.startedAt = result.startedAt;
  if (result.endedAt !== undefined) session.endedAt = result.endedAt;

  const title = deriveTitle(result.messages);
  if (title !== undefined) session.title = title;

  if (result.inputTokens > 0)
    session.transcript.inputTokens = result.inputTokens;
  if (result.outputTokens > 0)
    session.transcript.outputTokens = result.outputTokens;
  if (result.cacheReadTokens > 0)
    session.transcript.cacheReadTokens = result.cacheReadTokens;
  if (result.reasoningTokens > 0)
    session.transcript.reasoningTokens = result.reasoningTokens;

  return session;
}

// ---------------------------------------------------------------------------
// Internal: label a decoded event for the lossless rawEvents tier.
// ---------------------------------------------------------------------------

function rawEventType(event: DecodedEvent): string | undefined {
  switch (event.kind) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool_result":
      return "tool_result";
    case "skip":
      return event.lineType ?? undefined;
    default:
      return undefined;
  }
}
