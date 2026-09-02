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
import {
  type DecodedEvent,
  type DecodedUserArray,
  decodeLine,
} from "./events.js";

const CC_TERMINAL_STOP_REASONS = new Set([
  "end_turn",
  "stop_sequence",
  "max_tokens",
]);

/**
 * claude-code writes no assistant-level abort marker, but interrupting a
 * turn DOES persist a synthetic `user`-role record in its place: the sole
 * content block is `{type:"text", text: <one of these two strings>}`, once
 * the text is trimmed. Observed on disk with no other shape.
 *
 * These are the only two marker strings recognized — this is deliberately
 * a closed set, not a prefix/substring rule (see `detectInterruptMarker`).
 */
const CC_INTERRUPT_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
]);

/**
 * Recognize a decoded `user_array` record as claude-code's synthetic
 * interrupt marker, returning the raw marker text as the turn-end `signal`
 * when it is, `undefined` otherwise.
 *
 * The match is exact and whole-record, never a substring: content must be a
 * SOLE block (no accompanying tool_result — this is not a tool-gate
 * rejection — and no second text block) whose trimmed text is exactly one
 * of `CC_INTERRUPT_MARKERS`. A record that merely discusses one of these
 * markers in prose, or that carries one alongside other content, is left
 * alone and decoded as an ordinary user event — a substring rule would
 * misclassify any transcript that happens to talk about interrupts as
 * itself having been interrupted.
 *
 * This lives here, in the turn-scoped event mapper, rather than in
 * `decodeLine`. The decoder already exposes the exact structural facts this
 * predicate needs (`textParts` / `toolResults` on `DecodedUserArray`) with
 * no information loss, so nothing is gained by deciding it earlier — and
 * classifying it here keeps the decision entirely inside the turn-scoping
 * concern that consumes it (matching how this same function already turns
 * other decoded facts, e.g. an outstanding-work ledger record, into a
 * specific `TurnEvent` shape). Codex's structurally analogous synthetic
 * notice is instead dropped at decode time, because codex additionally
 * writes an independent terminal-signal record — dropping the notice loses
 * nothing there. claude-code has no second record: this marker is the only
 * on-disk evidence an interrupt happened, so it cannot simply be discarded;
 * it must become the turn-end event itself.
 *
 * Subagent (sidechain) records receive no special handling here — the
 * predicate applies identically regardless of that flag, matching every
 * other event kind this reader decodes, none of which branches on it
 * either.
 */
function detectInterruptMarker(decoded: DecodedUserArray): string | undefined {
  if (decoded.toolResults.length !== 0) return undefined;
  if (decoded.textParts.length !== 1) return undefined;
  const sole = decoded.textParts[0];
  if (sole === undefined) return undefined;
  const trimmed = sole.trim();
  return CC_INTERRUPT_MARKERS.has(trimmed) ? trimmed : undefined;
}

/**
 * How long, in milliseconds, an unpaired terminal assistant record is held
 * — emitting no event — before it degrades to an unconditional `turn-end`.
 * See `readEventsSince` for the full freshness-hold rule.
 *
 * Deliberately generous relative to the ~100ms assistant→ledger append gap
 * this rule exists to survive; it is not tuned tight to that gap.
 *
 * Sizing note: `decoded.ts` (see `parseTs` in `events.ts`) floors to whole
 * seconds, so comparing it against a millisecond wall clock (`nowMs`) always
 * makes a record look up to ~1s OLDER than it actually is
 * (`floor(ms/1000)*1000 <= ms`, so age computed from the floored value can
 * only be an overestimate, never an underestimate — the slack runs one way).
 * Rather than adding a second, millisecond-precision timestamp field to
 * `DecodedAssistant` (which would ripple into the shared decoder for a
 * ~100ms gap), that ~1s of slack is simply priced into this bound: 5000ms
 * leaves several seconds of margin over the worst case, so the flooring
 * error never flips a fresh record into a premature degrade in practice.
 */
const HOLD_WINDOW_MS = 5000;

/**
 * Snapshot the file cursor at EOF — call this before dispatching a prompt so
 * the subsequent `readEventsSince` sees only the new turn's lines.
 */
export async function snapshotCursor(filePath: string): Promise<FileCursor> {
  return snapshotFileCursor(filePath);
}

/** Options for `readEventsSince`. */
export interface ReadEventsSinceOptions {
  /**
   * Wall-clock reference (epoch ms) used to judge the freshness of an
   * unpaired terminal record against `HOLD_WINDOW_MS` (see `readEventsSince`).
   * Defaults to `Date.now()`. A deterministic caller (tests) should pass an
   * explicit value derived from the fixture's own record timestamps rather
   * than relying on the real clock.
   */
  nowMs?: number;
}

