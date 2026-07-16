/**
 * Qwen Code parser tests — a sanitized, capture-derived fixture plus synthetic
 * temp files for paths the fixture does not exercise (thought parts, error
 * tool results).
 *
 * The `capture-derived.jsonl` fixture contains a user prompt → two synthetic
 * shell tool calls → final reply. Paths, identifiers, timestamps, tool outputs,
 * usage values, and routing metadata are deterministic placeholders; the
 * record structure and correlation behavior are preserved.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeLine } from "../../src/parsers/qwen/events.js";
import { parseSessionFile } from "../../src/parsers/qwen/index.js";
import { IssueCollector } from "../../src/parsers/types.js";
import { SessionSchema } from "../../src/schemas/session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/qwen/capture-derived.jsonl");

/** Write JSONL lines to a temp file, return { file, cleanup }. */
function makeTempSession(lines: object[]): {
  file: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "qwen-parser-test-"));
  const file = join(dir, "0000000-0000-0000-0000-000000000000.jsonl");
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Capture-derived fixture
// ---------------------------------------------------------------------------

describe("qwen parser — capture-derived fixture", () => {
  it("parses the cc-enveloped records into a canonical session", async () => {
    const result = await parseSessionFile(FIXTURE);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const s = result.data;
    expect(s.id).toBe("qw--qwen-fixture-0001");
    expect(s.cli).toBe("qwen");
    expect(s.externalId).toBe("qwen-fixture-0001");
    expect(s.projectPath).toBe("/home/u/qwen-fixture");
    expect(s.gitBranch).toBe("main");
    expect(s.model).toBe("qwen/qwen3-coder");
    // The canonical session round-trips through its own schema.
    expect(SessionSchema.safeParse(s).success).toBe(true);
  });

  it("drops system records and keeps user/assistant messages in order", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const roles = result.data.transcript.messages.map((m) => m.role);
    // user, assistant(fc #1), assistant(fc #2), assistant(final text).
    // The six `system` records (one snapshot, five telemetry) produce no messages.
    expect(roles).toEqual(["user", "assistant", "assistant", "assistant"]);
  });

  it("correlates each tool_result to its assistant tool call by call id", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const msgs = result.data.transcript.messages;
    const calls = msgs.flatMap((m) => m.toolCalls);
    expect(calls).toHaveLength(2);

    const [first, second] = calls;
    expect(first?.name).toBe("run_shell_command");
    expect(first?.exitCode).toBe(0);
    expect(first?.outputFull).toContain("runtime-fixture");
    expect(second?.outputFull).toContain("os-fixture");
  });

  it("sums per-message usageMetadata into transcript totals", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const t = result.data.transcript;
    expect(t.inputTokens).toBe(10 + 20 + 30);
    expect(t.outputTokens).toBe(1 + 2 + 3);
    expect(t.cacheReadTokens).toBe(5 + 10);
  });

  it("derives the title from the first user turn", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    expect(result.data.title).toContain("synthetic shell command");
  });

  it("preserves every raw line in the lossless rawEvents tier", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    // 12 records: 1 user + 3 assistant + 2 tool_result + 6 system snapshots.
    const rawEvents = result.data.transcript.rawEvents ?? [];
    expect(rawEvents).toHaveLength(12);
    const types = rawEvents.map((e) => e.eventType);
    expect(types.filter((t) => t === "system")).toHaveLength(6);
    expect(types.filter((t) => t === "tool_result")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Synthetic — paths the capture-derived fixture does not hit
// ---------------------------------------------------------------------------

describe("qwen parser — synthetic edge cases", () => {
  it("emits a thinking message from a thought:true part, before the reply", async () => {
    const { file, cleanup } = makeTempSession([
      {
        type: "user",
        sessionId: "s1",
        cwd: "/home/u/repo",
        gitBranch: "main",
        timestamp: "2026-07-15T10:00:00.000Z",
        message: { role: "user", parts: [{ text: "hi" }] },
      },
      {
        type: "assistant",
        sessionId: "s1",
        cwd: "/home/u/repo",
        gitBranch: "main",
        timestamp: "2026-07-15T10:00:01.000Z",
        model: "qwen/qwen3-coder",
        message: {
          role: "model",
          parts: [
            {
              thought: true,
              text: "The user greeted me; I should greet back.",
            },
            { text: "Hello!" },
          ],
        },
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const msgs = result.data.transcript.messages;
      expect(msgs.map((m) => m.role)).toEqual([
        "user",
        "thinking",
        "assistant",
      ]);
      expect(msgs[1]?.text).toBe("The user greeted me; I should greet back.");
      expect(msgs[2]?.text).toBe("Hello!");
      // Usage attaches to the assistant body, not the thinking message.
      expect(msgs[1]?.usage).toBeUndefined();
      expect(msgs[2]?.usage?.inputTokens).toBe(10);
    } finally {
      cleanup();
    }
  });

  it("marks an error tool_result with a non-zero exit code", async () => {
    const { file, cleanup } = makeTempSession([
      {
        type: "user",
        sessionId: "s2",
        cwd: "/home/u/repo",
        timestamp: "2026-07-15T10:00:00.000Z",
        message: { role: "user", parts: [{ text: "run it" }] },
      },
      {
        type: "assistant",
        sessionId: "s2",
        cwd: "/home/u/repo",
        timestamp: "2026-07-15T10:00:01.000Z",
        model: "qwen/qwen3-coder",
        message: {
          role: "model",
          parts: [
            {
              functionCall: {
                id: "call-err",
                name: "run_shell_command",
                args: { command: "false" },
              },
            },
          ],
        },
      },
      {
        type: "tool_result",
        sessionId: "s2",
        cwd: "/home/u/repo",
        timestamp: "2026-07-15T10:00:02.000Z",
        message: {
          role: "user",
          parts: [
            {
              functionResponse: {
                id: "call-err",
                name: "run_shell_command",
                response: { output: "boom" },
              },
            },
          ],
        },
        toolCallResult: {
          callId: "call-err",
          status: "error",
          resultDisplay: "boom",
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const tc = result.data.transcript.messages.flatMap((m) => m.toolCalls)[0];
      expect(tc?.exitCode).toBe(1);
      expect(tc?.outputFull).toBe("boom");
    } finally {
      cleanup();
    }
  });

  it("fails cleanly on a file with no identifiable session", async () => {
    const { file, cleanup } = makeTempSession([
      { type: "system", subtype: "ui_telemetry", systemPayload: {} },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("decodes a bare assistant record without throwing (unit)", () => {
    const collector = new IssueCollector();
    const event = decodeLine(
      JSON.stringify({
        type: "assistant",
        sessionId: "s3",
        model: "qwen/qwen3-coder",
        message: { role: "model", parts: [{ text: "ok" }] },
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
      }),
      0,
      collector,
    );
    expect(event.kind).toBe("assistant");
    if (event.kind !== "assistant") return;
    expect(event.text).toBe("ok");
    expect(event.usage?.inputTokens).toBe(5);
  });

  it("treats a malformed JSON line as a warning, not a throw (unit)", () => {
    const collector = new IssueCollector();
    const event = decodeLine("{not json", 3, collector);
    expect(event.kind).toBe("malformed");
    expect(collector.list().length).toBeGreaterThan(0);
  });
});
