/** Exact-version Codex compatibility certification over sanitized captures. */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codex } from "../../src/dialects/codex.js";
import { CODEX_CAPTURE_EVIDENCE } from "../../src/dialects/codex-evidence.js";
import {
  classifyCodexJsonLine,
  classifyCodexRawRecord,
} from "../../src/parsers/codex/certification.js";
import { decodeLine } from "../../src/parsers/codex/events.js";
import {
  parseSessionFile,
  readEventsSince,
  snapshotCursor,
} from "../../src/parsers/codex/index.js";
import { IssueCollector } from "../../src/parsers/types.js";
import { SessionSchema } from "../../src/schemas/session.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RawLineSchema = z.object({
  timestamp: z.string().optional(),
  type: z.string().optional(),
  payload: z.unknown().optional(),
});
const PayloadTypeSchema = z.object({ type: z.string().optional() });
const EVIDENCE_FIXTURES = [
  {
    cliVersion: "0.141.0",
    fixture: "tests/fixtures/codex/capture-derived-0.141.0.jsonl",
    scenarios: {
      functionTool: true,
      customTool: false,
      abort: true,
      ignored: [
        "event_msg:user_message",
        "event_msg:agent_message",
        "response_item:message",
      ],
    },
    golden: {
      sessionId: "cx--capture-derived-session-141",
      messages: [
        ["user", "capture-derived user message"],
        ["thinking", "capture-derived reasoning"],
        ["assistant", "capture-derived assistant reply"],
      ],
      tools: [["capture_tool", "capture-derived tool output"]],
      tokens: { input: 11, output: 7, reasoning: 3 },
      turnEnds: ["task_complete", "turn_aborted"],
      abortedTurns: 1,
    },
  },
  {
    cliVersion: "0.150.1",
    fixture: "tests/fixtures/codex/capture-derived-0.150.1.jsonl",
    scenarios: {
      functionTool: true,
      customTool: true,
      abort: true,
      ignored: [
        "world_state",
        "compacted",
        "inter_agent_communication_metadata",
        "event_msg:item_completed",
        "event_msg:thread_settings_applied",
        "event_msg:thread_goal_updated",
        "response_item:agent_message",
        "response_item:message",
      ],
    },
    golden: {
      sessionId: "cx--capture-derived-session-150",
      messages: [
        ["user", "capture-derived user message"],
        ["thinking", "capture-derived reasoning"],
        ["assistant", "capture-derived assistant reply"],
      ],
      tools: [
        ["capture_tool", "capture-derived tool output"],
        ["capture_tool_two", "capture-derived output"],
      ],
      tokens: {
        input: 13,
        output: 9,
        cacheRead: 0,
        cacheCreation: 1,
        reasoning: 4,
      },
      turnEnds: ["task_complete", "turn_aborted"],
      abortedTurns: 1,
    },
  },
];

