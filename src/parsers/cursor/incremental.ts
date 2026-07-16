/**
 * Incremental reader for the Cursor JSONL transcript store.
 *
 * Provides two functions:
 *   - `snapshotCursor` — pre-turn byte-offset watermark (wraps snapshotFileCursor)
 *   - `readEventsSince` — decode all new `TurnEvent`s appended past a cursor
 *
 * Turn-end detection uses a content rule rather than an explicit terminal field:
 * cursor-agent writes records atomically and a mid-turn record always carries a
 * `tool_use` part (signalling the agent is about to run a tool). An assistant
 * record with NO `tool_use` part means the agent yielded — the turn is complete.
 * The residual case (a turn that ends genuinely on a `tool_use` with no closing
 * text) emits no `turn-end` event. Callers must apply their own timeout or
 * fallback policy for that case.
 *
 * User text is extracted from the `<user_query>…</user_query>` wrapper that
 * cursor-agent injects around the dispatched prompt body. The outer
 * `<timestamp>` prefix is stripped so the emitted user event carries the inner
 * prompt body. If no wrapper is found, the whole sanitized text is used.
 */

import { readFileDelta, snapshotFileCursor } from "../incremental-file.js";
import type { FileCursor, IncrementalRead, TurnEvent } from "../turn-events.js";
import { IssueCollector, ok, type ParseResult } from "../types.js";
import {
  decodeLine,
  parseCursorTimestamp,
  TIMESTAMP_TAG_RE,
} from "./events.js";

// ---------------------------------------------------------------------------
// snapshotCursor
// ---------------------------------------------------------------------------

/**
 * Return a `FileCursor` at the current end of `filePath` — the pre-turn
 * byte-offset watermark. Wraps `snapshotFileCursor`. Never fails.
 */
export async function snapshotCursor(filePath: string): Promise<FileCursor> {
  return snapshotFileCursor(filePath);
}

// ---------------------------------------------------------------------------
// readEventsSince
// ---------------------------------------------------------------------------

/**
 * Read all `TurnEvent`s appended to `filePath` past `cursor`.
 *
 * When `cursor` is absent or its `path` differs from `filePath` (the CLI
 * rotated to a new file), reading starts from offset 0.
 *
 * Event mapping per JSONL line:
 *   - user line → extract text from `<user_query>` wrapper (fallback: whole
 *     text); emit `{kind:"user", ts?, text}` only if non-empty. `ts` is
 *     extracted from the embedded `<timestamp>` tag when present.
 *   - assistant line → emit ONE `{kind:"assistant"}` event (text parts joined
 *     and trimmed, non-empty only); one `{kind:"tool-call"}` per `tool_use`
 *     part; THEN if the line has NO `tool_use` part emit
 *     `{kind:"turn-end", outcome:"completed", signal:"assistant-final-text"}`.
 *   - malformed / skip lines → nothing (decoder records warnings)
 *
 * `ts` on cursor-decoded lines: `DecodedUserLine` and `DecodedAssistantLine`
 * carry no `ts` field. For user lines, `ts` is recovered from the embedded
 * `<timestamp>` tag via `parseCursorTimestamp`; for assistant lines `ts` is
 * always undefined (cursor-agent writes no timestamp into assistant records).
 */
export async function readEventsSince(
  filePath: string,
  cursor?: FileCursor,
): Promise<ParseResult<IncrementalRead<FileCursor>>> {
  const issues = new IssueCollector();

  const deltaResult = await readFileDelta(filePath, cursor);
  if (!deltaResult.success) {
    return deltaResult;
  }

  const { lines, nextCursor } = deltaResult.data;

  if (lines.length === 0) {
    return ok({ events: [], nextCursor }, issues.list());
  }

  const events: TurnEvent[] = [];

  for (let seq = 0; seq < lines.length; seq++) {
    const rawLine = lines[seq];
    if (rawLine === undefined) continue;

    const decoded = decodeLine(rawLine, seq, issues);

    if (decoded.kind === "user") {
      // decodeLine already applied sanitizeUserText which strips <user_query>
      // tag wrappers but preserves their content. The remaining wrapper to
      // remove is the <timestamp> block that cursor-agent prepends to every
      // user line.
      const rawText = decoded.parts
        .filter((p) => p.kind === "text")
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("");

      // Extract timestamp before stripping the tag
      const ts = parseCursorTimestamp(rawText);

      // Strip the <timestamp>…</timestamp> block to isolate the prompt body
      const text = rawText.replace(TIMESTAMP_TAG_RE, "").trim();

      if (text) {
        events.push({ kind: "user", ts, text });
      }
    } else if (decoded.kind === "assistant") {
      const textParts = decoded.parts.filter((p) => p.kind === "text");
      const toolUseParts = decoded.parts.filter((p) => p.kind === "tool_use");

      // One assistant event (text joined + trimmed)
      const assistantText = textParts
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("")
        .trim();
      if (assistantText) {
        // assistant lines have no ts (cursor-agent writes no timestamp here)
        events.push({ kind: "assistant", text: assistantText });
      }

      // One tool-call event per tool_use part
      for (const tp of toolUseParts) {
        if (tp.kind === "tool_use") {
          events.push({
            kind: "tool-call",
            name: tp.name,
          });
        }
      }

      // Turn-end: only if the record has NO tool_use part
      if (toolUseParts.length === 0) {
        events.push({
          kind: "turn-end",
          outcome: "completed",
          signal: "assistant-final-text",
        });
      }
    }
    // malformed / skip → no events emitted (issues already recorded by decodeLine)
  }

  return ok({ events, nextCursor }, issues.list());
}
