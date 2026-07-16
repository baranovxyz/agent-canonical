/**
 * Gemini session reducer: pure event stream → Session.
 *
 * Consumes decoded events (from events.ts) plus the raw JSONL lines (for the
 * lossless rawEvents tier) and assembles the canonical Session. No IO here.
 *
 * Gemini's JSONL is a revision log: repeated message ids replace prior state,
 * `$set.messages` is a checkpoint, and `$rewindTo` truncates the ordered map.
 * Canonical messages and usage are materialized only after reconstruction, so
 * revisions contribute exactly once and turn numbers remain contiguous.
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
import type {
  DecodedEvent,
  DecodedMessageRecord,
  DecodedToolCall,
} from "./events.js";

// Message before its final turn number is assigned.
type PendingMessage = Omit<Message, "turn">;

export interface ReduceResult {
  sessionId: string | undefined;
  projectPath: string | undefined;
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

function summarizeOutput(text: string): {
  outputPreview: string;
  outputFull: string;
  outputBytes: number;
  outputSha: string;
} {
  return {
    outputPreview: text.slice(0, OUTPUT_PREVIEW_MAX),
    outputFull: text,
    outputBytes: Buffer.byteLength(text, "utf8"),
    outputSha: sha256Hex(text),
  };
}

function buildToolCall(dtc: DecodedToolCall): ToolCall {
  const { argsHash, argsPreview } = hashArgs(dtc.args ?? {});
  const tc: ToolCall = {
    name: dtc.name,
    args: dtc.args,
    argsHash,
    argsPreview,
  };
  if (dtc.callId !== undefined) tc.callId = dtc.callId;
  if (dtc.resultText) {
    const { outputPreview, outputFull, outputBytes, outputSha } =
      summarizeOutput(dtc.resultText);
    tc.outputPreview = outputPreview;
    tc.outputFull = outputFull;
    tc.outputBytes = outputBytes;
    tc.outputSha = outputSha;
  }
  if (dtc.exitCode !== undefined) tc.exitCode = dtc.exitCode;
  return tc;
}

/**
 * Pure reducer. Single pass over the event stream.
 * `collector` is accepted for symmetry; the decoder handles per-line issues.
 */
export function reduceEvents(
  events: DecodedEvent[],
  rawLines: string[],
  collector: IssueCollector,
): ReduceResult {
  let sessionId: string | undefined;
  let projectPath: string | undefined;
  let model: string | undefined;
  let startedAt: number | undefined;
  let endedAt: number | undefined;

  // Map preserves first-insertion order when an existing id is replaced,
  // matching Gemini CLI's own loadConversationRecord reconstruction.
  const recordsById = new Map<string, DecodedMessageRecord>();
  const messages: PendingMessage[] = [];
  const rawEvents: RawEvent[] = [];

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let reasoningTokens = 0;

  const foldTs = (ts: number | undefined): void => {
    if (ts === undefined || !Number.isFinite(ts)) return;
    startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
    endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
  };

  const sumUsage = (usage: MessageUsage): void => {
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadTokens += usage.cacheReadTokens ?? 0;
    reasoningTokens += usage.reasoningTokens ?? 0;
  };

  const pushRecord = (rec: DecodedMessageRecord): void => {
    foldTs(rec.ts);
    const toolCalls = rec.toolCalls.map(buildToolCall);
    const hasBody = rec.text.length > 0 || toolCalls.length > 0;

    // Assistant reasoning becomes its own role:"thinking" message, ordered
    // before the visible reply.
    if (rec.role === "assistant" && rec.thoughtsText) {
      const thinking: PendingMessage = {
        role: "thinking",
        text: rec.thoughtsText,
        toolCalls: [],
      };
      if (rec.ts !== undefined) thinking.ts = rec.ts;
      // A thoughts-only record has no assistant body to own its usage.
      if (!hasBody && rec.usage) thinking.usage = rec.usage;
      messages.push(thinking);
    }

    if (rec.role === "assistant" && model === undefined && rec.model)
      model = rec.model;
    if (!hasBody) {
      if (rec.usage) sumUsage(rec.usage);
      return; // thoughts-only record: the thinking message stands alone
    }

    const msg: PendingMessage = {
      role: rec.role,
      text: rec.text,
      toolCalls,
    };
    if (rec.ts !== undefined) msg.ts = rec.ts;
    if (rec.usage) {
      msg.usage = rec.usage;
      sumUsage(rec.usage);
    }
    messages.push(msg);
  };

  const rewindTo = (toId: string | undefined): void => {
    if (!toId) return;
    let found = false;
    for (const id of recordsById.keys()) {
      if (id === toId) found = true;
      if (found) recordsById.delete(id);
    }
    if (!found) {
      recordsById.clear();
      collector.warn(
        `$rewindTo target ${toId} not found — cleared prior state`,
      );
    }
  };

  for (let seq = 0; seq < events.length; seq++) {
    const event = events[seq];
    if (event === undefined) continue;
    const rawLine = rawLines[seq];
    if (rawLine === undefined) continue;

    foldTs(event.ts);
    rawEvents.push({
      seq,
      eventType: eventTypeOf(rawLine),
      ...(event.ts !== undefined && Number.isFinite(event.ts)
        ? { ts: event.ts }
        : {}),
      rawJson: rawLine,
    });

    switch (event.kind) {
      case "session_meta": {
        if (sessionId === undefined) sessionId = event.sessionId;
        if (
          projectPath === undefined &&
          event.directories &&
          event.directories.length > 0
        )
          projectPath = event.directories[0];
        foldTs(event.lastUpdatedTs);
        for (const rec of event.embedded) recordsById.set(rec.id, rec);
        break;
      }
      case "message":
        recordsById.set(event.record.id, event.record);
        break;
      case "set": {
        if (event.directories !== undefined) projectPath = event.directories[0];
        foldTs(event.lastUpdatedTs);
        if (event.messages !== undefined) {
          recordsById.clear();
          for (const rec of event.messages) recordsById.set(rec.id, rec);
        }
        break;
      }
      case "rewind":
        rewindTo(event.toId);
        break;
      case "skip":
        break;
    }
  }

  for (const rec of recordsById.values()) pushRecord(rec);

  const finalMessages: Message[] = messages.map((m, i) => ({
    turn: i + 1,
    ...m,
  }));

  return {
    sessionId,
    projectPath,
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

  const id = `gm--${result.sessionId}`;
  const contentHash = buildContentHash(id, result.messages);

  const session: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "gemini",
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
// Internal: label a raw line for the lossless rawEvents tier.
// ---------------------------------------------------------------------------

function eventTypeOf(rawLine: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (parsed === null || typeof parsed !== "object") return undefined;
    if ("$rewindTo" in parsed) return "$rewindTo";
    if ("$set" in parsed) return "$set";
    if ("sessionId" in parsed) return "session_meta";
    if ("type" in parsed && typeof parsed.type === "string") return parsed.type;
  } catch {
    // ignore
  }
  return undefined;
}
