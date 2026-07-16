/**
 * Tests for src/parsers/opencode/incremental.ts
 *
 * Uses a structural in-memory OpencodeDb stub — no better-sqlite3 dependency.
 * The fake DB stores messages and parts in arrays and dispatches queries by
 * matching SQL substrings, reusing the same pattern as opencode.test.ts.
 */

import { describe, expect, it } from "vitest";
import type { OpencodeDb } from "../../src/parsers/opencode/index.js";
import {
  readEventsSince,
  snapshotCursor,
} from "../../src/parsers/opencode/index.js";

// ---------------------------------------------------------------------------
// Fake DB builder (structural stub — mirrors opencode.test.ts pattern)
// ---------------------------------------------------------------------------

interface FakeRow {
  [key: string]: unknown;
}

/**
 * Build a minimal OpencodeDb stub over in-memory arrays. Supports:
 *   - watermark query: "SELECT COALESCE(MAX(time_created), 0) AS t FROM message"
 *   - message delta query: "FROM message WHERE session_id = ? AND time_created > ?"
 *   - part query: "FROM part WHERE session_id = ? AND message_id IN (...)"
 *
 * The `messages` and `parts` arrays are referenced by value — mutating them
 * after building the DB stub is reflected in subsequent queries, which is how
 * the "finish lands by row UPDATE" test works.
 */
function makeDb(messages: FakeRow[], parts: FakeRow[]): OpencodeDb {
  return {
    prepare(sql: string) {
      return {
        all(...params: unknown[]): unknown[] {
          if (
            sql.includes("COALESCE(MAX(time_created)") &&
            sql.includes("FROM message")
          ) {
            const sessionId = params[0];
            const sessionMsgs = messages.filter(
              (m) => m.session_id === sessionId,
            );
            const maxTs = sessionMsgs.reduce<number>(
              (acc, m) =>
                Math.max(
                  acc,
                  typeof m.time_created === "number" ? m.time_created : 0,
                ),
              0,
            );
            return [{ t: maxTs }];
          }
          if (
            sql.includes("FROM message") &&
            sql.includes("time_created > ?")
          ) {
            const sessionId = params[0];
            const sinceMs = typeof params[1] === "number" ? params[1] : 0;
            return messages.filter(
              (m) =>
                m.session_id === sessionId &&
                typeof m.time_created === "number" &&
                m.time_created > sinceMs,
            );
          }
          if (sql.includes("FROM part") && sql.includes("message_id IN")) {
            const sessionId = params[0];
            const messageIds = params.slice(1);
            return parts.filter(
              (p) =>
                p.session_id === sessionId && messageIds.includes(p.message_id),
            );
          }
          return [];
        },
        get(...params: unknown[]): unknown {
          void params;
          return undefined;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Row factory helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "ses_abc123";

interface MsgData {
  role: "user" | "assistant";
  finish?: string;
  error?: { name: string };
}

function msgRow(id: string, data: MsgData, timeCreated: number): FakeRow {
  return {
    id,
    session_id: SESSION_ID,
    time_created: timeCreated,
    data: JSON.stringify(data),
  };
}

function textPartRow(
  id: string,
  messageId: string,
  text: string,
  timeCreated = 0,
): FakeRow {
  return {
    id,
    message_id: messageId,
    session_id: SESSION_ID,
    time_created: timeCreated,
    data: JSON.stringify({ type: "text", text }),
  };
}

function reasoningPartRow(
  id: string,
  messageId: string,
  text: string,
  timeCreated = 0,
): FakeRow {
  return {
    id,
    message_id: messageId,
    session_id: SESSION_ID,
    time_created: timeCreated,
    data: JSON.stringify({ type: "reasoning", text }),
  };
}

function toolPartRow(
  id: string,
  messageId: string,
  tool: string,
  callId: string,
  timeCreated = 0,
): FakeRow {
  return {
    id,
    message_id: messageId,
    session_id: SESSION_ID,
    time_created: timeCreated,
    data: JSON.stringify({ type: "tool", tool, callID: callId }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("snapshotCursor", () => {
  it("returns sinceMs = MAX(time_created) for the session", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 1000),
      msgRow("m2", { role: "assistant", finish: "stop" }, 2000),
    ];
    const db = makeDb(messages, []);
    const cursor = snapshotCursor(db, SESSION_ID);
    expect(cursor).toEqual({
      kind: "db",
      sessionId: SESSION_ID,
      sinceMs: 2000,
    });
  });

  it("returns sinceMs = 0 for an empty session", () => {
    const db = makeDb([], []);
    const cursor = snapshotCursor(db, SESSION_ID);
    expect(cursor).toEqual({ kind: "db", sessionId: SESSION_ID, sinceMs: 0 });
  });

  it("returns sinceMs = 0 when the DB throws", () => {
    const throwingDb: OpencodeDb = {
      prepare(_sql: string) {
        return {
          all(): unknown[] {
            throw new Error("DB locked");
          },
          get(): unknown {
            return undefined;
          },
        };
      },
    };
    const cursor = snapshotCursor(throwingDb, SESSION_ID);
    expect(cursor).toEqual({ kind: "db", sessionId: SESSION_ID, sinceMs: 0 });
  });
});

describe("readEventsSince — full turn", () => {
  it("user → assistant text → finish:stop produces ordered events incl. turn-end", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 1000),
      msgRow("m2", { role: "assistant", finish: "stop" }, 2000),
    ];
    const parts: FakeRow[] = [
      textPartRow("p1", "m1", "hello world", 1001),
      textPartRow("p2", "m2", "hi there", 2001),
    ];
    const db = makeDb(messages, parts);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events, nextCursor } = result.data;
    expect(events).toEqual([
      { kind: "user", ts: 1, text: "hello world" },
      { kind: "assistant", ts: 2, text: "hi there" },
      { kind: "turn-end", ts: 2, outcome: "completed", signal: "stop" },
    ]);
    expect(nextCursor).toEqual({
      kind: "db",
      sessionId: SESSION_ID,
      sinceMs: 2000,
    });
  });

  it("nextCursor sinceMs = max time_created of returned rows", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 5000),
      msgRow("m2", { role: "assistant", finish: "stop" }, 9000),
    ];
    const db = makeDb(messages, []);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.nextCursor.sinceMs).toBe(9000);
  });
});

