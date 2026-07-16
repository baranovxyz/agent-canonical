/**
 * Pure session reducer for Cursor JSONL transcripts.
 *
 * Takes an ordered list of `DecodedEvent`s (from `decodeLine`) plus the
 * session id and options, and assembles the canonical Session object
 * (minus `startedAt` which requires filesystem IO — that stays in the shell).
 *
 * No IO, no throwing for content problems.
 */

import { sep } from "node:path";
import type { Session } from "../../schemas/session.js";
import type {
  Message,
  MessagePart,
  RawEvent,
  ToolCall,
} from "../../schemas/transcript.js";
import { SCHEMA_VERSION } from "../../schemas/version.js";
import { buildContentHash, hashArgs, PREVIEW_MAX } from "../shared.js";
import {
  type DecodedEvent,
  type DecodedPart,
  parseCursorTimestamp,
} from "./events.js";
import type { CursorParseOptions } from "./index.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildToolCall(name: string, input: unknown): ToolCall {
  const { argsHash, argsPreview } = hashArgs(input ?? {});
  return { name, args: input, argsHash, argsPreview };
}

function buildMessagePart(
  sourceSeq: number,
  partIdx: number,
  role: "user" | "assistant",
  part: DecodedPart,
  fields: {
    text?: string;
    toolName?: string;
    toolCallIdx?: number;
  } = {},
  turn?: number,
  includedInMessageText = false,
): MessagePart {
  const mp: MessagePart = {
    sourceSeq,
    partIdx,
    role,
    partType: part.partType,
    payloadJson: part.payloadJson,
    includedInMessageText,
  };
  if (turn !== undefined) mp.turn = turn;
  if (fields.text !== undefined) mp.text = fields.text;
  if (fields.toolName !== undefined) mp.toolName = fields.toolName;
  if (fields.toolCallIdx !== undefined) mp.toolCallIdx = fields.toolCallIdx;
  return mp;
}

function decodeProject(encoded: string): string {
  return `/${encoded.split("-").join("/")}`;
}

export function resolveLineage(
  filePath: string,
  opts: CursorParseOptions,
): { parentSessionId?: string; projectPath?: string } {
  const segs = filePath.split(sep).filter(Boolean);
  const cursorIdx = segs.lastIndexOf("cursor");
  let projectPath = opts.projectPath;
  if (
    projectPath === undefined &&
    cursorIdx >= 0 &&
    cursorIdx + 1 < segs.length
  ) {
    projectPath = decodeProject(segs[cursorIdx + 1] ?? "");
  }

  let parentSessionId = opts.parentSessionId;
  if (parentSessionId === undefined) {
    const parentDir = segs[segs.length - 2];
    if (parentDir === "subagents") {
      const grandparent = segs[segs.length - 3];
      if (grandparent) parentSessionId = `cur--${grandparent}`;
    }
  }

  const out: { parentSessionId?: string; projectPath?: string } = {};
  if (parentSessionId !== undefined) out.parentSessionId = parentSessionId;
  if (projectPath !== undefined) out.projectPath = projectPath;
  return out;
}

// ---------------------------------------------------------------------------
// Reducer result
// ---------------------------------------------------------------------------

export interface ReduceResult {
  messages: Message[];
  rawEvents: RawEvent[];
  messageParts: MessagePart[];
  /** First cursor timestamp tag value found in user text, if any. */
  startedAt: number | undefined;
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

/**
 * Assemble the message stream from a list of decoded events.
 * Pure: no IO, no throwing. `startedAt` is the timestamp extracted from
 * the first `<timestamp>` tag — caller applies the mtime fallback.
 */
export function reduceEvents(
  events: DecodedEvent[],
  rawLines: string[],
): ReduceResult {
  const messages: Message[] = [];
  const rawEvents: RawEvent[] = [];
  const messageParts: MessagePart[] = [];
  let turn = 0;
  let startedAt: number | undefined;

  for (const ev of events) {
    const rawJson = rawLines[ev.seq] ?? "";

    if (ev.kind === "malformed") {
      rawEvents.push({
        seq: ev.seq,
        eventType: "cursor:parse_error",
        rawJson,
      });
      continue;
    }

    if (ev.kind === "skip") {
      rawEvents.push({
        seq: ev.seq,
        eventType: "cursor:unknown",
        rawJson,
      });
      continue;
    }

    const role = ev.kind; // "user" | "assistant"

    rawEvents.push({
      seq: ev.seq,
      eventType: `cursor:${role}`,
      rawJson,
    });

    const parts = ev.parts;
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    const lineParts: MessagePart[] = [];

    for (const part of parts) {
      if (part.kind === "text") {
        const text = part.text;
        // Extract the first timestamp found in any text part.
        if (startedAt === undefined) {
          startedAt = parseCursorTimestamp(text);
        }
        if (text.length > 0) textParts.push(text);
        lineParts.push(
          buildMessagePart(ev.seq, part.partIdx, role, part, { text }),
        );
      } else if (part.kind === "tool_use") {
        const toolCallIdx = toolCalls.length;
        const tc = buildToolCall(part.name, part.input);
        toolCalls.push(tc);
        lineParts.push(
          buildMessagePart(ev.seq, part.partIdx, role, part, {
            toolName: part.name,
            toolCallIdx,
          }),
        );
      } else {
        // kind === "other": image or other unknown type
        lineParts.push(buildMessagePart(ev.seq, part.partIdx, role, part));
      }
    }

    const text = textParts.join("\n\n");

    if (text.length === 0 && toolCalls.length === 0) {
      // Nothing to contribute to a message — flush parts without a turn
      messageParts.push(...lineParts);
      continue;
    }

    turn += 1;
    messages.push({ turn, role, text, toolCalls });
    messageParts.push(
      ...lineParts.map((p) => ({
        ...p,
        turn,
        includedInMessageText: p.partType === "text" && text.length > 0,
      })),
    );
  }

  return { messages, rawEvents, messageParts, startedAt };
}

// ---------------------------------------------------------------------------
// Session assembler (pure — no IO)
// ---------------------------------------------------------------------------

/**
 * Assemble a canonical `Session` from a reduce result.
 * `startedAt` must already be resolved (mtime fallback applied by caller).
 */
export function assembleSession(
  sessionUuid: string,
  filePath: string,
  reduced: ReduceResult,
  resolvedStartedAt: number | undefined,
  lineage: { parentSessionId?: string; projectPath?: string },
): Session {
  const { messages, rawEvents, messageParts } = reduced;
  const id = `cur--${sessionUuid}`;
  const contentHash = buildContentHash(id, messages);

  const firstUser = messages.find((m) => m.role === "user")?.text;
  const title =
    firstUser && firstUser.length > 0 ? firstUser.slice(0, 200) : undefined;

  const session: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "cursor",
    externalId: sessionUuid,
    transcript: {
      schemaVersion: SCHEMA_VERSION,
      messages,
      contentHash,
      rawPath: filePath,
      rawEvents,
      messageParts,
    },
  };

  if (resolvedStartedAt !== undefined) session.startedAt = resolvedStartedAt;
  if (lineage.parentSessionId !== undefined)
    session.parentSessionId = lineage.parentSessionId;
  if (lineage.projectPath !== undefined)
    session.projectPath = lineage.projectPath;
  if (title !== undefined) session.title = title;

  return session;
}

// re-export for test convenience
export { PREVIEW_MAX };
