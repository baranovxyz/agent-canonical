/**
 * Tests for the Claude Code incremental reader.
 *
 * Wire format: one JSON object per line. Fixture shapes match the wire format
 * used by the CLI's on-disk transcripts.
 */

import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readEventsSince,
  snapshotCursor,
} from "../../src/parsers/claude-code/incremental.js";

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
    timestamp: "2026-04-01T10:00:02.000Z",
    message: {
      id: "msg_a1",
      role: "assistant",
      model: "claude-sonnet-4",
      content,
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
