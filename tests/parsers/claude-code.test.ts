/**
 * Tests for the claude-code parser in agent-canonical.
 *
 * Coverage:
 *  - Core parse (tiny fixture): id scheme, metadata extraction, roles, tool pairing.
 *  - Assistant-event deduplication by message.id.
 *  - Usage attribution once per unique message.id.
 *  - endedAt from the deduplicated event stream.
 *  - Thinking blocks as role:"thinking" messages, skipped for title derivation.
 *  - Per-block merge (new cc format: one block per event, same message.id).
 *  - Triple-emit golden: 1× usage even when the same message.id appears 3×.
 *  - SessionSchema.parse round-trip on a clean fixture.
 *  - ParseResult shape (success:true, issues:[]) for well-formed input.
 *  - fail() path for empty file / no sessionId.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSessionFile } from "../../src/parsers/claude-code/index.js";
import type { ParseIssue, ParseResult } from "../../src/parsers/types.js";
import { SessionSchema } from "../../src/schemas/index.js";
import type { Session } from "../../src/schemas/session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FX = join(__dirname, "claude-code-fixtures");

const TINY = join(FX, "tiny.jsonl");
const DUP = join(FX, "duplicated-message-ids.jsonl");
const PER_BLOCK = join(FX, "per-block-message-events.jsonl");
const THINKING = join(FX, "thinking-blocks.jsonl");
const EMPTY_THINKING = join(FX, "empty-thinking.jsonl");
const TRIPLE_EMIT = join(FX, "triple-emit-usage.jsonl");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert result is success; throw descriptively if not. */
function assertOk(
  result: ParseResult<Session>,
): asserts result is { success: true; data: Session; issues: ParseIssue[] } {
  if (!result.success) {
    throw new Error(
      `Expected parse success, got fail: ${JSON.stringify(result.issues)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Core parse (tiny fixture)
// ---------------------------------------------------------------------------

describe("parseSessionFile — tiny fixture", () => {
  it("returns success with issues:[] for a clean fixture", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    expect(result.success).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("produces a Session that passes SessionSchema.parse", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    // If this throws, the output shape is wrong.
    expect(() => SessionSchema.parse(result.data)).not.toThrow();
  });

  it("id is cc--<sessionId>, cli is claude-code, externalId matches", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    const s = result.data;
    expect(s.id).toBe("cc--fixture-001");
    expect(s.cli).toBe("claude-code");
    expect(s.externalId).toBe("fixture-001");
  });

  it("extracts projectPath, gitBranch, model", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    const s = result.data;
    expect(s.projectPath).toBe("/Users/u/repo");
    expect(s.gitBranch).toBe("main");
    expect(s.model).toBe("claude-sonnet-4");
  });

  it("drops noise types and produces only semantic message rows", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    const roles = result.data.transcript.messages.map((m) => m.role);
    // file-history-snapshot and system/turn_duration are skipped;
    // tool_result-only user lines produce no message row.
    expect(roles).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result.data.transcript.messages).toHaveLength(5);
  });

  it("pairs tool_use and tool_result by callId", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    const allTc = result.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(allTc).toHaveLength(2);
    const first = allTc[0];
    const second = allTc[1];
    if (!first || !second) throw new Error("expected 2 tool calls");
    expect(first.name).toBe("Shell");
    expect(first.callId).toBe("tc_1");
    expect(first.outputPreview).toContain("README.md");
    expect(first.outputFull).toContain("README.md");
    expect(first.exitCode).toBe(0);
    expect(second.callId).toBe("tc_2");
    expect(second.outputPreview).toContain("total 8");
  });

  it("content hash is a hex-64 string and is stable across two parses", async () => {
    const r1 = await parseSessionFile(TINY);
    const r2 = await parseSessionFile(TINY);
    assertOk(r1);
    assertOk(r2);
    expect(r1.data.transcript.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.data.transcript.contentHash).toBe(r2.data.transcript.contentHash);
  });

  it("sets startedAt <= endedAt", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    const s = result.data;
    expect(typeof s.startedAt).toBe("number");
    expect(typeof s.endedAt).toBe("number");
    expect(s.startedAt ?? 0).toBeLessThanOrEqual(s.endedAt ?? 0);
  });

  it("keeps raw events losslessly (every source line captured)", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    // Tiny fixture has 9 lines (1 file-history-snapshot + 8 content lines).
    const rawEvs = result.data.transcript.rawEvents ?? [];
    expect(rawEvs.length).toBeGreaterThan(5);
    const firstRaw = rawEvs[0];
    if (!firstRaw) throw new Error("expected at least one raw event");
    expect(firstRaw.eventType).toBe("file-history-snapshot");
    expect(firstRaw.rawJson).toContain("trackedFileBackups");
  });

  it("title is derived from the first non-thinking message, clipped to 200 chars", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    expect(result.data.title).toBe("please list the top-level files");
  });

  it("rawPath on transcript matches the input filePath", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    expect(result.data.transcript.rawPath).toBe(TINY);
  });
});

// ---------------------------------------------------------------------------
// Deduplication, usage, and endedAt
// ---------------------------------------------------------------------------

describe("deduplicate assistant events by message.id", () => {
  it("each assistant message appears exactly once even when emitted 3×", async () => {
    const result = await parseSessionFile(DUP);
    assertOk(result);
    const roles = result.data.transcript.messages.map((m) => m.role);
    // 1 user + msg_A (3×) + tool_result user (no text) + msg_B (2×)
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    const allTc = result.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(allTc).toHaveLength(1);
    expect(allTc[0]?.callId).toBe("tc_1");
  });
});

describe("attribute usage once per unique message.id", () => {
  it("session token totals = sum of unique message.ids only", async () => {
    const result = await parseSessionFile(DUP);
    assertOk(result);
    const t = result.data.transcript;
    // msg_A: in=100 out=50 cw=1000 cr=2000
    // msg_B: in=200 out=80 cw=500  cr=3000
    expect(t.inputTokens).toBe(300);
    expect(t.outputTokens).toBe(130);
    expect(t.cacheCreationTokens).toBe(1500);
    expect(t.cacheReadTokens).toBe(5000);
  });

  it("per-message usage attributes correctly and sums to session totals", async () => {
    const result = await parseSessionFile(DUP);
    assertOk(result);
    const asst = result.data.transcript.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(asst).toHaveLength(2);
    expect(asst[0]?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 2000,
      cacheCreationTokens: 1000,
    });
    expect(asst[1]?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 3000,
      cacheCreationTokens: 500,
    });
    // User turns carry no usage.
    const user = result.data.transcript.messages.find((m) => m.role === "user");
    expect(user?.usage).toBeUndefined();
  });

  it("per-message usage sums equal the session transcript totals", async () => {
    const result = await parseSessionFile(DUP);
    assertOk(result);
    const msgs = result.data.transcript.messages;
    const t = result.data.transcript;
    const sum = (
      k:
        | "inputTokens"
        | "outputTokens"
        | "cacheReadTokens"
        | "cacheCreationTokens",
    ) => msgs.reduce((acc, m) => acc + (m.usage?.[k] ?? 0), 0);
    expect(sum("inputTokens")).toBe(t.inputTokens);
    expect(sum("outputTokens")).toBe(t.outputTokens);
    expect(sum("cacheReadTokens")).toBe(t.cacheReadTokens);
    expect(sum("cacheCreationTokens")).toBe(t.cacheCreationTokens);
  });

  it("all source lines are captured in rawEvents (lossless)", async () => {
    const result = await parseSessionFile(DUP);
    assertOk(result);
    // 7 lines in duplicated-message-ids.jsonl
    expect(result.data.transcript.rawEvents ?? []).toHaveLength(7);
  });
});

describe("derive endedAt from the deduplicated event stream", () => {
  it("endedAt = timestamp of the LAST logically new event, ignoring re-emits", async () => {
    const result = await parseSessionFile(DUP);
    assertOk(result);
    // msg_A first emission: 10:00:01.000 → endedAt after that = 1s
    // msg_A copies at 10:00:01.100 and 10:00:01.200 — NOT counted (deduped).
    // tool_result user at 10:00:02 → 2s (new logical event).
    // msg_B first emission: 10:00:03.000 → 3s.
    // msg_B copy at 10:00:03.100 — NOT counted.
    // Expected endedAt = seconds since epoch for 2026-05-28T10:00:03.000Z.
    const expectedEndedAt = Math.floor(
      Date.parse("2026-05-28T10:00:03.000Z") / 1000,
    );
    expect(result.data.endedAt).toBe(expectedEndedAt);
  });
});

// ---------------------------------------------------------------------------
// Thinking blocks → role:"thinking" messages
// ---------------------------------------------------------------------------

describe("thinking blocks", () => {
  it("a thinking block produces a role:thinking message before the assistant message", async () => {
    const result = await parseSessionFile(THINKING);
    assertOk(result);
    const msgs = result.data.transcript.messages;
    // user + thinking + assistant
    const roles = msgs.map((m) => m.role);
    expect(roles).toEqual(["user", "thinking", "assistant"]);
  });

  it("thinking message text is the verbatim thinking text (no markdown prefix)", async () => {
    const result = await parseSessionFile(THINKING);
    assertOk(result);
    const tm = result.data.transcript.messages.find(
      (m) => m.role === "thinking",
    );
    if (!tm) throw new Error("expected a thinking message");
    expect(tm.text).toBe("Let me reason about this carefully.");
    expect(tm.text).not.toMatch(/^\*\*Reasoning\*\*/);
  });

  it("assistant message text is the assistant text, not the thinking text", async () => {
    const result = await parseSessionFile(THINKING);
    assertOk(result);
    const am = result.data.transcript.messages.find(
      (m) => m.role === "assistant",
    );
    if (!am) throw new Error("expected an assistant message");
    expect(am.text).toBe("Here is my answer.");
    expect(am.text).not.toContain("Let me reason");
  });

  it("usage attaches to the assistant message, not the thinking message", async () => {
    const result = await parseSessionFile(THINKING);
    assertOk(result);
    const tm = result.data.transcript.messages.find(
      (m) => m.role === "thinking",
    );
    const am = result.data.transcript.messages.find(
      (m) => m.role === "assistant",
    );
    if (!tm || !am)
      throw new Error("expected both thinking and assistant messages");
    expect(am.usage?.inputTokens).toBe(50);
    expect(tm.usage).toBeUndefined();
  });

  it("title skips thinking messages and uses the first non-thinking message", async () => {
    const result = await parseSessionFile(THINKING);
    assertOk(result);
    // First message is "user" with text "solve this problem".
    expect(result.data.title).toBe("solve this problem");
  });

  it("empty thinking text emits no thinking message", async () => {
    const result = await parseSessionFile(EMPTY_THINKING);
    assertOk(result);
    const roles = result.data.transcript.messages.map((m) => m.role);
    // user + assistant only — no thinking message for empty thinking text
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("thinking messages participate in turn numbering", async () => {
    const result = await parseSessionFile(THINKING);
    assertOk(result);
    const msgs = result.data.transcript.messages;
    // user=turn 1 (user takes turn 1), thinking=turn 2, assistant=turn 2
    // Actually: user takes turn 1, then assistant-turn increments to 2;
    // thinking and assistant share the same turn number.
    const thinkingTurn = msgs.find((m) => m.role === "thinking")?.turn;
    const assistantTurn = msgs.find((m) => m.role === "assistant")?.turn;
    expect(thinkingTurn).toBe(assistantTurn);
  });
});

// ---------------------------------------------------------------------------
// Triple-emitted messages contribute usage once
// ---------------------------------------------------------------------------

describe("triple-emit usage deduplication", () => {
  it("session token totals are 1× not 3× for a synthetic triple-emit", async () => {
    const result = await parseSessionFile(TRIPLE_EMIT);
    assertOk(result);
    const t = result.data.transcript;
    // msg_TRIPLE appears 3×: input=100, output=50, cw=200, cr=300 each time.
    // Expected: charged once only.
    expect(t.inputTokens).toBe(100);
    expect(t.outputTokens).toBe(50);
    expect(t.cacheCreationTokens).toBe(200);
    expect(t.cacheReadTokens).toBe(300);
  });

  it("produces exactly one assistant message for triple-emitted message.id", async () => {
    const result = await parseSessionFile(TRIPLE_EMIT);
    assertOk(result);
    const asst = result.data.transcript.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(asst).toHaveLength(1);
    expect(asst[0]?.text).toBe("response text");
  });
});

// ---------------------------------------------------------------------------
// Per-block assistant events (new cc format: one block per event, same message.id)
// ---------------------------------------------------------------------------

describe("per-block assistant events (new cc format)", () => {
  it("produces exactly one assistant message for the split message.id", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    // user + thinking(msg_NEW) + assistant(msg_NEW) + assistant(msg_FINAL)
    // The tool_result-only user event produces no message row.
    const roles = result.data.transcript.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "thinking", "assistant", "assistant"]);
  });

  it("captures text content from the text-block event", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const asstMsg = result.data.transcript.messages.find(
      (m) => m.role === "assistant" && m.toolCalls.length > 0,
    );
    if (!asstMsg) throw new Error("expected assistant message with tool calls");
    expect(asstMsg.text).toBe("I will help you with that.");
  });

  it("captures both tool_use blocks from separate events", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const asstMsg = result.data.transcript.messages.find(
      (m) => m.role === "assistant" && m.toolCalls.length > 0,
    );
    if (!asstMsg) throw new Error("expected assistant message with tool calls");
    expect(asstMsg.toolCalls).toHaveLength(2);
    const names = asstMsg.toolCalls.map((tc) => tc.name);
    expect(names).toContain("Agent");
    expect(names).toContain("Bash");
    const callIds = asstMsg.toolCalls.map((tc) => tc.callId);
    expect(callIds).toContain("tc_A");
    expect(callIds).toContain("tc_B");
  });

  it("pairs tool_results with both merged tool_use blocks", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const allTc = result.data.transcript.messages.flatMap((m) => m.toolCalls);
    const tcA = allTc.find((tc) => tc.callId === "tc_A");
    const tcB = allTc.find((tc) => tc.callId === "tc_B");
    if (!tcA || !tcB) throw new Error("expected both tc_A and tc_B tool calls");
    expect(tcA.outputPreview).toContain("test output");
    expect(tcB.outputPreview).toContain("file1.txt");
  });

  it("counts usage exactly once for the split message (not once per block event)", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const t = result.data.transcript;
    // msg_NEW: input=150 output=60 cc=800 cr=1500 (repeated on all 4 events — charge once)
    // msg_FINAL: input=250 output=40 cc=0 cr=2000 (single event)
    expect(t.inputTokens).toBe(400);
    expect(t.outputTokens).toBe(100);
    expect(t.cacheCreationTokens).toBe(800);
    expect(t.cacheReadTokens).toBe(3500);
  });

  it("attributes per-message usage to the merged message, not to the thinking message", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const asstMsgs = result.data.transcript.messages.filter(
      (m) => m.role === "assistant",
    );
    expect(asstMsgs).toHaveLength(2);
    const merged = asstMsgs.find((m) => m.toolCalls.length > 0);
    if (!merged)
      throw new Error("expected merged assistant message with tool calls");
    // msg_NEW merged: input=150 output=60 cc=800 cr=1500
    expect(merged.usage).toEqual({
      inputTokens: 150,
      outputTokens: 60,
      cacheReadTokens: 1500,
      cacheCreationTokens: 800,
    });
    const finalMsg = asstMsgs.find((m) => m.toolCalls.length === 0);
    if (!finalMsg)
      throw new Error("expected final assistant message without tool calls");
    expect(finalMsg.usage).toEqual({
      inputTokens: 250,
      outputTokens: 40,
      cacheReadTokens: 2000,
      cacheCreationTokens: 0,
    });
    // Thinking message should carry no usage (assistant message received it).
    const thinkingMsg = result.data.transcript.messages.find(
      (m) => m.role === "thinking",
    );
    expect(thinkingMsg?.usage).toBeUndefined();
  });

  it("per-message usage sums to session totals", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const msgs = result.data.transcript.messages;
    const t = result.data.transcript;
    const sum = (
      k:
        | "inputTokens"
        | "outputTokens"
        | "cacheReadTokens"
        | "cacheCreationTokens",
    ) => msgs.reduce((acc, m) => acc + (m.usage?.[k] ?? 0), 0);
    expect(sum("inputTokens")).toBe(t.inputTokens);
    expect(sum("outputTokens")).toBe(t.outputTokens);
    expect(sum("cacheReadTokens")).toBe(t.cacheReadTokens);
    expect(sum("cacheCreationTokens")).toBe(t.cacheCreationTokens);
  });

  it("thinking block is a role:thinking message (not dropped, not embedded in assistant text)", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const tm = result.data.transcript.messages.find(
      (m) => m.role === "thinking",
    );
    if (!tm) throw new Error("expected a thinking message");
    expect(tm.text).toBe("internal reasoning");
    // Should NOT appear in the assistant message text.
    const asstMsg = result.data.transcript.messages.find(
      (m) => m.role === "assistant" && m.toolCalls.length > 0,
    );
    if (!asstMsg) throw new Error("expected assistant message with tool calls");
    expect(asstMsg.text).not.toContain("internal reasoning");
  });

  it("preserves all raw events losslessly", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    // 7 lines: 1 user + 4 assistant (msg_NEW) + 1 user(tool_result) + 1 assistant (msg_FINAL)
    expect(result.data.transcript.rawEvents ?? []).toHaveLength(7);
  });

  it("thinking message precedes the assistant message in stream order", async () => {
    const result = await parseSessionFile(PER_BLOCK);
    assertOk(result);
    const msgs = result.data.transcript.messages;
    const thinkIdx = msgs.findIndex((m) => m.role === "thinking");
    const asstIdx = msgs.findIndex(
      (m) => m.role === "assistant" && m.toolCalls.length > 0,
    );
    expect(thinkIdx).toBeGreaterThanOrEqual(0);
    expect(thinkIdx).toBeLessThan(asstIdx);
  });
});

// ---------------------------------------------------------------------------
// Fail paths
// ---------------------------------------------------------------------------

describe("fail paths", () => {
  it("returns fail for a non-existent file", async () => {
    const result = await parseSessionFile(
      "/tmp/nonexistent-agent-canonical-test.jsonl",
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues[0]?.severity).toBe("error");
      expect(result.issues[0]?.message).toContain("Cannot read file");
    }
  });

  it("returns fail for a file with no sessionId", async () => {
    // Write a temp file with a line that has no sessionId.
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "ac-cc-test-"));
    const p = join(dir, "nosession.jsonl");
    try {
      await writeFile(
        p,
        '{"type":"user","message":{"role":"user","content":"hi"},"timestamp":"2026-01-01T00:00:00.000Z"}\n',
      );
      const result = await parseSessionFile(p);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues[0]?.severity).toBe("error");
        expect(result.issues[0]?.message).toContain("sessionId");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns fail for a file with zero messages (all lines are SKIP_TYPES)", async () => {
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "ac-cc-test-"));
    const p = join(dir, "skiponly.jsonl");
    try {
      await writeFile(
        p,
        '{"type":"system","sessionId":"s-skip-001","timestamp":"2026-01-01T00:00:00.000Z"}\n',
      );
      const result = await parseSessionFile(p);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.issues.some((i) => i.severity === "error")).toBe(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// idPrefix option
// ---------------------------------------------------------------------------

describe("ClaudeCodeParseOptions.idPrefix", () => {
  it("id uses custom idPrefix when provided", async () => {
    const result = await parseSessionFile(TINY, { idPrefix: "mycc" });
    assertOk(result);
    expect(result.data.id).toBe("mycc--fixture-001");
  });

  it("id uses default 'cc' prefix when not provided", async () => {
    const result = await parseSessionFile(TINY);
    assertOk(result);
    expect(result.data.id).toMatch(/^cc--/);
  });
});

// ---------------------------------------------------------------------------
// Metadata extraction from wrapper-only user lines
// ---------------------------------------------------------------------------

const PRE_USER_ATTACH_META = join(FX, "pre-user-attachment-metadata.jsonl");
const WRAPPER_ONLY_STUB = join(FX, "wrapper-only-stub.jsonl");
const UNKNOWN_TYPE_LINES = join(FX, "unknown-type-lines.jsonl");
const TRAILING_WRAPPER_ENDEDAT = join(FX, "trailing-wrapper-endedat.jsonl");

describe("metadata from wrapper-only user lines", () => {
  it("startedAt is taken from the FIRST user line even when it is wrapper-only", async () => {
    // The first two user lines (wrap1, wrap2) are wrapper-only with ts=10 and ts=20.
    // The first real user line has ts=30; the wrapper at ts=10 establishes startedAt.
    const result = await parseSessionFile(PRE_USER_ATTACH_META);
    assertOk(result);
    const expectedStartedAt = Math.floor(
      Date.parse("2026-06-01T10:00:10.000Z") / 1000,
    );
    expect(result.data.startedAt).toBe(expectedStartedAt);
  });

  it("gitBranch is taken from the FIRST user line even when it is wrapper-only", async () => {
    // wrap1 has gitBranch="wrapper-branch"; the real user line uses a later branch.
    const result = await parseSessionFile(PRE_USER_ATTACH_META);
    assertOk(result);
    expect(result.data.gitBranch).toBe("wrapper-branch");
  });

  it("endedAt is extended by trailing wrapper-only user lines", async () => {
    // File has: real user (ts=1), real assistant (ts=10), wrapper user (ts=20), wrapper user (ts=30).
    // endedAt is the maximum user/assistant timestamp, including wrappers.
    const result = await parseSessionFile(TRAILING_WRAPPER_ENDEDAT);
    assertOk(result);
    const expectedEndedAt = Math.floor(
      Date.parse("2026-06-01T10:00:30.000Z") / 1000,
    );
    expect(result.data.endedAt).toBe(expectedEndedAt);
  });

  it("messages contain only the non-wrapper user content — wrappers produce no message row", async () => {
    // Even though wrapper lines contribute to metadata, they must not produce message rows.
    const result = await parseSessionFile(PRE_USER_ATTACH_META);
    assertOk(result);
    const roles = result.data.transcript.messages.map((m) => m.role);
    // Only the real user and the assistant should appear.
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("wrapper-only-stub file returns fail because it has no messages", async () => {
    // File contains only a mode line + two wrapper-only user lines, no real messages.
    // Wrapper-only content carries metadata but does not create a session message.
    const result = await parseSessionFile(WRAPPER_ONLY_STUB);
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error should be about no messages, not about missing sessionId.
      // (sessionId IS found from the wrapper user lines now.)
      expect(result.issues.some((i) => i.severity === "error")).toBe(true);
      const errMsg =
        result.issues.find((i) => i.severity === "error")?.message ?? "";
      expect(errMsg).toContain("messages");
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown event types produce no warnings.
// Known bookkeeping types (mode, ai-title, worktree-state, pr-link, custom-title,
// agent-name) must be silently skipped, not warned.
// ---------------------------------------------------------------------------

describe("silent skip of non-semantic event types — no spurious warnings", () => {
  it("returns success with zero warnings when file contains only known skip types + real messages", async () => {
    // File has mode, ai-title, worktree-state, pr-link, custom-title, agent-name lines.
    // None of these should produce warnings.
    const result = await parseSessionFile(UNKNOWN_TYPE_LINES);
    assertOk(result);
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings).toHaveLength(0);
  });

  it("a malformed JSON line still produces a warning (malformed content is unexpected)", async () => {
    // Write a temp file with one malformed JSON line + one valid user line.
    const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "ac-cc-test-"));
    const p = join(dir, "malformed.jsonl");
    try {
      await writeFile(
        p,
        [
          "not valid json at all",
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "hello" },
            uuid: "u1",
            timestamp: "2026-06-01T10:00:01.000Z",
            sessionId: "malformed-test-001",
            cwd: "/tmp",
            gitBranch: "main",
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "hi" }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            uuid: "a1",
            timestamp: "2026-06-01T10:00:05.000Z",
            sessionId: "malformed-test-001",
            cwd: "/tmp",
            gitBranch: "main",
          }),
        ].join("\n"),
      );
      const result = await parseSessionFile(p);
      assertOk(result);
      // The malformed line must produce exactly one warning.
      const warnings = result.issues.filter((i) => i.severity === "warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toContain("JSON parse failed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
