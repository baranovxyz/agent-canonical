/**
 * Tests for src/parsers/cursor/incremental.ts
 *
 * Uses real tmp-dir JSONL files. Each test writes JSONL content and asserts
 * on the TurnEvents produced by readEventsSince.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readEventsSince,
  snapshotCursor,
} from "../../src/parsers/cursor/index.js";

// ---------------------------------------------------------------------------
// JSONL line helpers
// ---------------------------------------------------------------------------

function userLine(text: string): string {
  return `${JSON.stringify({
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: `<timestamp>Tuesday, Jun 2, 2026, 6:15 PM (UTC+2)</timestamp>\n<user_query>\n${text}\n</user_query>`,
        },
      ],
    },
  })}\n`;
}

function userLineRaw(text: string): string {
  // User line WITHOUT <user_query> wrapper — bare text fallback
  return `${JSON.stringify({
    role: "user",
    message: {
      content: [{ type: "text", text }],
    },
  })}\n`;
}

function assistantLine(text: string): string {
  return `${JSON.stringify({
    role: "assistant",
    message: { content: [{ type: "text", text }] },
  })}\n`;
}

function assistantToolUseLine(text: string, toolName = "Shell"): string {
  return `${JSON.stringify({
    role: "assistant",
    message: {
      content: [
        { type: "text", text },
        {
          type: "tool_use",
          name: toolName,
          input: { command: "ls" },
        },
      ],
    },
  })}\n`;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cx-incremental-"));
  filePath = join(dir, "session.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// snapshotCursor tests
// ---------------------------------------------------------------------------

describe("snapshotCursor", () => {
  it("returns offsetBytes = file size for an existing file", async () => {
    await writeFile(filePath, userLine("hello"));
    const cursor = await snapshotCursor(filePath);
    expect(cursor.kind).toBe("file");
    expect(cursor.path).toBe(filePath);
    expect(cursor.offsetBytes).toBeGreaterThan(0);
  });

  it("returns offsetBytes = 0 for a missing file", async () => {
    const cursor = await snapshotCursor(join(dir, "missing.jsonl"));
    expect(cursor.offsetBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — full turn
// ---------------------------------------------------------------------------

describe("readEventsSince — full turn", () => {
  it("<user_query> wrapped user + text-only assistant produce user event with inner text and turn-end", async () => {
    const prompt = "explain TCP";
    await writeFile(
      filePath,
      `${userLine(prompt)}${assistantLine("TCP uses a 3-way handshake.")}`,
    );

    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events } = result.data;

    const userEvent = events.find((e) => e.kind === "user");
    expect(userEvent?.kind === "user" && userEvent.text).toBe("explain TCP");

    const assistantEvent = events.find((e) => e.kind === "assistant");
    expect(assistantEvent?.kind === "assistant" && assistantEvent.text).toBe(
      "TCP uses a 3-way handshake.",
    );

    const turnEnd = events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "assistant-final-text",
    });
  });

  it("user event carries the INNER prompt text (not the wrapper)", async () => {
    await writeFile(filePath, userLine("count to 5"));
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const userEvent = result.data.events.find((e) => e.kind === "user");
    expect(userEvent?.kind === "user" && userEvent.text).toBe("count to 5");
    // Must NOT contain wrapper tags
    if (userEvent?.kind === "user") {
      expect(userEvent.text).not.toContain("<user_query>");
      expect(userEvent.text).not.toContain("<timestamp>");
    }
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — assistant with trailing tool_use
// ---------------------------------------------------------------------------

describe("readEventsSince — assistant with trailing tool_use", () => {
  it("assistant with trailing tool_use produces tool-call event but NO turn-end", async () => {
    await writeFile(
      filePath,
      `${userLine("create file")}${assistantToolUseLine("I will create the file.", "Shell")}`,
    );
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events } = result.data;

    const toolCall = events.find((e) => e.kind === "tool-call");
    expect(toolCall).toMatchObject({ kind: "tool-call", name: "Shell" });

    const turnEnd = events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — multi-record turn
// ---------------------------------------------------------------------------

describe("readEventsSince — multi-record turn", () => {
  it("{text+tool_use} then {text} produces two assistant events, turn-end only after the second", async () => {
    await writeFile(
      filePath,
      `${userLine("do the thing")}${assistantToolUseLine("I'll run the tool.", "bash")}${assistantLine("All done.")}`,
    );
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events } = result.data;

    const assistantEvents = events.filter((e) => e.kind === "assistant");
    expect(assistantEvents).toHaveLength(2);
    expect(
      assistantEvents[0]?.kind === "assistant" && assistantEvents[0].text,
    ).toBe("I'll run the tool.");
    expect(
      assistantEvents[1]?.kind === "assistant" && assistantEvents[1].text,
    ).toBe("All done.");

    const turnEndEvents = events.filter((e) => e.kind === "turn-end");
    expect(turnEndEvents).toHaveLength(1);
    // The turn-end should come after the last assistant event
    const lastAssistantIdx = events.map((e) => e.kind).lastIndexOf("assistant");
    const turnEndIdx = events.findIndex((e) => e.kind === "turn-end");
    expect(turnEndIdx).toBeGreaterThan(lastAssistantIdx);
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — Composer redacted-reasoning token
// ---------------------------------------------------------------------------

describe("readEventsSince — Composer [REDACTED] reasoning token", () => {
  it("drops a bare-[REDACTED] tool round from reply events but keeps its tool-call and strips the trailing token from the final turn", async () => {
    await writeFile(
      filePath,
      // Silent tool round (text is purely the placeholder) + final answer
      // with the placeholder appended after real prose.
      `${userLine("inspect the configuration")}${assistantToolUseLine("[REDACTED]", "Grep")}${assistantLine("Inspection complete: configuration is valid.\n\n[REDACTED]")}`,
    );
    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events } = result.data;

    // The bare-[REDACTED] round contributes no assistant (reply) text…
    const assistantEvents = events.filter((e) => e.kind === "assistant");
    expect(assistantEvents).toHaveLength(1);
    expect(
      assistantEvents[0]?.kind === "assistant" && assistantEvents[0].text,
    ).toBe("Inspection complete: configuration is valid.");

    // …but its tool call is still observed.
    expect(events.filter((e) => e.kind === "tool-call")).toHaveLength(1);

    // No reply event anywhere still carries the marker.
    for (const e of assistantEvents) {
      expect(e.kind === "assistant" && e.text).not.toContain("[REDACTED]");
    }
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — watermark slicing
// ---------------------------------------------------------------------------

describe("readEventsSince — watermark slicing", () => {
  it("cursor after turn 1 yields only turn 2 events", async () => {
    const turn1 = `${userLine("first")}${assistantLine("answer one")}`;
    await writeFile(filePath, turn1);

    // Snapshot after turn 1
    const cursor1 = await snapshotCursor(filePath);

    // Append turn 2
    const { appendFile } = await import("node:fs/promises");
    await appendFile(
      filePath,
      `${userLine("second")}${assistantLine("answer two")}`,
    );

    const result = await readEventsSince(filePath, cursor1);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events } = result.data;

    const userEvent = events.find((e) => e.kind === "user");
    expect(userEvent?.kind === "user" && userEvent.text).toBe("second");

    const assistantEvent = events.find((e) => e.kind === "assistant");
    expect(assistantEvent?.kind === "assistant" && assistantEvent.text).toBe(
      "answer two",
    );
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — rotation
// ---------------------------------------------------------------------------

describe("readEventsSince — rotation", () => {
  it("cursor.path mismatch causes read from 0", async () => {
    await writeFile(filePath, `${userLine("hello")}${assistantLine("world")}`);

    const staleCursor = {
      kind: "file" as const,
      path: join(dir, "old-session.jsonl"),
      offsetBytes: 9999,
    };

    const result = await readEventsSince(filePath, staleCursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events } = result.data;

    // Should read from 0 — both user and assistant events present
    const userEvent = events.find((e) => e.kind === "user");
    expect(userEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — unterminated trailing line
// ---------------------------------------------------------------------------

describe("readEventsSince — unterminated trailing line", () => {
  it("unterminated trailing line is not consumed, consumed after newline lands", async () => {
    const line = assistantLine("complete");
    const partial = line.trimEnd(); // remove the trailing \n

    await writeFile(filePath, partial);
    const result1 = await readEventsSince(filePath);
    expect(result1.success).toBe(true);
    if (!result1.success) return;
    // No events — the line was not newline-terminated
    expect(result1.data.events).toHaveLength(0);

    // Append the newline to complete the line
    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, "\n");

    const result2 = await readEventsSince(filePath);
    expect(result2.success).toBe(true);
    if (!result2.success) return;
    // Now the complete line is consumed
    const assistantEvent = result2.data.events.find(
      (e) => e.kind === "assistant",
    );
    expect(assistantEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — user line without <user_query> wrapper
// ---------------------------------------------------------------------------

describe("readEventsSince — fallback when no <user_query> wrapper", () => {
  it("user line without wrapper uses whole text", async () => {
    const rawText = "bare prompt without wrapper";
    await writeFile(filePath, `${userLineRaw(rawText)}${assistantLine("ok")}`);

    const result = await readEventsSince(filePath);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const userEvent = result.data.events.find((e) => e.kind === "user");
    expect(userEvent?.kind === "user" && userEvent.text).toBe(rawText);
  });
});
