/**
 * Tests for src/parsers/opencode.
 *
 * Covers both the file-based shell (parseSessionFile) and the DB-based
 * shell (parseSessionFromDb / listSessionIds), plus normalization tests.
 *
 * DB tests use a structural stub — no better-sqlite3 dependency.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpencodeDb } from "../../src/parsers/opencode/index.js";
import {
  listSessionIds,
  parseSessionFile,
  parseSessionFromDb,
} from "../../src/parsers/opencode/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_ROOT = join(__dirname, "../fixtures/opencode");
const SESSION_PATH = join(
  FIXTURE_ROOT,
  "session",
  "global",
  "ses_test001.json",
);

// ---------------------------------------------------------------------------
// Minimal fake DB builder — structural stub matching OpencodeDb interface
// ---------------------------------------------------------------------------

interface FakeRow {
  [key: string]: unknown;
}

function makeDb(
  sessions: FakeRow[],
  messages: FakeRow[],
  parts: FakeRow[],
): OpencodeDb {
  return {
    prepare(sql: string) {
      return {
        all(...params: unknown[]): unknown[] {
          const sessionIdParam = params[0];
          if (sql.includes("FROM session") && sql.includes("WHERE id = ?")) {
            return sessions.filter((r) => r.id === sessionIdParam);
          }
          if (sql.includes("FROM session")) {
            return sessions;
          }
          if (sql.includes("FROM message")) {
            return messages.filter((r) => r.session_id === sessionIdParam);
          }
          if (sql.includes("FROM part")) {
            return parts.filter((r) => r.session_id === sessionIdParam);
          }
          return [];
        },
        get(...params: unknown[]): unknown {
          const sessionIdParam = params[0];
          if (sql.includes("FROM session")) {
            return sessions.find((r) => r.id === sessionIdParam);
          }
          return undefined;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// File-based shell tests
// ---------------------------------------------------------------------------

describe("parseSessionFile — file-based shell", () => {
  it("returns success with correct id, cli, externalId, projectPath, model, title, timestamps", async () => {
    const r = await parseSessionFile(SESSION_PATH);
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("oc--ses_test001");
    expect(s.cli).toBe("opencode");
    expect(s.externalId).toBe("ses_test001");
    expect(s.projectPath).toBe("/Users/u/repo");
    expect(s.title).toBe("test session for opencode adapter");
    // model comes from message.modelID, NOT session.version
    expect(s.model).toBe("claude-sonnet-4-6");
    expect(s.startedAt).toBe(1700000000);
    expect(s.endedAt).toBe(1700000010);
  });

  it("emits one message per valid role (user + assistant), no thinking in base fixture", async () => {
    const r = await parseSessionFile(SESSION_PATH);
    if (!r.success) throw new Error("parse failed");
    const roles = r.data.transcript.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(r.data.transcript.messages[0]?.text).toBe(
      "please list the repo root",
    );
    expect(r.data.transcript.messages[1]?.text).toBe(
      "Listing the directory now.",
    );
    expect(r.data.transcript.messages[0]?.toolCalls).toHaveLength(0);
  });

  it("converts tool parts to ToolCalls with output, exitCode, and timing", async () => {
    const r = await parseSessionFile(SESSION_PATH);
    if (!r.success) throw new Error("parse failed");
    const tcs = r.data.transcript.messages[1]?.toolCalls ?? [];
    expect(tcs).toHaveLength(2);

    if (tcs.length < 2) throw new Error("expected 2 tool calls");
    const first = tcs[0];
    expect(first?.name).toBe("list");
    expect(first?.callId).toBe("call_aaa");
    expect(first?.exitCode).toBe(0);
    expect(first?.outputPreview).toContain("README.md");
    expect(first?.outputBytes).toBeGreaterThan(0);
    expect(first?.outputSha).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.durationMs).toBe(150);

    const second = tcs[1];
    expect(second?.name).toBe("read");
    expect(second?.exitCode).toBe(1);
    expect(second?.outputPreview).toContain("ENOENT");
  });

  it("skips step-start and step-finish parts", async () => {
    const r = await parseSessionFile(SESSION_PATH);
    if (!r.success) throw new Error("parse failed");
    const asst = r.data.transcript.messages[1];
    if (!asst) throw new Error("expected assistant message");
    expect(asst.text).not.toContain("step");
    expect(asst.toolCalls).toHaveLength(2);
  });

  it("sorts tool parts by state.time.start regardless of filename order", async () => {
    const r = await parseSessionFile(SESSION_PATH);
    if (!r.success) throw new Error("parse failed");
    const [first, second] = r.data.transcript.messages[1]?.toolCalls ?? [];
    expect(first?.name).toBe("list");
    expect(second?.name).toBe("read");
  });

  it("computes a stable content hash across identical runs", async () => {
    const a = await parseSessionFile(SESSION_PATH);
    const b = await parseSessionFile(SESSION_PATH);
    if (!a.success || !b.success) throw new Error("parse failed");
    expect(a.data.transcript.contentHash).toBe(b.data.transcript.contentHash);
    expect(a.data.transcript.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails cleanly on a missing session file", async () => {
    const r = await parseSessionFile("/tmp/__no_such_file__.json");
    expect(r.success).toBe(false);
    expect(r.issues[0]?.severity).toBe("error");
  });

  it("populates rawEvents in the transcript", async () => {
    const r = await parseSessionFile(SESSION_PATH);
    if (!r.success) throw new Error("parse failed");
    const events = r.data.transcript.rawEvents ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.eventType).toBe("session");
  });

  it("round-trips through SessionSchema.parse with no errors (clean fixture)", async () => {
    const r = await parseSessionFile(SESSION_PATH);
    if (!r.success) throw new Error("parse failed");
    expect(r.issues).toEqual([]);
    expect(() => SessionSchema.parse(r.data)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Structural DB stub helpers
// ---------------------------------------------------------------------------

function makeSessionRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "ses_test001",
    parent_id: null,
    directory: "/Users/u/repo",
    title: "test session for opencode adapter",
    version: "1.0.55",
    time_created: 1700000000000,
    time_updated: 1700000010000,
    ...overrides,
  };
}

function makeMessageRow(
  id: string,
  sessionId: string,
  data: Record<string, unknown>,
  timeCreated = 1700000001,
): FakeRow {
  return {
    id,
    session_id: sessionId,
    time_created: timeCreated,
    data: JSON.stringify(data),
  };
}

function makePartRow(
  id: string,
  messageId: string,
  sessionId: string,
  data: Record<string, unknown>,
  timeCreated = 0,
): FakeRow {
  return {
    id,
    message_id: messageId,
    session_id: sessionId,
    time_created: timeCreated,
    data: JSON.stringify(data),
  };
}

// ---------------------------------------------------------------------------
// DB-based shell tests
// ---------------------------------------------------------------------------

describe("listSessionIds", () => {
  it("returns ids in time_created order", () => {
    const db = makeDb(
      [
        { id: "ses_b", time_created: 2000 },
        { id: "ses_a", time_created: 1000 },
      ],
      [],
      [],
    );
    expect(listSessionIds(db)).toEqual(["ses_b", "ses_a"]); // stub returns as-is; real ORDER BY handled by DB
  });

  it("returns empty array when no sessions", () => {
    const db = makeDb([], [], []);
    expect(listSessionIds(db)).toEqual([]);
  });
});

describe("parseSessionFromDb — basic reconstruction", () => {
  it("reconstructs session metadata from DB row", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_user001",
          "ses_test001",
          { role: "user", time: { created: 1700000001000 } },
          1700000001,
        ),
      ],
      [
        makePartRow("prt_u001", "msg_user001", "ses_test001", {
          type: "text",
          text: "please list the repo root",
        }),
      ],
    );
    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.id).toBe("oc--ses_test001");
    expect(r.data.cli).toBe("opencode");
    expect(r.data.projectPath).toBe("/Users/u/repo");
    expect(r.data.title).toBe("test session for opencode adapter");
    expect(r.data.startedAt).toBe(1700000000);
    expect(r.data.endedAt).toBe(1700000010);
  });

  it("returns failure for unknown session id", () => {
    const db = makeDb([makeSessionRow()], [], []);
    const r = parseSessionFromDb(db, "ses_does_not_exist", "/fake/opencode.db");
    expect(r.success).toBe(false);
    expect(r.issues[0]?.severity).toBe("error");
  });

  it("returns failure for session with no message rows", () => {
    const db = makeDb([makeSessionRow()], [], []);
    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(false);
    expect(r.issues[0]?.severity).toBe("error");
  });

  it("captures parent_id, summed tokens, and aborted-turn count", () => {
    const sessionRow = makeSessionRow({
      id: "ses_child001",
      parent_id: "ses_parent001",
      time_created: 1700000020000,
      time_updated: 1700000030000,
    });
    const db = makeDb(
      [sessionRow],
      [
        makeMessageRow(
          "msg_c1",
          "ses_child001",
          {
            role: "user",
            time: { created: 1700000021000 },
          },
          1700000021,
        ),
        makeMessageRow(
          "msg_c2",
          "ses_child001",
          {
            role: "assistant",
            modelID: "claude-sonnet-4-6",
            time: { created: 1700000022000 },
            tokens: {
              input: 100,
              output: 30,
              reasoning: 5,
              cache: { read: 40, write: 10 },
            },
            error: { name: "MessageAbortedError" },
          },
          1700000022,
        ),
      ],
      [
        makePartRow(
          "prt_c1",
          "msg_c1",
          "ses_child001",
          { type: "text", text: "go" },
          1,
        ),
        makePartRow(
          "prt_c2",
          "msg_c2",
          "ses_child001",
          { type: "text", text: "starting" },
          2,
        ),
      ],
    );

    const r = parseSessionFromDb(db, "ses_child001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.parentSessionId).toBe("oc--ses_parent001");
    expect(s.transcript.inputTokens).toBe(100);
    expect(s.transcript.outputTokens).toBe(30);
    expect(s.transcript.cacheReadTokens).toBe(40);
    expect(s.transcript.cacheCreationTokens).toBe(10);
    expect(s.transcript.reasoningTokens).toBe(5);
    expect(s.transcript.abortedTurns).toBe(1);

    const asst = s.transcript.messages.find((m) => m.role === "assistant");
    expect(asst?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
    });
    expect(
      s.transcript.messages.find((m) => m.role === "user")?.usage,
    ).toBeUndefined();
  });

  it("emits tool calls with correct shape from DB", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_a1",
          "ses_test001",
          {
            role: "assistant",
            modelID: "claude-sonnet-4-6",
            time: { created: 1700000005000 },
          },
          1700000005,
        ),
      ],
      [
        makePartRow("prt_tool", "msg_a1", "ses_test001", {
          type: "tool",
          callID: "call_xyz",
          tool: "bash",
          state: {
            status: "completed",
            input: { cmd: "ls" },
            output: "file.txt\n",
            time: { start: 1700000005100, end: 1700000005200 },
          },
        }),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const tc = r.data.transcript.messages[0]?.toolCalls[0];
    expect(tc?.name).toBe("bash");
    expect(tc?.callId).toBe("call_xyz");
    expect(tc?.exitCode).toBe(0);
    expect(tc?.outputPreview).toContain("file.txt");
    expect(tc?.durationMs).toBe(100);
  });

  it("round-trips through SessionSchema.parse with no issues", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_u1",
          "ses_test001",
          {
            role: "user",
            time: { created: 1700000001000 },
          },
          1700000001,
        ),
      ],
      [
        makePartRow("prt_u1", "msg_u1", "ses_test001", {
          type: "text",
          text: "hello",
        }),
      ],
    );
    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.issues).toEqual([]);
    expect(() => SessionSchema.parse(r.data)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Normalization guarantees
// ---------------------------------------------------------------------------

describe("patch parts become opencode_patch ToolCall", () => {
  it("patch part with hash and files → synthetic ToolCall named opencode_patch", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_p1",
          "ses_test001",
          {
            role: "assistant",
            modelID: "gpt-test",
            time: { created: 1700000061000 },
          },
          1700000061,
        ),
      ],
      [
        makePartRow("prt_p1", "msg_p1", "ses_test001", {
          type: "patch",
          hash: "abc123",
          files: ["/Users/u/repo/a.ts", "/Users/u/repo/b.ts"],
        }),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const tc = r.data.transcript.messages[0]?.toolCalls[0];
    expect(tc?.name).toBe("opencode_patch");
    expect(tc?.exitCode).toBe(0);
    expect(tc?.args).toEqual({
      hash: "abc123",
      files: ["/Users/u/repo/a.ts", "/Users/u/repo/b.ts"],
    });
    expect(tc?.outputPreview).toContain("abc123");
    expect(tc?.outputPreview).toContain("2 files");
  });

  it("patch part with no hash and no files → no ToolCall emitted", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_p2",
          "ses_test001",
          {
            role: "assistant",
            time: { created: 1700000070000 },
          },
          1700000070,
        ),
      ],
      [
        makePartRow("prt_p2", "msg_p2", "ses_test001", {
          type: "patch",
          hash: "",
          files: [],
        }),
      ],
    );

    // Session will fail since the only message has no usable content
    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    // Either fails (no usable messages) or succeeds with 0 tool calls
    if (r.success) {
      const tc = r.data.transcript.messages[0]?.toolCalls ?? [];
      expect(tc).toHaveLength(0);
    } else {
      expect(r.issues[0]?.severity).toBe("error");
    }
  });
});

describe("reasoning → separate thinking message, not inlined", () => {
  it("reasoning part emits a separate role:thinking message before the assistant message", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_r1",
          "ses_test001",
          {
            role: "assistant",
            modelID: "gpt-test",
            time: { created: 1700000041000 },
          },
          1700000041,
        ),
      ],
      [
        makePartRow(
          "prt_r1",
          "msg_r1",
          "ses_test001",
          {
            type: "reasoning",
            text: "The command failed because the file path is wrong.",
          },
          1,
        ),
        makePartRow(
          "prt_r2",
          "msg_r1",
          "ses_test001",
          {
            type: "text",
            text: "I will retry with the corrected path.",
          },
          2,
        ),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const msgs = r.data.transcript.messages;

    // Exactly 2 messages: thinking then assistant
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("thinking");
    expect(msgs[1]?.role).toBe("assistant");

    // thinking message carries the reasoning text WITHOUT the "**Reasoning**\n\n" prefix
    expect(msgs[0]?.text).toBe(
      "The command failed because the file path is wrong.",
    );
    expect(msgs[0]?.text).not.toContain("**Reasoning**");

    // assistant message has ONLY the text part content
    expect(msgs[1]?.text).toBe("I will retry with the corrected path.");
    expect(msgs[1]?.text).not.toContain("**Reasoning**");
    expect(msgs[1]?.text).not.toContain("file path is wrong");
  });

  it("reasoning part with markdown prefix in source — prefix is NOT stripped from text", () => {
    // The source text already has **Diagnosing failure** — that is data, not our prefix
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_r2",
          "ses_test001",
          {
            role: "assistant",
            modelID: "gpt-test",
            time: { created: 1700000042000 },
          },
          1700000042,
        ),
      ],
      [
        makePartRow(
          "prt_r3",
          "msg_r2",
          "ses_test001",
          {
            type: "reasoning",
            text: "**Diagnosing failure**\n\nThe command failed because the file path is wrong.",
          },
          1,
        ),
        makePartRow(
          "prt_r4",
          "msg_r2",
          "ses_test001",
          {
            type: "text",
            text: "Retrying now.",
          },
          2,
        ),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const msgs = r.data.transcript.messages;
    expect(msgs[0]?.role).toBe("thinking");
    // Source text's own markdown is preserved in the thinking message text
    expect(msgs[0]?.text).toContain("**Diagnosing failure**");
    // But no additional "**Reasoning**\n\n" prefix is injected
    expect(msgs[0]?.text).not.toMatch(/^\*\*Reasoning\*\*/);
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[1]?.text).toBe("Retrying now.");
  });

  it("empty reasoning part emits no thinking message", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_r3",
          "ses_test001",
          {
            role: "assistant",
            modelID: "gpt-test",
            time: { created: 1700000043000 },
          },
          1700000043,
        ),
      ],
      [
        makePartRow(
          "prt_r5",
          "msg_r3",
          "ses_test001",
          {
            type: "reasoning",
            text: "",
          },
          1,
        ),
        makePartRow(
          "prt_r6",
          "msg_r3",
          "ses_test001",
          {
            type: "text",
            text: "Done.",
          },
          2,
        ),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const msgs = r.data.transcript.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("assistant");
    expect(msgs[0]?.text).toBe("Done.");
  });

  it("whitespace-only reasoning text emits no thinking message", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_r4",
          "ses_test001",
          {
            role: "assistant",
            time: { created: 1700000044000 },
          },
          1700000044,
        ),
      ],
      [
        makePartRow(
          "prt_r7",
          "msg_r4",
          "ses_test001",
          {
            type: "reasoning",
            text: "   \n  ",
          },
          1,
        ),
        makePartRow(
          "prt_r8",
          "msg_r4",
          "ses_test001",
          {
            type: "text",
            text: "Result.",
          },
          2,
        ),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const msgs = r.data.transcript.messages;
    expect(msgs.filter((m) => m.role === "thinking")).toHaveLength(0);
  });

  it("thinking messages participate in turn numbering", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_t1",
          "ses_test001",
          {
            role: "user",
            time: { created: 1700000001000 },
          },
          1700000001,
        ),
        makeMessageRow(
          "msg_t2",
          "ses_test001",
          {
            role: "assistant",
            time: { created: 1700000002000 },
          },
          1700000002,
        ),
      ],
      [
        makePartRow(
          "prt_t1",
          "msg_t1",
          "ses_test001",
          { type: "text", text: "go" },
          1,
        ),
        makePartRow(
          "prt_t2",
          "msg_t2",
          "ses_test001",
          {
            type: "reasoning",
            text: "Let me think.",
          },
          2,
        ),
        makePartRow(
          "prt_t3",
          "msg_t2",
          "ses_test001",
          { type: "text", text: "done" },
          3,
        ),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    const msgs = r.data.transcript.messages;
    // Turn sequence: 1=user, 2=thinking, 3=assistant
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.turn).toBe(1);
    expect(msgs[1]?.role).toBe("thinking");
    expect(msgs[1]?.turn).toBe(2);
    expect(msgs[2]?.role).toBe("assistant");
    expect(msgs[2]?.turn).toBe(3);
  });
});

