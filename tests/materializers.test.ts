import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectCodexRolloutFamily,
  createCodexSessionSourcePlan,
  SessionSourceMaterializationError,
} from "../src/materializers/index.js";
import type { Session } from "../src/schemas/session.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { directory: string; day: string } {
  const directory = mkdtempSync(join(tmpdir(), "codex-family-test-"));
  temporaryDirectories.push(directory);
  const day = join(directory, "sessions", "2026", "07", "31");
  mkdirSync(day, { recursive: true });
  return { directory, day };
}

function line(type: string, payload: unknown, second: number): object {
  return {
    timestamp: `2026-07-31T10:00:${String(second).padStart(2, "0")}.000Z`,
    type,
    payload,
  };
}

function writeRollout(options: {
  day: string;
  name: string;
  id: string;
  parentId?: string;
  model?: string;
  tokens?: { input: number; output: number; cached: number; reasoning: number };
  spawnId?: string;
  spawnOutput?: unknown;
  failedSpawn?: boolean;
  liveSpawn?: boolean;
  malformedLiveActivity?: boolean;
  agentRole?: string;
  padding?: string;
}): string {
  const source =
    options.parentId === undefined
      ? "cli"
      : {
          subagent: {
            thread_spawn: {
              parent_thread_id: options.parentId,
              depth: 1,
              agent_role: options.agentRole ?? "worker",
            },
          },
        };
  const records: object[] = [
    line(
      "session_meta",
      {
        id: options.id,
        cwd: "/workspace",
        source,
        thread_source: options.parentId === undefined ? "user" : "subagent",
        parent_thread_id: options.parentId,
      },
      0,
    ),
    line("turn_context", { model: options.model ?? "gpt-test" }, 1),
    line(
      "response_item",
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.padding ?? "task" }],
      },
      2,
    ),
  ];
  if (options.spawnId !== undefined || options.failedSpawn === true) {
    records.push(
      line(
        "response_item",
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "delegating" }],
        },
        3,
      ),
    );
    if (options.liveSpawn === true) {
      records.push(
        line(
          "response_item",
          {
            type: "function_call",
            name: "spawn_agent",
            arguments: JSON.stringify({
              task_name: "/root/review",
              fork_turns: "all",
              message: "review",
            }),
            call_id: "spawn-1",
          },
          4,
        ),
        line(
          "event_msg",
          {
            type: "sub_agent_activity",
            event_id: "spawn-1",
            ...(options.malformedLiveActivity === true
              ? {}
              : { agent_thread_id: options.spawnId }),
            kind: "started",
          },
          5,
        ),
        line(
          "response_item",
          {
            type: "function_call_output",
            call_id: "spawn-1",
            output: JSON.stringify({ task_name: "/root/review" }),
          },
          6,
        ),
      );
    } else {
      records.push(
        line(
          "response_item",
          {
            type: "custom_tool_call",
            name: "spawn_agent",
            input: "{}",
            call_id: "spawn-1",
          },
          4,
        ),
        line(
          "response_item",
          {
            type: "custom_tool_call_output",
            call_id: "spawn-1",
            output:
              options.failedSpawn === true
                ? JSON.stringify({
                    output: "failed: capacity limit exceeded",
                    metadata: { exit_code: 1 },
                  })
                : JSON.stringify({
                    output: JSON.stringify(
                      options.spawnOutput ?? { agent_id: options.spawnId },
                    ),
                    metadata: { exit_code: 0 },
                  }),
          },
          5,
        ),
      );
    }
  }
  if (options.tokens !== undefined) {
    records.push(
      line(
        "event_msg",
        {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: options.tokens.input,
              output_tokens: options.tokens.output,
              cached_input_tokens: options.tokens.cached,
              reasoning_output_tokens: options.tokens.reasoning,
            },
          },
        },
        6,
      ),
    );
  }
  const path = join(options.day, `rollout-${options.name}.jsonl`);
  writeFileSync(
    path,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  return path;
}

function canonicalSession(options: {
  id: string;
  parentId?: string;
  raw?: string[];
  inputTokens?: number;
  cacheCreationTokens?: number;
}): Session {
  return {
    schemaVersion: 1,
    id: `cx--${options.id}`,
    cli: "codex",
    externalId: options.id,
    ...(options.parentId === undefined
      ? {}
      : { parentSessionId: `cx--${options.parentId}` }),
    transcript: {
      schemaVersion: 1,
      messages: [{ turn: 1, role: "user", text: "task", toolCalls: [] }],
      contentHash: `hash-${options.id}`,
      ...(options.inputTokens === undefined
        ? {}
        : { inputTokens: options.inputTokens }),
      ...(options.cacheCreationTokens === undefined
        ? {}
        : { cacheCreationTokens: options.cacheCreationTokens }),
      rawEvents: (options.raw ?? [JSON.stringify({ id: options.id })]).map(
        (rawJson, seq) => ({ seq, rawJson }),
      ),
    },
  };
}

