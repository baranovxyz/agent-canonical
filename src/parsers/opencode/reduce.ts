/**
 * Pure session reducer for opencode transcripts.
 *
 * Takes fully-decoded records and constructs a canonical Session.
 * Shared by both the file-based and DB-based parse shells — format
 * knowledge lives here once.
 *
 * Normalization guarantees:
 *   - reasoning parts → separate role:"thinking" message in stream order;
 *       excluded from the assistant message text (NOT inlined with prefix).
 *   - patch parts → synthetic ToolCall named after the reducer identity
 *       ("opencode_patch" by default; forks override — see ReducerIdentity).
 */

import type { CliKind, Session } from "../../schemas/session.js";
import type {
  Message,
  MessageUsage,
  RawEvent,
  ToolCall,
} from "../../schemas/transcript.js";
import { SCHEMA_VERSION } from "../../schemas/version.js";
import {
  buildContentHash,
  hashArgs,
  OUTPUT_PREVIEW_MAX,
  PREVIEW_MAX,
  sha256Hex,
  stableStringify,
} from "../shared.js";
import type { IssueCollector } from "../types.js";
import type {
  MessageRecord,
  OtherPart,
  PatchPart,
  ReasoningPart,
  SessionRecord,
  TextPart,
  ToolPart,
} from "./records.js";

// ---------------------------------------------------------------------------
// Reducer identity
//
// The opencode reducer is reused verbatim by every CLI that ships opencode's
// storage shape (session / message / part rows with the same nested `data`
// JSON). Kilo Code is the first such fork — its reader-facing row shape is
// compatible as of Kilo 7.4.9. The only thing that varies per fork is the
// *identity* stamped on the canonical Session: which `cli` kind it is, the id
// prefix, and the label for synthetic patch tool calls. Everything else —
// record shapes, tool correlation, token summing, turn ordering — is shared.
// ---------------------------------------------------------------------------

export interface ReducerIdentity {
  /** Canonical `cli` kind stamped on the Session. */
  cli: CliKind;
  /** Session id prefix: the canonical id is `<idPrefix>--<sessionId>`. */
  idPrefix: string;
  /** Synthetic tool name emitted for `patch` parts. */
  patchToolName: string;
  /** Human label used in the synthetic patch tool's output preview. */
  patchLabel: string;
}

/** Default identity — preserves opencode's original output exactly. */
export const OPENCODE_IDENTITY: ReducerIdentity = {
  cli: "opencode",
  idPrefix: "oc",
  patchToolName: "opencode_patch",
  patchLabel: "OpenCode patch",
};

// ---------------------------------------------------------------------------
// Part type guards
//
// TypeScript cannot narrow a union where one member has `type: Exclude<string, ...>`
// (a non-literal type) by checking `=== "tool"` alone. These guards provide a
// second, unambiguous narrowing step by also asserting the concrete subtype.
// ---------------------------------------------------------------------------
function isToolPart(
  p: TextPart | ReasoningPart | ToolPart | PatchPart | OtherPart,
): p is ToolPart {
  return p.type === "tool";
}

function isPatchPart(
  p: TextPart | ReasoningPart | ToolPart | PatchPart | OtherPart,
): p is PatchPart {
  return p.type === "patch";
}

/** One raw message bundled with its decoded parts, in part-file order. */
export interface RawMessageBundle {
  msg: MessageRecord;
  /** Parts in the order the loader provides them (file sort or DB row order). */
  parts: Array<TextPart | ReasoningPart | ToolPart | PatchPart | OtherPart>;
}

/**
 * Build a canonical Session from decoded opencode records.
 *
 * @param session   Decoded session record.
 * @param rawMessages  One bundle per source message, in any order (sorted here
 *                     by msg.time.created).
 * @param rawPath   Source file or DB path; written to transcript.rawPath.
 * @param rawEvents Pre-built raw-event array from the calling shell.
 * @param collector Issue collector; malformed records add warnings.
 * @param identity  Per-fork identity (cli kind, id prefix, patch labels).
 *                  Defaults to opencode; kilo passes its own.
 * @returns Session, or `null` if the session is empty (no usable messages).
 */
