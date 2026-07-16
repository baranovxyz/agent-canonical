/**
 * Cline parser tests — driven by a sanitized, capture-derived Cline 0.0.13
 * fixture (`messages-contract-v1`).
 *
 * `capture-derived.json` holds two sessions, each as its on-disk file pair
 * (`<id>.json` metadata + `<id>.messages.json` payload):
 *   - cline_fixture_1: a `thinking` block + a `read_files` tool call whose
 *     `tool_use` (assistant message) pairs with a `tool_result` (later user
 *     message), then the final reply — exercising cross-message tool
 *     correlation, the array-form `tool_result.content`, per-message usage, and
 *     the `<user_input …>` wrapper strip.
 *   - cline_fixture_2: a plain text turn, then a `run_commands` tool call, across
 *     multiple user/assistant turns — exercising message ordering and
 *     cacheReadTokens.
 * Paths, opaque ids, timestamps, costs, and model/provider names are
 * deterministic placeholders; the block shape, per-message metrics, and parser
 * behavior are preserved.
 *
 * The parser reads a session's `<id>.messages.json` and (optionally) its sibling
 * `<id>.json`; the tests materialize each pair under a temp dir.
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
import { parseSessionFile } from "../../src/parsers/cline/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/cline/capture-derived.json");

const CaptureSchema = z.object({
  sessions: z.array(
    z.object({
      meta: z.record(z.string(), z.unknown()),
      messages: z.object({ sessionId: z.string() }).passthrough(),
    }),
  ),
});
const capture = CaptureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Materialize a session's file pair under a fresh temp dir and return the path
 * to its `<id>.messages.json`. When `withMeta` is false, only the messages file
 * is written (the sibling metadata is absent).
 */
function materialize(index: number, withMeta = true): string {
  const s = capture.sessions[index];
  if (!s) throw new Error(`no fixture session ${index}`);
  const id = s.messages.sessionId;
  const root = mkdtempSync(join(tmpdir(), "cline-parser-test-"));
  tempDirs.push(root);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const messagesPath = join(dir, `${id}.messages.json`);
  writeFileSync(messagesPath, JSON.stringify(s.messages));
  if (withMeta) writeFileSync(join(dir, `${id}.json`), JSON.stringify(s.meta));
  return messagesPath;
}

/** Write a synthetic messages file to a temp dir; return its path. */
function writeSynthetic(id: string, messages: object): string {
  const root = mkdtempSync(join(tmpdir(), "cline-parser-test-"));
  tempDirs.push(root);
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const messagesPath = join(dir, `${id}.messages.json`);
  writeFileSync(messagesPath, JSON.stringify(messages));
  return messagesPath;
}

// ---------------------------------------------------------------------------
// cline_fixture_1 — thinking + read_files tool call
// ---------------------------------------------------------------------------

describe("cline parser — capture-derived fixture (tool call)", () => {
  it("stamps cline identity and session metadata from the sibling file", async () => {
    const r = await parseSessionFile(materialize(0));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("cline--cline_fixture_1");
    expect(s.cli).toBe("cline");
    expect(s.externalId).toBe("cline_fixture_1");
    expect(s.projectPath).toBe("/home/u/cline-cap");
    expect(s.model).toBe("model-placeholder");
    expect(s.status).toBe("complete");
    expect(s.title).toBe(
      "Read the file hello.txt and tell me the secret word it contains.",
    );
    // ts is epoch ms in the store; canonical timing is unix seconds.
    expect(s.startedAt).toBe(1700000000);
    expect(s.endedAt).toBe(1700000003);
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("splits thinking, strips the user_input wrapper, drops the tool-result user row", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const msgs = r.data.transcript.messages;
    // user prompt, thinking, assistant (text + tool call), final reply. The
    // tool_result-only user message is consumed at the tool_use site.
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "assistant",
    ]);
    expect(msgs[0]?.text).toBe(
      "Read the file hello.txt and tell me the secret word it contains.",
    );
    expect(msgs[0]?.text).not.toContain("<user_input");
    expect(msgs[1]?.text).toContain("read_files");
  });

  it("correlates the tool_use with its later tool_result message", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls).toHaveLength(1);
    const read = calls[0];
    expect(read?.name).toBe("read_files");
    expect(read?.callId).toBe("toolu_fixture_read");
    expect(read?.exitCode).toBe(0);
    expect(read?.outputFull).toContain("banana");
    const args = z
      .object({ files: z.array(z.object({ path: z.string() })) })
      .safeParse(read?.args);
    expect(args.success).toBe(true);
    expect(args.data?.files[0]?.path).toBe("/home/u/cline-cap/hello.txt");
  });

  it("sums per-message usage from assistant metrics", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    expect(t.inputTokens).toBe(5531 + 5644);
    expect(t.outputTokens).toBe(199 + 15);
    const withUsage = t.messages.filter((m) => m.usage !== undefined);
    expect(withUsage.every((m) => m.role === "assistant")).toBe(true);
  });

  it("preserves the final assistant reply text", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const last = r.data.transcript.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.text).toBe(
      "The secret word contained in hello.txt is **banana**.",
    );
  });
});