/**
 * Read and decode all complete lines appended past `cursor`, returning a
 * stream of canonical `TurnEvent`s.
 *
 * - User text events are emitted only for genuine operator turns (wrapper-only
 *   lines, tool_result-carrier arrays, and records claude-code flags `isMeta`
 *   — its own synthetic injections, e.g. the skill body it appends when a
 *   Skill loads — produce no `user` event). A record that is claude-code's own
 *   synthetic interrupt marker (see `detectInterruptMarker`) produces an
 *   aborted `turn-end` instead.
 * - `turn-end` is emitted only when `stop_reason` is one of the terminal set
 *   AND its ledger pairing (see below) does not leave it withheld or
 *   discarded; `tool_use` and `null` do not produce a turn-end event.
 * - A terminal `stop_reason` whose paired `system`/`turn_duration`
 *   record reports `pendingBackgroundAgentCount > 0` produces a
 *   `background-work` event INSTEAD OF `turn-end` — the CLI's own record
 *   says the dispatched work is not done, so this reader does not report the
 *   turn as over. Pairing is by `uuid`/`parentUuid`, resolved in a pass over
 *   the whole decoded delta before events are built.
 *
 * Freshness-hold rule for an unpaired terminal record (no `turn_duration`
 * anywhere in this delta whose `parentUuid` matches its `uuid`) — the
 * assistant record and its paired ledger record are two separate appends to
 * the file, so a read landing in the gap between them sees the terminal
 * `stop_reason` with no ledger record for it yet:
 *   1. `uuid` or the record's timestamp is missing — nothing to pair on, no
 *      freshness evidence — emit `turn-end` immediately.
 *   2. Otherwise, `age = nowMs - record timestamp`:
 *      - `age < HOLD_WINDOW_MS` — the record is fresh; its pairing may
 *        simply not have been written yet. Emit NO event for it this read.
 *        This is a pure decline, not a state entry: a stateless caller that
 *        polls a fixed watermark on an interval sees this same record again
 *        on its next poll, plus whatever was appended since (including the
 *        ledger record, if it has landed by then).
 *      - `age >= HOLD_WINDOW_MS` — the record has aged out; degrade to an
 *        unconditional `turn-end`. A warning issue is attached only if this
 *        delta contains at least one `turn_duration` record (for any uuid —
 *        the CLI demonstrably writes ledger records in this delta, so this
 *        record's absence is anomalous). A whole-file read of an
 *        older-CLI transcript that never writes `turn_duration` records at
 *        all degrades silently, with no warning per turn.
 * - Malformed JSON lines are recorded as warnings; neighbouring lines still decode.
 */
export async function readEventsSince(
  filePath: string,
  cursor?: FileCursor,
  opts?: ReadEventsSinceOptions,
): Promise<ParseResult<IncrementalRead<FileCursor>>> {
  const deltaResult = await readFileDelta(filePath, cursor);
  if (!deltaResult.success) return deltaResult;

  const { lines, nextCursor } = deltaResult.data;
  const issues = new IssueCollector();

  const decoded: DecodedEvent[] = [];
  for (let seq = 0; seq < lines.length; seq++) {
    const rawLine = lines[seq];
    if (rawLine === undefined) continue;
    decoded.push(decodeLine(rawLine, seq, issues));
  }

  // Background-agent ledger lookup, built ahead of the main pass so a
  // terminal assistant line can be paired regardless of ordering within the
  // delta. `pairedUuids` records every assistant `uuid` that has ANY ledger
  // record in this delta, even one with no `pendingBackgroundAgentCount`
  // (nothing outstanding — the CLI omits the field rather than writing 0);
  // `pendingByAssistantUuid` carries the count for the ones that do.
  // `hasAnyTurnDuration` records whether this delta contains a
  // `turn_duration` record at all (regardless of whether it names a
  // `parentUuid`) — used only to decide whether a degrade warning is
  // anomalous (see the freshness-hold rule above).
  const pairedUuids = new Set<string>();
  const pendingByAssistantUuid = new Map<string, number>();
  let hasAnyTurnDuration = false;
  for (const d of decoded) {
    if (d.kind === "turn_duration") {
      hasAnyTurnDuration = true;
      if (d.parentUuid !== undefined) {
        pairedUuids.add(d.parentUuid);
        if (d.pendingBackgroundAgentCount !== undefined) {
          pendingByAssistantUuid.set(
            d.parentUuid,
            d.pendingBackgroundAgentCount,
          );
        }
      }
    }
  }

  const nowMs = opts?.nowMs ?? Date.now();

  const events: TurnEvent[] = [];
  for (const d of decoded) {
    mapToTurnEvents(d, events, {
      pairedUuids,
      pendingByAssistantUuid,
      hasAnyTurnDuration,
      nowMs,
      issues,
    });
  }

  return ok({ events, nextCursor }, issues.list());
}

