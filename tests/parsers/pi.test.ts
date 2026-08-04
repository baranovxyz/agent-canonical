/**
 * Pi parser tests — driven by a sanitized, capture-derived Pi 0.83.0 fixture
 * (append-only session JSONL, store `version` 3).
 *
 * `capture-derived.json` holds two sessions, each an ordered `entries` array the
 * test materializes to `<tmp>/<cwdSlug>/<ISO-timestamp>_<sessionId>.jsonl`:
 *   - pi_fixture_1: a plain reasoning turn, a `write` + `bash` tool round, a
 *     mid-session `model_change`, an in-place branch (a second child of the
 *     same parent entry), a `bashExecution` (`!cmd`) shell escape, and a closing
 *     `session_info` — exercising the thinking split, cross-record tool
 *     correlation by `toolCallId`, per-message usage summing, file-order DAG
 *     traversal, and the title source.
 *   - pi_fixture_2: an errored turn (`stopReason:"error"`, empty content,
 *     zeroed usage, an `errorMessage`).
 * Paths, session ids, entry ids, tool-call ids, response ids, models, providers,
 * and timestamps are deterministic placeholders; entry structure (including
 * entry-level ISO vs message-level Unix-ms timestamps), token numbers, message
 * content, and tool outputs are preserved.
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
import { parseSessionFile } from "../../src/parsers/pi/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/pi/capture-derived.json");

const CaptureSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      cwdSlug: z.string(),
      fileName: z.string(),
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
  const root = mkdtempSync(join(tmpdir(), "pi-parser-test-"));
  tempDirs.push(root);
  return root;
}

/** Materialize a fixture session as `<tmp>/<cwdSlug>/<fileName>`. */
function materialize(index: number): string {
  const s = capture.sessions[index];
  if (!s) throw new Error(`no fixture session ${index}`);
  const dir = join(tempRoot(), s.cwdSlug);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, s.fileName);
  writeFileSync(filePath, s.entries.map((e) => JSON.stringify(e)).join("\n"));
  return filePath;
}

/** Write arbitrary JSONL lines to a throwaway session file. */
function writeLines(fileName: string, lines: string[]): string {
  const dir = join(tempRoot(), "--home-u-project--");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, fileName);
  writeFileSync(filePath, lines.join("\n"));
  return filePath;
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------
// pi_fixture_1 — tools, thinking, a model change, a branch, and a shell escape
// ---------------------------------------------------------------------------

