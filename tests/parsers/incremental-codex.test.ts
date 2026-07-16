/**
 * Tests for the Codex incremental reader.
 *
 * Wire format: `{ timestamp?, type, payload }`. Fixture shapes match the wire
 * format used by the CLI's on-disk transcripts.
 */

import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readEventsSince,
  snapshotCursor,
} from "../../src/parsers/codex/incremental.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function userLine(text: string): string {
  return `${JSON.stringify({
    timestamp: "2026-04-01T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  })}\n`;
}

function assistantLine(text: string): string {
  return `${JSON.stringify({
    timestamp: "2026-04-01T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  })}\n`;
}

function reasoningLine(reasoningText: string): string {
  return `${JSON.stringify({
    timestamp: "2026-04-01T10:00:01.500Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      reasoning_text: reasoningText,
    },
  })}\n`;
}

function functionCallLine(name: string, callId: string): string {
  return `${JSON.stringify({
    timestamp: "2026-04-01T10:00:01.800Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name,
      call_id: callId,
      arguments: "{}",
    },
  })}\n`;
}

function eventMsgLine(type: string): string {
  return `${JSON.stringify({
    timestamp: "2026-04-01T10:00:03.000Z",
    type: "event_msg",
    payload: { type },
  })}\n`;
}

function tokenCountLine(): string {
  return `${JSON.stringify({
    timestamp: "2026-04-01T10:00:02.500Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 100, output_tokens: 50 } },
    },
  })}\n`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("codex incremental reader", () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cx-incremental-"));
    filePath = join(dir, "rollout.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("full turn: user → assistant(text) → task_complete ⇒ events in order including turn-end", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("hello")}${assistantLine("hello back")}${eventMsgLine("task_complete")}`,
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
        signal: "task_complete",
      },
    ]);
    expect(nextCursor.offsetBytes).toBeGreaterThan(0);
  });

  it("watermark slicing: cursor taken after turn 1 ⇒ only turn 2 events", async () => {
    await writeFile(
      filePath,
      `${userLine("turn1")}${assistantLine("reply1")}${eventMsgLine("task_complete")}`,
    );
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("turn2")}${assistantLine("reply2")}${eventMsgLine("task_complete")}`,
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
      `${userLine("msg")}${assistantLine("reply")}${eventMsgLine("task_complete")}`,
    );

    const staleCursor = {
      kind: "file" as const,
      path: join(dir, "old-rollout.jsonl"),
      offsetBytes: 9999,
    };
    const result = await readEventsSince(filePath, staleCursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events.length).toBeGreaterThan(0);
    const kinds = result.data.events.map((e) => e.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("turn-end");
  });

  it("truncation: cursor.offsetBytes > file size ⇒ reads from 0", async () => {
    await writeFile(
      filePath,
      `${userLine("msg")}${assistantLine("reply")}${eventMsgLine("task_complete")}`,
    );

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

    // Write the line WITHOUT a trailing newline.
    const partial = JSON.stringify({
      timestamp: "2026-04-01T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "partial" }],
      },
    });
    const fh1 = await open(filePath, "a");
    try {
      await fh1.appendFile(partial);
    } finally {
      await fh1.close();
    }

    // Read from cursor 0: no newline → 0 events, cursor stays at 0.
    const r1 = await readEventsSince(filePath, cursor);
    expect(r1.success).toBe(true);
    if (!r1.success) return;
    expect(r1.data.events).toHaveLength(0);
    expect(r1.data.nextCursor.offsetBytes).toBe(0);

    // Append the closing newline.
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
        `${userLine("before")}{not json}\n${assistantLine("after")}${eventMsgLine("task_complete")}`,
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

  it("task_complete ⇒ turn-end completed", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("ping")}${assistantLine("pong")}${eventMsgLine("task_complete")}`,
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
      signal: "task_complete",
    });
  });

  it("turn_aborted ⇒ turn-end aborted", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("do a thing")}${assistantLine("part")}${eventMsgLine("turn_aborted")}`,
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
      outcome: "aborted",
      signal: "turn_aborted",
    });
  });

  it("reasoning ⇒ thinking event (trimmed, non-empty)", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${reasoningLine("  let me think  ")}${assistantLine("result")}${eventMsgLine("task_complete")}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const thinking = result.data.events.find((e) => e.kind === "thinking");
    expect(thinking).toMatchObject({ kind: "thinking", text: "let me think" });
  });

  it("function_call ⇒ tool-call event", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("go")}${functionCallLine("bash", "call-abc")}${eventMsgLine("task_complete")}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const toolCall = result.data.events.find((e) => e.kind === "tool-call");
    expect(toolCall).toMatchObject({
      kind: "tool-call",
      name: "bash",
      callId: "call-abc",
    });
  });

  it("token_count and other event_msg noise → no events emitted", async () => {
    await writeFile(filePath, "");
    const cursor = await snapshotCursor(filePath);

    const fh = await open(filePath, "a");
    try {
      await fh.appendFile(
        `${userLine("go")}${tokenCountLine()}${assistantLine("ok")}${eventMsgLine("task_complete")}`,
      );
    } finally {
      await fh.close();
    }

    const result = await readEventsSince(filePath, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // token_count should not appear as any event kind
    const kinds = result.data.events.map((e) => e.kind);
    expect(kinds).not.toContain("token_count");
    expect(kinds).toEqual(["user", "assistant", "turn-end"]);
  });

  it("nextCursor advances to EOF after consuming all lines", async () => {
    await writeFile(
      filePath,
      `${userLine("q")}${assistantLine("a")}${eventMsgLine("task_complete")}`,
    );

    const result = await readEventsSince(filePath, undefined);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const r2 = await readEventsSince(filePath, result.data.nextCursor);
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    expect(r2.data.events).toHaveLength(0);
  });
});
