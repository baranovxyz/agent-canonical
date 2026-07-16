/** Codex parser tests using only synthetic inline or temporary fixtures. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeLine } from "../../src/parsers/codex/events.js";
import { parseSessionFile } from "../../src/parsers/codex/index.js";
import { IssueCollector } from "../../src/parsers/types.js";
import { SessionSchema } from "../../src/schemas/session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Synthetic codex fixture bundled with this package
const FIXTURE = join(__dirname, "../fixtures/codex/tiny.jsonl");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write lines to a temp file, return { file, cleanup }. */
function makeTempRollout(lines: object[]): {
  file: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "codex-parser-test-"));
  const file = join(dir, "rollout.jsonl");
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeMetadataRollout(payload: Record<string, unknown>): {
  file: string;
  cleanup: () => void;
} {
  return makeTempRollout([
    {
      timestamp: "2026-07-16T09:00:00.000Z",
      type: "session_meta",
      payload,
    },
    {
      timestamp: "2026-07-16T09:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "delegated task" }],
      },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Core parser behavior
// ---------------------------------------------------------------------------

describe("codex parser — core behavior", () => {
  it("parses session_meta + response_items into a canonical session", async () => {
    const result = await parseSessionFile(FIXTURE);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const s = result.data;
    expect(s.id).toBe("cx--codex-fix-001");
    expect(s.cli).toBe("codex");
    expect(s.externalId).toBe("codex-fix-001");
    expect(s.projectPath).toBe("/home/u/repo");
    expect(s.model).toBe("gpt-5.5");
    expect(s.agentType).toBeUndefined();
    // Title comes from first non-thinking message (the user message)
    expect(s.title).toBe("please list the top-level files");
  });

  it("emits a thinking message from a reasoning summary", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const msgs = result.data.transcript.messages;
    // Expected stream: user, thinking, assistant, assistant, user, assistant.
    const roles = msgs.map((m) => m.role);
    expect(roles).toEqual([
      "user",
      "thinking",
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
    // The thinking message has UNPREFIXED text (no "**Reasoning**" markdown)
    const thinkingMsg = msgs[1];
    expect(thinkingMsg?.role).toBe("thinking");
    expect(thinkingMsg?.text).toBe(
      "Need to inspect the repo root before answering.",
    );
    expect(thinkingMsg?.text).not.toContain("**Reasoning**");
  });

  it("attaches function_call to the assistant turn it followed", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const msgs = result.data.transcript.messages;
    const a1 = msgs.find((m) => m.text === "Reading the repo root.");
    expect(a1?.role).toBe("assistant");
    expect(a1?.toolCalls.map((tc) => tc.name)).toEqual(["exec_command"]);
    expect(a1?.toolCalls[0]?.callId).toBe("call_A");
    expect(a1?.toolCalls[0]?.exitCode).toBe(0);
    expect(a1?.toolCalls[0]?.outputPreview).toContain("README.md");
  });

  it("parses custom_tool_call exit_code and durationMs from JSON metadata", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const patch = result.data.transcript.messages
      .flatMap((m) => m.toolCalls)
      .find((tc) => tc.callId === "call_B");
    expect(patch).toBeDefined();
    expect(patch?.name).toBe("apply_patch");
    expect(patch?.exitCode).toBe(0);
    expect(patch?.durationMs).toBe(50);
    expect(patch?.outputPreview).toContain("Success.");
    expect(patch?.outputFull).toContain("Success.");
  });

  it("keeps raw events for lossless source inspection", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const raw = result.data.transcript.rawEvents;
    expect(raw).toBeDefined();
    expect((raw ?? []).length).toBeGreaterThan(10);
    expect(raw?.[0]?.eventType).toBe("session_meta");
    expect(raw?.[0]?.rawJson).toContain("codex-fix-001");
  });

  it("falls back to event_msg/exec_command_end.exit_code for interactive shells", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-fb-001", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "running" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"sleep 99"}',
          call_id: "call_X",
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_X",
          output:
            "Wall time: 0.0\nProcess running with session ID 4242\nOutput:\n",
        },
      },
      {
        timestamp: "2026-04-28T10:00:30.000Z",
        type: "event_msg",
        payload: {
          type: "exec_command_end",
          call_id: "call_X",
          exit_code: 137,
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const tc = result.data.transcript.messages[0]?.toolCalls.find(
        (t) => t.callId === "call_X",
      );
      expect(tc?.exitCode).toBe(137);
    } finally {
      cleanup();
    }
  });

  it("treats 'exec_command failed for' (sandbox denied) as exit_code=1", async () => {
    const denyOut =
      'exec_command failed for `/bin/bash -lc pwd`: CreateProcess { message: "Codex(Sandbox(Denied { output: ExecToolCallOutput { exit_code: 1, ... } }))" }';
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-fb-002", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "trying" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
          call_id: "call_Y",
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_Y",
          output: denyOut,
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const tc = result.data.transcript.messages[0]?.toolCalls.find(
        (t) => t.callId === "call_Y",
      );
      expect(tc?.exitCode).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("captures token usage from event_msg/token_count and counts turn_aborted", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-tk-001", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              output_tokens: 20,
              cached_input_tokens: 30,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
      // Later token_count snapshot should win
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              output_tokens: 50,
              cached_input_tokens: 80,
              reasoning_output_tokens: 12,
            },
          },
        },
      },
      {
        timestamp: "2026-04-28T10:00:04.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "interrupted" },
      },
      {
        timestamp: "2026-04-28T10:00:05.000Z",
        type: "event_msg",
        payload: { type: "turn_aborted", reason: "interrupted" },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const t = result.data.transcript;
      expect(t.inputTokens).toBe(200);
      expect(t.outputTokens).toBe(50);
      expect(t.cacheReadTokens).toBe(80);
      expect(t.reasoningTokens).toBe(12);
      expect(t.abortedTurns).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("flattens array-shaped function_call_output into text", async () => {
    const result = await parseSessionFile(FIXTURE);
    if (!result.success) throw new Error("parse failed");
    const msgs = result.data.transcript.messages;
    // call_C is an orphan (issued after last assistant, no following assistant
    // message with output before it — see fixture). It ends up on the last
    // assistant turn ("Patched.") since that is lastAssistantIdx when call_C
    // is issued, or on a synthetic tail turn depending on ordering.
    // In the fixture: call_C is issued AFTER "Patched." (line 14), so
    // lastAssistantOrThinkingIdx points at "Patched.". call_C output arrives
    // before EOF, attached to "Patched." turn (not a synthetic turn).
    const patchedMsg = msgs.find((m) => m.text === "Patched.");
    expect(patchedMsg).toBeDefined();
    const callC = patchedMsg?.toolCalls.find((tc) => tc.callId === "call_C");
    // call_C gets its exitCode from the flattened array output
    expect(callC?.exitCode).toBe(1);
    expect(callC?.outputPreview).toContain("No such file");
  });
});