describe("readEventsSince — watermark slicing", () => {
  it("cursor after turn 1 yields only turn 2 events", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 1000),
      msgRow("m2", { role: "assistant", finish: "stop" }, 1100),
      msgRow("m3", { role: "user" }, 2000),
      msgRow("m4", { role: "assistant", finish: "stop" }, 2100),
    ];
    const parts: FakeRow[] = [
      textPartRow("p1", "m1", "first question"),
      textPartRow("p2", "m2", "first answer"),
      textPartRow("p3", "m3", "second question"),
      textPartRow("p4", "m4", "second answer"),
    ];
    const db = makeDb(messages, parts);

    // Manually set watermark to after turn 1 (sinceMs = 1100)
    const turn1Cursor = {
      kind: "db" as const,
      sessionId: SESSION_ID,
      sinceMs: 1100,
    };

    const result = readEventsSince(db, SESSION_ID, turn1Cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { events } = result.data;

    // Should only have turn 2 events
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    expect(kinds).toContain("turn-end");

    const userEvent = events.find((e) => e.kind === "user");
    expect(userEvent?.kind === "user" && userEvent.text).toBe(
      "second question",
    );
  });
});

describe("readEventsSince — finish lands by row UPDATE", () => {
  it("first read with assistant row finish absent/tool-calls: no turn-end; mutate to stop: turn-end appears", () => {
    // Simulate opencode updating a row in-place:
    // the fake messages array is mutable, so mutating an element's data
    // is reflected on the next .all() call — same cursor, re-read.
    const assistantData: MsgData = { role: "assistant" };
    // no finish yet — still working
    const assistantRowData = { ...assistantData };

    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 1000),
      {
        id: "m2",
        session_id: SESSION_ID,
        time_created: 2000,
        data: JSON.stringify(assistantRowData),
      },
    ];
    const parts: FakeRow[] = [
      textPartRow("p1", "m1", "do something"),
      textPartRow("p2", "m2", "working on it"),
    ];
    const db = makeDb(messages, parts);

    // First poll with turn-start cursor (sinceMs = 0)
    const cursor = { kind: "db" as const, sessionId: SESSION_ID, sinceMs: 0 };
    const result1 = readEventsSince(db, SESSION_ID, cursor);
    expect(result1.success).toBe(true);
    if (!result1.success) return;
    const turnEndEvents1 = result1.data.events.filter(
      (e) => e.kind === "turn-end",
    );
    expect(turnEndEvents1).toHaveLength(0);

    // Simulate row update: finish = "stop" lands
    messages[1] = {
      id: "m2",
      session_id: SESSION_ID,
      time_created: 2000,
      data: JSON.stringify({ role: "assistant", finish: "stop" }),
    };

    // Re-read with the SAME cursor
    const result2 = readEventsSince(db, SESSION_ID, cursor);
    expect(result2.success).toBe(true);
    if (!result2.success) return;
    const turnEndEvents2 = result2.data.events.filter(
      (e) => e.kind === "turn-end",
    );
    expect(turnEndEvents2).toHaveLength(1);
    expect(turnEndEvents2[0]).toMatchObject({
      kind: "turn-end",
      outcome: "completed",
      signal: "stop",
    });
  });
});

