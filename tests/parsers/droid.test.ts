/**
 * Factory Droid parser tests — driven by a sanitized, capture-derived Droid
 * 0.187.0 fixture (`session_start.version` 2).
 *
 * `capture-derived.json` holds two sessions, each an ordered `entries` array
 * plus its sibling `settings` object. The test materializes them as the on-disk
 * pair `<tmp>/<cwdSlug>/<sessionId>.jsonl` + `<sessionId>.settings.json`:
 *   - droid_fixture_1: a plain reasoning turn, a `Create` tool round, an
 *     `Execute` tool round, and a max-reasoning turn — four turns, each closed
 *     by a `completed` agent_turn_outcome. Exercises the thinking split,
 *     cross-message tool correlation by `tool_use_id`, the dropped
 *     `visibility:"llm_only"` context bundle, and session-level token totals.
 *   - droid_fixture_2: a `visibility:"both"` config-error notice, then a turn
 *     that dies on a `visibility:"user_only"` provider error and closes with an
 *     `agent_turn_outcome` of `reason:"error"`.
 * Paths, owner, host id, session ids, message ids, response ids, tool-call ids,
 * the model alias, and timestamps are deterministic placeholders, and the
 * injected context bundle's prose is neutralized; line envelopes, block
 * structure, token numbers, tool outputs, and message content are preserved.
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
import { parseSessionFile } from "../../src/parsers/droid/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/droid/capture-derived.json");

const CaptureSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      cwdSlug: z.string(),
      fileName: z.string(),
      settings: z.record(z.string(), z.unknown()),
      entries: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});
const capture = CaptureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "droid-parser-test-"));
  tempDirs.push(root);
  return root;
}

/**
 * Materialize a fixture session as `<tmp>/<cwdSlug>/<sessionId>.jsonl` plus its
 * sibling settings file, and return the JSONL path. With `withSettings` false
 * only the JSONL is written (the settings file is absent).
 */
function materialize(index: number, withSettings = true): string {
  const s = capture.sessions[index];
  if (!s) throw new Error(`no fixture session ${index}`);
  const dir = join(tempRoot(), s.cwdSlug);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, s.fileName);
  writeFileSync(filePath, s.entries.map((e) => JSON.stringify(e)).join("\n"));
  if (withSettings) {
    writeFileSync(
      filePath.replace(/\.jsonl$/, ".settings.json"),
      JSON.stringify(s.settings),
    );
  }
  return filePath;
}

/** Write arbitrary JSONL lines (and optional settings) to a throwaway session. */
function writeSession(
  fileName: string,
  lines: string[],
  settings?: object,
): string {
  const dir = join(tempRoot(), "-home-u-project");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, lines.join("\n"));
  if (settings !== undefined) {
    writeFileSync(
      filePath.replace(/\.jsonl$/, ".settings.json"),
      JSON.stringify(settings),
    );
  }
  return filePath;
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------
// droid_fixture_1 — four completed turns, two tool rounds
// ---------------------------------------------------------------------------