describe("pi parser — capture-derived fixture", () => {
  it("stamps pi identity and metadata from the header and session_info", async () => {
    const r = await parseSessionFile(materialize(0));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("pi--pi_fixture_1");
    expect(s.cli).toBe("pi");
    expect(s.externalId).toBe("pi_fixture_1");
    // The header line is the only source of the project path.
    expect(s.projectPath).toBe("/home/u/project");
    // `session_info.name` is the only title source Pi persists.
    expect(s.title).toBe("pi-session-demo");
    // Last model observed on an assistant message wins; the mid-session
    // model_change to model-placeholder-2 was left behind on the abandoned
    // branch.
    expect(s.model).toBe("model-placeholder");
    // A quiet tail is not completion: Pi files are append-only and --continue
    // reopens them, so only an errored last turn sets a status.
    expect(s.status).toBeUndefined();
    expect(s.startedAt).toBe(sec("2026-01-01T00:00:00.000Z"));
    expect(s.endedAt).toBe(sec("2026-01-01T00:11:05.284Z"));
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("splits thinking blocks into their own messages in stream order", async () => {
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
      "thinking",
      "assistant",
      "assistant",
      "user",
      "thinking",
      "assistant",
      "user",
      "thinking",
      "assistant",
      "user",
    ]);
    expect(msgs[1]?.text).toContain("Just answer");
    expect(msgs[2]?.text).toBe("The capital of Iceland is Reykjavík.");
    // Thinking is excluded from the assistant text it preceded.
    expect(msgs[2]?.text).not.toContain("Just answer");
    // A tool-issuing assistant message carries the call with empty text.
    expect(msgs[5]?.text).toBe("");
    expect(msgs[5]?.toolCalls).toHaveLength(1);
  });

  it("correlates each toolCall block with its separate toolResult entry", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls.map((c) => c.name)).toEqual(["write", "bash", "pi_bash"]);

    const write = calls[0];
    expect(write?.callId).toBe("call_fixture_1");
    expect(write?.exitCode).toBe(0);
    expect(write?.outputFull).toBe("Successfully wrote 2 bytes to hello.txt");
    // `arguments` is already an object in the store — never a JSON string.
    const writeArgs = z
      .object({ path: z.string(), content: z.string() })
      .safeParse(write?.args);
    expect(writeArgs.success).toBe(true);
    expect(writeArgs.data?.path).toBe("hello.txt");

    const bash = calls[1];
    expect(bash?.callId).toBe("call_fixture_2");
    expect(bash?.exitCode).toBe(0);
    expect(bash?.outputFull).toContain("hello.txt");
    expect(bash?.outputBytes).toBe(
      Buffer.byteLength(bash?.outputFull ?? "", "utf8"),
    );
  });

  it("encodes a bashExecution shell escape as a user turn with a pi_bash call", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const last = r.data.transcript.messages.at(-1);
    // The `!cmd` escape is the user's action, not the model's: the message text
    // is what they typed and the captured run becomes a synthetic tool call.
    expect(last?.role).toBe("user");
    expect(last?.text).toBe("!echo hello-from-pi-bash");
    const call = last?.toolCalls[0];
    expect(call?.name).toBe("pi_bash");
    expect(call?.callId).toBe("a1000010");
    expect(call?.exitCode).toBe(0);
    expect(call?.outputFull).toBe("hello-from-pi-bash\n");
    const args = z.object({ command: z.string() }).safeParse(call?.args);
    expect(args.success).toBe(true);
    expect(args.data?.command).toBe("echo hello-from-pi-bash");
  });

  it("sums per-message usage into transcript totals", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    // Six assistant messages: 1099+1136+1216+1398+2220+1099 in, 44+59+31+158+92+35 out.
    expect(t.inputTokens).toBe(8168);
    expect(t.outputTokens).toBe(419);
    expect(t.reasoningTokens).toBe(129);
    // Zero cache totals are omitted, not written as 0.
    expect(t.cacheReadTokens).toBeUndefined();
    expect(t.cacheCreationTokens).toBeUndefined();

    const withUsage = t.messages.filter((m) => m.usage !== undefined);
    expect(withUsage.every((m) => m.role === "assistant")).toBe(true);
    expect(withUsage.map((m) => m.usage?.outputTokens)).toEqual([
      44, 59, 31, 158, 92, 35,
    ]);
    expect(withUsage[0]?.usage?.reasoningTokens).toBe(27);
  });

  it("keeps Pi's per-message cost object in rawEvents (no canonical field)", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const raw = r.data.transcript.rawEvents ?? [];
    const assistantLine = raw.find((e) => e.eventType === "message:assistant");
    const CostSchema = z.object({
      message: z.object({
        usage: z.object({
          totalTokens: z.number(),
          cost: z.object({ total: z.number() }),
        }),
      }),
    });
    const parsed = CostSchema.safeParse(
      JSON.parse(assistantLine?.rawJson ?? "{}"),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.message.usage.totalTokens).toBe(1143);
    expect(parsed.data?.message.usage.cost.total).toBe(0);
  });

  it("keeps both branches of the entry DAG, in file order", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const msgs = r.data.transcript.messages;
    // a1000003 (Iceland) and a100000e (Norway) are both children of a1000002:
    // Pi's own reader would show only the leaf's path, but a corpus records
    // every turn that was actually spent, abandoned branch included.
    expect(msgs[0]?.text).toBe(
      "In one sentence: what is the capital of Iceland?",
    );
    expect(msgs[12]?.text).toBe(
      "In one sentence: what is the capital of Norway?",
    );
    expect(msgs[11]?.text).toBe("15:55");

    const ParentSchema = z.object({
      id: z.string(),
      parentId: z.string().nullable(),
    });
    const children = (r.data.transcript.rawEvents ?? [])
      .map((e) => ParentSchema.safeParse(JSON.parse(e.rawJson)))
      .filter((p) => p.success && p.data.parentId === "a1000002")
      .map((p) => p.data?.id);
    expect(children).toEqual(["a1000003", "a100000e"]);
  });

  it("preserves every line losslessly in rawEvents, typed by entry and role", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const raw = r.data.transcript.rawEvents ?? [];
    expect(raw.length).toBe(capture.sessions[0]?.entries.length);
    expect(raw.length).toBe(18);
    expect(raw[0]?.eventType).toBe("session");
    expect(raw.map((e) => e.eventType)).toContain("model_change");
    expect(raw.map((e) => e.eventType)).toContain("thinking_level_change");
    expect(raw.map((e) => e.eventType)).toContain("message:toolResult");
    expect(raw.map((e) => e.eventType)).toContain("message:bashExecution");
    expect(raw.map((e) => e.eventType)).toContain("session_info");
  });
});

