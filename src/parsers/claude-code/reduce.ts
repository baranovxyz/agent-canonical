/**
 * Pure session reducer for the Claude Code parser.
 *
 * Takes a stream of `DecodedEvent`s (from `decodeLine`) and folds them into
 * an assembled `ReducedSession` (a plain object, not yet a canonical `Session`).
 * No IO. The IO shell (`index.ts`) calls this after decoding all lines.
 *
 * Normalization guarantees:
 *  - Assistant events are deduplicated by message.id.
 *  - Token usage is attributed once per unique message.id.
 *  - endedAt is derived from the deduplicated event stream only.
 *  - Thinking content becomes a role:"thinking" message before its assistant
 *      message in stream order. Empty thinking emits nothing. Usage attaches to
 *      the assistant message of the same message.id; if an id yields only
 *      thinking messages, usage attaches to the last thinking message.
 *  - The title derives from the first non-thinking message (handled via
 *      deriveTitle from shared.ts).
 */

import { createHash } from "node:crypto";
import type {
  Message,
  MessageUsage,
  RawEvent,
  ToolCall,
} from "../../schemas/transcript.js";
import { hashArgs, OUTPUT_PREVIEW_MAX } from "../shared.js";
import type { IssueCollector } from "../types.js";
import type {
  DecodedAssistant,
  DecodedEvent,
  DecodedToolResult,
} from "./events.js";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ReducedSession {
  sessionId: string | undefined;
  agentId: string | undefined;
  parentUuid: string | undefined;
  projectPath: string | undefined;
  gitBranch: string | undefined;
  model: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  messages: Message[];
  rawEvents: RawEvent[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Flatten a tool_result content value to a plain string. */
function flattenResult(
  raw: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String(p.text ?? "") : "",
      )
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

interface AssistantEntry {
  /** The last thinking message pushed for this id, if any. */
  lastThinkingMsg: Message | undefined;
  /** The assistant message row (role:"assistant") if any blocks were text/tool_use. */
  assistantMsg: Message | undefined;
  /** Turn number assigned on creation of this entry. */
  turnNumber: number;
  /** Block keys seen so far (for old-format dedup and per-block merge). */
  seenBlockKeys: Set<string>;
  /**
   * Usage attributed on the first event. Held here so _mergeBlocks can
   * move it from a thinking message to the assistant message once one is
   * created (per-block format: first block may be thinking, assistant text
   * arrives in a later block event for the same message.id).
   */
  pendingUsage: MessageUsage | undefined;
}

/**
 * Fold a stream of decoded events into a `ReducedSession`.
 * Pure: the only side-effect is calling `issues` for degraded-parse warnings.
 * `rawLines` is the original array of raw JSONL strings, indexed by seq.
 */
export function reduceEvents(
  events: DecodedEvent[],
  rawLines: string[],
  _issues: IssueCollector,
): ReducedSession {
  const session: ReducedSession = {
    sessionId: undefined,
    agentId: undefined,
    parentUuid: undefined,
    projectPath: undefined,
    gitBranch: undefined,
    model: undefined,
    startedAt: undefined,
    endedAt: undefined,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    messages: [],
    rawEvents: [],
  };

  // pending tool_use IDs waiting for their tool_result
  const pendingToolCalls = new Map<
    string,
    { turn: number; toolCall: ToolCall }
  >();

  let turn = 0;
  let seenFirstSidechainLine = false;

  // Maps message.id to its deduplicated assistant entry.
  const seenAssistantMessages = new Map<string, AssistantEntry>();

  for (const ev of events) {
    // Build rawEvents from every line (lossless tier).
    const rawLine = rawLines[ev.seq];
    if (rawLine !== undefined) {
      const rawEventTs = "ts" in ev && ev.ts !== undefined ? ev.ts : undefined;
      const eventType = _rawEventType(ev);
      const rawEv: RawEvent = { seq: ev.seq, rawJson: rawLine };
      if (rawEventTs !== undefined) rawEv.ts = rawEventTs;
      if (eventType !== undefined) rawEv.eventType = eventType;
      session.rawEvents.push(rawEv);
    }

    if (ev.kind === "malformed" || ev.kind === "skip") {
      continue;
    }

    // Extract session-level metadata from all user events, including wrapper-only
    // events, and assistant events. Wrapper-only lines can therefore establish
    // startedAt, endedAt, gitBranch, and sessionId.
    if (
      ev.kind === "user_text" ||
      ev.kind === "user_array" ||
      ev.kind === "user_skipped" ||
      ev.kind === "assistant"
    ) {
      // Subagent file: first sidechain line sets parentUuid + agentId.
      if (!seenFirstSidechainLine && ev.isSidechain) {
        seenFirstSidechainLine = true;
        session.parentUuid = ev.sessionId;
        session.agentId = ev.agentId;
      }
      session.sessionId ??= ev.sessionId;
      session.projectPath ??= ev.cwd;
      session.gitBranch ??= ev.gitBranch;
    }

    // Wrapper-only user lines contribute metadata (above) but no message content.
    if (ev.kind === "user_skipped") {
      _updateTimestamps(session, ev.ts);
      continue;
    }

    // ---- ASSISTANT ----
    if (ev.kind === "assistant") {
      if (ev.model) session.model = ev.model;

      const mid = ev.messageId;

      // Merge subsequent blocks for an already-seen message id.
      if (mid && seenAssistantMessages.has(mid)) {
        const entry = seenAssistantMessages.get(mid);
        if (!entry) continue; // defensive; .has() guarantees presence
        _mergeBlocks(ev, entry, pendingToolCalls, session);
        // Re-emitted events do not update endedAt.
        continue;
      }

      // First event for this message.id (or id-less — treat as unique).
      // Update timestamps from the FIRST event for this id (deduped stream).
      _updateTimestamps(session, ev.ts);

      // Attribute usage once per unique message id.
      const usage = ev.usage;
      let msgUsage: MessageUsage | undefined;
      if (usage) {
        session.inputTokens += usage.inputTokens ?? 0;
        session.outputTokens += usage.outputTokens ?? 0;
        session.cacheReadTokens += usage.cacheReadTokens ?? 0;
        session.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
        msgUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
        };
      }

      // Increment turn once per logical message.id.
      turn += 1;
      const thisTurn = turn;
      const seenBlockKeys = new Set<string>();

      // Build thinking messages and the assistant message.
      const thinkingMsgs: Message[] = [];
      let assistantMsg: Message | undefined;

      for (const block of ev.blocks) {
        if (seenBlockKeys.has(block.blockKey)) continue;
        seenBlockKeys.add(block.blockKey);

        if (block.blockType === "thinking") {
          const thinkingText = block.thinkingText ?? "";
          if (thinkingText === "") continue;
          const tmsg: Message = {
            turn: thisTurn,
            role: "thinking",
            text: thinkingText,
            toolCalls: [],
          };
          if (ev.ts !== undefined) tmsg.ts = ev.ts;
          thinkingMsgs.push(tmsg);
        } else if (block.blockType === "text") {
          const text = block.text ?? "";
          if (!assistantMsg) {
            assistantMsg = {
              turn: thisTurn,
              role: "assistant",
              text,
              toolCalls: [],
            };
            if (ev.ts !== undefined) assistantMsg.ts = ev.ts;
          } else {
            assistantMsg.text = assistantMsg.text
              ? `${assistantMsg.text}\n\n${text}`
              : text;
          }
        } else if (block.blockType === "tool_use") {
          const { callId, toolName, toolInput } = block;
          if (!callId || !toolName) continue;
          const { argsHash, argsPreview } = hashArgs(toolInput);
          const tc: ToolCall = {
            name: toolName,
            args: toolInput,
            argsHash,
            argsPreview,
            callId,
          };
          if (!assistantMsg) {
            assistantMsg = {
              turn: thisTurn,
              role: "assistant",
              text: "",
              toolCalls: [],
            };
            if (ev.ts !== undefined) assistantMsg.ts = ev.ts;
          }
          assistantMsg.toolCalls.push(tc);
          pendingToolCalls.set(callId, { turn: thisTurn, toolCall: tc });
        }
      }

      // Attribute usage:
      // - assistant message exists → attach to it.
      // - only thinking messages → attach to last thinking message.
      // - nothing → usage counted at session level; defer for merge events.
      let pendingUsage: MessageUsage | undefined;
      if (msgUsage) {
        if (assistantMsg) {
          assistantMsg.usage = msgUsage;
        } else if (thinkingMsgs.length > 0) {
          // Per-block format: first block may be thinking; assistant text
          // arrives in a later merge event. Attach to thinking for now but
          // store pendingUsage so _mergeBlocks can re-assign it.
          const lastThinking = thinkingMsgs.at(-1);
          if (lastThinking) {
            lastThinking.usage = msgUsage;
          }
          pendingUsage = msgUsage;
        }
        // else: usage still counted at session level, nothing to attach.
      }

      // Push thinking messages before the assistant message in stream order.
      for (const tm of thinkingMsgs) {
        session.messages.push(tm);
      }
      if (assistantMsg) {
        session.messages.push(assistantMsg);
      }

      // Register entry for subsequent dedup/merge.
      if (mid) {
        seenAssistantMessages.set(mid, {
          lastThinkingMsg:
            thinkingMsgs.length > 0
              ? thinkingMsgs[thinkingMsgs.length - 1]
              : undefined,
          assistantMsg,
          turnNumber: thisTurn,
          seenBlockKeys,
          pendingUsage,
        });
      }

      continue;
    }

    // ---- USER_TEXT ----
    if (ev.kind === "user_text") {
      _updateTimestamps(session, ev.ts);
      turn += 1;
      const msg: Message = { turn, role: "user", text: ev.text, toolCalls: [] };
      if (ev.ts !== undefined) msg.ts = ev.ts;
      session.messages.push(msg);
      continue;
    }

    // ---- USER_ARRAY ----
    if (ev.kind === "user_array") {
      _updateTimestamps(session, ev.ts);

      for (const tr of ev.toolResults) {
        _applyToolResult(tr, pendingToolCalls);
      }

      if (ev.textParts.length > 0) {
        turn += 1;
        const msg: Message = {
          turn,
          role: "user",
          text: ev.textParts.join("\n\n"),
          toolCalls: [],
        };
        if (ev.ts !== undefined) msg.ts = ev.ts;
        session.messages.push(msg);
      }
    }
  }

  return session;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _rawEventType(ev: DecodedEvent): string | undefined {
  if (ev.kind === "assistant") return "assistant";
  if (
    ev.kind === "user_text" ||
    ev.kind === "user_array" ||
    ev.kind === "user_skipped"
  )
    return "user";
  if (ev.kind === "skip") return ev.lineType ?? undefined;
  return undefined;
}

function _updateTimestamps(
  session: ReducedSession,
  ts: number | undefined,
): void {
  if (ts === undefined) return;
  session.startedAt =
    session.startedAt === undefined ? ts : Math.min(session.startedAt, ts);
  session.endedAt =
    session.endedAt === undefined ? ts : Math.max(session.endedAt, ts);
}

function _applyToolResult(
  tr: DecodedToolResult,
  pendingToolCalls: Map<string, { turn: number; toolCall: ToolCall }>,
): void {
  const pending = pendingToolCalls.get(tr.toolUseId);
  if (!pending) return;
  const text = flattenResult(tr.content);
  const outputBytes = Buffer.byteLength(text, "utf8");
  const outputSha = sha256Hex(text);
  pending.toolCall.outputPreview = text.slice(0, OUTPUT_PREVIEW_MAX);
  pending.toolCall.outputFull = text;
  pending.toolCall.outputBytes = outputBytes;
  pending.toolCall.outputSha = outputSha;
  pending.toolCall.exitCode = tr.isError ? 1 : 0;
  pendingToolCalls.delete(tr.toolUseId);
}

/** Merge unseen blocks from a subsequent event into an existing entry. */
function _mergeBlocks(
  ev: DecodedAssistant,
  entry: AssistantEntry,
  pendingToolCalls: Map<string, { turn: number; toolCall: ToolCall }>,
  session: ReducedSession,
): void {
  for (const block of ev.blocks) {
    if (entry.seenBlockKeys.has(block.blockKey)) continue;
    entry.seenBlockKeys.add(block.blockKey);

    if (block.blockType === "thinking") {
      const thinkingText = block.thinkingText ?? "";
      if (thinkingText === "") continue;
      const tmsg: Message = {
        turn: entry.turnNumber,
        role: "thinking",
        text: thinkingText,
        toolCalls: [],
      };
      if (ev.ts !== undefined) tmsg.ts = ev.ts;
      // Insert before the assistant message (stream order).
      if (entry.assistantMsg) {
        const idx = session.messages.indexOf(entry.assistantMsg);
        if (idx >= 0) {
          session.messages.splice(idx, 0, tmsg);
        } else {
          session.messages.push(tmsg);
        }
      } else {
        session.messages.push(tmsg);
      }
      entry.lastThinkingMsg = tmsg;
    } else if (block.blockType === "text") {
      const text = block.text ?? "";
      if (entry.assistantMsg) {
        entry.assistantMsg.text = entry.assistantMsg.text
          ? `${entry.assistantMsg.text}\n\n${text}`
          : text;
      } else {
        entry.assistantMsg = {
          turn: entry.turnNumber,
          role: "assistant",
          text,
          toolCalls: [],
        };
        if (ev.ts !== undefined) entry.assistantMsg.ts = ev.ts;
        // Move deferred usage from thinking message to the new assistant message.
        _transferPendingUsage(entry);
        session.messages.push(entry.assistantMsg);
      }
    } else if (block.blockType === "tool_use") {
      const { callId, toolName, toolInput } = block;
      if (!callId || !toolName) continue;
      const { argsHash, argsPreview } = hashArgs(toolInput);
      const tc: ToolCall = {
        name: toolName,
        args: toolInput,
        argsHash,
        argsPreview,
        callId,
      };
      if (!entry.assistantMsg) {
        entry.assistantMsg = {
          turn: entry.turnNumber,
          role: "assistant",
          text: "",
          toolCalls: [],
        };
        if (ev.ts !== undefined) entry.assistantMsg.ts = ev.ts;
        // Move deferred usage from thinking message to the new assistant message.
        _transferPendingUsage(entry);
        session.messages.push(entry.assistantMsg);
      }
      entry.assistantMsg.toolCalls.push(tc);
      pendingToolCalls.set(callId, { turn: entry.turnNumber, toolCall: tc });
    }
  }
}

/**
 * When a per-block-format message's first event was thinking-only, usage
 * gets temporarily placed on the thinking message. Once a text/tool_use block
 * arrives (creating the assistant message), move the usage there.
 * Usage attaches to the assistant message, falling back to
 * last thinking only when the id truly yields no assistant message.
 */
function _transferPendingUsage(entry: AssistantEntry): void {
  if (!entry.pendingUsage || !entry.assistantMsg) return;
  // Move from the thinking message.
  if (entry.lastThinkingMsg) {
    entry.lastThinkingMsg.usage = undefined;
  }
  entry.assistantMsg.usage = entry.pendingUsage;
  entry.pendingUsage = undefined;
}