describe("codex parser — collaboration lineage", () => {
  it("leaves user threads untyped and ignores fork-only lineage", async () => {
    const { file, cleanup } = makeMetadataRollout({
      id: "root-session",
      cwd: "/tmp/repo",
      originator: "codex-tui",
      source: "cli",
      thread_source: "user",
      forked_from_id: "another-user-thread",
    });
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parentSessionId).toBeUndefined();
      expect(result.data.agentType).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("maps v1 role-based workers to their direct parent", async () => {
    const { file, cleanup } = makeMetadataRollout({
      id: "child-v1",
      cwd: "/tmp/repo",
      originator: "codex-tui",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent-v1",
            depth: 1,
            agent_path: null,
            agent_nickname: "Boole",
            agent_role: "explorer",
          },
        },
      },
      thread_source: "subagent",
      parent_thread_id: "parent-v1",
      forked_from_id: null,
      agent_path: null,
      multi_agent_version: "v1",
    });
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parentSessionId).toBe("cx--parent-v1");
      expect(result.data.agentType).toBe("explorer");
    } finally {
      cleanup();
    }
  });

  it("maps v2 path-named workers without changing identity or raw events", async () => {
    const { file, cleanup } = makeMetadataRollout({
      id: "child-v2",
      session_id: "root-session",
      cwd: "/tmp/repo",
      originator: "codex-tui",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "root-session",
            depth: 1,
            agent_path: "/root/code_audit",
            agent_nickname: "Newton",
            agent_role: null,
          },
        },
      },
      thread_source: "subagent",
      parent_thread_id: "root-session",
      forked_from_id: "root-session",
      agent_path: "/root/code_audit",
      agent_nickname: "Newton",
      multi_agent_version: "v2",
    });
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const session = result.data;
      expect(session.id).toBe("cx--child-v2");
      expect(session.externalId).toBe("child-v2");
      expect(session.parentSessionId).toBe("cx--root-session");
      expect(session.agentType).toBe("/root/code_audit");
      expect(session.transcript.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(session.transcript.rawEvents).toHaveLength(2);
      expect(session.transcript.rawEvents?.[0]?.rawJson).toContain(
        '"agent_path":"/root/code_audit"',
      );
    } finally {
      cleanup();
    }
  });

  it("links nested workers to the immediate worker rather than the root", async () => {
    const { file, cleanup } = makeMetadataRollout({
      id: "nested-child",
      session_id: "root-session",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "direct-worker",
            depth: 2,
            agent_path: "/root/parent/nested",
            agent_role: null,
          },
        },
      },
      thread_source: "subagent",
      parent_thread_id: "direct-worker",
      forked_from_id: "direct-worker",
      agent_path: "/root/parent/nested",
      multi_agent_version: "v2",
    });
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parentSessionId).toBe("cx--direct-worker");
      expect(result.data.parentSessionId).not.toBe("cx--root-session");
      expect(result.data.agentType).toBe("/root/parent/nested");
    } finally {
      cleanup();
    }
  });

  it("classifies Guardian reviews as direct child sessions", async () => {
    const { file, cleanup } = makeMetadataRollout({
      id: "guardian-review",
      session_id: "root-session",
      source: { subagent: { other: "guardian" } },
      thread_source: "subagent",
      parent_thread_id: "direct-worker",
      forked_from_id: null,
      multi_agent_version: "disabled",
    });
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parentSessionId).toBe("cx--direct-worker");
      expect(result.data.agentType).toBe("guardian");
    } finally {
      cleanup();
    }
  });

  it("uses forked_from_id only as a guarded subagent fallback", async () => {
    const { file, cleanup } = makeMetadataRollout({
      id: "fallback-child",
      source: {
        subagent: {
          thread_spawn: {
            depth: 1,
            agent_role: "worker",
          },
        },
      },
      thread_source: "subagent",
      forked_from_id: "cx--fallback-parent",
      multi_agent_version: "v1",
    });
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parentSessionId).toBe("cx--fallback-parent");
      expect(result.data.agentType).toBe("worker");
    } finally {
      cleanup();
    }
  });

  it("warns nonfatally when Codex parent metadata conflicts", async () => {
    const { file, cleanup } = makeMetadataRollout({
      id: "conflicting-child",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "nested-parent",
            depth: 1,
            agent_path: "/root/conflict_test",
          },
        },
      },
      thread_source: "subagent",
      parent_thread_id: "top-level-parent",
      forked_from_id: "fork-parent",
      multi_agent_version: "v2",
    });
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.parentSessionId).toBe("cx--nested-parent");
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]?.severity).toBe("warning");
      expect(result.issues[0]?.message).toContain("conflicting Codex parent");
      expect(result.issues[1]?.message).toContain("conflicting Codex fork");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Reasoning normalization