export function buildSession(
  session: SessionRecord,
  rawMessages: RawMessageBundle[],
  rawPath: string,
  rawEvents: RawEvent[],
  collector: IssueCollector,
  identity: ReducerIdentity = OPENCODE_IDENTITY,
): Session | null {
  const sessionId = session.id;
  if (!sessionId) {
    collector.error("session record missing id", { path: rawPath });
    return null;
  }

  // Sort by message creation time, earliest first.
  const sorted = [...rawMessages].sort(
    (a, b) => (a.msg.time?.created ?? 0) - (b.msg.time?.created ?? 0),
  );

  const messages: Message[] = [];
  let turn = 0;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let model: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let reasoningTokens = 0;
  let abortedTurns = 0;

  for (const { msg, parts } of sorted) {
    const role = msg.role;
    if (role !== "user" && role !== "assistant") continue;

    if (
      role === "assistant" &&
      model === undefined &&
      typeof msg.modelID === "string"
    ) {
      model = msg.modelID;
    }

    let msgUsage: MessageUsage | undefined;
    if (role === "assistant") {
      const t = msg.tokens;
      if (t) {
        inputTokens += t.input ?? 0;
        outputTokens += t.output ?? 0;
        reasoningTokens += t.reasoning ?? 0;
        cacheReadTokens += t.cache?.read ?? 0;
        cacheCreationTokens += t.cache?.write ?? 0;
        msgUsage = {
          inputTokens: t.input,
          outputTokens: t.output,
          reasoningTokens: t.reasoning,
          cacheReadTokens: t.cache?.read,
          cacheCreationTokens: t.cache?.write,
        };
      }
      if (msg.error?.name === "MessageAbortedError") abortedTurns += 1;
    }

    // Sort parts: tool parts by state.time.start; everything else by id.
    const ordered = [...parts].sort((a, b) =>
      partOrderKey(a).localeCompare(partOrderKey(b)),
    );

    const tsMs = msg.time?.created;
    const ts = typeof tsMs === "number" ? Math.floor(tsMs / 1000) : undefined;
    if (ts !== undefined) {
      startedAt = startedAt === undefined ? ts : Math.min(startedAt, ts);
      endedAt = endedAt === undefined ? ts : Math.max(endedAt, ts);
    }

    // Walk parts in order: collect text fragments, tool calls, and reasoning
    // blocks. Reasoning becomes a separate thinking message in
    // stream order; it is NOT inlined into the assistant text.
    const textBuf: string[] = [];
    const toolCalls: ToolCall[] = [];

    // We need to emit thinking messages inline as we encounter reasoning parts,
    // interleaved with the eventual assistant message. Build a sequence of
    // "emission items" first.
    type EmitItem =
      | { kind: "text"; text: string }
      | { kind: "tool"; tc: ToolCall }
      | { kind: "thinking"; text: string };

    const emissions: EmitItem[] = [];

    for (const p of ordered) {
      if (p.type === "text") {
        if (typeof p.text === "string") {
          emissions.push({ kind: "text", text: p.text });
        }
      } else if (p.type === "reasoning") {
        // Emit a separate thinking message; skip empty content.
        if (typeof p.text === "string" && p.text.trim()) {
          emissions.push({ kind: "thinking", text: p.text.trim() });
        }
      } else if (isToolPart(p)) {
        const tc = buildToolCall(p, collector);
        emissions.push({ kind: "tool", tc });
      } else if (isPatchPart(p)) {
        const tc = buildPatchToolCall(p, identity);
        if (tc) emissions.push({ kind: "tool", tc });
      }
      // step-start / step-finish / other bookkeeping types: skipped
    }

    // Drain emissions: each thinking block in order, then the main message.
    // Thinking messages get their own turn number.
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
        messages.push(tm);
      } else if (item.kind === "text") {
        textBuf.push(item.text);
      } else {
        toolCalls.push(item.tc);
      }
    }

    const text = textBuf.join("\n\n").trim();
    if (text.length === 0 && toolCalls.length === 0) {
      // Nothing survives: don't emit the main message either.
      continue;
    }

    turn += 1;
    const m: Message = { turn, role, text, toolCalls };
    if (ts !== undefined) m.ts = ts;
    if (msgUsage) m.usage = msgUsage;
    messages.push(m);
  }

  if (messages.length === 0) return null;

  // Prefer session-level timing if available — authoritative window.
  if (typeof session.time?.created === "number") {
    startedAt = Math.floor(session.time.created / 1000);
  }
  if (typeof session.time?.updated === "number") {
    endedAt = Math.floor(session.time.updated / 1000);
  }

  const id = `${identity.idPrefix}--${sessionId}`;
  const contentHash = buildContentHash(id, messages);

  const out: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: identity.cli,
    externalId: sessionId,
    transcript: {
      schemaVersion: SCHEMA_VERSION,
      messages,
      contentHash,
      rawPath,
      rawEvents,
      ...(inputTokens > 0 ? { inputTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {}),
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      ...(abortedTurns > 0 ? { abortedTurns } : {}),
    },
  };

  if (session.directory) out.projectPath = session.directory;
  // opencode stores a session-level title in its own store field — use it.
  if (session.title) out.title = session.title;
  if (model !== undefined) out.model = model;
  // Subagent linkage: opencode task invocations set parentID on the child.
  if (session.parentID)
    out.parentSessionId = `${identity.idPrefix}--${session.parentID}`;
  if (startedAt !== undefined) out.startedAt = startedAt;
  if (endedAt !== undefined) out.endedAt = endedAt;

  return out;
}