describe("droid parser — capture-derived fixture", () => {
  it("stamps droid identity from session_start and the sibling settings", async () => {
    const r = await parseSessionFile(materialize(0));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("droid--droid_fixture_1");
    expect(s.cli).toBe("droid");
    expect(s.externalId).toBe("droid_fixture_1");
    expect(s.projectPath).toBe("/home/u/project");
    expect(s.title).toBe("In one short sentence, what is a JSONL file?");
    // `owner` is the only per-session author any dialect persists.
    expect(s.author).toBe("u");
    // The settings model is an alias, never an upstream slug — reported as-is.
    expect(s.model).toBe("custom:model-placeholder-0");
    // A completed turn ends a turn, not the session: the file is append-only
    // and resumable, so a `completed` tail sets no session status.
    expect(s.status).toBeUndefined();
    // session_start and agent_turn_outcome carry no timestamp, so the session
    // window is the message window.
    expect(s.startedAt).toBe(sec("2026-01-01T00:00:17.000Z"));
    expect(s.endedAt).toBe(sec("2026-01-01T00:03:24.000Z"));
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("splits thinking into its own message and drops the tool-result rows", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const msgs = r.data.transcript.messages;
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "user",
      "thinking",
      "assistant",
      "assistant",
      "user",
      "thinking",
      "assistant",
      "assistant",
      "user",
      "thinking",
      "assistant",
    ]);
    expect(msgs[1]?.text).toContain("informational");
    expect(msgs[2]?.text).toContain("JSON Lines");
    // Thinking is excluded from the assistant text it preceded.
    expect(msgs[2]?.text).not.toContain("informational");
    // A tool-issuing assistant message carries the call with empty text.
    expect(msgs[5]?.text).toBe("");
    expect(msgs[5]?.toolCalls).toHaveLength(1);
    expect(msgs.every((m) => m.usage === undefined)).toBe(true);
  });

  it("skips the llm_only context bundle but keeps it in rawEvents", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const texts = r.data.transcript.messages.map((m) => m.text);
    expect(texts.some((t) => t.includes("<system-reminder>"))).toBe(false);
    expect(texts.some((t) => t.includes("Available skills"))).toBe(false);

    const raw = r.data.transcript.rawEvents ?? [];
    const context = raw.find((e) => e.rawJson.includes("llm_only"));
    expect(context?.eventType).toBe("message:user");
    expect(context?.rawJson).toContain("Available skills");
    // The bundle renders git facts as prose; nothing mines prose for metadata,
    // so gitBranch stays unset even though the reminder names a branch.
    expect(context?.rawJson).toContain("## main");
    expect(r.data.gitBranch).toBeUndefined();
  });

  it("correlates each tool_use with its tool_result on a later user message", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls.map((c) => c.name)).toEqual(["Create", "Execute"]);

    const create = calls[0];
    expect(create?.callId).toBe("call_fixture_1");
    expect(create?.exitCode).toBe(0);
    expect(create?.outputFull).toContain('"success":true');
    const createArgs = z
      .object({ file_path: z.string(), content: z.string() })
      .safeParse(create?.args);
    expect(createArgs.success).toBe(true);
    expect(createArgs.data?.file_path).toBe("/home/u/project/hello.txt");

    const exec = calls[1];
    expect(exec?.callId).toBe("call_fixture_2");
    expect(exec?.exitCode).toBe(0);
    expect(exec?.outputFull).toContain("hello.txt");
    expect(exec?.outputBytes).toBe(
      Buffer.byteLength(exec?.outputFull ?? "", "utf8"),
    );
    const execArgs = z
      .object({ command: z.string(), riskLevel: z.string() })
      .safeParse(exec?.args);
    expect(execArgs.success).toBe(true);
    expect(execArgs.data?.command).toBe("ls -la");
  });

  it("takes session-level token totals from the sibling settings file", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    // Droid records no per-message usage; `tokenUsage` is the whole story.
    expect(t.inputTokens).toBe(13653);
    expect(t.outputTokens).toBe(591);
    expect(t.cacheReadTokens).toBe(66560);
    // Zero totals are omitted, not written as 0.
    expect(t.cacheCreationTokens).toBeUndefined();
    expect(t.reasoningTokens).toBeUndefined();
  });

  it("preserves every line losslessly in rawEvents, typed by envelope and role", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const raw = r.data.transcript.rawEvents ?? [];
    // rawEvents mirrors the JSONL one entry per line — the settings file is
    // read for session facts but is not a raw event.
    expect(raw.length).toBe(capture.sessions[0]?.entries.length);
    expect(raw.length).toBe(18);
    expect(raw[0]?.eventType).toBe("session_start");
    // The header carries no timestamp, so its raw event carries no ts.
    expect(raw[0]?.ts).toBeUndefined();
    const types = raw.map((e) => e.eventType);
    expect(types).toContain("message:user");
    expect(types).toContain("message:assistant");
    expect(types.filter((t) => t === "agent_turn_outcome")).toHaveLength(4);
    expect(raw.some((e) => e.rawJson.includes("tool_result"))).toBe(true);
  });

  it("parses without the sibling settings file, falling back to the message alias", async () => {
    const r = await parseSessionFile(materialize(0, false));
    expect(r.success).toBe(true);
    if (!r.success) return;
    // No settings file: the model alias comes from the first assistant
    // message's modelId, and there are no token totals anywhere.
    expect(r.data.model).toBe("custom:model-placeholder-0");
    expect(r.data.transcript.inputTokens).toBeUndefined();
    expect(r.data.transcript.outputTokens).toBeUndefined();
    expect(r.data.transcript.messages).toHaveLength(14);
  });
});

// ---------------------------------------------------------------------------
// droid_fixture_2 — a turn that ended in an error outcome
// ---------------------------------------------------------------------------