// ---------------------------------------------------------------------------

describe("codex parser — reasoning → thinking message", () => {
  it("emits a separate role:thinking message with unprefixed reasoning text", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-r-001", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "I should greet warmly." }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hi there!" }],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const msgs = result.data.transcript.messages;
      expect(msgs.map((m) => m.role)).toEqual([
        "user",
        "thinking",
        "assistant",
      ]);

      const thinkingMsg = msgs[1];
      expect(thinkingMsg?.role).toBe("thinking");
      expect(thinkingMsg?.text).toBe("I should greet warmly.");
      // No markdown prefix
      expect(thinkingMsg?.text).not.toContain("**Reasoning**");
    } finally {
      cleanup();
    }
  });

  it("empty summary[] emits nothing — no thinking message", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-r-002", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "go" }],
        },
      },
      // Empty summary — should produce no message
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: { type: "reasoning", summary: [] },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const msgs = result.data.transcript.messages;
      expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(msgs.find((m) => m.role === "thinking")).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("reasoning_text field takes precedence over summary[]", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-r-003", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "think" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          reasoning_text: "Primary reasoning text.",
          summary: [{ type: "summary_text", text: "Secondary summary." }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const thinkingMsg = result.data.transcript.messages.find(
        (m) => m.role === "thinking",
      );
      expect(thinkingMsg?.text).toBe("Primary reasoning text.");
    } finally {
      cleanup();
    }
  });
});

