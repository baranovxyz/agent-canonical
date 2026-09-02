/**
 * Tests for the Claude Code incremental reader.
 *
 * Wire format: one JSON object per line. Fixture shapes match the wire format
 * used by the CLI's on-disk transcripts.
 */

import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readEventsSince,
  snapshotCursor,
} from "../../src/parsers/claude-code/incremental.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * A background-dispatching-turn fixture, modeled on claude-code 2.1.209. The
 * main loop dispatches three background `Agent` tool calls (each gets an
 * immediate async-launch tool_result, so there is no pending tool call to
 * key off), then emits an assistant message with `stop_reason: "end_turn"`
 * while all three are still running. The following `system`/`turn_duration`
 * record carries `pendingBackgroundAgentCount`, which drains 3 → 2 → 1 →
 * absent across the exchange; the real answer arrives only when the count
 * goes absent, ~233s after the preamble. Sanitized and trimmed to the
 * structural shapes under test.
 */
const PENDING_BACKGROUND_AGENTS = join(
  __dirname,
  "claude-code-fixtures",
  "pending-background-agents.jsonl",
);

/**
 * A dispatched prompt, a partial assistant reply (flushed with no terminal
 * `stop_reason` — the record cc leaves behind for a generation cut off
 * mid-stream), then the operator's interrupt landing as claude-code's
 * synthetic marker record. Minimal and built directly from the documented
 * wire shape rather than lifted from a captured transcript.
 */
const INTERRUPTED_TURN = join(
  __dirname,
  "claude-code-fixtures",
  "interrupted-turn.jsonl",
);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function userLine(text: string): string {
  return `${JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid: "u1",
    parentUuid: null,
    isSidechain: false,
    timestamp: "2026-04-01T10:00:01.000Z",
    message: { role: "user", content: text },
  })}\n`;
}

/** Fixed timestamp `assistantLine` stamps every record with, by default. */
const ASSISTANT_TS = "2026-04-01T10:00:02.000Z";

function assistantLine(
  text: string,
  stopReason: string | null = null,
  opts: {
    uuid?: string;
    thinking?: string;
    toolUse?: { id: string; name: string };
  } = {},
): string {
  const content: unknown[] = [];
  if (opts.thinking !== undefined) {
    content.push({ type: "thinking", thinking: opts.thinking });
  }
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  if (opts.toolUse !== undefined) {
    content.push({
      type: "tool_use",
      id: opts.toolUse.id,
      name: opts.toolUse.name,
      input: {},
    });
  }
  return `${JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    uuid: opts.uuid ?? "a1",
    parentUuid: "u1",
    isSidechain: false,
    timestamp: ASSISTANT_TS,
    message: {
      id: "msg_a1",
      role: "assistant",
      model: "claude-sonnet-4",
      content,
      stop_reason: stopReason,
    },
  })}\n`;
}

/** An assistant line with no `uuid` field at all (wire-legal per schema). */
function assistantLineNoUuid(
  text: string,
  stopReason: string,
  timestamp: string = ASSISTANT_TS,
): string {
  return `${JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    parentUuid: "u1",
    isSidechain: false,
    timestamp,
    message: {
      id: "msg_a1",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
    },
  })}\n`;
}

/** An assistant line with a `uuid` but no `timestamp` field at all. */
function assistantLineNoTimestamp(
  text: string,
  stopReason: string,
  uuid: string,
): string {
  return `${JSON.stringify({
    type: "assistant",
    sessionId: "s1",
    uuid,
    parentUuid: "u1",
    isSidechain: false,
    message: {
      id: "msg_a1",
      role: "assistant",
      model: "claude-sonnet-4",
      content: [{ type: "text", text }],
      stop_reason: stopReason,
    },
  })}\n`;
}

/** A user line that is a tool_result carrier (no text parts). */
function toolResultUserLine(): string {
  return `${JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid: "u2",
    parentUuid: "a1",
    isSidechain: false,
    timestamp: "2026-04-01T10:00:03.000Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "tool output" },
      ],
    },
  })}\n`;
}

