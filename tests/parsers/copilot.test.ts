/**
 * GitHub Copilot CLI parser tests — driven by a sanitized, capture-derived
 * Copilot 1.0.70 fixture (`events.jsonl` typed event stream).
 *
 * `capture-derived.json` holds two sessions, each as an ordered `events` array
 * the test materializes to `<tmp>/<sessionId>/events.jsonl`:
 *   - copilot_fixture_1: a plain text turn, a `bash` tool call, and a `create`
 *     tool call across three user turns — exercising cross-event tool
 *     correlation (`toolRequests` on an assistant.message paired with a later
 *     `tool.execution_complete` by `toolCallId`), the two-assistant-message
 *     tool round, per-message `outputTokens`, and the `session.shutdown`
 *     usage aggregate.
 *   - copilot_fixture_2: a reasoning-model turn carrying `reasoningText` and no
 *     `session.shutdown` — exercising the thinking split and the summed-output
 *     token fallback when the store wrote no shutdown event.
 * Paths, opaque ids, timestamps, models, and the 26KB system prompt are
 * deterministic placeholders; event shape, token numbers, and tool outputs are
 * preserved.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { parseSessionFile } from "../../src/parsers/copilot/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/copilot/capture-derived.json");

const CaptureSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      events: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});
const capture = CaptureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** Materialize a session's events as `<tmp>/<sessionId>/events.jsonl`. */
function materialize(index: number): string {
  const s = capture.sessions[index];
  if (!s) throw new Error(`no fixture session ${index}`);
  const root = mkdtempSync(join(tmpdir(), "copilot-parser-test-"));
  tempDirs.push(root);
  const dir = join(root, s.sessionId);
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, "events.jsonl");
  writeFileSync(eventsPath, s.events.map((e) => JSON.stringify(e)).join("\n"));
  return eventsPath;
}

// ---------------------------------------------------------------------------
// copilot_fixture_1 — text + bash + create, with a shutdown aggregate
// ---------------------------------------------------------------------------

describe("copilot parser — capture-derived fixture (tools)", () => {
  it("stamps copilot identity and session metadata from session.start + shutdown", async () => {
    const r = await parseSessionFile(materialize(0));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("copilot--copilot_fixture_1");
    expect(s.cli).toBe("copilot");
    expect(s.externalId).toBe("copilot_fixture_1");
    expect(s.projectPath).toBe("/home/u/copilot-cap");
    expect(s.gitBranch).toBe("master");
    expect(s.model).toBe("model-placeholder");
    expect(s.status).toBe("complete");
    expect(s.title).toBe(
      "Without using any tools, reply in exactly one short sentence: what is the capital of France?",
    );
    // Timestamps are epoch ms in the store; canonical timing is unix seconds.
    expect(s.startedAt).toBe(Date.parse("2026-01-01T00:00:00.000Z") / 1000);
    expect(s.endedAt).toBe(Date.parse("2026-01-01T00:00:27.000Z") / 1000);
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("folds the event stream into ordered user/assistant messages", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const msgs = r.data.transcript.messages;
    // Each tool round splits into two assistant messages (the tool-issuing one
    // with empty text, then the final answer). system.message is dropped.
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
    expect(msgs[0]?.text).toBe(
      "Without using any tools, reply in exactly one short sentence: what is the capital of France?",
    );
    expect(msgs[1]?.text).toBe("The capital of France is Paris.");
    expect(msgs.at(-1)?.text).toBe(
      'Created notes.txt with the line "captured-ok".',
    );
  });

  it("correlates each tool call with its later tool.execution_complete", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls.map((c) => c.name)).toEqual(["bash", "create"]);

    const bash = calls[0];
    expect(bash?.callId).toBe("bash_fixture_1");
    expect(bash?.exitCode).toBe(0);
    expect(bash?.outputFull).toContain("2 total");
    const bashArgs = z.object({ command: z.string() }).safeParse(bash?.args);
    expect(bashArgs.success).toBe(true);
    expect(bashArgs.data?.command).toBe("wc -l README.md app.js");

    const create = calls[1];
    expect(create?.callId).toBe("create_fixture_1");
    expect(create?.exitCode).toBe(0);
    const createArgs = z
      .object({ path: z.string(), file_text: z.string() })
      .safeParse(create?.args);
    expect(createArgs.success).toBe(true);
    expect(createArgs.data?.path).toBe("/home/u/copilot-cap/notes.txt");
  });

  it("takes transcript totals from the shutdown aggregate and per-message output tokens", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    // session.shutdown modelMetrics: input 73962, output 230 (= 10+86+31+88+15).
    expect(t.inputTokens).toBe(73962);
    expect(t.outputTokens).toBe(230);
    // Zero cache/reasoning totals are omitted, not written as 0.
    expect(t.cacheReadTokens).toBeUndefined();
    expect(t.reasoningTokens).toBeUndefined();
    // Per-message usage is output-only and lands on assistant messages.
    const withUsage = t.messages.filter((m) => m.usage !== undefined);
    expect(withUsage.every((m) => m.role === "assistant")).toBe(true);
    expect(withUsage.map((m) => m.usage?.outputTokens)).toEqual([
      10, 86, 31, 88, 15,
    ]);
  });

  it("preserves every event losslessly in rawEvents", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const raw = r.data.transcript.rawEvents ?? [];
    // One raw event per source line, including inert system/turn/tool events.
    expect(raw.length).toBe(28);
    expect(raw.some((e) => e.eventType === "session.shutdown")).toBe(true);
    expect(raw.some((e) => e.eventType === "system.message")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// copilot_fixture_2 — reasoning model, no shutdown event
// ---------------------------------------------------------------------------

describe("copilot parser — reasoning turn without a shutdown event", () => {
  it("splits reasoningText into a thinking message before the assistant reply", async () => {
    const r = await parseSessionFile(materialize(1));
    if (!r.success) throw new Error("parse failed");
    const msgs = r.data.transcript.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "thinking", "assistant"]);
    expect(msgs[1]?.text).toContain("Rayleigh scattering");
    expect(msgs[2]?.text).toContain("sky appears blue");
  });

  it("falls back to summed per-message output tokens when no shutdown was written", async () => {
    const r = await parseSessionFile(materialize(1));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    expect(t.outputTokens).toBe(369);
    expect(t.inputTokens).toBeUndefined();
    // No shutdown event means no session status.
    expect(r.data.status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("copilot parser — edges", () => {
  it("fails cleanly for a missing events file", async () => {
    const r = await parseSessionFile("/nonexistent/events.jsonl");
    expect(r.success).toBe(false);
  });

  it("skips malformed lines and still builds the session", async () => {
    const root = mkdtempSync(join(tmpdir(), "copilot-parser-test-"));
    tempDirs.push(root);
    const dir = join(root, "copilot_synth");
    mkdirSync(dir, { recursive: true });
    const eventsPath = join(dir, "events.jsonl");
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({
          type: "session.start",
          data: { sessionId: "copilot_synth" },
          timestamp: "2026-01-01T00:00:00.000Z",
        }),
        "{ this is not json",
        JSON.stringify({
          type: "user.message",
          data: { content: "hello" },
          timestamp: "2026-01-01T00:00:01.000Z",
        }),
        JSON.stringify({
          type: "assistant.message",
          data: { content: "hi there", model: "m", outputTokens: 3 },
          timestamp: "2026-01-01T00:00:02.000Z",
        }),
      ].join("\n"),
    );
    const r = await parseSessionFile(eventsPath);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.id).toBe("copilot--copilot_synth");
    expect(r.data.transcript.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(r.issues.some((i) => i.severity === "warning")).toBe(true);
  });
});
