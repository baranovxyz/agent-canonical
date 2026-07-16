/**
 * Incremental reader for the opencode SQLite transcript store.
 *
 * Provides two functions:
 *   - `snapshotCursor` — pre-turn watermark (call before dispatching a prompt)
 *   - `readEventsSince` — decode all new `TurnEvent`s since a cursor
 *
 * Watermark is `message.time_created` (epoch ms), NOT `time_updated`.
 * opencode touches the user message's `time_updated` AFTER the assistant turn
 * completes, so a `time_updated` watermark would silently exclude the assistant
 * rows sandwiched between dispatch and that post-turn touch. `time_created` is
 * monotonic on insert and cleanly partitions the past from the new turn.
 *
 * IMPORTANT: rows are re-read with `time_created > sinceMs` on every call
 * because opencode updates assistant rows IN PLACE — the terminal `finish` field
 * lands by row update, not by a new row insert. A consumer polling a fixed
 * turn-start cursor will see the terminal fact appear on a later poll without
 * advancing the cursor.
 */

import { z } from "zod";
import type { DbCursor, IncrementalRead, TurnEvent } from "../turn-events.js";
import { fail, IssueCollector, ok, type ParseResult } from "../types.js";
import { decodeMessage, decodePart } from "./records.js";
import type { OpencodeDb } from "./shells.js";

// ---------------------------------------------------------------------------
// Row schemas for incremental queries — only columns this module reads
// ---------------------------------------------------------------------------

const WatermarkRowSchema = z.object({ t: z.number() });

const MessageRowSchema = z.object({
  id: z.string(),
  time_created: z.number(),
  data: z.string(),
});

const PartRowSchema = z.object({
  message_id: z.string(),
  time_created: z.number(),
  data: z.string(),
});

// ---------------------------------------------------------------------------
// snapshotCursor
// ---------------------------------------------------------------------------

/**
 * Return a `DbCursor` watermarked at the session's current `MAX(time_created)`
 * in the `message` table. Call this BEFORE dispatching a prompt to mark the
 * boundary between the prior turn and the new one.
 *
 * On any DB error the cursor falls back to `sinceMs = 0` — a 0 watermark
 * re-reads everything, which is safe (idempotent events).
 */
