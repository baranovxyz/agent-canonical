/**
 * Incremental reader for the Cursor JSONL transcript store.
 *
 * Provides two functions:
 *   - `snapshotCursor` — pre-turn byte-offset watermark (wraps snapshotFileCursor)
 *   - `readEventsSince` — decode all new `TurnEvent`s appended past a cursor
 *
 * Turn-end detection is two-tier. cursor-agent appends its own terminal record —
 * `{"type":"turn_ended","status":"success"|"aborted"|"error"}` — and that marker
 * is authoritative: it states the outcome, so an interrupted or errored turn is
 * distinguishable from a clean one.
 *
 * The older content rule survives as an explicitly `inferred` fallback for turns
 * that carry no marker (a run killed before the record was flushed): an assistant
 * record with no `tool_use` part usually means the agent yielded. It is only a
 * guess — cursor-agent does write text-only records mid-turn — so consumers must
 * corroborate an `inferred` turn-end before ending a turn on it. The residual
 * case (a turn that genuinely ends on a `tool_use` with no closing text and no
 * marker) emits no `turn-end` event at all; callers apply their own timeout or
 * fallback policy for that.
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
 *     part; THEN if the line has NO `tool_use` part emit an INFERRED
 *     `{kind:"turn-end", outcome:"completed", signal:"assistant-final-text",
 *     confidence:"inferred"}`.
 *   - `turn_ended` control line → emit an EXPLICIT
 *     `{kind:"turn-end", signal:"turn_ended", confidence:"explicit"}` whose
 *     outcome is `completed` for `status:"success"` and `aborted` otherwise.
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

      // Inferred turn-end: the record carries no tool_use part, so the agent
      // has PROBABLY yielded. Only a guess — cursor-agent also writes text-only
      // records mid-turn — so it is marked `inferred` and the explicit
      // `turn_ended` marker below supersedes it whenever one is written.
      if (toolUseParts.length === 0) {
        events.push({
          kind: "turn-end",
          outcome: "completed",
          signal: "assistant-final-text",
          confidence: "inferred",
        });
      }
    } else if (decoded.kind === "turn_ended") {
      // The dialect's own terminal marker: authoritative, and the only cursor
      // signal that can report a turn ending badly.
      events.push({
        kind: "turn-end",
        outcome: decoded.status === "success" ? "completed" : "aborted",
        signal: "turn_ended",
        confidence: "explicit",
      });
    }
    // malformed / skip → no events emitted (issues already recorded by decodeLine)
  }

  return ok({ events, nextCursor }, issues.list());
}