interface PairingContext {
  pairedUuids: Set<string>;
  pendingByAssistantUuid: Map<string, number>;
  hasAnyTurnDuration: boolean;
  nowMs: number;
  issues: IssueCollector;
}

function mapToTurnEvents(
  decoded: DecodedEvent,
  out: TurnEvent[],
  ctx: PairingContext,
): void {
  switch (decoded.kind) {
    case "user_text": {
      // A `user` event is a turn BOUNDARY for every consumer of this stream
      // (`detectTurnEndFromEvents` stops scanning at one), so it must mean
      // "the operator spoke". claude-code marks its own synthetic user
      // records with `isMeta` — see the case below for the live failure a
      // missing skip caused.
      if (decoded.isMeta) break;
      const text = decoded.text.trim();
      if (text.length > 0) {
        out.push({ kind: "user", ts: decoded.ts, text });
      }
      break;
    }

    case "user_array": {
      const interruptSignal = detectInterruptMarker(decoded);
      if (interruptSignal !== undefined) {
        out.push({
          kind: "turn-end",
          ts: decoded.ts,
          outcome: "aborted",
          signal: interruptSignal,
        });
        break;
      }
      // claude-code synthesizes user records for content nobody typed: the
      // skill body it injects when a Skill loads is a `user` line whose sole
      // part is text (`Base directory for this skill: …`), flagged `isMeta`
      // and carrying `sourceToolUseID`. Emitting a `user` event for it ENDS
      // the turn window at the injection, so a turn that loaded a skill can
      // never see its own terminal `stop_reason` — every consumer that scopes
      // a turn between `user` events stops reading at the injected record and
      // reports the turn as still in progress for the rest of its life.
      // Observed on claude-code 2.1.x.
      //
      // Checked AFTER the interrupt marker above: an interrupt is a genuine
      // turn-end signal whatever the CLI flags the record with.
      if (decoded.isMeta) break;
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

      // Turn-end only on terminal stop_reason — but this gates it on the
      // paired ledger record: outstanding background work reports as
      // `background-work`, never `turn-end`; an unpaired record is subject
      // to the freshness-hold rule (see the function docstring).
      if (
        decoded.stopReason !== undefined &&
        CC_TERMINAL_STOP_REASONS.has(decoded.stopReason)
      ) {
        const uuid = decoded.uuid;
        const paired = uuid !== undefined && ctx.pairedUuids.has(uuid);
        if (paired) {
          const pending =
            uuid !== undefined
              ? ctx.pendingByAssistantUuid.get(uuid)
              : undefined;
          if (pending !== undefined && pending > 0) {
            out.push({
              kind: "background-work",
              ts: decoded.ts,
              count: pending,
            });
          } else {
            out.push({
              kind: "turn-end",
              ts: decoded.ts,
              outcome: "completed",
              signal: decoded.stopReason,
            });
          }
        } else if (uuid === undefined || decoded.ts === undefined) {
          // Nothing to pair on (no uuid) or no freshness evidence (no
          // timestamp) — cannot hold, so fall back immediately.
          out.push({
            kind: "turn-end",
            ts: decoded.ts,
            outcome: "completed",
            signal: decoded.stopReason,
          });
        } else {
          const ageMs = ctx.nowMs - decoded.ts * 1000;
          if (ageMs < HOLD_WINDOW_MS) {
            // Fresh and unpaired: the pairing may simply not be on disk
            // yet. Decline — no event for this record this read. A pure
            // decline, not a state entry: nothing is persisted here, so a
            // caller re-reading the same watermark sees this record again
            // next poll, alongside whatever was appended in the meantime.
          } else {
            // Aged out with no pairing. Degrade to an unconditional
            // turn-end. Only warn when this delta demonstrably contains
            // ledger records (for some uuid) — otherwise this is very
            // likely an older CLI that never writes them, and a whole-file
            // read of such a transcript must not warn once per turn.
            if (ctx.hasAnyTurnDuration) {
              ctx.issues.warn(
                `terminal stop_reason with no ledger pairing after ${HOLD_WINDOW_MS}ms; degrading to an unconditional turn-end`,
                { seq: decoded.seq },
              );
            }
            out.push({
              kind: "turn-end",
              ts: decoded.ts,
              outcome: "completed",
              signal: decoded.stopReason,
            });
          }
        }
      }
      break;
    }

    // turn_duration, user_skipped, skip, malformed → nothing (turn_duration
    // is consumed via ctx.pairedUuids/pendingByAssistantUuid above, not
    // turned into its own event).
    default:
      break;
  }
}