describe("readEventsSince — abort wins over finish", () => {
  it("MessageAbortedError produces aborted even with finish and a tool part", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 1000),
      msgRow(
        "m2",
        {
          role: "assistant",
          finish: "tool-calls",
          error: { name: "MessageAbortedError" },
        },
        2000,
      ),
    ];
    const parts: FakeRow[] = [
      textPartRow("p1", "m1", "go"),
      textPartRow("p2", "m2", "partial"),
      toolPartRow("p3", "m2", "bash", "call_001"),
    ];
    const db = makeDb(messages, parts);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const turnEnd = result.data.events.find((e) => e.kind === "turn-end");
    expect(turnEnd).toMatchObject({
      kind: "turn-end",
      outcome: "aborted",
      signal: "MessageAbortedError",
    });
  });
});

describe("readEventsSince — finish reasons", () => {
  it.each([
    "unknown",
    "length",
    "content-filter",
    "error",
  ])("finish:%s produces a completed turn-end with the raw signal", (finish) => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "assistant", finish }, 1000),
    ];
    const db = makeDb(messages, []);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events).toContainEqual({
      kind: "turn-end",
      ts: 1,
      outcome: "completed",
      signal: finish,
    });
  });

  it("finish:tool-calls remains nonterminal", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "assistant", finish: "tool-calls" }, 1000),
    ];
    const db = makeDb(messages, []);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events.some((event) => event.kind === "turn-end")).toBe(
      false,
    );
  });

  it("a non-tool finish with a decoded tool part remains nonterminal", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "assistant", finish: "stop" }, 1000),
    ];
    const parts = [toolPartRow("p1", "m1", "bash", "call_001")];
    const db = makeDb(messages, parts);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events).toContainEqual({
      kind: "tool-call",
      ts: 1,
      name: "bash",
      callId: "call_001",
    });
    expect(result.data.events.some((event) => event.kind === "turn-end")).toBe(
      false,
    );
  });
});