export function snapshotCursor(db: OpencodeDb, sessionId: string): DbCursor {
  try {
    const rows = db
      .prepare(
        "SELECT COALESCE(MAX(time_created), 0) AS t FROM message WHERE session_id = ?",
      )
      .all(sessionId);
    const first = rows[0];
    const parsed = WatermarkRowSchema.safeParse(first);
    const sinceMs = parsed.success ? parsed.data.t : 0;
    return { kind: "db", sessionId, sinceMs };
  } catch {
    return { kind: "db", sessionId, sinceMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// readEventsSince
// ---------------------------------------------------------------------------

/**
 * Decode all `TurnEvent`s appended to the session past `cursor.sinceMs`.
 *
 * `cursor.sessionId` must match `sessionId`; a mismatch (stale cursor from a
 * different session) is treated as sinceMs = 0 so the full store is re-read.
 *
 * Rows are queried with `time_created > sinceMs` because opencode updates
 * assistant rows in place — the terminal `finish` field is not in a new row.
 * Consumers polling a fixed turn-start cursor will see `finish` appear on a
 * subsequent poll.
 *
 * Event ordering per message (time_created, id):
 *   - user role → `{kind:"user"}` if text parts produce non-empty text
 *   - assistant role → per-part thinking events, one assistant event, any
 *     tool-call events, then a turn-end event when the terminal signal is
 *     present (`error.name == "MessageAbortedError"`, or a non-`"tool-calls"`
 *     finish on a message with no decoded tool-call parts)
 *   - other roles → skipped with a warning issue
 *
 * `ts` on each event is `Math.floor(time_created / 1000)` (epoch seconds).
 */
export function readEventsSince(
  db: OpencodeDb,
  sessionId: string,
  cursor?: DbCursor,
): ParseResult<IncrementalRead<DbCursor>> {
  const issues = new IssueCollector();

  const effectiveSinceMs =
    cursor !== undefined && cursor.sessionId === sessionId ? cursor.sinceMs : 0;

  // Query message rows past the watermark
  let rawMessageRows: unknown[];
  try {
    rawMessageRows = db
      .prepare(
        "SELECT id, time_created, data FROM message WHERE session_id = ? AND time_created > ? ORDER BY time_created, id",
      )
      .all(sessionId, effectiveSinceMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `DB error in message query: ${msg}`,
        path: undefined,
      },
    ]);
  }

  if (rawMessageRows.length === 0) {
    const nextCursor: DbCursor = {
      kind: "db",
      sessionId,
      sinceMs: effectiveSinceMs,
    };
    return ok({ events: [], nextCursor }, issues.list());
  }

  // Validate message rows
  type MessageRow = { id: string; time_created: number; data: string };
  const messageRows: MessageRow[] = [];
  for (const raw of rawMessageRows) {
    const parsed = MessageRowSchema.safeParse(raw);
    if (parsed.success) {
      messageRows.push(parsed.data);
    } else {
      issues.warn(`Skipping malformed message row: ${parsed.error.message}`);
    }
  }

  if (messageRows.length === 0) {
    const nextCursor: DbCursor = {
      kind: "db",
      sessionId,
      sinceMs: effectiveSinceMs,
    };
    return ok({ events: [], nextCursor }, issues.list());
  }

  // Query part rows for the message set
  let rawPartRows: unknown[];
  try {
    const placeholders = messageRows.map(() => "?").join(",");
    rawPartRows = db
      .prepare(
        `SELECT message_id, time_created, data FROM part WHERE session_id = ? AND message_id IN (${placeholders}) ORDER BY time_created, id`,
      )
      .all(sessionId, ...messageRows.map((m) => m.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `DB error in part query: ${msg}`,
        path: undefined,
      },
    ]);
  }

  // Validate and group parts by message_id
  type PartRow = { message_id: string; time_created: number; data: string };
  const partsByMsg = new Map<string, PartRow[]>();
  for (const raw of rawPartRows) {
    const parsed = PartRowSchema.safeParse(raw);
    if (parsed.success) {
      const arr = partsByMsg.get(parsed.data.message_id) ?? [];
      arr.push(parsed.data);
      partsByMsg.set(parsed.data.message_id, arr);
    } else {
      issues.warn(`Skipping malformed part row: ${parsed.error.message}`);
    }
  }

  // Build events from message rows in order
  const events: TurnEvent[] = [];
  let maxTimeCreated = effectiveSinceMs;

  for (const mr of messageRows) {
    if (mr.time_created > maxTimeCreated) {
      maxTimeCreated = mr.time_created;
    }

    const ts = Math.floor(mr.time_created / 1000);

    // Decode message data JSON
    let rawData: unknown;
    try {
      rawData = JSON.parse(mr.data);
    } catch {
      issues.warn(`Message row ${mr.id} has invalid JSON data, skipped`);
      continue;
    }

    const msg = decodeMessage(rawData);
    if (!msg) {
      issues.warn(`Message row ${mr.id} failed decode, skipped`);
      continue;
    }

    const role = msg.role;
    if (role !== "user" && role !== "assistant") {
      if (role !== undefined) {
        issues.warn(`Message row ${mr.id} has unknown role "${role}", skipped`);
      }
      continue;
    }

    // Decode parts for this message
    const partRows = partsByMsg.get(mr.id) ?? [];

    if (role === "user") {
      // Collect text from text parts
      const textParts: string[] = [];
      for (const pr of partRows) {
        let partData: unknown;
        try {
          partData = JSON.parse(pr.data);
        } catch {
          issues.warn(
            `Part row for message ${mr.id} has invalid JSON, skipped`,
          );
          continue;
        }
        const part = decodePart(partData);
        if (
          part?.type === "text" &&
          typeof part.text === "string" &&
          part.text
        ) {
          textParts.push(part.text);
        }
      }
      const text = textParts.join("").trim();
      if (text) {
        events.push({ kind: "user", ts, text });
      }
    } else {
      // assistant role
      const thinkingTexts: string[] = [];
      const assistantTexts: string[] = [];
      const toolCallEvents: TurnEvent[] = [];

      for (const pr of partRows) {
        let partData: unknown;
        try {
          partData = JSON.parse(pr.data);
        } catch {
          issues.warn(
            `Part row for message ${mr.id} has invalid JSON, skipped`,
          );
          continue;
        }
        const part = decodePart(partData);
        if (!part) {
          issues.warn(
            `Part row for message ${mr.id} has unrecognised shape, skipped`,
          );
          continue;
        }

        if (part.type === "reasoning") {
          if (typeof part.text === "string" && part.text) {
            thinkingTexts.push(part.text);
          }
        } else if (part.type === "text") {
          if (typeof part.text === "string" && part.text) {
            assistantTexts.push(part.text);
          }
        } else if (part.type === "tool") {
          toolCallEvents.push({
            kind: "tool-call",
            ts,
            name: typeof part.tool === "string" ? part.tool : "",
            callId: typeof part.callID === "string" ? part.callID : undefined,
          });
        }
        // patch, step-start, step-finish, other → skip
      }

      // Emit thinking events (trimmed, non-empty)
      for (const thinkText of thinkingTexts) {
        const trimmed = thinkText.trim();
        if (trimmed) {
          events.push({ kind: "thinking", ts, text: trimmed });
        }
      }

      // Emit one assistant event (text parts joined + trimmed)
      const assistantText = assistantTexts.join("").trim();
      if (assistantText) {
        events.push({ kind: "assistant", ts, text: assistantText });
      }

      // Emit tool-call events
      for (const tc of toolCallEvents) {
        events.push(tc);
      }

      // Emit turn-end if the structural terminal signal is present. Abort
      // wins; otherwise OpenCode keeps looping only for "tool-calls" or when
      // the assistant message contains a decoded tool-call part.
      if (msg.error?.name === "MessageAbortedError") {
        events.push({
          kind: "turn-end",
          ts,
          outcome: "aborted",
          signal: "MessageAbortedError",
        });
      } else if (
        msg.finish &&
        msg.finish !== "tool-calls" &&
        toolCallEvents.length === 0
      ) {
        events.push({
          kind: "turn-end",
          ts,
          outcome: "completed",
          signal: msg.finish,
        });
      }
      // "tool-calls", absent finish, or a decoded tool part → still working
    }
  }

  const nextCursor: DbCursor = {
    kind: "db",
    sessionId,
    sinceMs: maxTimeCreated,
  };
  return ok({ events, nextCursor }, issues.list());
}