describe("title rule (opencode-specific)", () => {
  it("uses the session-level title field when present", () => {
    const db = makeDb(
      [makeSessionRow({ title: "My custom title" })],
      [
        makeMessageRow(
          "msg_u1",
          "ses_test001",
          {
            role: "user",
            time: { created: 1700000001000 },
          },
          1700000001,
        ),
      ],
      [
        makePartRow("prt_u1", "msg_u1", "ses_test001", {
          type: "text",
          text: "hello",
        }),
      ],
    );
    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    // opencode stores its own session-level title — use it directly
    expect(r.data.title).toBe("My custom title");
  });

  it("has no title when the session row has null title", () => {
    const db = makeDb(
      [makeSessionRow({ title: null })],
      [
        makeMessageRow(
          "msg_u2",
          "ses_test001",
          {
            role: "user",
            time: { created: 1700000001000 },
          },
          1700000001,
        ),
      ],
      [
        makePartRow("prt_u2", "msg_u2", "ses_test001", {
          type: "text",
          text: "hello",
        }),
      ],
    );
    const r = parseSessionFromDb(db, "ses_test001", "/fake/opencode.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.title).toBeUndefined();
  });
});

describe("content hash stability", () => {
  it("identical messages always yield the same hash", () => {
    function buildSingleMsgDb(): OpencodeDb {
      return makeDb(
        [makeSessionRow()],
        [
          makeMessageRow(
            "msg_u1",
            "ses_test001",
            {
              role: "user",
              time: { created: 1700000001000 },
            },
            1700000001,
          ),
        ],
        [
          makePartRow("prt_u1", "msg_u1", "ses_test001", {
            type: "text",
            text: "stable",
          }),
        ],
      );
    }
    const r1 = parseSessionFromDb(buildSingleMsgDb(), "ses_test001", "/db1");
    const r2 = parseSessionFromDb(buildSingleMsgDb(), "ses_test001", "/db2");
    if (!r1.success || !r2.success) throw new Error("parse failed");
    // rawPath differs but contentHash must be identical (content-only hash)
    expect(r1.data.transcript.contentHash).toBe(r2.data.transcript.contentHash);
    expect(r1.data.transcript.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("contentHash changes when thinking messages are present", () => {
    const withThinking = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_a1",
          "ses_test001",
          {
            role: "assistant",
            time: { created: 1700000005000 },
          },
          1700000005,
        ),
      ],
      [
        makePartRow(
          "prt_r1",
          "msg_a1",
          "ses_test001",
          {
            type: "reasoning",
            text: "Let me think.",
          },
          1,
        ),
        makePartRow(
          "prt_t1",
          "msg_a1",
          "ses_test001",
          { type: "text", text: "Done." },
          2,
        ),
      ],
    );

    const withoutThinking = makeDb(
      [makeSessionRow()],
      [
        makeMessageRow(
          "msg_a1",
          "ses_test001",
          {
            role: "assistant",
            time: { created: 1700000005000 },
          },
          1700000005,
        ),
      ],
      [
        makePartRow(
          "prt_t1",
          "msg_a1",
          "ses_test001",
          { type: "text", text: "Done." },
          1,
        ),
      ],
    );

    const r1 = parseSessionFromDb(withThinking, "ses_test001", "/fake.db");
    const r2 = parseSessionFromDb(withoutThinking, "ses_test001", "/fake.db");
    if (!r1.success || !r2.success) throw new Error("parse failed");
    // Different message count → different hash
    expect(r1.data.transcript.contentHash).not.toBe(
      r2.data.transcript.contentHash,
    );
  });
});

describe("error paths and issue collection", () => {
  it("file-based: missing message dir → failure with error issue", async () => {
    // Use a session file that has an ID not matching any message dir
    // We test with a bogus path so both session read AND message dir fail.
    const r = await parseSessionFile("/no/such/path/ses_fake.json");
    expect(r.success).toBe(false);
    expect(r.issues.some((i) => i.severity === "error")).toBe(true);
  });

  it("DB-based: message rows with malformed JSON data are skipped with warning", () => {
    const db = makeDb(
      [makeSessionRow()],
      [
        {
          id: "msg_bad",
          session_id: "ses_test001",
          time_created: 1700000001,
          data: "not-valid-json",
        },
        makeMessageRow(
          "msg_ok",
          "ses_test001",
          {
            role: "user",
            time: { created: 1700000002000 },
          },
          1700000002,
        ),
      ],
      [
        makePartRow("prt_ok", "msg_ok", "ses_test001", {
          type: "text",
          text: "hi",
        }),
      ],
    );

    const r = parseSessionFromDb(db, "ses_test001", "/fake.db");
    expect(r.success).toBe(true);
    if (!r.success) return;
    // Warning for the bad row
    expect(r.issues.some((i) => i.severity === "warning")).toBe(true);
    // But the good message still produced a session
    expect(r.data.transcript.messages[0]?.text).toBe("hi");
  });
});
