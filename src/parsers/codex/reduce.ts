/**
 * Codex session reducer: pure event stream → Session.
 *
 * Takes the array of decoded events (from events.ts) plus the raw JSONL lines
 * (for the lossless rawEvents tier) and assembles the canonical Session.
 * No IO here — the only pure logic layer.
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
import type { DecodedEvent } from "./events.js";

// ---------------------------------------------------------------------------
// Internal mutable state types
// ---------------------------------------------------------------------------

interface PendingSlot {
  toolCall: ToolCall;
  ownerIdx: number;
}

interface TokenUsage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  cacheWriteInputTokens: number | undefined;
  reasoningOutputTokens: number | undefined;
}

interface IncrementalTokenSnapshot {
  total: TokenUsage;
  last: TokenUsage;
}

// Fork rollouts can rewrite every replayed event's top-level timestamp to the
// child start while preserving the historical task_started.started_at value.
// When different session metadata proves replay, trust only that embedded time
// with a one-second precision allowance. Without replay evidence, ordered event
// time can establish the boundary and tolerates larger embedded clock drift.
const REPLAY_TASK_STARTED_CLOCK_SKEW_SECONDS = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildToolCall(
  name: string,
  input: unknown,
  callId: string | undefined,
): ToolCall {
  const { argsHash, argsPreview } = hashArgs(input);
  const tc: ToolCall = { name, args: input, argsHash, argsPreview };
  if (callId !== undefined) tc.callId = callId;
  return tc;
}

function summarizeOutput(text: string): {
  outputPreview: string;
  outputFull: string;
  outputBytes: number;
  outputSha: string;
} {
  const outputBytes = Buffer.byteLength(text, "utf8");
  const outputSha = sha256Hex(text);
  return {
    outputPreview: text.slice(0, OUTPUT_PREVIEW_MAX),
    outputFull: text,
    outputBytes,
    outputSha,
  };
}

function canonicalCodexSessionId(id: string): string {
  return id.startsWith("cx--") ? id : `cx--${id}`;
}

function tokenUsageEquals(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.reasoningOutputTokens === right.reasoningOutputTokens
  );
}

/**
 * function_call_output text may carry a header "Process exited with code N".
 * Returns undefined when the header is absent.
 */
function parseFunctionCallExitCode(text: string): number | undefined {
  const m = text.match(/Process exited with code (-?\d+)/);
  if (m?.[1] !== undefined) {
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) ? n : undefined;
  }
  // Sandbox-denied shells produce "exec_command failed for ..."; treat as exit 1.
  if (text.startsWith("exec_command failed for")) return 1;
  return undefined;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export interface ReduceResult {
  sessionId: string | undefined;
  directParentId: string | undefined;
  projectPath: string | undefined;
  model: string | undefined;
  agentType: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  messages: Message[];
  rawEvents: RawEvent[];
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  reasoningTokens: number | undefined;
  abortedTurns: number;
}

/**
 * Pure reducer. Consumes the full event stream in a single pass.
 * Ambiguous fork token usage is omitted and reported through `collector`.
 */
