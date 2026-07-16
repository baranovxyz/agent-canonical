/**
 * Tests for the Claude Code workflow manifest/journal decoders.
 *
 * Coverage:
 *  - Manifest decode: runId, rollups, ordered phases, per-agent progress rows.
 *  - Resilience: missing runId fails; a malformed workflow_agent entry is
 *    skipped with a warning; an unexpected field type coerces to undefined
 *    rather than dropping the whole run.
 *  - Journal decode: result events carry the full value; malformed lines warn.
 */

import { describe, expect, it } from "vitest";
import {
  decodeWorkflowJournal,
  decodeWorkflowManifest,
} from "../../src/parsers/claude-code/index.js";
import { IssueCollector } from "../../src/parsers/types.js";

function manifestFixture(): Record<string, unknown> {
  return {
    runId: "wf_abc",
    workflowName: "demo",
    status: "completed",
    agentCount: 1,
    totalTokens: 1234,
    totalToolCalls: 7,
    durationMs: 42_000,
    startTime: 1_784_050_973_990,
    summary: "ran",
    scriptPath: "/x/demo.js",
    phases: [
      { title: "Sweep", detail: "parallel" },
      { title: "Verify", detail: "adversarial" },
    ],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "Sweep" },
      {
        type: "workflow_agent",
        agentId: "a1",
        label: "sweep:x",
        phaseIndex: 1,
        phaseTitle: "Sweep",
        model: "claude-fable-5",
        state: "done",
        attempt: 1,
        tokens: 400,
        toolCalls: 3,
        durationMs: 30_000,
        startedAt: 1_784_050_973_990,
        resultPreview: '{"x":1}',
      },
    ],
  };
}

describe("decodeWorkflowManifest", () => {
  it("decodes rollups, ordered phases, and per-agent progress", () => {
    const res = decodeWorkflowManifest(manifestFixture(), new IssueCollector());
    expect(res.success).toBe(true);
    if (!res.success) return;
    const m = res.data;
    expect(m.runId).toBe("wf_abc");
    expect(m.workflowName).toBe("demo");
    expect(m.totalTokens).toBe(1234);
    expect(m.startedAtMs).toBe(1_784_050_973_990);
    expect(m.phases).toEqual([
      { index: 1, title: "Sweep", detail: "parallel" },
      { index: 2, title: "Verify", detail: "adversarial" },
    ]);
    expect(m.agents).toHaveLength(1);
    expect(m.agents[0]).toMatchObject({
      agentId: "a1",
      phaseIndex: 1,
      tokens: 400,
      resultPreview: '{"x":1}',
    });
  });

  it("fails when runId is missing", () => {
    const res = decodeWorkflowManifest(
      { workflowName: "x" },
      new IssueCollector(),
    );
    expect(res.success).toBe(false);
  });

  it("skips a malformed workflow_agent entry but keeps the run", () => {
    const bad = manifestFixture();
    (bad.workflowProgress as unknown[]).push({ type: "workflow_agent" }); // no agentId
    const issues = new IssueCollector();
    const res = decodeWorkflowManifest(bad, issues);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.agents).toHaveLength(1); // only the valid one
    expect(res.issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("coerces an unexpected field type to undefined instead of failing", () => {
    const weird = manifestFixture();
    weird.totalTokens = "not-a-number";
    const res = decodeWorkflowManifest(weird, new IssueCollector());
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.totalTokens).toBeUndefined();
    expect(res.data.runId).toBe("wf_abc");
  });
});

describe("decodeWorkflowJournal", () => {
  it("decodes result events with their full value and warns on malformed lines", () => {
    const lines = [
      JSON.stringify({ type: "started", agentId: "a1", key: "v2:a1" }),
      JSON.stringify({
        type: "result",
        agentId: "a1",
        key: "v2:a1",
        result: { x: 1, note: "full" },
      }),
      "{ not json",
    ];
    const issues = new IssueCollector();
    const res = decodeWorkflowJournal(lines, issues);
    expect(res.success).toBe(true);
    if (!res.success) return;
    const result = res.data.find((e) => e.type === "result");
    expect(result?.agentId).toBe("a1");
    expect(result?.result).toMatchObject({ x: 1, note: "full" });
    expect(res.issues.some((i) => i.severity === "warning")).toBe(true);
  });
});