/** claude-code's synthetic interrupt marker: a sole content block of type text. */
function interruptLine(
  marker: string,
  opts: { uuid?: string; parentUuid?: string; isSidechain?: boolean } = {},
): string {
  return `${JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid: opts.uuid ?? "u-int",
    parentUuid: opts.parentUuid ?? "a1",
    isSidechain: opts.isSidechain ?? false,
    timestamp: "2026-04-01T10:00:03.000Z",
    message: { role: "user", content: [{ type: "text", text: marker }] },
  })}\n`;
}

/** A user record whose sole text block merely discusses a marker in prose. */
function markerInProseLine(): string {
  return `${JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid: "u-prose",
    parentUuid: "a1",
    isSidechain: false,
    timestamp: "2026-04-01T10:00:03.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "By the way, [Request interrupted by user] is the exact marker string we're testing for.",
        },
      ],
    },
  })}\n`;
}

/** A record carrying the marker text alongside a second, unrelated block. */
function markerWithToolResultLine(): string {
  return `${JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid: "u-multi",
    parentUuid: "a1",
    isSidechain: false,
    timestamp: "2026-04-01T10:00:03.000Z",
    message: {
      role: "user",
      content: [
        { type: "text", text: "[Request interrupted by user]" },
        { type: "tool_result", tool_use_id: "t1", content: "tool output" },
      ],
    },
  })}\n`;
}

/** A wrapper-only user line (system reminder injected by cc). */
function wrapperUserLine(): string {
  return `${JSON.stringify({
    type: "user",
    sessionId: "s1",
    uuid: "u-wrap",
    parentUuid: null,
    isSidechain: false,
    timestamp: "2026-04-01T10:00:00.500Z",
    message: {
      role: "user",
      content: "<system-reminder>some context</system-reminder>",
    },
  })}\n`;
}

/** A `system`/`turn_duration` ledger record paired to `parentUuid`. */
function turnDurationLine(
  parentUuid: string,
  pendingBackgroundAgentCount?: number,
): string {
  return `${JSON.stringify({
    type: "system",
    subtype: "turn_duration",
    parentUuid,
    uuid: `td-${parentUuid}`,
    ...(pendingBackgroundAgentCount !== undefined
      ? { pendingBackgroundAgentCount }
      : {}),
    timestamp: "2026-04-01T10:00:04.000Z",
  })}\n`;
}