function fixturePath(fixture: string): string {
  return join(__dirname, "..", fixture.replace(/^tests\//, ""));
}

async function fixtureLines(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

describe("Codex exact-version certification", () => {
  it("derives the dialect baseline from exactly one fixture per capture version", async () => {
    const versions = CODEX_CAPTURE_EVIDENCE.map((entry) => entry.cliVersion);
    expect(versions).toEqual(["0.141.0", "0.150.1"]);
    expect(new Set(versions).size).toBe(versions.length);
    expect(codex.validatedAgainst?.cliVersions).toEqual(versions);

    expect(EVIDENCE_FIXTURES.map((entry) => entry.cliVersion)).toEqual(
      versions,
    );
    for (const evidence of EVIDENCE_FIXTURES) {
      const matching = EVIDENCE_FIXTURES.filter(
        (candidate) => candidate.cliVersion === evidence.cliVersion,
      );
      expect(matching).toHaveLength(1);
      const lines = await fixtureLines(fixturePath(evidence.fixture));
      const firstRaw: unknown = JSON.parse(lines[0] ?? "null");
      const first = RawLineSchema.parse(firstRaw);
      const payload = z
        .object({ cli_version: z.string() })
        .parse(first.payload);
      expect(first.type).toBe("session_meta");
      expect(payload.cli_version).toBe(evidence.cliVersion);
    }
  });

  it.each(
    EVIDENCE_FIXTURES,
  )("$cliVersion capture parses, validates, and classifies exhaustively", async (evidence) => {
    const path = fixturePath(evidence.fixture);
    const lines = await fixtureLines(path);
    for (const line of lines) {
      const classification = classifyCodexJsonLine(line);
      expect(classification.kind).not.toBe("unclassified");
      if (classification.kind === "explicitly-ignored") {
        expect(classification.reason).toMatch(
          /^(noncanonical-state-snapshot|transport-metadata-only|duplicate-derived-message|lifecycle-bookkeeping)$/,
        );
      }
    }

    const result = await parseSessionFile(path);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(SessionSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.id).toBe(evidence.golden.sessionId);
    expect(
      result.data.transcript.messages
        .filter(
          (message) =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "thinking",
        )
        .map((message) => [message.role, message.text]),
    ).toEqual(evidence.golden.messages);
    expect(
      result.data.transcript.messages.flatMap((message) =>
        message.toolCalls.map((tool) => [tool.name, tool.outputFull ?? ""]),
      ),
    ).toEqual(evidence.golden.tools);
    expect(result.data.transcript.inputTokens).toBe(
      evidence.golden.tokens.input,
    );
    expect(result.data.transcript.outputTokens).toBe(
      evidence.golden.tokens.output,
    );
    expect(result.data.transcript.cacheReadTokens).toBe(
      evidence.golden.tokens.cacheRead,
    );
    expect(result.data.transcript.cacheCreationTokens).toBe(
      evidence.golden.tokens.cacheCreation,
    );
    expect(result.data.transcript.reasoningTokens).toBe(
      evidence.golden.tokens.reasoning,
    );
    expect(result.data.transcript.abortedTurns ?? 0).toBe(
      evidence.golden.abortedTurns,
    );

    const rawRecords = lines.map((line) => {
      const parsed: unknown = JSON.parse(line);
      return RawLineSchema.parse(parsed);
    });
    const sessionMetaRecords = rawRecords.filter(
      (record) => record.type === "session_meta",
    );
    expect(sessionMetaRecords).toHaveLength(1);
    expect(result.data.parentSessionId).toBeUndefined();
    expect(result.data.agentType).toBeUndefined();
    const rootMetadata = z
      .object({
        forked_from_id: z.string().optional(),
        parent_thread_id: z.string().optional(),
        thread_source: z.string().optional(),
        agent_path: z.string().optional(),
        source: z
          .object({ subagent: z.unknown().optional() })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .parse(sessionMetaRecords[0]?.payload);
    expect(rootMetadata.forked_from_id).toBeUndefined();
    expect(rootMetadata.parent_thread_id).toBeUndefined();
    expect(rootMetadata.thread_source).not.toBe("subagent");
    expect(rootMetadata.agent_path).toBeUndefined();
    expect(rootMetadata.source?.subagent).toBeUndefined();
    const taskStartedRecords = rawRecords.flatMap((record) => {
      if (record.type !== "event_msg") return [];
      const payload = z
        .object({
          type: z.literal("task_started"),
          started_at: z.number().int().nonnegative(),
        })
        .safeParse(record.payload);
      if (!payload.success || record.timestamp === undefined) return [];
      return [
        {
          recordSeconds: Date.parse(record.timestamp) / 1000,
          startedAt: payload.data.started_at,
        },
      ];
    });
    // The initial evidence rows are root captures. Replay captures need the
    // reducer's contextual replay detection instead of this ordered-time check.
    expect(taskStartedRecords.length).toBeGreaterThan(0);
    for (const boundary of taskStartedRecords) {
      expect(
        Math.abs(boundary.startedAt - boundary.recordSeconds),
      ).toBeLessThanOrEqual(1);
    }
    const responseTypes = new Set(
      rawRecords
        .filter((record) => record.type === "response_item")
        .map((record) => {
          const payload = PayloadTypeSchema.safeParse(record.payload);
          return payload.success ? payload.data.type : undefined;
        }),
    );
    const eventTypes = new Set(
      rawRecords
        .filter((record) => record.type === "event_msg")
        .map((record) => {
          const payload = PayloadTypeSchema.safeParse(record.payload);
          return payload.success ? payload.data.type : undefined;
        }),
    );
    const primaryMessages = rawRecords
      .filter((record) => record.type === "response_item")
      .flatMap((record) => {
        const payload = z
          .object({
            type: z.literal("message"),
            role: z.enum(["user", "assistant"]),
            content: z.array(z.object({ text: z.string().optional() })),
          })
          .safeParse(record.payload);
        if (!payload.success) return [];
        return [
          {
            role: payload.data.role,
            text: payload.data.content
              .map((part) => part.text ?? "")
              .filter(Boolean)
              .join("\n\n"),
          },
        ];
      });
    for (const record of rawRecords) {
      if (record.type === "event_msg") {
        const duplicate = z
          .object({
            type: z.enum(["user_message", "agent_message"]),
            message: z.string(),
          })
          .safeParse(record.payload);
        if (duplicate.success) {
          const role =
            duplicate.data.type === "user_message" ? "user" : "assistant";
          expect(primaryMessages).toContainEqual({
            role,
            text: duplicate.data.message,
          });
        }
      }
      if (record.type === "response_item") {
        const duplicate = z
          .object({
            type: z.literal("agent_message"),
            content: z.array(z.object({ text: z.string().optional() })),
          })
          .safeParse(record.payload);
        if (duplicate.success) {
          expect(primaryMessages).toContainEqual({
            role: "assistant",
            text: duplicate.data.content
              .map((part) => part.text ?? "")
              .filter(Boolean)
              .join("\n\n"),
          });
        }
      }
    }
    expect(responseTypes.has("reasoning")).toBe(true);
    expect(responseTypes.has("message")).toBe(true);
    expect(responseTypes.has("function_call")).toBe(
      evidence.scenarios.functionTool,
    );
    expect(responseTypes.has("custom_tool_call")).toBe(
      evidence.scenarios.customTool,
    );
    expect(eventTypes.has("token_count")).toBe(true);
    expect(eventTypes.has("task_started")).toBe(true);
    expect(eventTypes.has("task_complete")).toBe(true);
    expect(evidence.scenarios.abort).toBe(true);
    expect(eventTypes.has("turn_aborted")).toBe(true);
    const ignoredKeys = new Set<string>();
    for (const record of rawRecords) {
      const payload = PayloadTypeSchema.safeParse(record.payload);
      const key =
        record.type === "event_msg" || record.type === "response_item"
          ? `${record.type}:${payload.success ? payload.data.type : ""}`
          : record.type;
      const classification = classifyCodexRawRecord(record);
      if (
        classification.kind === "explicitly-ignored" &&
        key !== undefined &&
        evidence.scenarios.ignored.includes(key)
      ) {
        ignoredKeys.add(key);
      }
    }
    expect([...ignoredKeys].sort()).toEqual(
      [...evidence.scenarios.ignored].sort(),
    );
  });

  it.each(
    EVIDENCE_FIXTURES,
  )("$cliVersion full and incremental streams preserve semantic signals", async (evidence) => {
    const path = fixturePath(evidence.fixture);
    const lines = await fixtureLines(path);
    const full = await parseSessionFile(path);
    expect(full.success).toBe(true);
    if (!full.success) return;

    const tempDir = await mkdtemp(join(tmpdir(), "codex-certification-"));
    const tempPath = join(tempDir, "rollout.jsonl");
    try {
      await writeFile(tempPath, "", "utf8");
      const cursor = await snapshotCursor(tempPath);
      await writeFile(tempPath, `${lines.join("\n")}\n`, "utf8");
      const incremental = await readEventsSince(tempPath, cursor);
      expect(incremental.success).toBe(true);
      if (!incremental.success) return;

      const fullMessages = full.data.transcript.messages
        .filter(
          (message) =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "thinking",
        )
        .map((message) => ({ role: message.role, text: message.text }));
      const incrementalMessages = incremental.data.events
        .filter(
          (event) =>
            event.kind === "user" ||
            event.kind === "assistant" ||
            event.kind === "thinking",
        )
        .map((event) => ({ role: event.kind, text: event.text }));
      expect(incrementalMessages).toEqual(fullMessages);

      const fullToolNames = full.data.transcript.messages.flatMap((message) =>
        message.toolCalls.map((tool) => tool.name),
      );
      const incrementalToolNames = incremental.data.events
        .filter((event) => event.kind === "tool-call")
        .map((event) => event.name);
      expect(incrementalToolNames).toEqual(fullToolNames);

      const fullTerminalSignals = lines
        .map((line, seq) => decodeLine(line, seq, new IssueCollector()))
        .map((event) => {
          if (event.kind === "event_msg_task_complete") return "task_complete";
          if (event.kind === "event_msg_turn_aborted") return "turn_aborted";
          return undefined;
        })
        .filter(
          (signal): signal is "task_complete" | "turn_aborted" =>
            signal !== undefined,
        );
      const incrementalTerminalSignals = incremental.data.events
        .filter((event) => event.kind === "turn-end")
        .map((event) => event.signal);
      expect(incrementalTerminalSignals).toEqual(evidence.golden.turnEnds);
      expect(incrementalTerminalSignals).toEqual(fullTerminalSignals);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps unknown records unclassified while naming every explicit ignore", () => {
    expect(
      classifyCodexRawRecord({ type: "future_record", payload: {} }),
    ).toEqual({
      kind: "unclassified",
    });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "world_state",
        payload: { capture: "capture-derived" },
      }),
    ).toMatchObject({
      kind: "explicitly-ignored",
      reason: "noncanonical-state-snapshot",
    });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "thread_goal_updated",
          threadId: "capture-derived-thread",
          goal: {
            threadId: "capture-derived-thread",
            objective: "capture-derived objective",
            status: "capture-derived",
            tokensUsed: 1,
            timeUsedSeconds: 1,
            createdAt: 1787961600,
            updatedAt: 1787961600,
          },
        },
      }),
    ).toMatchObject({
      kind: "explicitly-ignored",
      reason: "lifecycle-bookkeeping",
    });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "agent_message",
          id: "capture-derived-agent-message",
          author: "capture-derived-agent",
          recipient: "capture-derived-recipient",
          content: [
            { type: "input_text", text: "capture-derived" },
            {
              type: "encrypted_content",
              encrypted_content: "capture-derived-encrypted",
            },
          ],
          internal_chat_message_metadata_passthrough: {},
        },
      }),
    ).toMatchObject({
      kind: "explicitly-ignored",
      reason: "duplicate-derived-message",
    });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 13,
              output_tokens: 9,
              total_tokens: 22,
            },
          },
        },
      }),
    ).toEqual({ kind: "handled" });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "capture-derived" }],
        },
      }),
    ).toMatchObject({
      kind: "explicitly-ignored",
      reason: "transport-metadata-only",
    });
  });

  it("does not classify malformed known records as handled", () => {
    const timestamp = "2026-08-29T00:00:00.000Z";
    expect(
      classifyCodexRawRecord({ timestamp, type: "session_meta", payload: {} }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: { type: "token_count" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: { type: "task_started", started_at: -1 },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: { type: "task_started", started_at: 1787961600000 },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 1 } },
        },
      }),
    ).toEqual({ kind: "unclassified" });
    const usageCounterNames = [
      "input_tokens",
      "output_tokens",
      "cached_input_tokens",
      "cache_write_input_tokens",
      "reasoning_output_tokens",
      "total_tokens",
    ] as const;
    const usageFields = ["total_token_usage", "last_token_usage"] as const;
    for (const usageField of usageFields) {
      for (const counterName of usageCounterNames) {
        for (const invalidValue of [-1, 1.5]) {
          expect(
            classifyCodexRawRecord({
              timestamp,
              type: "event_msg",
              payload: {
                type: "token_count",
                info: {
                  [usageField]: {
                    input_tokens: 1,
                    output_tokens: 1,
                    [counterName]: invalidValue,
                  },
                },
              },
            }),
          ).toEqual({ kind: "unclassified" });
        }
      }
    }
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: { future_tokens: 1 } },
        },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: { type: "user_message" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: { type: "thread_settings_applied", settings: "rewritten" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "event_msg",
        payload: { type: "thread_goal_updated", goal: "rewritten" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "world_state",
        payload: "bad",
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "response_item",
        payload: { type: "message" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp,
        type: "response_item",
        payload: { type: "function_call", name: "capture_tool" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [] },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "exec_command_end", call_id: "capture-call" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "developer", content: "bad" },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "response_item",
        payload: { type: "message", role: "future_role", content: [] },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "response_item",
        payload: { type: "message", content: [] },
      }),
    ).toEqual({ kind: "unclassified" });
    expect(
      classifyCodexRawRecord({
        timestamp: "2026-08-29T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "capture-derived-warning",
          parent_thread_id: "capture-parent-a",
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: "capture-parent-b" },
            },
          },
        },
      }),
    ).toEqual({ kind: "unclassified" });
  });

  it("keeps ordinary parsing tolerant when unknown records are appended", async () => {
    const source = fixturePath(EVIDENCE_FIXTURES[0]?.fixture ?? "");
    const lines = await fixtureLines(source);
    const timestamp = "2026-08-29T00:00:00.000Z";
    const unknownLines = [
      JSON.stringify({ timestamp, type: "future_top_level", payload: {} }),
      JSON.stringify({
        timestamp,
        type: "event_msg",
        payload: { type: "future_event_msg" },
      }),
      JSON.stringify({
        timestamp,
        type: "response_item",
        payload: { type: "future_response_item" },
      }),
    ];
    for (const line of unknownLines) {
      expect(classifyCodexJsonLine(line)).toEqual({ kind: "unclassified" });
    }

    const tempDir = await mkdtemp(join(tmpdir(), "codex-certification-"));
    const tempPath = join(tempDir, "rollout.jsonl");
    try {
      await writeFile(
        tempPath,
        `${lines.concat(unknownLines).join("\n")}\n`,
        "utf8",
      );
      const result = await parseSessionFile(tempPath);
      expect(result.success).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pins a stable reason to every observed ignored wire record", async () => {
    const expected = new Map<string, string>([
      ["world_state", "noncanonical-state-snapshot"],
      ["compacted", "noncanonical-state-snapshot"],
      ["inter_agent_communication_metadata", "transport-metadata-only"],
      ["event_msg:user_message", "duplicate-derived-message"],
      ["event_msg:agent_message", "duplicate-derived-message"],
      ["event_msg:item_completed", "lifecycle-bookkeeping"],
      ["event_msg:thread_settings_applied", "lifecycle-bookkeeping"],
      ["event_msg:thread_goal_updated", "lifecycle-bookkeeping"],
      ["response_item:agent_message", "duplicate-derived-message"],
      ["response_item:message", "lifecycle-bookkeeping"],
    ]);
    const observed = new Map<string, string>();
    for (const evidence of EVIDENCE_FIXTURES) {
      const path = fixturePath(evidence.fixture);
      const lines = await fixtureLines(path);
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);
        const raw = RawLineSchema.parse(parsed);
        const payload = PayloadTypeSchema.safeParse(raw.payload);
        const key =
          raw.type === "event_msg" || raw.type === "response_item"
            ? `${raw.type}:${payload.success ? payload.data.type : ""}`
            : raw.type;
        if (key === undefined || !expected.has(key)) continue;
        const classification = classifyCodexRawRecord(raw);
        if (classification.kind === "explicitly-ignored") {
          observed.set(key, classification.reason);
        }
      }
    }
    expect(observed).toEqual(expected);
  });
});