// ---------------------------------------------------------------------------
// Part helpers
// ---------------------------------------------------------------------------

function partOrderKey(
  p: TextPart | ReasoningPart | ToolPart | PatchPart | OtherPart,
): string {
  if (isToolPart(p)) {
    const start = p.state?.time?.start;
    if (typeof start === "number") return String(start).padStart(20, "0");
  }
  return p.id ?? "";
}

function buildToolCall(part: ToolPart, _collector: IssueCollector): ToolCall {
  const name = part.tool ?? "?";
  const input = part.state?.input ?? {};
  const { argsHash, argsPreview } = hashArgs(input);

  const tc: ToolCall = {
    name,
    args: input,
    argsHash,
    argsPreview,
  };

  if (part.callID) tc.callId = part.callID;

  const status = part.state?.status;
  if (status === "completed") tc.exitCode = 0;
  else if (status === "error") tc.exitCode = 1;

  const outputText =
    typeof part.state?.output === "string"
      ? part.state.output
      : (part.state?.error ?? "");
  if (outputText) {
    tc.outputBytes = Buffer.byteLength(outputText, "utf8");
    tc.outputSha = sha256Hex(outputText);
    tc.outputPreview = outputText.slice(0, OUTPUT_PREVIEW_MAX);
    tc.outputFull = outputText;
  }

  const start = part.state?.time?.start;
  const end = part.state?.time?.end;
  if (typeof start === "number" && typeof end === "number" && end >= start) {
    tc.durationMs = end - start;
  }

  return tc;
}

/**
 * Build a synthetic ToolCall from a `patch` part. Patch parts become synthetic
 * tool calls named after the reducer identity (`opencode_patch` / `kilo_patch`).
 */
function buildPatchToolCall(
  part: PatchPart,
  identity: ReducerIdentity,
): ToolCall | null {
  const files = Array.isArray(part.files)
    ? part.files.filter(
        (f): f is string => typeof f === "string" && f.length > 0,
      )
    : [];
  if (files.length === 0 && !part.hash) return null;

  const args: { hash?: string; files: string[] } = { files };
  if (typeof part.hash === "string" && part.hash.length > 0)
    args.hash = part.hash;

  const argsJson = stableStringify(args);
  const outputText = `${identity.patchLabel}${part.hash ? ` ${part.hash}` : ""} touched ${files.length} file${files.length === 1 ? "" : "s"}.`;

  return {
    name: identity.patchToolName,
    args,
    argsHash: sha256Hex(argsJson),
    argsPreview: argsJson.slice(0, PREVIEW_MAX),
    outputPreview: outputText,
    outputFull: outputText,
    outputBytes: Buffer.byteLength(outputText, "utf8"),
    outputSha: sha256Hex(outputText),
    exitCode: 0,
    callId: part.id,
  };
}
