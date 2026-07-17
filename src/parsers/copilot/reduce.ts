/**
 * Pure session reducer for GitHub Copilot CLI event streams.
 *
 * Takes the decoded `events.jsonl` events (in emission order) and folds them
 * into a canonical Session. No IO — the file shell (index.ts) does the read and
 * hands records here.
 *
 * Copilot's store is an event stream, not a message array, so the reduction
 * differs from the message-array dialects:
 *   - Tool results are cross-event. A tool call is issued in an
 *     `assistant.message`'s `toolRequests[]`; its output arrives later in a
 *     `tool.execution_complete`, paired by `toolCallId`. We index every result
 *     first, then attach each to the request that made it.
 *   - `reasoningText` on an `assistant.message` (present only for reasoning
 *     models) becomes its own `role:"thinking"` message in stream order,
 *     excluded from the assistant text.
 *   - A tool round emits two assistant messages — one issuing the tool call
 *     (empty text + `toolRequests`), one with the final answer — mirroring the
 *     Anthropic-native two-message shape.
 *   - Per-message usage is output-only (`outputTokens` on each
 *     `assistant.message`); session input/cache/reasoning totals live only in
 *     `session.shutdown.modelMetrics`, so transcript totals come from that
 *     aggregate, falling back to summed per-message output when no shutdown
 *     event was written (a still-running or crashed session).
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
  CopilotEvent,
  CopilotToolRequest,
  CopilotToolResult,
} from "./records.js";

/** Canonical id prefix stamped on Copilot sessions: `copilot--<sessionId>`. */
const ID_PREFIX = "copilot";