// ---------------------------------------------------------------------------
// pi_fixture_2 — an errored turn
// ---------------------------------------------------------------------------

describe("pi parser — errored turn", () => {
  it("keeps the errorMessage as a system message and fails the session", async () => {
    const r = await parseSessionFile(materialize(1));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("pi--pi_fixture_2");
    expect(s.status).toBe("failed");
    const msgs = s.transcript.messages;
    expect(msgs.map((m) => m.role)).toEqual(["user", "system"]);
    expect(msgs[1]?.text).toContain("Insufficient credits");
    // No session_info: the title falls back to the first non-thinking message.
    expect(s.title).toBe("In one sentence: what is the capital of Iceland?");
    expect(SessionSchema.safeParse(s).success).toBe(true);
  });

  it("omits token totals when the errored turn zeroed its usage", async () => {
    const r = await parseSessionFile(materialize(1));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    expect(t.inputTokens).toBeUndefined();
    expect(t.outputTokens).toBeUndefined();
    expect(t.rawEvents?.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("pi parser — edges", () => {
  it("fails cleanly for a missing session file", async () => {
    const r = await parseSessionFile("/nonexistent/2026_pi_missing.jsonl");
    expect(r.success).toBe(false);
  });

  it("skips malformed lines and unknown entry types, keeping them countable", async () => {
    const filePath = writeLines("2026-01-01T00-00-00-000Z_pi_synth.jsonl", [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "pi_synth",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/home/u/project",
      }),
      "{ this is not json",
      JSON.stringify({
        type: "label",
        id: "c0000001",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        targetId: "c0000000",
        label: "checkpoint",
      }),
      JSON.stringify({
        type: "message",
        id: "c0000002",
        parentId: "c0000001",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "user",
          content: "plain string content",
          timestamp: 1767225602000,
        },
      }),
      JSON.stringify({
        type: "compaction",
        id: "c0000003",
        parentId: "c0000002",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "Earlier turns were compacted.",
        firstKeptEntryId: "c0000002",
        tokensBefore: 4096,
      }),
    ]);
    const r = await parseSessionFile(filePath);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.id).toBe("pi--pi_synth");
    // A string `content` decodes like a single text block; a compaction summary
    // survives as a system message; `label` is inert.
    expect(r.data.transcript.messages.map((m) => m.text)).toEqual([
      "plain string content",
      "Earlier turns were compacted.",
    ]);
    expect(r.data.transcript.messages.map((m) => m.role)).toEqual([
      "user",
      "system",
    ]);
    expect(r.issues.some((i) => i.severity === "warning")).toBe(true);
    // The malformed line is not a raw event; the four decodable lines are.
    expect(r.data.transcript.rawEvents?.length).toBe(4);
  });

  it("falls back to the filename uuid when the header carries no id", async () => {
    const filePath = writeLines(
      "2026-01-01T00-00-00-000Z_pi_from_filename.jsonl",
      [
        JSON.stringify({
          type: "session",
          version: 3,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: "/home/u/project",
        }),
        JSON.stringify({
          type: "message",
          id: "d0000001",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1767225601000,
          },
        }),
      ],
    );
    const r = await parseSessionFile(filePath);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.id).toBe("pi--pi_from_filename");
    expect(r.data.externalId).toBe("pi_from_filename");
  });
});
