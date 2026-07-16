/**
 * Pure session reducer for Cline transcripts.
 *
 * Takes the decoded messages file + optional metadata record and builds a
 * canonical Session. No IO — the file shell (index.ts) does the reads and hands
 * records here.
 *
 * Cline's content is Anthropic-native, so the reduction mirrors that shape:
 *   - Tool results are cross-message. A `tool_use` block lands on a
 *     `role:"assistant"` message; its `tool_result` lands on a later
 *     `role:"user"` message, paired by `tool_use_id`. We index every result
 *     first, then attach each to the `tool_use` that made it — so a user message
 *     carrying only tool results emits no user message.
 *   - `thinking` blocks become their own `role:"thinking"` message in stream
 *     order, excluded from the assistant text.
 *   - Per-message usage lives in `metrics` on the terminal assistant message of
 *     a turn (earlier assistant messages of the same turn carry `modelInfo` but
 *     no `metrics`), so summing the present `metrics` never double-counts.
 *   - Timestamps are epoch ms in the store; canonical `ts`/`startedAt`/`endedAt`
 *     are unix seconds, so they are divided by 1000.
 */

import type { Session, SessionStatus } from "../../schemas/session.js";
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
  ClineContent,
  ClineMessagesFile,
  ClineSessionMeta,
} from "./records.js";
import { stripUserInputWrapper } from "./records.js";

/** Canonical id prefix stamped on Cline sessions: `cline--<sessionId>`. */
const ID_PREFIX = "cline";

type ToolResultContent = Extract<ClineContent, { kind: "toolResult" }>;

/** Epoch ms → unix seconds. */
function msToSec(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Map Cline's `status` string to a canonical SessionStatus, when recognized. */
function mapStatus(status: string | undefined): SessionStatus | undefined {
  switch (status) {
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "aborted":
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    default:
      return undefined;
  }
}

/** Build a ToolCall from a `tool_use` block, filling output from its result. */
function buildToolCall(
  use: Extract<ClineContent, { kind: "toolUse" }>,
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
    // Cline's canonical tool error signal is `is_error`; the store carries no
    // numeric exit code, so derive one from it.
    tc.exitCode = result.isError ? 1 : 0;
  }
  return tc;
}

/**
 * Build a canonical Session from a decoded Cline messages file.
 *
 * @param file      Decoded messages file (messages already in stream order).
 * @param meta      Decoded `<id>.json` metadata, or undefined when absent.
 * @param sessionId Resolved session id (file `sessionId` or filename fallback).
 * @param rawPath   Source messages-file path; written to transcript.rawPath.
 * @param rawEvents Pre-built raw-event array from the shell.
 * @param collector Issue collector; reserved for future warnings.
 * @returns Session, or null when no usable messages survive.
 */
export function buildSession(
  file: ClineMessagesFile,
  meta: ClineSessionMeta | undefined,
  sessionId: string,
  rawPath: string,
  rawEvents: RawEvent[],
  collector: IssueCollector,
): Session | null {
  if (!sessionId) {
    collector.error("Cline session missing id", { path: rawPath });
    return null;
  }

  // Pass 1: index every tool result by its callId (results live in user
  // messages, correlated to the tool_use in an earlier assistant message).
  const resultsByCallId = new Map<string, ToolResultContent>();
  for (const msg of file.messages) {
    for (const block of msg.contents) {
      if (block.kind === "toolResult" && block.callId) {
        resultsByCallId.set(block.callId, block);
      }
    }
  }

  const out: Message[] = [];
  let turn = 0;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let firstModelId: string | undefined;

  for (const msg of file.messages) {
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;
    if (role === "assistant" && firstModelId === undefined && msg.modelId)
      firstModelId = msg.modelId;

    const ts = msg.tsMs !== undefined ? msToSec(msg.tsMs) : undefined;
    if (ts !== undefined) {
      startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
      endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
    }

    // Walk blocks in stream order, staging emissions so thinking blocks keep
    // their position relative to the surrounding text/tool calls.
    type EmitItem =
      | { kind: "text"; text: string }
      | { kind: "tool"; tc: ToolCall }
      | { kind: "thinking"; text: string };
    const emissions: EmitItem[] = [];

    for (const block of msg.contents) {
      if (block.kind === "text") {
        const text =
          role === "user" ? stripUserInputWrapper(block.text) : block.text;
        if (text) emissions.push({ kind: "text", text });
      } else if (block.kind === "thinking") {
        if (block.text.trim())
          emissions.push({ kind: "thinking", text: block.text.trim() });
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

    // Sum per-message usage (assistant terminal messages carry it).
    let msgUsage: MessageUsage | undefined;
    if (role === "assistant" && msg.metrics) {
      inputTokens += msg.metrics.inputTokens ?? 0;
      outputTokens += msg.metrics.outputTokens ?? 0;
      cacheReadTokens += msg.metrics.cacheReadTokens ?? 0;
      cacheCreationTokens += msg.metrics.cacheWriteTokens ?? 0;
      msgUsage = {};
      if (msg.metrics.inputTokens !== undefined)
        msgUsage.inputTokens = msg.metrics.inputTokens;
      if (msg.metrics.outputTokens !== undefined)
        msgUsage.outputTokens = msg.metrics.outputTokens;
      if (msg.metrics.cacheReadTokens !== undefined)
        msgUsage.cacheReadTokens = msg.metrics.cacheReadTokens;
      if (msg.metrics.cacheWriteTokens !== undefined)
        msgUsage.cacheCreationTokens = msg.metrics.cacheWriteTokens;
    }

    const text = textBuf.join("\n\n").trim();
    if (text.length === 0 && toolCalls.length === 0) {
      // A user message of pure tool results, or an empty assistant message.
      continue;
    }

    turn += 1;
    const m: Message = { turn, role, text, toolCalls };
    if (ts !== undefined) m.ts = ts;
    if (msgUsage && Object.keys(msgUsage).length > 0) m.usage = msgUsage;
    out.push(m);
  }

  if (out.length === 0) return null;

  // Prefer session-level timing when the metadata file provided it.
  if (meta?.startedAtMs !== undefined) startedAt = msToSec(meta.startedAtMs);
  if (meta?.endedAtMs !== undefined) endedAt = msToSec(meta.endedAtMs);

  const id = `${ID_PREFIX}--${sessionId}`;
  const contentHash = buildContentHash(id, out);

  const result: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "cline",
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
    },
  };

  if (meta?.projectPath) result.projectPath = meta.projectPath;
  const model = meta?.model ?? firstModelId;
  if (model !== undefined) result.model = model;
  const title = meta?.title ?? deriveTitle(out);
  if (title) result.title = title;
  const status = mapStatus(meta?.status);
  if (status !== undefined) result.status = status;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (endedAt !== undefined) result.endedAt = endedAt;

  return result;
}