function skipLine(): string {
  return `${JSON.stringify({
    type: "system",
    sessionId: "s1",
    timestamp: "2026-04-01T10:00:00.100Z",
  })}\n`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("claude-code incremental reader", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-incremental-"));
    filePath = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("full turn: user → assistant(text) → end_turn ⇒ events in order including turn-end", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("hello")}${assistantLine("hello back", "end_turn")}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { events, nextCursor } = result.data;
    expect(events).toEqual([
      { kind: "user", ts: expect.any(Number), text: "hello" },
      { kind: "assistant", ts: expect.any(Number), text: "hello back" },
      {
        kind: "turn-end",
        ts: expect.any(Number),
        outcome: "completed",
        signal: "end_turn",
      },
    ]);
    expect(nextCursor.offsetBytes).toBeGreaterThan(0);
  });

  it("watermark slicing: cursor taken after turn 1 ⇒ only turn 2 events", async () => {
    // Turn 1
    await writeFile(
      filePath,
      `${userLine("turn1")}${assistantLine("reply1", "end_turn")}`,
    );
    const cursor = await snapshotCursor(filePath);

    // Turn 2
    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("turn2")}${assistantLine("reply2", "end_turn")}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { events } = result.data;
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["user", "assistant", "turn-end"]);
    const userEvent = events.find((e) => e.kind === "user");
    expect(userEvent).toMatchObject({ kind: "user", text: "turn2" });
  });

  it("rotation: cursor.path differs from file ⇒ reads from byte 0", async () => {
    await writeFile(
      filePath,
      `${userLine("msg")}${assistantLine("reply", "end_turn")}`,
    );

    // Cursor pointing at a different path (rotation scenario).
    const staleCursor = {
      kind: "file" as const,
      path: join(dir, "old-session.jsonl"),
      offsetBytes: 9999,
    };
    const result = await readEventsSince(filePath, staleCursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events.length).toBeGreaterThan(0);
    const kinds = result.data.events.map((e) => e.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
  });

  it("truncation: cursor.offsetBytes > file size ⇒ reads from 0", async () => {
    await writeFile(
      filePath,
      `${userLine("msg")}${assistantLine("reply", "end_turn")}`,
    );

    // Cursor beyond EOF (truncation scenario).
    const truncCursor = {
      kind: "file" as const,
      path: filePath,
      offsetBytes: 999999,
    };
    const result = await readEventsSince(filePath, truncCursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events.length).toBeGreaterThan(0);
  });

  it("unterminated trailing line: not consumed; after appending newline it appears", async () => {
    // Start with an empty file and capture cursor at 0.
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);
    expect(cursor.offsetBytes).toBe(0);

    // Write the line WITHOUT a trailing newline — readFileDelta will find no
    // newline in the new bytes and leave the cursor unchanged.
    const partial = JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u-partial",
      parentUuid: null,
      isSidechain: false,
      timestamp: "2026-04-01T10:00:10.000Z",
      message: { role: "user", content: "partial" },
    });
    const fh1 = await open(filePath, "a");
    try {
      await fh1.appendFile(partial);
    } finally {
      await fh1.close();
    }

    // Read from the start: no newline → 0 events; cursor stays at 0.
    const r1 = await readEventsSince(filePath, cursor);
    expect(r1.success).toBe(true);
    if (!r1.success) return;
    expect(r1.data.events).toHaveLength(0);
    expect(r1.data.nextCursor.offsetBytes).toBe(0);

    // Append the closing newline — the full line is now on disk.
    const fh2 = await open(filePath, "a");
    try {
      await fh2.appendFile("\n");
    } finally {
      await fh2.close();
    }

    // Re-read from cursor 0; the complete line is now consumable.
    const r2 = await readEventsSince(filePath, r1.data.nextCursor);
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    const userEvent = r2.data.events.find((e) => e.kind === "user");
    expect(userEvent).toMatchObject({ kind: "user", text: "partial" });
  });

  it("malformed JSON line ⇒ warning issue, neighbouring lines still decode", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("before")}{not json}\n${assistantLine("after", "end_turn")}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const kinds = result.data.events.map((e) => e.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("wrapper-only user line ⇒ no user event", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(`${wrapperUserLine()}${skipLine()}`);
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const userEvents = result.data.events.filter((e) => e.kind === "user");
    expect(userEvents).toHaveLength(0);
  });

  it("tool_result-carrier user array (no text parts) ⇒ no user event", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(toolResultUserLine());
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const userEvents = result.data.events.filter((e) => e.kind === "user");
    expect(userEvents).toHaveLength(0);
  });

  it("assistant with stop_reason:tool_use ⇒ no turn-end event", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("go")}${assistantLine("working", "tool_use", { toolUse: { id: "t1", name: "Bash" } })}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const turnEndEvents = result.data.events.filter(
      (e) => e.kind === "turn-end",
    );
    expect(turnEndEvents).toHaveLength(0);
  });

  it("assistant with stop_reason:end_turn ⇒ turn-end completed", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("ping")}${assistantLine("pong", "end_turn")}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "end_turn",
    });
  });

  it("stop_sequence and max_tokens also produce turn-end completed", async () => {
    for (const stopReason of ["stop_sequence", "max_tokens"]) {
      await writeFile(filePath, "");
      const cursor = await snapshotCursor(filePath);
      const fh = await open(filePath, "a");
      try {
        await fh.appendFile(
          `${userLine("p")}${assistantLine("x", stopReason)}`,
        );
      } finally {
        await fh.close();
      }
      const result = await readEventsSince(filePath, cursor);
      expect(result.success).toBe(true);
      if (!result.success) continue;
      const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
      expect(turnEnd).toMatchObject({
        kind: "turn-end",
        outcome: "completed",
        signal: stopReason,
      });
    }
  });

  it("thinking + tool_use blocks ⇒ thinking + tool-call events before assistant text", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("do it")}${assistantLine("result text", "tool_use", {
          thinking: "let me think",
          toolUse: { id: "c1", name: "Read" },
        })}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const kinds = result.data.events.map((e) => e.kind);
    // Order: user, thinking, assistant, tool-call  (no turn-end — tool_use stop)
    expect(kinds).toEqual(["user", "thinking", "assistant", "tool-call"]);
    const thinking = result.data.events.find((e) => e.kind === "thinking");
    expect(thinking).toMatchObject({ kind: "thinking", text: "let me think" });
    const toolCall = result.data.events.find((e) => e.kind === "tool-call");
    expect(toolCall).toMatchObject({
      kind: "tool-call",
      name: "Read",
      callId: "c1",
    });
  });

  it("null stop_reason ⇒ no turn-end event", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(`${userLine("p")}${assistantLine("partial", null)}`);
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const turnEndEvents = result.data.events.filter(
      (e) => e.kind === "turn-end",
    );
    expect(turnEndEvents).toHaveLength(0);
  });

  it("nextCursor advances to EOF after consuming all lines", async () => {
    await writeFile(
      filePath,
      `${userLine("q")}${assistantLine("a", "end_turn")}`,
    );

    const result = await readEventsSince(filePath, undefined);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Second read with the returned cursor should see nothing new.
    const r2 = await readEventsSince(filePath, result.data.nextCursor);
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.data.events).toHaveLength(0);
  });
});