describe("codex parser — title skips thinking messages", () => {
  it("title derives from first non-thinking message, not from thinking", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-title-001", cwd: "/tmp" },
      },
      // Reasoning comes FIRST in the stream before user message (unusual but possible)
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Preliminary thinking." }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "The real user message." }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "reply" }],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Title must NOT be "Preliminary thinking." — it should be the user msg
      expect(result.data.title).toBe("The real user message.");
    } finally {
      cleanup();
    }
  });
});

describe("codex parser — fail cases", () => {
  it("returns fail when file does not exist", async () => {
    const result = await parseSessionFile(
      "/tmp/__nonexistent_codex_file__.jsonl",
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[0]?.message).toContain("failed to read");
  });

  it("returns fail when session_meta is missing", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.issues[0]?.severity).toBe("error");
      expect(result.issues[0]?.message).toContain("no session_meta");
    } finally {
      cleanup();
    }
  });

  it("returns fail when session has zero messages", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-empty-001", cwd: "/tmp" },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.issues[0]?.severity).toBe("error");
      expect(result.issues[0]?.message).toContain("zero messages");
    } finally {
      cleanup();
    }
  });
});

describe("codex parser — clean fixture passes SessionSchema.parse", () => {
  it("result.data satisfies SessionSchema and issues === [] for a clean fixture", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "cx-clean-001",
          cwd: "/home/u/proj",
          originator: "codex-tui",
        },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "turn_context",
        payload: { model: "gpt-5.5" },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "list files" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Need to check directory." }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Here are the files." }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:05.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
          call_id: "call_1",
        },
      },
      {
        timestamp: "2026-04-28T10:00:06.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output:
            "Wall time: 0.1s\nProcess exited with code 0\nOutput:\nfoo.ts",
        },
      },
      {
        timestamp: "2026-04-28T10:00:07.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 50,
              output_tokens: 10,
              cached_input_tokens: 0,
              reasoning_output_tokens: 3,
            },
          },
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      // Zero issues (no warnings for this clean fixture)
      expect(result.issues).toEqual([]);

      // Session validates against the full schema
      const parsed = SessionSchema.safeParse(result.data);
      expect(parsed.success).toBe(true);

      // Spot-check nested shape
      expect(result.data.cli).toBe("codex");
      expect(result.data.transcript.messages.length).toBeGreaterThan(0);
      expect(result.data.transcript.contentHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanup();
    }
  });
});

describe("codex parser — decodeLine exported separately", () => {
  it("decodeLine is a pure function that decodes one raw line", () => {
    const collector = new IssueCollector();
    const line = JSON.stringify({
      timestamp: "2026-04-28T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "cx-test", cwd: "/tmp", originator: "test" },
    });
    const event = decodeLine(line, 0, collector);
    expect(event.kind).toBe("session_meta");
    if (event.kind !== "session_meta") return;
    expect(event.id).toBe("cx-test");
    expect(collector.list()).toEqual([]);
  });

  it("decodeLine warns on invalid JSON and returns skip", () => {
    const collector = new IssueCollector();
    const event = decodeLine("not-valid-json{", 5, collector);
    expect(event.kind).toBe("skip");
    const issues = collector.list();
    expect(issues.length).toBe(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.seq).toBe(5);
  });
});

describe("codex parser — web_search_call handling", () => {
  it("emits a web_search tool call with queries, no paired output", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-ws-001", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "searching" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", queries: ["rust async", "tokio docs"] },
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const msgs = result.data.transcript.messages;
      const searchingMsg = msgs.find((m) => m.text === "searching");
      expect(searchingMsg).toBeDefined();
      const tc = searchingMsg?.toolCalls.find((t) => t.name === "web_search");
      expect(tc).toBeDefined();
      expect(tc?.exitCode).toBe(0);
      expect(tc?.args).toMatchObject({ queries: ["rust async", "tokio docs"] });
    } finally {
      cleanup();
    }
  });
});

describe("codex parser — turn numbering", () => {
  it("thinking messages participate in turn numbering", async () => {
    const { file, cleanup } = makeTempRollout([
      {
        timestamp: "2026-04-28T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "cx-turns-001", cwd: "/tmp" },
      },
      {
        timestamp: "2026-04-28T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "prompt" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "think" }],
        },
      },
      {
        timestamp: "2026-04-28T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "answer" }],
        },
      },
    ]);
    try {
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;

      const msgs = result.data.transcript.messages;
      expect(msgs[0]?.turn).toBe(1); // user
      expect(msgs[1]?.turn).toBe(2); // thinking
      expect(msgs[2]?.turn).toBe(3); // assistant
    } finally {
      cleanup();
    }
  });
});
