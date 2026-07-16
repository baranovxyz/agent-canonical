/**
 * Incremental event reader for Codex JSONL transcripts.
 *
 * Builds on the shared file-cursor mechanics in `incremental-file.ts` and the
 * line decoder in `events.ts`. Returns a canonical `TurnEvent` stream ready
 * for consumers (reply capture, turn-end detection).
 */

import { readFileDelta, snapshotFileCursor } from "../incremental-file.js";
import type { FileCursor, IncrementalRead, TurnEvent } from "../turn-events.js";
import { IssueCollector, ok, type ParseResult } from "../types.js";
import { type DecodedEvent, decodeLine } from "./events.js";

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
 * - User and assistant text is trimmed before events are emitted.
 * - `task_complete` produces a completed `turn-end`; `turn_aborted` produces
 *   an aborted `turn-end`.
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
    case "response_message": {
      const text = decoded.text.trim();
      if (text.length > 0) {
        out.push({ kind: decoded.role, ts: decoded.ts, text });
      }
      break;
    }

    case "response_reasoning": {
      const text = decoded.text.trim();
      if (text.length > 0) {
        out.push({ kind: "thinking", ts: decoded.ts, text });
      }
      break;
    }

    case "response_function_call": {
      out.push({
        kind: "tool-call",
        ts: decoded.ts,
        name: decoded.name,
        callId: decoded.callId,
      });
      break;
    }

    case "response_custom_tool_call": {
      out.push({
        kind: "tool-call",
        ts: decoded.ts,
        name: decoded.name,
        callId: decoded.callId,
      });
      break;
    }

    case "response_web_search_call": {
      out.push({
        kind: "tool-call",
        ts: decoded.ts,
        name: "web_search",
        callId: undefined,
      });
      break;
    }

    case "event_msg_task_complete": {
      out.push({
        kind: "turn-end",
        ts: decoded.ts,
        outcome: "completed",
        signal: "task_complete",
      });
      break;
    }

    case "event_msg_turn_aborted": {
      out.push({
        kind: "turn-end",
        ts: decoded.ts,
        outcome: "aborted",
        signal: "turn_aborted",
      });
      break;
    }

    // session_meta, turn_context, event_msg_token_count, event_msg_exec_command_end,
    // response_function_call_output, response_custom_tool_call_output, skip → nothing.
    default:
      break;
  }
}