describe("synthetic interrupt marker", () => {
  it("interrupt fixture: turn-end aborted, and the partial assistant text is still in the window", async () => {
    const result = await readEventsSince(INTERRUPTED_TURN);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { events } = result.data;
    // No `user` event for the interrupt record — the marker becomes the
    // turn-end, not an operator turn boundary.
    const userTexts = events
      .filter((e) => e.kind === "user")
      .map((e) => e.text);
    expect(userTexts).toEqual([
      "Summarize the last three entries in the changelog.",
    ]);

    const turnEnd = events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "aborted",
      signal: "[Request interrupted by user]",
    });

    // The partial reply, flushed before the interrupt landed, is still
    // present in the event window a caller would scan for it.
    const assistantText = events
      .filter((e) => e.kind === "assistant")
      .map((e) => e.text)
      .join("\n\n");
    expect(assistantText).toContain("Here is what I found so far");
  });

  it("both marker variants ⇒ turn-end aborted", async () => {
    for (const marker of [
      "[Request interrupted by user]",
      "[Request interrupted by user for tool use]",
    ]) {
      const dir = await mkdtemp(join(tmpdir(), "cc-interrupt-"));
      const filePath = join(dir, "session.jsonl");
      try {
        await writeFile(
          filePath,
          `${userLine("go")}${assistantLine("partial", "tool_use", {
            toolUse: { id: "t1", name: "Bash" },
          })}${interruptLine(marker)}`,
        );
        const result = await readEventsSince(filePath);
        expect(result.success).toBe(true);
        if (!result.success) continue;
        const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
        expect(turnEnd).toMatchObject({
          kind: "turn-end",
          outcome: "aborted",
          signal: marker,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("anti-quote guard: marker embedded in prose ⇒ ordinary user event, no aborted turn-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-interrupt-prose-"));
    const filePath = join(dir, "session.jsonl");
    try {
      await writeFile(
        filePath,
        `${userLine("go")}${assistantLine("hi", "end_turn")}${markerInProseLine()}`,
      );
      const result = await readEventsSince(filePath);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const { events } = result.data;
      expect(
        events.some((e) => e.kind === "turn-end" && e.outcome === "aborted"),
      ).toBe(false);
      const userTexts = events
        .filter((e) => e.kind === "user")
        .map((e) => e.text);
      expect(userTexts).toContain(
        "By the way, [Request interrupted by user] is the exact marker string we're testing for.",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("multi-block guard: marker alongside a tool_result ⇒ ordinary user event, no aborted turn-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-interrupt-multiblock-"));
    const filePath = join(dir, "session.jsonl");
    try {
      await writeFile(filePath, markerWithToolResultLine());
      const result = await readEventsSince(filePath);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const { events } = result.data;
      expect(
        events.some((e) => e.kind === "turn-end" && e.outcome === "aborted"),
      ).toBe(false);
      const userEvent = events.find((e) => e.kind === "user");
      expect(userEvent).toMatchObject({
        kind: "user",
        text: "[Request interrupted by user]",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sidechain interrupt record ⇒ still an aborted turn-end (no special-case policy)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-interrupt-sidechain-"));
    const filePath = join(dir, "session.jsonl");
    try {
      await writeFile(
        filePath,
        `${userLine("go")}${assistantLine("partial", null)}${interruptLine(
          "[Request interrupted by user]",
          { isSidechain: true },
        )}`,
      );
      const result = await readEventsSince(filePath);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
      expect(turnEnd).toMatchObject({ kind: "turn-end", outcome: "aborted" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ordinary user record with no interrupt ⇒ unaffected (turn-end completed as before)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-interrupt-ordinary-"));
    const filePath = join(dir, "session.jsonl");
    try {
      await writeFile(
        filePath,
        `${userLine("hello")}${assistantLine("hello back", "end_turn")}`,
      );
      const result = await readEventsSince(filePath);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.events).toEqual([
        { kind: "user", ts: expect.any(Number), text: "hello" },
        { kind: "assistant", ts: expect.any(Number), text: "hello back" },
        {
          kind: "turn-end",
          ts: expect.any(Number),
          outcome: "completed",
          signal: "end_turn",
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("background-agent ledger consulted", () => {
  it("does not end the turn while a background dispatch is unsettled", async () => {
    // The ledger is on disk, in the same file, right after the preamble's
    // end_turn — confirm the fixture actually carries the drain before
    // asserting on the parser's response to it.
    const raw = await readFile(PENDING_BACKGROUND_AGENTS, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const ledgerRecords = lines
      .map((l) => JSON.parse(l))
      .filter(
        (r) =>
          typeof r === "object" &&
          r !== null &&
          r.type === "system" &&
          r.subtype === "turn_duration",
      );
    expect(ledgerRecords).toHaveLength(4);
    expect(ledgerRecords.map((r) => r.pendingBackgroundAgentCount)).toEqual([
      3,
      2,
      1,
      undefined, // absent on the wire — JSON.parse never adds the key
    ]);

    const result = await readEventsSince(PENDING_BACKGROUND_AGENTS);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { events } = result.data;

    // The preamble text is immediately followed by a `background-work`
    // event carrying the CLI's own count — NOT a `turn-end`. The dialect's
    // own record says the dispatched work isn't done, so this reader must
    // not report the turn as over here.
    const preambleIdx = events.findIndex(
      (e) =>
        e.kind === "assistant" &&
        e.text.includes("I'll compile the comparison"),
    );
    expect(preambleIdx).toBeGreaterThanOrEqual(0);
    expect(events[preambleIdx + 1]).toMatchObject({
      kind: "background-work",
      count: 3,
    });

    // Every interim status turn (2-of-3, then 1-of-3 done) reports the same
    // way — the drain is visible as a `background-work` count, never as a
    // completed turn-end.
    const backgroundWork = events.filter((e) => e.kind === "background-work");
    expect(backgroundWork.map((e) => e.count)).toEqual([3, 2, 1]);

    // Exactly one `turn-end` in the whole stream: the real answer's, once
    // the ledger drains to nothing outstanding.
    const turnEnds = events.filter((e) => e.kind === "turn-end");
    expect(turnEnds).toHaveLength(1);
  });

  it("ends the turn once the dispatch settles, with the answer in the window", async () => {
    const result = await readEventsSince(PENDING_BACKGROUND_AGENTS);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const { events } = result.data;

    const turnEndIdx = events.findIndex((e) => e.kind === "turn-end");
    expect(turnEndIdx).toBeGreaterThanOrEqual(0);
    expect(events[turnEndIdx]).toMatchObject({
      outcome: "completed",
      signal: "end_turn",
    });

    // A consumer collecting every assistant text event up to that turn-end
    // gets BOTH the preamble and the real answer, in the same reply window —
    // "capture reads anchor-to-end", no splitter change needed.
    const assistantText = events
      .slice(0, turnEndIdx + 1)
      .filter((e) => e.kind === "assistant")
      .map((e) => e.text)
      .join("\n\n");
    expect(assistantText).toContain("I'll compile the comparison");
    expect(assistantText).toContain("Here's the comparison");
  });
});

/** Type guard: narrows `v` to `Record<string, unknown>` without `as` casts. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse one JSONL line into a plain object, without `as`/`any`. */
function parseObjectLine(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) {
    throw new Error("expected a JSON object line");
  }
  return value;
}

describe("background-agent ledger freshness hold (append gap)", () => {
  // The assistant record and its paired `turn_duration` ledger record are
  // TWO SEPARATE appends to the file. A poll landing between them must not
  // settle the turn on the strength of the assistant record alone — these
  // tests construct that split explicitly (plus a real fixture truncation),
  // since the atomic fixture file used above cannot exercise it.
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-incremental-hold-"));
    filePath = join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("append-gap repro: fixture truncated inside the assistant→ledger gap ⇒ no turn-end for the still-unpaired final answer", async () => {
    // Truncate the branch's own incident fixture off its final line — the
    // `turn_duration` record that pairs with the final ("Here's the
    // comparison") assistant record — so the file ends exactly as it would
    // if a read landed in the append gap before that ledger line existed.
    const raw = await readFile(PENDING_BACKGROUND_AGENTS, "utf8");
    const allLines = raw.split("\n").filter((l) => l.trim().length > 0);

    const lastLine = allLines[allLines.length - 1];
    const finalAssistantLine = allLines[allLines.length - 2];
    if (lastLine === undefined || finalAssistantLine === undefined) {
      throw new Error(
        "fixture shorter than expected — cannot construct the gap",
      );
    }

    const lastRecord = parseObjectLine(lastLine);
    expect(lastRecord.type).toBe("system");
    expect(lastRecord.subtype).toBe("turn_duration");

    const finalAssistantRecord = parseObjectLine(finalAssistantLine);
    expect(finalAssistantRecord.type).toBe("assistant");
    const rawTimestamp = finalAssistantRecord.timestamp;
    if (typeof rawTimestamp !== "string") {
      throw new Error("final assistant record has no string timestamp");
    }
    const recordTsMs = Date.parse(rawTimestamp);
    expect(Number.isFinite(recordTsMs)).toBe(true);

    // Everything up to (not including) the trailing ledger line.
    const truncated = `${allLines.slice(0, -1).join("\n")}\n`;
    await writeFile(filePath, truncated);

    // A fresh read, ~200ms after the (still-unpaired) final assistant
    // record — well inside HOLD_WINDOW_MS.
    const result = await readEventsSince(filePath, undefined, {
      nowMs: recordTsMs + 200,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const kinds = result.data.events.map((e) => e.kind);
    expect(kinds).not.toContain("turn-end");
    // The three earlier, fully-paired drains still surface normally — only
    // the unpaired final record is held back.
    const backgroundCounts = result.data.events
      .filter((e) => e.kind === "background-work")
      .map((e) => (e.kind === "background-work" ? e.count : undefined));
    expect(backgroundCounts).toEqual([3, 2, 1]);
  });

  it("fresh unpaired terminal record (age < HOLD_WINDOW) ⇒ no event emitted for it", async () => {
    await writeFile(
      filePath,
      `${userLine("go")}${assistantLine("preamble", "end_turn", { uuid: "a1" })}`,
    );

    const result = await readEventsSince(filePath, undefined, {
      nowMs: Date.parse(ASSISTANT_TS) + 200,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const kinds = result.data.events.map((e) => e.kind);
    expect(kinds).not.toContain("turn-end");
    expect(kinds).not.toContain("background-work");
  });

  it("aged-out unpaired terminal record (age >= HOLD_WINDOW), other ledger records present ⇒ degrades to turn-end with a warning", async () => {
    // a0 is paired (its ledger says 1 agent still running, so it reports as
    // background-work, not turn-end) — its presence is what makes the
    // absence of a1's pairing anomalous. a1 shares a0's fixed timestamp
    // (both come from the `assistantLine` helper) but has no pairing at all.
    await writeFile(
      filePath,
      `${userLine("go")}${assistantLine("first reply", "end_turn", { uuid: "a0" })}${turnDurationLine("a0", 1)}${assistantLine("second reply", "end_turn", { uuid: "a1" })}`,
    );

    const result = await readEventsSince(filePath, undefined, {
      nowMs: Date.parse(ASSISTANT_TS) + 10_000,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const turnEnds = result.data.events.filter((e) => e.kind === "turn-end");
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "end_turn",
    });
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.message).toContain("degrading");
  });

  it("aged-out unpaired terminal record, no ledger records anywhere in delta ⇒ degrades silently (no warning)", async () => {
    await writeFile(
      filePath,
      `${userLine("go")}${assistantLine("preamble", "end_turn", { uuid: "a1" })}`,
    );

    const result = await readEventsSince(filePath, undefined, {
      nowMs: Date.parse(ASSISTANT_TS) + 10_000,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "end_turn",
    });
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings).toHaveLength(0);
  });

  it("missing uuid ⇒ turn-end immediately, even when otherwise fresh", async () => {
    await writeFile(
      filePath,
      `${userLine("go")}${assistantLineNoUuid("preamble", "end_turn")}`,
    );

    const result = await readEventsSince(filePath, undefined, {
      nowMs: Date.parse(ASSISTANT_TS) + 200,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "end_turn",
    });
  });

  it("missing timestamp ⇒ turn-end immediately, regardless of nowMs", async () => {
    await writeFile(
      filePath,
      `${userLine("go")}${assistantLineNoTimestamp("preamble", "end_turn", "a1")}`,
    );

    const result = await readEventsSince(filePath, undefined, {
      nowMs: Date.now(),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "end_turn",
    });
  });

  it("nowMs omitted ⇒ defaults to Date.now(), degrading a stale fixture with no warning", async () => {
    await writeFile(
      filePath,
      `${userLine("go")}${assistantLine("preamble", "end_turn", { uuid: "a1" })}`,
    );

    // ASSISTANT_TS is fixed and far in the past relative to any real clock,
    // so the default `Date.now()` unconditionally ages this record out. No
    // `nowMs` option is passed at all — this is the one-shot/static-read
    // path, which must behave exactly as it did before the freshness hold.
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "end_turn",
    });
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings).toHaveLength(0);
  });
});

/**
 * claude-code synthesizes `user` records for content nobody typed and flags
 * them `isMeta`. The one that matters here is the skill-body injection the CLI
 * appends when a Skill loads — a sole `text` part beginning
 * `Base directory for this skill: …`, carrying `sourceToolUseID`. Fixtures are
 * capture-derived and reduced to the structural shapes under test.
 *
 * Every `user` event on this stream is a turn BOUNDARY for consumers, so
 * emitting one here truncates the turn window at the injection and hides the
 * turn's own `end_turn` from every reader downstream.
 */
describe("claude-code isMeta user records", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-meta-"));
    filePath = join(dir, "meta.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function metaSkillBodyLine(): string {
    return `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u-skillbody",
      parentUuid: "u-toolresult",
      isMeta: true,
      sourceToolUseID: "call_00_skill",
      timestamp: "2026-04-01T10:00:09.136Z",
      version: "2.1.209",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "Base directory for this skill: /proj/.claude/skills/demo-skill\n\n# demo-skill\n\nSkill body text.\n",
          },
        ],
      },
    })}\n`;
  }

  it("emits no user event for an injected skill body", async () => {
    await writeFile(
      filePath,
      `${userLine("real prompt")}${metaSkillBodyLine()}`,
    );
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const users = result.data.events.filter((e) => e.kind === "user");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ kind: "user", text: "real prompt" });
  });

  it("emits no user event for a meta record with string content", async () => {
    const metaString = `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u-caveat",
      parentUuid: null,
      isMeta: true,
      message: { role: "user", content: "Caveat: this session was resumed." },
    })}\n`;
    await writeFile(filePath, `${userLine("real prompt")}${metaString}`);
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events.filter((e) => e.kind === "user")).toHaveLength(1);
  });

  it("still decodes an interrupt marker cc flagged isMeta", async () => {
    // The interrupt marker is a genuine turn-end signal whatever cc flags the
    // record with, so it is recognised before the meta skip applies.
    const interrupt = `${JSON.stringify({
      type: "user",
      sessionId: "s1",
      uuid: "u-int",
      parentUuid: "u1",
      isMeta: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    })}\n`;
    await writeFile(filePath, `${userLine("real prompt")}${interrupt}`);
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events.find((e) => e.kind === "turn-end")).toMatchObject(
      {
        outcome: "aborted",
        signal: "[Request interrupted by user]",
      },
    );
  });
});
