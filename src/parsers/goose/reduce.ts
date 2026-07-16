/**
 * Pure session reducer for Goose transcripts.
 *
 * Takes decoded `sessions` + `messages` records and builds a canonical Session.
 * No IO — the DB shell (index.ts) does the reads and hands records here.
 *
 * Goose's storage model differs from every other dialect we parse, so this is a
 * genuinely new reducer (not an opencode/gemini reuse):
 *   - Tool calls are cross-row. A `toolRequest` block lands in a
 *     `role:"assistant"` row; its `toolResponse` lands in a *later*
 *     `role:"user"` row (Anthropic convention), paired by the tool `callId`. We
 *     index every response first, then attach each to the request that made it —
 *     so a user row carrying only tool results emits no user message.
 *   - `thinking` blocks become their own `role:"thinking"` message in stream
 *     order (as opencode does), excluded from the assistant text.
 *   - Per-message usage lives in `metadata_json.usage` on assistant rows, not in
 *     the `messages.tokens` column (which Goose leaves null).
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
  GooseContent,
  GooseMessageRecord,
  GooseSessionRecord,
} from "./records.js";

/** Canonical id prefix stamped on Goose sessions: `goose--<sessionId>`. */
const ID_PREFIX = "goose";

type ToolResponseContent = Extract<GooseContent, { kind: "toolResponse" }>;

/** Build a ToolCall from a request block, filling output from its response. */
function buildToolCall(
  req: Extract<GooseContent, { kind: "toolRequest" }>,
  response: ToolResponseContent | undefined,
): ToolCall {
  const { argsHash, argsPreview } = hashArgs(req.args);
  const tc: ToolCall = {
    name: req.name,
    args: req.args,
    argsHash,
    argsPreview,
  };
  if (req.callId) tc.callId = req.callId;

  if (response) {
    if (response.output) {
      tc.outputBytes = Buffer.byteLength(response.output, "utf8");
      tc.outputSha = sha256Hex(response.output);
      tc.outputPreview = response.output.slice(0, OUTPUT_PREVIEW_MAX);
      tc.outputFull = response.output;
    }
    if (response.exitCode !== undefined) tc.exitCode = response.exitCode;
  }
  return tc;
}

/**
 * Build a canonical Session from decoded Goose records.
 *
 * @param session   Decoded `sessions` row.
 * @param messages  Decoded `messages` rows, any order (sorted here by pk).
 * @param rawPath   Source DB path; written to transcript.rawPath.
 * @param rawEvents Pre-built raw-event array from the shell.
 * @param collector Issue collector; malformed content adds warnings.
 * @returns Session, or null when no usable messages survive.
 */
export function buildSession(
  session: GooseSessionRecord,
  messages: GooseMessageRecord[],
  rawPath: string,
  rawEvents: RawEvent[],
  collector: IssueCollector,
): Session | null {
  const sessionId = session.id;
  if (!sessionId) {
    collector.error("session record missing id", { path: rawPath });
    return null;
  }

  const sorted = [...messages].sort((a, b) => a.pk - b.pk);

  // Pass 1: index every tool response by its callId (responses live in user
  // rows, correlated to the request in an earlier assistant row).
  const responsesByCallId = new Map<string, ToolResponseContent>();
  for (const msg of sorted) {
    for (const block of msg.contents) {
      if (block.kind === "toolResponse" && block.callId) {
        responsesByCallId.set(block.callId, block);
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

  for (const msg of sorted) {
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    const ts = msg.ts;
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
        if (block.text) emissions.push({ kind: "text", text: block.text });
      } else if (block.kind === "thinking") {
        if (block.text.trim())
          emissions.push({ kind: "thinking", text: block.text.trim() });
      } else if (block.kind === "toolRequest") {
        const response = block.callId
          ? responsesByCallId.get(block.callId)
          : undefined;
        emissions.push({ kind: "tool", tc: buildToolCall(block, response) });
      }
      // toolResponse blocks are consumed at the request site; `other` is inert.
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

    // Sum per-message usage (assistant rows only carry it).
    let msgUsage: MessageUsage | undefined;
    if (role === "assistant" && msg.usage) {
      inputTokens += msg.usage.inputTokens ?? 0;
      outputTokens += msg.usage.outputTokens ?? 0;
      cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
      msgUsage = {
        inputTokens: msg.usage.inputTokens,
        outputTokens: msg.usage.outputTokens,
        cacheReadTokens: msg.usage.cacheReadTokens,
      };
    }

    const text = textBuf.join("\n\n").trim();
    if (text.length === 0 && toolCalls.length === 0) {
      // A user row of pure tool results, or an empty assistant row: no message.
      continue;
    }

    turn += 1;
    const m: Message = { turn, role, text, toolCalls };
    if (ts !== undefined) m.ts = ts;
    if (msgUsage) m.usage = msgUsage;
    out.push(m);
  }

  if (out.length === 0) return null;

  // Prefer session-level timing when present — the authoritative window.
  if (session.createdAt !== undefined) startedAt = session.createdAt;
  if (session.updatedAt !== undefined) endedAt = session.updatedAt;

  const id = `${ID_PREFIX}--${sessionId}`;
  const contentHash = buildContentHash(id, out);

  const result: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "goose",
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
    },
  };

  if (session.workingDir) result.projectPath = session.workingDir;
  const title = session.description || session.name || deriveTitle(out);
  if (title) result.title = title;
  if (session.model !== undefined) result.model = session.model;
  if (session.parentId)
    result.parentSessionId = `${ID_PREFIX}--${session.parentId}`;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (endedAt !== undefined) result.endedAt = endedAt;

  return result;
}