describe("readEventsSince — tool parts", () => {
  it("tool parts produce tool-call events", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "assistant", finish: "stop" }, 1000),
    ];
    const parts: FakeRow[] = [
      textPartRow("p1", "m1", "running tools"),
      toolPartRow("p2", "m1", "bash", "call_001"),
      toolPartRow("p3", "m1", "read", "call_002"),
    ];
    const db = makeDb(messages, parts);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const toolCalls = result.data.events.filter((e) => e.kind === "tool-call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      kind: "tool-call",
      name: "bash",
      callId: "call_001",
    });
    expect(toolCalls[1]).toMatchObject({
      kind: "tool-call",
      name: "read",
      callId: "call_002",
    });
  });
});

describe("readEventsSince — reasoning parts", () => {
  it("reasoning parts produce thinking events", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "assistant", finish: "stop" }, 1000),
    ];
    const parts: FakeRow[] = [
      reasoningPartRow("p1", "m1", "Let me think about this.", 1),
      textPartRow("p2", "m1", "Here is my answer.", 2),
    ];
    const db = makeDb(messages, parts);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const thinking = result.data.events.filter((e) => e.kind === "thinking");
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      kind: "thinking",
      text: "Let me think about this.",
    });
  });
});

describe("readEventsSince — user row with no text parts", () => {
  it("user row with no text parts emits no user event", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 1000),
      msgRow("m2", { role: "assistant", finish: "stop" }, 2000),
    ];
    const parts: FakeRow[] = [
      // No parts for m1, some for m2
      textPartRow("p1", "m2", "done"),
    ];
    const db = makeDb(messages, parts);
    const result = readEventsSince(db, SESSION_ID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const userEvents = result.data.events.filter((e) => e.kind === "user");
    expect(userEvents).toHaveLength(0);
  });
});

describe("readEventsSince — sessionId mismatch on cursor", () => {
  it("cursor with different sessionId causes read from 0", () => {
    const messages: FakeRow[] = [
      msgRow("m1", { role: "user" }, 1000),
      msgRow("m2", { role: "assistant", finish: "stop" }, 2000),
    ];
    const parts: FakeRow[] = [
      textPartRow("p1", "m1", "hi"),
      textPartRow("p2", "m2", "hello"),
    ];
    const db = makeDb(messages, parts);

    // Cursor from a different session with a high sinceMs that would exclude everything
    const staleCursor = {
      kind: "db" as const,
      sessionId: "ses_other",
      sinceMs: 99999,
    };
    const result = readEventsSince(db, SESSION_ID, staleCursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Should read from 0, not from 99999 — so both messages are included
    expect(result.data.events.length).toBeGreaterThan(0);
    const userEvents = result.data.events.filter((e) => e.kind === "user");
    expect(userEvents).toHaveLength(1);
  });
});

describe("readEventsSince — empty delta", () => {
  it("no rows past cursor returns empty events with original cursor", () => {
    const messages: FakeRow[] = [msgRow("m1", { role: "user" }, 1000)];
    const db = makeDb(messages, []);

    // Cursor set after the only row
    const cursor = {
      kind: "db" as const,
      sessionId: SESSION_ID,
      sinceMs: 1000,
    };
    const result = readEventsSince(db, SESSION_ID, cursor);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.events).toHaveLength(0);
    expect(result.data.nextCursor.sinceMs).toBe(1000);
  });
});

describe("readEventsSince — throwing DB", () => {
  it("message query throwing returns fail", () => {
    let callCount = 0;
    const throwingDb: OpencodeDb = {
      prepare(_sql: string) {
        return {
          all(): unknown[] {
            callCount += 1;
            if (callCount === 1) {
              // Watermark query (from snapshotCursor) would use a different code path
              // For readEventsSince, the first .all() is the message query
              throw new Error("connection lost");
            }
            return [];
          },
          get(): unknown {
            return undefined;
          },
        };
      },
    };
    const result = readEventsSince(throwingDb, SESSION_ID);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[0]?.message).toContain("DB error");
  });
});