export function reduceEvents(
  events: DecodedEvent[],
  rawLines: string[],
  collector: IssueCollector,
): ReduceResult {
  let primaryMetadataId: string | undefined;
  for (const event of events) {
    if (event.kind === "session_meta" && event.id !== undefined) {
      primaryMetadataId = event.id;
      break;
    }
  }
  const hasReplayedSessionMetadata = events.some(
    (event) =>
      event.kind === "session_meta" &&
      event.id !== undefined &&
      primaryMetadataId !== undefined &&
      event.id !== primaryMetadataId,
  );
  let sessionId: string | undefined;
  let directParentId: string | undefined;
  let projectPath: string | undefined;
  let model: string | undefined;
  let agentType: string | undefined;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let primarySessionStartedAt: number | undefined;

  const messages: Message[] = [];
  const rawEvents: RawEvent[] = [];
  let turn = 0;
  let lastAssistantOrThinkingIdx = -1;
  const orphanCalls: ToolCall[] = [];
  const pending = new Map<string, PendingSlot>();
  const toolCallByCallId = new Map<string, ToolCall>();
  const execEndExitByCallId = new Map<string, number>();

  let lastTokenSnapshot: TokenUsage | undefined;
  let currentSessionTaskStarted = false;
  let sawTokenUsageFields = false;
  let lastIncrementalTokenSnapshot: IncrementalTokenSnapshot | undefined;
  let incrementalTokenUsage: TokenUsage | undefined;
  let abortedTurns = 0;

  const addUsage = (
    current: number | undefined,
    next: number | undefined,
  ): number | undefined =>
    next === undefined ? current : (current ?? 0) + next;

  const attachToolCall = (tc: ToolCall, ownerIdx: number): void => {
    if (ownerIdx >= 0 && messages[ownerIdx] !== undefined) {
      messages[ownerIdx].toolCalls.push(tc);
    } else {
      orphanCalls.push(tc);
    }
  };

  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq];
    if (event === undefined) continue;
    const rawLine = rawLines[seq];
    if (rawLine === undefined) continue;

    // Track time extents across all events
    const ts = event.ts;
    if (ts !== undefined && Number.isFinite(ts)) {
      startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
      endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
    }

    // Always push rawEvent for every non-skipped line (rawLines includes all)
    rawEvents.push({
      seq,
      eventType:
        event.kind === "skip"
          ? undefined
          : kindToEventType(event.kind, rawLine),
      ...(ts !== undefined && Number.isFinite(ts) ? { ts } : {}),
      rawJson: rawLine,
    });

    switch (event.kind) {
      case "session_meta": {
        if (sessionId === undefined && event.id !== undefined) {
          sessionId = event.id;
          primarySessionStartedAt = event.ts;
        }
        if (directParentId === undefined) directParentId = event.directParentId;
        if (projectPath === undefined) projectPath = event.cwd;
        if (agentType === undefined) agentType = event.agentType;
        break;
      }

      case "turn_context": {
        if (model === undefined && event.model) model = event.model;
        break;
      }

      case "event_msg_token_count": {
        const currentTokenSnapshot = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cachedInputTokens: event.cachedInputTokens,
          cacheWriteInputTokens: event.cacheWriteInputTokens,
          reasoningOutputTokens: event.reasoningOutputTokens,
        };
        lastTokenSnapshot = currentTokenSnapshot;
        const hasCurrentTokenSnapshot = Object.values(
          currentTokenSnapshot,
        ).some((value) => value !== undefined);
        const currentLastUsage = {
          inputTokens: event.lastInputTokens,
          outputTokens: event.lastOutputTokens,
          cachedInputTokens: event.lastCachedInputTokens,
          cacheWriteInputTokens: event.lastCacheWriteInputTokens,
          reasoningOutputTokens: event.lastReasoningOutputTokens,
        };
        const isDuplicateIncrementalSnapshot =
          hasCurrentTokenSnapshot &&
          lastIncrementalTokenSnapshot !== undefined &&
          tokenUsageEquals(
            currentTokenSnapshot,
            lastIncrementalTokenSnapshot.total,
          ) &&
          tokenUsageEquals(currentLastUsage, lastIncrementalTokenSnapshot.last);
        const hasLastUsage = Object.values(currentLastUsage).some(
          (value) => value !== undefined,
        );
        if (hasCurrentTokenSnapshot || hasLastUsage) {
          sawTokenUsageFields = true;
        }
        if (
          currentSessionTaskStarted &&
          !isDuplicateIncrementalSnapshot &&
          hasLastUsage
        ) {
          incrementalTokenUsage = {
            inputTokens: addUsage(
              incrementalTokenUsage?.inputTokens,
              event.lastInputTokens,
            ),
            outputTokens: addUsage(
              incrementalTokenUsage?.outputTokens,
              event.lastOutputTokens,
            ),
            cachedInputTokens: addUsage(
              incrementalTokenUsage?.cachedInputTokens,
              event.lastCachedInputTokens,
            ),
            cacheWriteInputTokens: addUsage(
              incrementalTokenUsage?.cacheWriteInputTokens,
              event.lastCacheWriteInputTokens,
            ),
            reasoningOutputTokens: addUsage(
              incrementalTokenUsage?.reasoningOutputTokens,
              event.lastReasoningOutputTokens,
            ),
          };
        }
        if (currentSessionTaskStarted && hasCurrentTokenSnapshot) {
          lastIncrementalTokenSnapshot = {
            total: currentTokenSnapshot,
            last: currentLastUsage,
          };
        }
        break;
      }

      case "event_msg_task_started": {
        const earliestCurrentTaskStart =
          primarySessionStartedAt === undefined
            ? undefined
            : primarySessionStartedAt - REPLAY_TASK_STARTED_CLOCK_SKEW_SECONDS;
        const boundaryTimestamp = hasReplayedSessionMetadata
          ? event.startedAt
          : (event.ts ?? event.startedAt);
        if (
          earliestCurrentTaskStart !== undefined &&
          boundaryTimestamp !== undefined &&
          boundaryTimestamp >= earliestCurrentTaskStart
        ) {
          currentSessionTaskStarted = true;
        }
        break;
      }

      case "event_msg_exec_command_end": {
        execEndExitByCallId.set(event.callId, event.exitCode);
        break;
      }

      case "event_msg_turn_aborted": {
        abortedTurns += 1;
        break;
      }

      case "response_message": {
        turn += 1;
        const msg: Message = {
          turn,
          role: event.role,
          text: event.text,
          toolCalls: [],
        };
        if (ts !== undefined) msg.ts = ts;
        messages.push(msg);
        const idx = messages.length - 1;
        if (event.role === "assistant") {
          lastAssistantOrThinkingIdx = idx;
          if (orphanCalls.length > 0) {
            msg.toolCalls.push(...orphanCalls);
            orphanCalls.length = 0;
          }
        }
        break;
      }

      case "response_function_call": {
        const tc = buildToolCall(event.name, event.parsedArgs, event.callId);
        pending.set(event.callId, {
          toolCall: tc,
          ownerIdx: lastAssistantOrThinkingIdx,
        });
        toolCallByCallId.set(event.callId, tc);
        break;
      }

      case "response_function_call_output": {
        const slot = pending.get(event.callId);
        if (!slot) break;
        const { outputPreview, outputFull, outputBytes, outputSha } =
          summarizeOutput(event.text);
        slot.toolCall.outputPreview = outputPreview;
        slot.toolCall.outputFull = outputFull;
        slot.toolCall.outputBytes = outputBytes;
        slot.toolCall.outputSha = outputSha;
        const exit = parseFunctionCallExitCode(event.text);
        if (exit !== undefined) slot.toolCall.exitCode = exit;
        attachToolCall(slot.toolCall, slot.ownerIdx);
        pending.delete(event.callId);
        break;
      }

      case "response_custom_tool_call": {
        const tc = buildToolCall(event.name, event.input, event.callId);
        pending.set(event.callId, {
          toolCall: tc,
          ownerIdx: lastAssistantOrThinkingIdx,
        });
        toolCallByCallId.set(event.callId, tc);
        break;
      }

      case "response_custom_tool_call_output": {
        const slot = pending.get(event.callId);
        if (!slot) break;
        const { outputPreview, outputFull, outputBytes, outputSha } =
          summarizeOutput(event.text);
        slot.toolCall.outputPreview = outputPreview;
        slot.toolCall.outputFull = outputFull;
        slot.toolCall.outputBytes = outputBytes;
        slot.toolCall.outputSha = outputSha;
        if (event.exitCode !== undefined)
          slot.toolCall.exitCode = event.exitCode;
        if (event.durationMs !== undefined)
          slot.toolCall.durationMs = event.durationMs;
        attachToolCall(slot.toolCall, slot.ownerIdx);
        pending.delete(event.callId);
        break;
      }

      case "response_web_search_call": {
        const tc = buildToolCall(
          "web_search",
          { queries: event.queries },
          undefined,
        );
        if (event.completed) tc.exitCode = 0;
        attachToolCall(tc, lastAssistantOrThinkingIdx);
        break;
      }

      case "response_reasoning": {
        // Emit a separate role:"thinking" message with unprefixed reasoning
        // text. Empty text is skipped.
        if (!event.text) break;
        turn += 1;
        const msg: Message = {
          turn,
          role: "thinking",
          text: event.text,
          toolCalls: [],
        };
        if (ts !== undefined) msg.ts = ts;
        messages.push(msg);
        // Thinking messages can own tool calls that arrive immediately after.
        lastAssistantOrThinkingIdx = messages.length - 1;
        if (orphanCalls.length > 0) {
          msg.toolCalls.push(...orphanCalls);
          orphanCalls.length = 0;
        }
        break;
      }

      case "skip":
        break;
    }
  }

  // Drain unmatched pending calls onto their owner (no output ever recorded).
  for (const slot of pending.values())
    attachToolCall(slot.toolCall, slot.ownerIdx);
  pending.clear();

  // Apply exec_command_end exit codes as fallback for interactive shells.
  for (const [callId, exit] of execEndExitByCallId) {
    const tc = toolCallByCallId.get(callId);
    if (tc !== undefined && tc.exitCode === undefined) tc.exitCode = exit;
  }

  // Flush orphan tool calls into a synthetic assistant turn.
  if (orphanCalls.length > 0) {
    turn += 1;
    messages.push({
      turn,
      role: "assistant",
      text: "",
      toolCalls: orphanCalls.splice(0),
    });
  }

  const ambiguousForkUsage =
    incrementalTokenUsage === undefined &&
    sawTokenUsageFields &&
    (directParentId !== undefined || hasReplayedSessionMetadata);
  if (ambiguousForkUsage) {
    collector.warn(
      "Codex token usage omitted because current-session request deltas or a reliable task boundary are missing",
    );
  }
  const tokenUsage = ambiguousForkUsage
    ? undefined
    : (incrementalTokenUsage ?? lastTokenSnapshot);

  return {
    sessionId,
    directParentId,
    projectPath,
    model,
    agentType,
    startedAt,
    endedAt,
    messages,
    rawEvents,
    inputTokens: tokenUsage?.inputTokens,
    outputTokens: tokenUsage?.outputTokens,
    cacheReadTokens: tokenUsage?.cachedInputTokens,
    cacheCreationTokens: tokenUsage?.cacheWriteInputTokens,
    reasoningTokens: tokenUsage?.reasoningOutputTokens,
    abortedTurns,
  };
}