/** Epoch ms → unix seconds. */
function msToSec(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Map Copilot's `shutdownType` to a canonical SessionStatus, when recognized. */
function mapStatus(
  shutdownType: string | undefined,
): SessionStatus | undefined {
  switch (shutdownType) {
    case "routine":
      return "complete";
    case "error":
    case "crash":
      return "failed";
    default:
      return undefined;
  }
}

/** Build a ToolCall from a request, filling output from its paired result. */
function buildToolCall(
  req: CopilotToolRequest,
  result: CopilotToolResult | undefined,
): ToolCall {
  const { argsHash, argsPreview } = hashArgs(req.args);
  const tc: ToolCall = {
    name: req.name,
    args: req.args,
    argsHash,
    argsPreview,
  };
  if (req.callId) tc.callId = req.callId;

  if (result) {
    if (result.output) {
      tc.outputBytes = Buffer.byteLength(result.output, "utf8");
      tc.outputSha = sha256Hex(result.output);
      tc.outputPreview = result.output.slice(0, OUTPUT_PREVIEW_MAX);
      tc.outputFull = result.output;
    }
    // Copilot's per-tool error signal is `success`; the store carries no numeric
    // exit code (a shell tool embeds one in its output text), so derive one.
    tc.exitCode = result.success ? 0 : 1;
  }
  return tc;
}

/**
 * Build a canonical Session from a Copilot event stream.
 *
 * @param events    Decoded events in emission order.
 * @param sessionId Resolved session id (session.start id or dir-name fallback).
 * @param rawPath   Source `events.jsonl` path; written to transcript.rawPath.
 * @param rawEvents Pre-built raw-event array from the shell.
 * @param collector Issue collector; reserved for future warnings.
 * @returns Session, or null when no usable messages survive.
 */
export function buildSession(
  events: CopilotEvent[],
  sessionId: string,
  rawPath: string,
  rawEvents: RawEvent[],
  collector: IssueCollector,
): Session | null {
  if (!sessionId) {
    collector.error("Copilot session missing id", { path: rawPath });
    return null;
  }

  // Pass 1: index every tool result by its callId.
  const resultsByCallId = new Map<string, CopilotToolResult>();
  for (const ev of events) {
    if (ev.kind === "toolComplete" && ev.result.callId)
      resultsByCallId.set(ev.result.callId, ev.result);
  }

  const out: Message[] = [];
  let turn = 0;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let firstModelId: string | undefined;
  let modelFromChange: string | undefined;
  let projectPath: string | undefined;
  let gitBranch: string | undefined;
  let sumOutputTokens = 0;
  let shutdownType: string | undefined;
  let shutdownTotals:
    | Extract<CopilotEvent, { kind: "shutdown" }>["totals"]
    | undefined;

  const noteTime = (ts: number | undefined) => {
    if (ts === undefined) return;
    startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
    endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
  };

  for (const ev of events) {
    switch (ev.kind) {
      case "sessionStart": {
        if (ev.startedAtMs !== undefined) noteTime(msToSec(ev.startedAtMs));
        const p = ev.gitRoot ?? ev.cwd;
        if (p !== undefined) projectPath = p;
        if (ev.branch !== undefined) gitBranch = ev.branch;
        break;
      }
      case "modelChange": {
        modelFromChange = ev.model;
        break;
      }
      case "shutdown": {
        shutdownTotals = ev.totals;
        shutdownType = ev.shutdownType;
        noteTime(ev.tsMs !== undefined ? msToSec(ev.tsMs) : undefined);
        break;
      }
      case "userMessage": {
        const ts = ev.tsMs !== undefined ? msToSec(ev.tsMs) : undefined;
        noteTime(ts);
        const text = ev.text.trim();
        if (text.length === 0) break;
        turn += 1;
        const m: Message = { turn, role: "user", text, toolCalls: [] };
        if (ts !== undefined) m.ts = ts;
        out.push(m);
        break;
      }
      case "assistantMessage": {
        const ts = ev.tsMs !== undefined ? msToSec(ev.tsMs) : undefined;
        noteTime(ts);
        if (firstModelId === undefined && ev.model) firstModelId = ev.model;
        if (ev.outputTokens !== undefined) sumOutputTokens += ev.outputTokens;

        // Reasoning precedes the message's content: emit it as its own message.
        if (ev.reasoningText) {
          const thinking = ev.reasoningText.trim();
          if (thinking) {
            turn += 1;
            const tm: Message = {
              turn,
              role: "thinking",
              text: thinking,
              toolCalls: [],
            };
            if (ts !== undefined) tm.ts = ts;
            out.push(tm);
          }
        }

        const toolCalls = ev.toolRequests.map((req) =>
          buildToolCall(
            req,
            req.callId ? resultsByCallId.get(req.callId) : undefined,
          ),
        );

        let usage: MessageUsage | undefined;
        if (ev.outputTokens !== undefined)
          usage = { outputTokens: ev.outputTokens };

        const text = ev.text.trim();
        if (text.length === 0 && toolCalls.length === 0) break;

        turn += 1;
        const m: Message = { turn, role: "assistant", text, toolCalls };
        if (ts !== undefined) m.ts = ts;
        if (usage !== undefined) m.usage = usage;
        out.push(m);
        break;
      }
      // toolComplete is consumed at the request site; other events are inert.
      default:
        break;
    }
  }

  if (out.length === 0) return null;

  // Transcript totals: prefer the shutdown aggregate (the only source of input /
  // cache / reasoning totals); fall back to summed per-message output when the
  // session wrote no shutdown event.
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  if (shutdownTotals) {
    inputTokens = shutdownTotals.inputTokens;
    outputTokens = shutdownTotals.outputTokens;
    cacheReadTokens = shutdownTotals.cacheReadTokens;
    cacheCreationTokens = shutdownTotals.cacheCreationTokens;
    reasoningTokens = shutdownTotals.reasoningTokens;
  }
  if (outputTokens === 0 && sumOutputTokens > 0) outputTokens = sumOutputTokens;

  const id = `${ID_PREFIX}--${sessionId}`;
  const contentHash = buildContentHash(id, out);

  const result: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "copilot",
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
  if (gitBranch !== undefined) result.gitBranch = gitBranch;
  const model = firstModelId ?? modelFromChange;
  if (model !== undefined) result.model = model;
  const title = deriveTitle(out);
  if (title) result.title = title;
  const status = mapStatus(shutdownType);
  if (status !== undefined) result.status = status;
  if (startedAt !== undefined) result.startedAt = startedAt;
  if (endedAt !== undefined) result.endedAt = endedAt;

  return result;
}