function addCanonicalSpawn(
  parent: Session,
  childId: string,
  callId: string,
): void {
  const message = parent.transcript.messages[0];
  if (message === undefined) throw new Error("test session has no message");
  message.toolCalls.push({
    name: "spawn_agent",
    argsHash: `args-${callId}`,
    argsPreview: "{}",
    outputPreview: JSON.stringify({ agent_id: childId }),
    outputFull: JSON.stringify({ agent_id: childId }),
    exitCode: 0,
    callId,
  });
}

function sourceMember(session: Session, content?: string) {
  return {
    session,
    content:
      content ??
      `${(session.transcript.rawEvents ?? [])
        .map((event) => event.rawJson)
        .join("\n")}${
        (session.transcript.rawEvents?.length ?? 0) === 0 ? "" : "\n"
      }`,
  };
}

describe("Codex rollout-family collection", () => {
  it("collects the exact root and every transitive child in deterministic order", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({
      day,
      name: "root",
      id: "root",
      spawnId: "child",
    });
    writeRollout({
      day,
      name: "nested",
      id: "nested",
      parentId: "child",
    });
    writeRollout({ day, name: "other", id: "other" });
    writeRollout({
      day,
      name: "child",
      id: "child",
      parentId: "root",
      spawnId: "nested",
    });

    const family = await collectCodexRolloutFamily({
      rootPath,
      rootSessionId: "cx--root",
      captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
    });

    expect(family.members.map((member) => member.session.id)).toEqual([
      "cx--root",
      "cx--child",
      "cx--nested",
    ]);
    expect(family.members.map((member) => member.sourcePath)).not.toContain(
      join(day, "rollout-other.jsonl"),
    );
    expect(family.totalBytes).toBeGreaterThan(0);
  });

  it("does not let a large unrelated rollout consume the selected-family byte limit", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({ day, name: "root", id: "root" });
    writeRollout({
      day,
      name: "other",
      id: "other",
      padding: "x".repeat(4_000),
    });
    const rootBytes = Buffer.byteLength(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(rootPath),
      ),
    );

    const family = await collectCodexRolloutFamily({
      rootPath,
      rootSessionId: "cx--root",
      captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      limits: { maxFileBytes: rootBytes + 1, maxTotalBytes: rootBytes + 1 },
    });

    expect(family.members).toHaveLength(1);
  });

  it("fails closed when a successful spawn has no captured child", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({
      day,
      name: "root",
      id: "root",
      spawnId: "missing-child",
    });

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_FAMILY_INCOMPLETE",
    });
  });

  it("fails closed when child metadata has no matching successful parent spawn", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({ day, name: "root", id: "root" });
    writeRollout({
      day,
      name: "unclaimed",
      id: "unclaimed",
      parentId: "root",
    });

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toThrow("has no successful spawn_agent claim");
  });

  it("accepts successful children and ignores an explicitly failed spawn", async () => {
    const successful = createStore();
    const rootPath = writeRollout({
      day: successful.day,
      name: "root",
      id: "root",
      spawnId: "guardian",
    });
    writeRollout({
      day: successful.day,
      name: "guardian",
      id: "guardian",
      parentId: "root",
      agentRole: "guardian",
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      members: [
        { session: { id: "cx--root" } },
        { session: { id: "cx--guardian", agentType: "guardian" } },
      ],
    });

    const failed = createStore();
    const failedRoot = writeRollout({
      day: failed.day,
      name: "root",
      id: "root",
      failedSpawn: true,
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath: failedRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ members: [{ session: { id: "cx--root" } }] });
  });

  it("links the live Codex function-call spawn through started sub-agent activity", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({
      day,
      name: "root",
      id: "root",
      spawnId: "live-child",
      liveSpawn: true,
    });
    writeRollout({
      day,
      name: "live-child",
      id: "live-child",
      parentId: "root",
    });

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      members: [
        { session: { id: "cx--root" } },
        { session: { id: "cx--live-child", parentSessionId: "cx--root" } },
      ],
    });
  });

  it("rejects malformed live Codex started sub-agent activity", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({
      day,
      name: "root",
      id: "root",
      spawnId: "live-child",
      liveSpawn: true,
      malformedLiveActivity: true,
    });

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toThrow("malformed started sub_agent_activity");
  });

  it("requires an exact direct-child agent id from each successful spawn", async () => {
    const unrelatedId = createStore();
    const unrelatedRoot = writeRollout({
      day: unrelatedId.day,
      name: "root",
      id: "root",
      spawnId: "ignored",
      spawnOutput: { session_id: "root" },
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath: unrelatedRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FAMILY_INCOMPLETE" });

    const wrongParent = createStore();
    const wrongParentRoot = writeRollout({
      day: wrongParent.day,
      name: "root",
      id: "root",
      spawnId: "grandchild",
    });
    writeRollout({
      day: wrongParent.day,
      name: "child",
      id: "child",
      parentId: "root",
    });
    writeRollout({
      day: wrongParent.day,
      name: "grandchild",
      id: "grandchild",
      parentId: "child",
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath: wrongParentRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toThrow("direct parent");
  });

  it("rejects malformed spawn records instead of dropping their parse issues", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({
      day,
      name: "root",
      id: "root",
      spawnId: "missing-output",
    });
    const records = readFileSync(rootPath, "utf8")
      .trimEnd()
      .split("\n")
      .filter((record) => {
        const parsed = JSON.parse(record) as { payload?: { type?: string } };
        return parsed.payload?.type !== "custom_tool_call_output";
      });
    writeFileSync(rootPath, `${records.join("\n")}\n`);

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toThrow("no terminal output");
  });

  it("fails closed when a truncated spawn record could hide family lineage", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({ day, name: "root", id: "root" });
    const content = readFileSync(rootPath, "utf8");
    writeFileSync(
      rootPath,
      `${content}{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent"\n`,
    );

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "LOSSLESS_SOURCE_INVALID",
      message: expect.stringContaining("complete family membership"),
    });
  });

  it("fails closed when a selected child rollout contains malformed JSONL", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({
      day,
      name: "root",
      id: "root",
      spawnId: "child",
    });
    const childPath = writeRollout({
      day,
      name: "child",
      id: "child",
      parentId: "root",
    });
    const content = readFileSync(childPath, "utf8");
    writeFileSync(childPath, `${content}not-json\n`);

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "LOSSLESS_SOURCE_INVALID" });
  });

  it("fails closed on malformed known Codex records", async () => {
    const { day } = createStore();
    const rootPath = writeRollout({ day, name: "root", id: "root" });
    const content = readFileSync(rootPath, "utf8");
    writeFileSync(
      rootPath,
      `${content}${JSON.stringify(
        line(
          "response_item",
          { type: "function_call", name: "unrelated-tool" },
          8,
        ),
      )}\n`,
    );

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "LOSSLESS_SOURCE_INVALID" });
  });

  it("rejects orphan, reordered, and failed live child-start evidence", async () => {
    const orphan = createStore();
    const orphanRoot = writeRollout({
      day: orphan.day,
      name: "root",
      id: "root",
    });
    const orphanRecords = readFileSync(orphanRoot, "utf8")
      .trimEnd()
      .split("\n");
    orphanRecords.push(
      JSON.stringify(
        line(
          "event_msg",
          {
            type: "sub_agent_activity",
            event_id: "missing-call",
            agent_thread_id: "child",
            kind: "started",
          },
          7,
        ),
      ),
    );
    writeFileSync(orphanRoot, `${orphanRecords.join("\n")}\n`);
    await expect(
      collectCodexRolloutFamily({
        rootPath: orphanRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toThrow("unknown spawn_agent call");

    const reordered = createStore();
    const reorderedRoot = writeRollout({
      day: reordered.day,
      name: "root",
      id: "root",
      spawnId: "child",
      liveSpawn: true,
    });
    const reorderedRecords = readFileSync(reorderedRoot, "utf8")
      .trimEnd()
      .split("\n");
    [reorderedRecords[4], reorderedRecords[5]] = [
      reorderedRecords[5] ?? "",
      reorderedRecords[4] ?? "",
    ];
    writeFileSync(reorderedRoot, `${reorderedRecords.join("\n")}\n`);
    await expect(
      collectCodexRolloutFamily({
        rootPath: reorderedRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toThrow("before its call");

    const failed = createStore();
    const failedRoot = writeRollout({
      day: failed.day,
      name: "root",
      id: "root",
      spawnId: "child",
      liveSpawn: true,
    });
    const failedRecords = readFileSync(failedRoot, "utf8")
      .trimEnd()
      .split("\n")
      .map((record) => {
        const parsed = JSON.parse(record) as {
          payload?: { type?: string; output?: unknown };
        };
        if (parsed.payload?.type === "function_call_output") {
          parsed.payload.output = JSON.stringify({
            output: "failed: unavailable",
            metadata: { exit_code: 1 },
          });
        }
        return JSON.stringify(parsed);
      });
    writeFileSync(failedRoot, `${failedRecords.join("\n")}\n`);
    await expect(
      collectCodexRolloutFamily({
        rootPath: failedRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toThrow("observed child");
  });

  it("rejects duplicate identities, a parented root, and selected-family overflow", async () => {
    const duplicate = createStore();
    const duplicateRoot = writeRollout({
      day: duplicate.day,
      name: "root-a",
      id: "root",
    });
    writeRollout({ day: duplicate.day, name: "root-b", id: "root" });
    await expect(
      collectCodexRolloutFamily({
        rootPath: duplicateRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "LOSSLESS_SOURCE_INVALID" });

    const cycle = createStore();
    const parentedRoot = writeRollout({
      day: cycle.day,
      name: "root",
      id: "root",
      parentId: "child",
    });
    writeRollout({
      day: cycle.day,
      name: "child",
      id: "child",
      parentId: "root",
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath: parentedRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "LOSSLESS_SOURCE_INVALID" });

    const oversized = createStore();
    const oversizedRoot = writeRollout({
      day: oversized.day,
      name: "root",
      id: "root",
      spawnId: "child",
    });
    const childPath = writeRollout({
      day: oversized.day,
      name: "child",
      id: "child",
      parentId: "root",
    });
    const selectedBytes =
      Buffer.byteLength(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(oversizedRoot),
        ),
      ) +
      Buffer.byteLength(
        await import("node:fs/promises").then(({ readFile }) =>
          readFile(childPath),
        ),
      );
    await expect(
      collectCodexRolloutFamily({
        rootPath: oversizedRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
        limits: { maxTotalBytes: selectedBytes - 1 },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FAMILY_LIMIT_EXCEEDED" });
  });

  it("rejects an exact root mismatch, malformed root, and selected file overflow", async () => {
    const first = createStore();
    const wrongRoot = writeRollout({
      day: first.day,
      name: "root",
      id: "other",
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath: wrongRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FAMILY_INCOMPLETE" });

    const second = createStore();
    const malformedRoot = join(second.day, "rollout-root.jsonl");
    writeFileSync(malformedRoot, "not-json\n");
    await expect(
      collectCodexRolloutFamily({
        rootPath: malformedRoot,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FAMILY_INCOMPLETE" });

    const third = createStore();
    const oversized = writeRollout({
      day: third.day,
      name: "root",
      id: "root",
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath: oversized,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
        limits: { maxFileBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FAMILY_LIMIT_EXCEEDED" });
  });

  it("enforces bounded day and directory discovery", async () => {
    const { directory, day } = createStore();
    const rootPath = writeRollout({ day, name: "root", id: "root" });
    mkdirSync(join(directory, "sessions", "2026", "08", "01"), {
      recursive: true,
    });
    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-08-01T01:00:00.000Z"),
        limits: { maxDays: 1 },
      }),
    ).rejects.toMatchObject({ code: "SOURCE_FAMILY_LIMIT_EXCEEDED" });

    await expect(
      collectCodexRolloutFamily({
        rootPath,
        rootSessionId: "cx--root",
        captureEndedAtMs: Date.parse("2026-07-31T23:00:00.000Z"),
        limits: { maxDirectoryEntries: 1 },
      }),
    ).resolves.toMatchObject({ inspectedEntries: 1 });
  });
});

describe("Codex source materialization plans", () => {
  it("preserves each native JSONL order and reports partial token coverage", () => {
    const root = canonicalSession({
      id: "root",
      raw: [
        '{"type":"future_record","value":1}',
        '{"type":"future_record","value":2}',
      ],
      inputTokens: 11,
      cacheCreationTokens: 7,
    });
    const child = canonicalSession({ id: "child", parentId: "root" });
    addCanonicalSpawn(root, "child", "spawn-child");

    const exactRootContent =
      '{"type":"future_record","value":1}\n\n{"type":"future_record","value":2}';
    const plan = createCodexSessionSourcePlan({
      rootSessionId: root.id,
      members: [sourceMember(child), sourceMember(root, exactRootContent)],
    });

    expect(plan.format).toBe("jsonl-tree");
    expect(plan.members.map((member) => member.sessionId)).toEqual([
      "cx--root",
      "cx--child",
    ]);
    expect(plan.members[0]?.content).toBe(exactRootContent);
    expect(plan.tokenUsage.inputTokens).toEqual({
      reported: 11,
      missingSessionIds: ["cx--child"],
    });
    expect(plan.tokenUsage.outputTokens).toEqual({
      reported: 0,
      missingSessionIds: ["cx--root", "cx--child"],
    });
    expect(plan.tokenUsage.cacheCreationTokens).toEqual({
      reported: 7,
      missingSessionIds: ["cx--child"],
    });
  });

  it("rejects missing, unordered, foreign, and outside-family sources", () => {
    expect(() =>
      createCodexSessionSourcePlan({
        rootSessionId: "cx--root",
        members: [sourceMember(canonicalSession({ id: "root", raw: [] }))],
      }),
    ).toThrow(SessionSourceMaterializationError);

    const unordered = canonicalSession({ id: "root" });
    unordered.transcript.rawEvents = [
      { seq: 2, rawJson: "{}" },
      { seq: 1, rawJson: "{}" },
    ];
    expect(() =>
      createCodexSessionSourcePlan({
        rootSessionId: unordered.id,
        members: [sourceMember(unordered)],
      }),
    ).toThrow("unordered raw events");

    const foreign = {
      ...canonicalSession({ id: "root" }),
      cli: "goose",
    } as Session;
    expect(() =>
      createCodexSessionSourcePlan({
        rootSessionId: "cx--root",
        members: [sourceMember(foreign)],
      }),
    ).toThrow("at least one Codex session");

    expect(() =>
      createCodexSessionSourcePlan({
        rootSessionId: "cx--root",
        members: [
          sourceMember(canonicalSession({ id: "root" })),
          sourceMember(canonicalSession({ id: "other" })),
        ],
      }),
    ).toThrow("outside the bound root family");
  });

  it("rejects malformed JSONL and malformed known records at the planning boundary", () => {
    for (const rawJson of [
      "not-json",
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", name: "unrelated-tool" },
      }),
    ]) {
      const root = canonicalSession({ id: "root", raw: [rawJson] });
      expect(() =>
        createCodexSessionSourcePlan({
          rootSessionId: root.id,
          members: [sourceMember(root)],
        }),
      ).toThrow("parser issue");
    }
  });

  it("does not let failure words override an authoritative spawned child id", () => {
    const root = canonicalSession({ id: "root" });
    addCanonicalSpawn(root, "child", "spawn-child");
    const call = root.transcript.messages[0]?.toolCalls[0];
    if (call === undefined) throw new Error("test session has no spawn call");
    call.outputFull = JSON.stringify({
      agent_id: "child",
      note: "capacity available",
    });

    expect(() =>
      createCodexSessionSourcePlan({
        rootSessionId: root.id,
        members: [sourceMember(root)],
      }),
    ).toThrow("spawned by cx--root is missing");
  });

  it("requires a child identity for an explicit successful exit", () => {
    const root = canonicalSession({ id: "root" });
    const message = root.transcript.messages[0];
    if (message === undefined) throw new Error("test session has no message");
    message.toolCalls.push({
      name: "spawn_agent",
      argsHash: "args-spawn-child",
      argsPreview: "{}",
      outputPreview: '{"note":"capacity available"}',
      outputFull: '{"note":"capacity available"}',
      exitCode: 0,
      callId: "spawn-child",
    });

    expect(() =>
      createCodexSessionSourcePlan({
        rootSessionId: root.id,
        members: [sourceMember(root)],
      }),
    ).toThrow("without exactly one child agent id");
  });

  it("rejects duplicate spawn claims for one child", () => {
    const root = canonicalSession({ id: "root" });
    const message = root.transcript.messages[0];
    if (message === undefined) throw new Error("test session has no message");
    message.toolCalls = ["one", "two"].map((callId) => ({
      name: "spawn_agent",
      argsHash: `args-${callId}`,
      argsPreview: "{}",
      outputPreview: '{"agent_id":"child"}',
      outputFull: '{"agent_id":"child"}',
      exitCode: 0,
      callId,
    }));
    const child = canonicalSession({ id: "child", parentId: "root" });

    expect(() =>
      createCodexSessionSourcePlan({
        rootSessionId: root.id,
        members: [sourceMember(root), sourceMember(child)],
      }),
    ).toThrow("claimed by multiple");
  });
});