/**
 * Assemble the canonical Session from the reducer output.
 * Returns undefined when the session cannot be built (no sessionId or no messages).
 */
export function assembleSession(
  result: ReduceResult,
  filePath: string,
): Session | undefined {
  if (!result.sessionId) return undefined;
  if (result.messages.length === 0) return undefined;

  const id = `cx--${result.sessionId}`;
  const contentHash = buildContentHash(id, result.messages);

  const session: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "codex",
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
  if (result.directParentId !== undefined)
    session.parentSessionId = canonicalCodexSessionId(result.directParentId);
  if (result.model !== undefined) session.model = result.model;
  if (result.agentType !== undefined) session.agentType = result.agentType;
  if (result.startedAt !== undefined) session.startedAt = result.startedAt;
  if (result.endedAt !== undefined) session.endedAt = result.endedAt;

  // Title: first non-thinking message, clipped to 200 characters.
  const title = deriveTitle(result.messages);
  if (title !== undefined) session.title = title;

  if (result.inputTokens !== undefined)
    session.transcript.inputTokens = result.inputTokens;
  if (result.outputTokens !== undefined)
    session.transcript.outputTokens = result.outputTokens;
  if (result.cacheReadTokens !== undefined)
    session.transcript.cacheReadTokens = result.cacheReadTokens;
  if (result.cacheCreationTokens !== undefined)
    session.transcript.cacheCreationTokens = result.cacheCreationTokens;
  if (result.reasoningTokens !== undefined)
    session.transcript.reasoningTokens = result.reasoningTokens;
  if (result.abortedTurns > 0)
    session.transcript.abortedTurns = result.abortedTurns;

  return session;
}

// ---------------------------------------------------------------------------
// Internal: map decoded event kind back to the raw event_type string
// ---------------------------------------------------------------------------

function kindToEventType(
  kind: DecodedEvent["kind"],
  rawLine: string,
): string | undefined {
  // For skip events, we try to extract the type from the raw JSON directly.
  if (kind === "skip") {
    try {
      const parsed: unknown = JSON.parse(rawLine);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "type" in parsed &&
        typeof parsed.type === "string"
      ) {
        return parsed.type;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  const map: Record<string, string> = {
    session_meta: "session_meta",
    turn_context: "turn_context",
    event_msg_token_count: "event_msg",
    event_msg_task_started: "event_msg",
    event_msg_exec_command_end: "event_msg",
    event_msg_turn_aborted: "event_msg",
    event_msg_task_complete: "event_msg",
    response_message: "response_item",
    response_function_call: "response_item",
    response_function_call_output: "response_item",
    response_custom_tool_call: "response_item",
    response_custom_tool_call_output: "response_item",
    response_web_search_call: "response_item",
    response_reasoning: "response_item",
  };
  return map[kind];
}
