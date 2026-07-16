/** Gemini CLI parser tests — bundled fixture + synthetic temp files. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeLine } from "../../src/parsers/gemini/events.js";
import { parseSessionFile } from "../../src/parsers/gemini/index.js";
import { IssueCollector } from "../../src/parsers/types.js";
import { SessionSchema } from "../../src/schemas/session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/gemini/tiny.jsonl");

/** Write JSONL lines to a temp file, return { file, cleanup }. */
function makeTempSession(lines: object[]): {
  file: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "gemini-parser-test-"));
  const file = join(dir, "session-2026-07-14T10-00-abcd1234.jsonl");
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Core behavior
// ---------------------------------------------------------------------------

describe("gemini parser — core behavior", () => {
  it("parses metadata header + message records into a canonical session", async () => {
    const result = await parseSessionFile(FIXTURE);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const s = result.data;
    expect(s.id).toBe("gm--gem-fix-001");
    expect(s.cli).toBe("gemini");
    expect(s.externalId).toBe("gem-fix-001");
    expect(s.projectPath).toBe("/home/u/repo");
    expect(s.model).toBe("gemini-2.5-pro");
    expect(s.title).toBe("list the top-level files");
    // startTime → startedAt; lastUpdated (later than any message ts) → endedAt.
    expect(s.startedAt).toBe(
      Math.floor(Date.parse("2026-07-14T10:00:00Z") / 1000),
    );
    expect(s.endedAt).toBe(
      Math.floor(Date.parse("2026-07-14T10:05:00Z") / 1000),
    );
  });

  it("maps type→role: user, gemini→assistant (with thinking), info→system", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const roles = result.data.transcript.messages.map((m) => m.role);
    expect(roles).toEqual([
      "user",
      "thinking",
      "assistant",
      "user",
      "assistant",
      "system",
    ]);
  });

  it("emits an unprefixed thinking message from gemini thoughts", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const thinking = result.data.transcript.messages[1];
    expect(thinking?.role).toBe("thinking");
    expect(thinking?.text).toBe(
      "Inspect repo: I should list the root before answering.",
    );
    // Reasoning tokens attach to the assistant body, not the thinking message.
    expect(thinking?.usage).toBeUndefined();
  });

  it("attaches the enriched tool call to its assistant turn", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const assistant = result.data.transcript.messages.find(
      (m) => m.text === "Let me check the directory.",
    );
    expect(assistant?.role).toBe("assistant");
    const tc = assistant?.toolCalls[0];
    expect(tc?.name).toBe("run_shell_command");
    expect(tc?.callId).toBe("tool-1");
    expect(tc?.exitCode).toBe(0); // status:"success"
    expect(tc?.args).toMatchObject({ command: "ls" });
    expect(tc?.outputPreview).toContain("README.md");
    expect(tc?.outputFull).toContain("package.json");
  });

  it("sums per-message tokens into transcript totals and keeps per-message usage", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const t = result.data.transcript;
    expect(t.inputTokens).toBe(250); // 100 + 150
    expect(t.outputTokens).toBe(50); // 20 + 30
    expect(t.cacheReadTokens).toBe(50); // 10 + 40
    expect(t.reasoningTokens).toBe(5); // 5 + 0

    const firstAssistant = t.messages.find(
      (m) => m.text === "Let me check the directory.",
    );
    expect(firstAssistant?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      reasoningTokens: 5,
    });
  });

  it("keeps model and usage from a thoughts-only assistant record", async () => {
    const { file, cleanup } = makeTempSession([
      { sessionId: "gem-thoughts-001", startTime: "2026-07-14T10:00:00.000Z" },
      { id: "u1", type: "user", content: "investigate" },
      {
        id: "a1",
        type: "gemini",
        model: "gemini-2.5-flash",
        thoughts: [{ subject: "Plan", description: "Inspect the repository." }],
        tokens: { input: 12, output: 3, cached: 4, thoughts: 2, total: 21 },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.model).toBe("gemini-2.5-flash");
      expect(result.data.transcript.inputTokens).toBe(12);
      expect(result.data.transcript.outputTokens).toBe(3);
      expect(result.data.transcript.cacheReadTokens).toBe(4);
      expect(result.data.transcript.reasoningTokens).toBe(2);
      expect(result.data.transcript.messages[1]).toMatchObject({
        role: "thinking",
        text: "Plan: Inspect the repository.",
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 4,
          reasoningTokens: 2,
        },
      });
    } finally {
      cleanup();
    }
  });

  it("keeps raw events for lossless inspection with labeled types", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const raw = result.data.transcript.rawEvents ?? [];
    expect(raw.length).toBe(6);
    expect(raw[0]?.eventType).toBe("session_meta");
    expect(raw[0]?.rawJson).toContain("gem-fix-001");
    expect(raw[1]?.eventType).toBe("user");
    expect(raw[2]?.eventType).toBe("gemini");
    expect(raw[5]?.eventType).toBe("info");
  });
});