// ---------------------------------------------------------------------------
// cline_fixture_2 — multi-turn text + run_commands
// ---------------------------------------------------------------------------

describe("cline parser — multi-turn shell session", () => {
  it("orders user/assistant turns and splits each thinking block", async () => {
    const r = await parseSessionFile(materialize(1));
    if (!r.success) throw new Error("parse failed");
    expect(r.data.transcript.messages.map((m) => m.role)).toEqual([
      "user",
      "thinking",
      "assistant",
      "user",
      "thinking",
      "assistant",
      "assistant",
    ]);
  });

  it("decodes the run_commands tool call and sums cache-read tokens", async () => {
    const r = await parseSessionFile(materialize(1));
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("run_commands");
    expect(calls[0]?.outputFull).toContain("hi-from-cline");
    // Only the tool-call turn carried cacheReadTokens (5513); others were 0.
    expect(r.data.transcript.cacheReadTokens).toBe(5513);
  });
});

// ---------------------------------------------------------------------------
// Metadata-optional + edge cases
// ---------------------------------------------------------------------------

describe("cline parser — metadata-optional and edges", () => {
  it("parses without the sibling metadata file, deriving model + title", async () => {
    const r = await parseSessionFile(materialize(0, false));
    expect(r.success).toBe(true);
    if (!r.success) return;
    // No <id>.json: model comes from the first assistant modelInfo, title from
    // the first message, and projectPath is absent.
    expect(r.data.model).toBe("model-placeholder");
    expect(r.data.title).toBe(
      "Read the file hello.txt and tell me the secret word it contains.",
    );
    expect(r.data.projectPath).toBeUndefined();
  });

  it("handles a string-form tool_result and maps is_error to a nonzero exit", async () => {
    const messagesPath = writeSynthetic("cline_fixture_err", {
      version: 1,
      sessionId: "cline_fixture_err",
      messages: [
        { id: "m1", role: "user", content: [{ type: "text", text: "do it" }] },
        {
          id: "m2",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_err",
              name: "read_files",
              input: { path: "/nope" },
            },
          ],
          ts: 1700000100000,
          modelInfo: { id: "model-placeholder", provider: "p" },
        },
        {
          id: "m3",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_err",
              content: "ENOENT: no such file",
              is_error: true,
            },
          ],
        },
        {
          id: "m4",
          role: "assistant",
          content: [{ type: "text", text: "That file does not exist." }],
          ts: 1700000101000,
          modelInfo: { id: "model-placeholder", provider: "p" },
          metrics: { inputTokens: 10, outputTokens: 5 },
        },
      ],
    });
    const r = await parseSessionFile(messagesPath);
    if (!r.success) throw new Error("parse failed");
    const call = r.data.transcript.messages.flatMap((m) => m.toolCalls)[0];
    expect(call?.exitCode).toBe(1);
    expect(call?.outputFull).toBe("ENOENT: no such file");
  });

  it("fails cleanly for a missing messages file", async () => {
    const r = await parseSessionFile("/nonexistent/x.messages.json");
    expect(r.success).toBe(false);
  });
});
