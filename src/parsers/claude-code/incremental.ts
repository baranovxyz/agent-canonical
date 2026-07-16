/**
 * Incremental event reader for Claude Code JSONL transcripts.
 *
 * Builds on the shared file-cursor mechanics in `incremental-file.ts` and the
 * line decoder in `events.ts`. Returns a canonical `TurnEvent` stream ready
 * for consumers (reply capture, turn-end detection).
 */

import { readFileDelta, snapshotFileCursor } from "../incremental-file.js";
import type { FileCursor, IncrementalRead, TurnEvent } from "../turn-events.js";
import { IssueCollector, ok, type ParseResult } from "../types.js";
import { type DecodedEvent, decodeLine } from "./events.js";

const CC_TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

/**
 * Snapshot the file cursor at EOF — call this before dispatching a prompt so
 * the subsequent `readEventsSince` sees only the new turn's lines.
 */
export async function snapshotCursor(filePath: string): Promise<FileCursor> {
  return snapshotFileCursor(filePath);
}

/**
 * Read and decode all complete lines appended past `cursor`, returning a
 * stream of canonical `TurnEvent`s.
 *
 * - User text events are emitted only for genuine operator turns (wrapper-only
 *   lines and tool_result-carrier arrays produce no `user` event).
 * - `turn-end` is emitted only when `stop_reason` is one of the terminal set;
 *   `tool_use` and `null` do not produce a turn-end event.
 * - Malformed JSON lines are recorded as warnings; neighbouring lines still decode.
 */
export async function readEventsSince(
  filePath: string,
  cursor?: FileCursor,
): Promise<ParseResult<IncrementalRead<FileCursor>>> {
  const deltaResult = await readFileDelta(filePath, cursor);
  if (!deltaResult.success) return deltaResult;

  const { lines, nextCursor } = deltaResult.data;
  const issues = new IssueCollector();
  const events: TurnEvent[] = [];

  for (let seq = 0; seq < lines.length; seq++) {
    const rawLine = lines[seq];
    if (rawLine === undefined) continue;
    const decoded: DecodedEvent = decodeLine(rawLine, seq, issues);
    mapToTurnEvents(decoded, events);
  }

  return ok({ events, nextCursor }, issues.list());
}

function mapToTurnEvents(decoded: DecodedEvent, out: TurnEvent[]): void {
  switch (decoded.kind) {
    case "user_text": {
      const text = decoded.text.trim();
      if (text.length > 0) {
        out.push({ kind: "user", ts: decoded.ts, text });
      }
      break;
    }

    case "user_array": {
      const text = decoded.textParts.join("").trim();
      if (text.length > 0) {
        out.push({ kind: "user", ts: decoded.ts, text });
      }
      break;
    }

    case "assistant": {
      // Thinking blocks first, in order.
      for (const block of decoded.blocks) {
        if (block.blockType === "thinking") {
          const text = (block.thinkingText ?? "").trim();
          if (text.length > 0) {
            out.push({ kind: "thinking", ts: decoded.ts, text });
          }
        }
      }

      // Join all text blocks in source order without trimming their contents.
      const assistantText = decoded.blocks
        .filter((b) => b.blockType === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (assistantText.length > 0) {
        out.push({ kind: "assistant", ts: decoded.ts, text: assistantText });
      }

      // Tool-call events, in order.
      for (const block of decoded.blocks) {
        if (block.blockType === "tool_use") {
          out.push({
            kind: "tool-call",
            ts: decoded.ts,
            name: block.toolName ?? "",
            callId: block.callId,
          });
        }
      }

      // Turn-end only on terminal stop_reason.
      if (
        decoded.stopReason !== undefined &&
        CC_TERMINAL_STOP_REASONS.has(decoded.stopReason)
      ) {
        out.push({
          kind: "turn-end",
          ts: decoded.ts,
          outcome: "completed",
          signal: decoded.stopReason,
        });
      }
      break;
    }

    // user_skipped, skip, malformed → nothing.
    default:
      break;
  }
}