// ---------------------------------------------------------------------------
// $set / $rewindTo edit-history records
// ---------------------------------------------------------------------------

describe("gemini parser — metadata updates and rewind", () => {
  it("applies $set.directories to the session project path", async () => {
    const { file, cleanup } = makeTempSession([
      {
        sessionId: "gem-set-001",
        startTime: "2026-07-14T10:00:00.000Z",
        directories: ["/old/path"],
      },
      { id: "u1", type: "user", content: [{ text: "hi" }] },
      {
        $set: {
          directories: ["/new/path"],
          lastUpdated: "2026-07-14T10:10:00.000Z",
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.projectPath).toBe("/new/path");
      expect(result.data.endedAt).toBe(
        Math.floor(Date.parse("2026-07-14T10:10:00Z") / 1000),
      );
    } finally {
      cleanup();
    }
  });

  it("clears the session project path when $set.directories is empty", async () => {
    const { file, cleanup } = makeTempSession([
      {
        sessionId: "gem-set-002",
        startTime: "2026-07-14T10:00:00.000Z",
        directories: ["/old/path"],
      },
      { id: "u1", type: "user", content: "hi" },
      { $set: { directories: [] } },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.projectPath).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("coalesces same-id revisions before materializing messages and usage", async () => {
    const revisedAssistant = {
      id: "a1",
      timestamp: "2026-07-14T10:00:02.000Z",
      type: "gemini",
      model: "gemini-2.5-flash",
      content: [{ text: "final answer" }],
      thoughts: [{ subject: "Plan", description: "Inspect once." }],
      tokens: { input: 12, output: 3, cached: 4, thoughts: 2, total: 21 },
    };
    const { file, cleanup } = makeTempSession([
      { sessionId: "gem-upsert-001", startTime: "2026-07-14T10:00:00.000Z" },
      { id: "u1", type: "user", content: "investigate" },
      { ...revisedAssistant, tokens: undefined },
      revisedAssistant,
      {
        ...revisedAssistant,
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            args: { path: "README.md" },
            status: "success",
            resultDisplay: "contents",
          },
        ],
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(
        result.data.transcript.messages.map((message) => message.role),
      ).toEqual(["user", "thinking", "assistant"]);
      expect(
        result.data.transcript.messages.filter(
          (message) => message.text === "final answer",
        ),
      ).toHaveLength(1);
      expect(result.data.transcript.messages[2]?.toolCalls).toHaveLength(1);
      expect(result.data.transcript.inputTokens).toBe(12);
      expect(result.data.transcript.outputTokens).toBe(3);
      expect(result.data.transcript.cacheReadTokens).toBe(4);
      expect(result.data.transcript.reasoningTokens).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("replaces prior message state with a $set.messages checkpoint", async () => {
    const { file, cleanup } = makeTempSession([
      {
        sessionId: "gem-checkpoint-001",
        startTime: "2026-07-14T10:00:00.000Z",
      },
      { id: "u1", type: "user", content: "old prompt" },
      { id: "a1", type: "gemini", content: "old answer" },
      {
        $set: {
          messages: [
            { id: "u2", type: "user", content: "checkpoint prompt" },
            {
              id: "a2",
              type: "gemini",
              content: "checkpoint answer",
              tokens: { input: 7, output: 2, total: 9 },
            },
          ],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(
        result.data.transcript.messages.map((message) => message.text),
      ).toEqual(["checkpoint prompt", "checkpoint answer"]);
      expect(result.data.transcript.inputTokens).toBe(7);
      expect(result.data.transcript.outputTokens).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("$rewindTo removes the target message and everything after it", async () => {
    const { file, cleanup } = makeTempSession([
      { sessionId: "gem-rw-001", startTime: "2026-07-14T10:00:00.000Z" },
      { id: "u1", type: "user", content: [{ text: "first" }] },
      { id: "a1", type: "gemini", content: [{ text: "reply one" }] },
      { id: "u2", type: "user", content: [{ text: "second (undone)" }] },
      { id: "a2", type: "gemini", content: [{ text: "reply two (undone)" }] },
      { $rewindTo: "u2" },
      { id: "u3", type: "user", content: [{ text: "second retried" }] },
      { id: "a3", type: "gemini", content: [{ text: "reply retried" }] },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const texts = result.data.transcript.messages.map((m) => m.text);
      expect(texts).toEqual([
        "first",
        "reply one",
        "second retried",
        "reply retried",
      ]);
      // Turns renumber contiguously after the splice.
      expect(result.data.transcript.messages.map((m) => m.turn)).toEqual([
        1, 2, 3, 4,
      ]);
    } finally {
      cleanup();
    }
  });

  it("warns and clears prior state when a $rewindTo target is not present", async () => {
    const { file, cleanup } = makeTempSession([
      { sessionId: "gem-rw-002", startTime: "2026-07-14T10:00:00.000Z" },
      { id: "u1", type: "user", content: [{ text: "only" }] },
      { $rewindTo: "does-not-exist" },
      { id: "u2", type: "user", content: [{ text: "after rewind" }] },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.transcript.messages.map((m) => m.text)).toEqual([
        "after rewind",
      ]);
      expect(result.issues.some((i) => i.message.includes("$rewindTo"))).toBe(
        true,
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Legacy embedded messages
// ---------------------------------------------------------------------------

describe("gemini parser — legacy single-file (embedded messages)", () => {
  it("reads messages embedded on the metadata header record", async () => {
    const { file, cleanup } = makeTempSession([
      {
        sessionId: "gem-legacy-001",
        startTime: "2026-07-14T10:00:00.000Z",
        directories: ["/repo"],
        messages: [
          { id: "u1", type: "user", content: [{ text: "embedded prompt" }] },
          {
            id: "a1",
            type: "gemini",
            model: "gemini-2.5-flash",
            content: [{ text: "embedded reply" }],
            tokens: { input: 5, output: 3, cached: 0, total: 8 },
          },
        ],
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.transcript.messages.map((m) => m.text)).toEqual([
        "embedded prompt",
        "embedded reply",
      ]);
      expect(result.data.model).toBe("gemini-2.5-flash");
      expect(result.data.transcript.inputTokens).toBe(5);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Content shapes
// ---------------------------------------------------------------------------

describe("gemini parser — content flattening", () => {
  it("accepts string content and skips thought parts in message text", async () => {
    const { file, cleanup } = makeTempSession([
      { sessionId: "gem-c-001", startTime: "2026-07-14T10:00:00.000Z" },
      { id: "u1", type: "user", content: "plain string prompt" },
      {
        id: "a1",
        type: "gemini",
        content: [
          { text: "visible answer" },
          { text: "hidden chain", thought: true },
        ],
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const msgs = result.data.transcript.messages;
      expect(msgs[0]?.text).toBe("plain string prompt");
      expect(msgs[1]?.text).toBe("visible answer");
      expect(msgs[1]?.text).not.toContain("hidden chain");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fail cases
// ---------------------------------------------------------------------------

describe("gemini parser — fail cases", () => {
  it("returns fail when the file does not exist", async () => {
    const result = await parseSessionFile("/tmp/__no_such_gemini_file__.jsonl");
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[0]?.message).toContain("failed to read");
  });

  it("returns fail when no sessionId is present", async () => {
    const { file, cleanup } = makeTempSession([
      { id: "u1", type: "user", content: [{ text: "orphan" }] },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.issues[0]?.message).toContain("no sessionId");
    } finally {
      cleanup();
    }
  });

  it("returns fail when the session has zero messages", async () => {
    const { file, cleanup } = makeTempSession([
      { sessionId: "gem-empty-001", startTime: "2026-07-14T10:00:00.000Z" },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.issues[0]?.message).toContain("zero messages");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Schema conformance + decodeLine
// ---------------------------------------------------------------------------

describe("gemini parser — clean fixture passes SessionSchema", () => {
  it("result.data validates and the bundled fixture yields no warnings", async () => {
    const result = await parseSessionFile(FIXTURE);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.issues).toEqual([]);
    expect(SessionSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.transcript.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("gemini parser — decodeLine exported separately", () => {
  it("decodes a metadata header line", () => {
    const collector = new IssueCollector();
    const line = JSON.stringify({
      sessionId: "gem-dl-001",
      startTime: "2026-07-14T10:00:00.000Z",
      directories: ["/x"],
    });
    const event = decodeLine(line, 0, collector);
    expect(event.kind).toBe("session_meta");
    if (event.kind !== "session_meta") return;
    expect(event.sessionId).toBe("gem-dl-001");
    expect(collector.list()).toEqual([]);
  });

  it("warns on invalid JSON and returns skip", () => {
    const collector = new IssueCollector();
    const event = decodeLine("}not json", 3, collector);
    expect(event.kind).toBe("skip");
    const issues = collector.list();
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.seq).toBe(3);
  });
});