describe("droid parser — errored turn", () => {
  it("re-roles the user_only notice as system and fails the session", async () => {
    const r = await parseSessionFile(materialize(1));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("droid--droid_fixture_2");
    // The trailing agent_turn_outcome is reason:"error".
    expect(s.status).toBe("failed");
    const msgs = s.transcript.messages;
    // The `both`-visibility config error was in the model's context as a
    // user-role message and stays one; the `user_only` provider error was
    // rendered only to the human, so it lands as a system notice.
    expect(msgs.map((m) => m.role)).toEqual(["user", "user", "system"]);
    expect(msgs[0]?.text).toContain("appears to be a Claude/Anthropic model");
    expect(msgs[1]?.text).toBe("In one short sentence, what is a JSONL file?");
    expect(msgs[2]?.text).toContain("Insufficient credits");
    expect(SessionSchema.safeParse(s).success).toBe(true);
  });

  it("omits token totals when the failed session spent nothing", async () => {
    const r = await parseSessionFile(materialize(1));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    expect(t.inputTokens).toBeUndefined();
    expect(t.outputTokens).toBeUndefined();
    expect(t.cacheReadTokens).toBeUndefined();
    expect(t.rawEvents?.length).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("droid parser — edges", () => {
  it("fails cleanly for a missing session file", async () => {
    const r = await parseSessionFile("/nonexistent/droid_missing.jsonl");
    expect(r.success).toBe(false);
  });

  it("skips malformed lines and unknown envelopes, keeping them countable", async () => {
    const filePath = writeSession("droid_synth.jsonl", [
      JSON.stringify({
        type: "session_start",
        id: "droid_synth",
        title: "synthetic",
        owner: "u",
        version: 2,
        cwd: "/home/u/project",
        hostId: "host-fixture-1",
        isSessionTitleManuallySet: false,
      }),
      "{ this is not json",
      JSON.stringify({
        type: "some_future_line",
        id: "x1",
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: { role: "user", content: "plain string content" },
      }),
    ]);
    const r = await parseSessionFile(filePath);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.id).toBe("droid--droid_synth");
    // A string `content` decodes like a single text block.
    expect(r.data.transcript.messages.map((m) => m.text)).toEqual([
      "plain string content",
    ]);
    expect(r.issues.some((i) => i.severity === "warning")).toBe(true);
    // The malformed line is not a raw event; the three decodable lines are.
    expect(r.data.transcript.rawEvents?.length).toBe(3);
  });

  it("falls back to the filename uuid when session_start carries no id", async () => {
    const filePath = writeSession("droid_from_filename.jsonl", [
      JSON.stringify({ type: "session_start", owner: "u", version: 2 }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }] },
      }),
    ]);
    const r = await parseSessionFile(filePath);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.id).toBe("droid--droid_from_filename");
    expect(r.data.externalId).toBe("droid_from_filename");
    // No header title: the title falls back to the first non-thinking message.
    expect(r.data.title).toBe("hello");
  });

  it("maps a failed tool_result to a nonzero exit code", async () => {
    const filePath = writeSession("droid_tool_error.jsonl", [
      JSON.stringify({
        type: "session_start",
        id: "droid_tool_error",
        owner: "u",
        version: 2,
        cwd: "/home/u/project",
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "read it" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        timestamp: "2026-01-01T00:00:01.000Z",
        parentId: "m1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_fixture_9",
              name: "Read",
              input: { file_path: "/home/u/project/nope.txt" },
            },
          ],
          modelId: null,
        },
      }),
      JSON.stringify({
        type: "message",
        id: "m3",
        timestamp: "2026-01-01T00:00:02.000Z",
        parentId: "m2",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_fixture_9",
              is_error: true,
              content: "ENOENT: no such file",
            },
          ],
        },
      }),
    ]);
    const r = await parseSessionFile(filePath);
    if (!r.success) throw new Error("parse failed");
    const call = r.data.transcript.messages.flatMap((m) => m.toolCalls)[0];
    expect(call?.exitCode).toBe(1);
    expect(call?.outputFull).toBe("ENOENT: no such file");
    // A null `modelId` leaves the model unset — nothing is invented.
    expect(r.data.model).toBeUndefined();
  });

  it("totals this session's tokenUsage, not the child-inclusive rollup", async () => {
    const filePath = writeSession(
      "droid_parent.jsonl",
      [
        JSON.stringify({
          type: "session_start",
          id: "droid_parent",
          owner: "u",
          version: 2,
          cwd: "/home/u/project",
        }),
        JSON.stringify({
          type: "message",
          id: "m1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "go" }] },
        }),
      ],
      {
        model: "custom:model-placeholder-0",
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          thinkingTokens: 5,
          factoryCredits: 0,
        },
        inclusiveTokenUsage: {
          inputTokens: 900,
          outputTokens: 90,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          thinkingTokens: 45,
          factoryCredits: 0,
        },
        childInclusiveTokenUsageBySessionId: {
          droid_child: { inputTokens: 800, outputTokens: 80 },
        },
      },
    );
    const r = await parseSessionFile(filePath);
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    // Using inclusiveTokenUsage would double-count any child session the
    // corpus also ingests, so the session's own totals win.
    expect(t.inputTokens).toBe(100);
    expect(t.outputTokens).toBe(10);
    expect(t.reasoningTokens).toBe(5);
  });
});
