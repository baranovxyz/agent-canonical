/**
 * Mistral Vibe parser tests — driven by a sanitized, capture-derived Vibe 2.23.3
 * fixture (the store carries no schema or format version to pin).
 *
 * `capture-derived.json` holds two sessions, each a `dirName` plus its `meta`
 * sidecar and its ordered `messages` array. The test materializes them as the
 * on-disk pair `<tmp>/<dirName>/messages.jsonl` + `<tmp>/<dirName>/meta.json`:
 *   - session 0: a plain text turn, a `bash` tool round, a `write_file` round
 *     the user approved, a reasoning turn, and a `bash` call the user DENIED.
 *     Exercises the inline-reasoning split, cross-record tool correlation by
 *     `tool_call_id`, the `<user_cancellation>` shape, session-level token
 *     totals, and alias → name model resolution through the config.
 *   - session 1: a session whose first turn died on an API error, so only the
 *     user line was ever persisted and every stat is zero.
 * Usernames, paths, git commit, session uuids (the directory suffix keeps the
 * first 8 characters, as the store derives it), message / reasoning / tool-call
 * ids, model and provider names, provider base URLs, the metadata fingerprint,
 * and timestamps are deterministic placeholders. Two size trims are documented
 * in the fixture's own `note`: `meta.config` keeps only the keys the parser
 * consumes plus a few representative extras, and the system prompt and tool
 * descriptions are placeholder lines. Line envelopes, role sequence, token
 * numbers, tool outputs, and message text are preserved.
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
import {
  MESSAGES_FILENAME,
  METADATA_FILENAME,
  parseSessionFile,
} from "../../src/parsers/vibe/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/vibe/capture-derived.json");

const CaptureSchema = z.object({
  sessions: z.array(
    z.object({
      dirName: z.string(),
      meta: z.record(z.string(), z.unknown()),
      messages: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});
const capture = CaptureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "vibe-parser-test-"));
  tempDirs.push(root);
  return root;
}

/**
 * Materialize a fixture session as `<tmp>/<dirName>/messages.jsonl` plus its
 * sibling `meta.json`, and return the SESSION DIRECTORY. With `withMeta` false
 * only the JSONL is written (the sidecar is absent).
 */
function materialize(index: number, withMeta = true): string {
  const s = capture.sessions[index];
  if (!s) throw new Error(`no fixture session ${index}`);
  const dir = join(tempRoot(), s.dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, MESSAGES_FILENAME),
    `${s.messages.map((m) => JSON.stringify(m)).join("\n")}\n`,
  );
  if (withMeta) {
    writeFileSync(join(dir, METADATA_FILENAME), JSON.stringify(s.meta));
  }
  return dir;
}

/** Write arbitrary JSONL lines (and optional meta) to a throwaway session. */
function writeSession(dirName: string, lines: string[], meta?: object): string {
  const dir = join(tempRoot(), dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MESSAGES_FILENAME), lines.join("\n"));
  if (meta !== undefined) {
    writeFileSync(join(dir, METADATA_FILENAME), JSON.stringify(meta));
  }
  return dir;
}

const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------
// Session 0 — tool rounds, inline reasoning, and a denied call
// ---------------------------------------------------------------------------

describe("vibe parser — capture-derived fixture", () => {
  it("stamps vibe identity from the meta.json sidecar", async () => {
    const r = await parseSessionFile(materialize(0));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    // The full uuid lives only in meta.json — the directory keeps 8 chars.
    expect(s.id).toBe("vibe--vibefix1-0545-100f-a727-000000000001");
    expect(s.cli).toBe("vibe");
    expect(s.externalId).toBe("vibefix1-0545-100f-a727-000000000001");
    expect(s.projectPath).toBe("/home/u/project");
    expect(s.gitBranch).toBe("main");
    expect(s.author).toBe("u");
    expect(s.agentType).toBe("default");
    expect(s.title).toContain("append-only JSONL");
    expect(s.parentSessionId).toBeUndefined();
    expect(s.startedAt).toBe(sec("2026-01-01T00:00:00.000000+00:00"));
    expect(s.endedAt).toBe(sec("2026-01-01T00:05:03.000000+00:00"));
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("accepts the messages.jsonl path as well as the session directory", async () => {
    const dir = materialize(0);
    const viaDir = await parseSessionFile(dir);
    const viaFile = await parseSessionFile(join(dir, MESSAGES_FILENAME));
    expect(viaDir.success && viaFile.success).toBe(true);
    if (!viaDir.success || !viaFile.success) return;
    expect(viaFile.data.transcript.contentHash).toBe(
      viaDir.data.transcript.contentHash,
    );
    expect(viaFile.data.transcript.rawPath).toBe(join(dir, MESSAGES_FILENAME));
  });

  it("splits inline reasoning into its own message ahead of the reply", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const msgs = r.data.transcript.messages;
    expect(msgs.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant", // bash call
      "assistant", // write_file call
      "assistant", // "Done." reply
      "user",
      "thinking", // reasoning_content, emitted before its own reply
      "assistant",
      "user",
      "assistant", // denied bash call
    ]);
    const thinking = msgs[7];
    expect(thinking?.text).toContain("The user asks a conceptual question");
    // Reasoning is excluded from the reply text it preceded.
    expect(msgs[8]?.text).toContain("monotonic sequence number");
    expect(msgs[8]?.text).not.toContain("The user asks a conceptual question");
    // A tool-issuing assistant record has no `content` key at all.
    expect(msgs[3]?.text).toBe("");
    expect(msgs[3]?.toolCalls).toHaveLength(1);
  });

  it("leaves every message timestamp unset — the store has no message clock", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    // Back-filling from the session window would fabricate an ordering fact.
    expect(r.data.transcript.messages.every((m) => m.ts === undefined)).toBe(
      true,
    );
    expect(r.data.transcript.rawEvents?.every((e) => e.ts === undefined)).toBe(
      true,
    );
    // Per-message usage is equally absent.
    expect(r.data.transcript.messages.every((m) => m.usage === undefined)).toBe(
      true,
    );
  });

  it("correlates each tool_call with its later role:tool record", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls.map((c) => c.name)).toEqual(["bash", "write_file", "bash"]);

    const bash = calls[0];
    expect(bash?.callId).toBe("call_fixture_1");
    // `function.arguments` is a JSON string on disk; the parser decodes it.
    const bashArgs = z.object({ command: z.string() }).safeParse(bash?.args);
    expect(bashArgs.success).toBe(true);
    expect(bashArgs.data?.command).toBe("ls -la /home/u/project");
    // `bash` is the one tool that states an exit status.
    expect(bash?.exitCode).toBe(0);
    expect(bash?.outputFull).toContain("returncode: 0");
    expect(bash?.outputBytes).toBe(
      Buffer.byteLength(bash?.outputFull ?? "", "utf8"),
    );
    expect(bash?.durationMs).toBe(19);

    const write = calls[1];
    expect(write?.callId).toBe("call_fixture_2");
    const writeArgs = z
      .object({ file_path: z.string(), content: z.string() })
      .safeParse(write?.args);
    expect(writeArgs.success).toBe(true);
    expect(writeArgs.data?.file_path).toBe("/home/u/project/hello.txt");
    // No `returncode` and no per-tool error flag: nothing is assumed.
    expect(write?.exitCode).toBeUndefined();
    expect(write?.outputFull).toContain("bytes_written: 2");
  });

  it("keeps a denied call as a cancelled call carrying the refusal text", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const denied = r.data.transcript.messages.flatMap((m) => m.toolCalls)[2];
    expect(denied?.name).toBe("bash");
    expect(denied?.callId).toBe("call_fixture_3");
    // The record has no `tool_result` key; the sentinel is what the model saw.
    expect(denied?.outputFull).toBe(
      "<user_cancellation>User cancelled the operation.</user_cancellation>",
    );
    expect(denied?.exitCode).toBe(1);
    expect(denied?.durationMs).toBeUndefined();
    // A tool-scoped refusal is not a turn-level abort, so nothing is counted.
    expect(r.data.transcript.abortedTurns).toBeUndefined();
  });

  it("takes session-level token totals from meta.json stats", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    expect(t.inputTokens).toBe(35030);
    expect(t.outputTokens).toBe(744);
    // The cached figure is the cached SHARE of the prompt total, kept as
    // recorded rather than netted out of `inputTokens`.
    expect(t.cacheReadTokens).toBe(23040);
    expect(t.cacheCreationTokens).toBeUndefined();
    expect(t.reasoningTokens).toBeUndefined();
  });

  it("resolves the model through config.active_model → models[alias].name", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    // The active alias is `model-alias-1`; its entry's `name` is the slug.
    expect(r.data.model).toBe("model-placeholder-1");
  });

  it("derives turn end without inventing a session status", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    // meta.json is rewritten after every turn, so a quiet tail says nothing
    // about whether the session finished.
    expect(r.data.status).toBeUndefined();
  });

  it("preserves every line losslessly in rawEvents, typed by role", async () => {
    const r = await parseSessionFile(materialize(0));
    if (!r.success) throw new Error("parse failed");
    const raw = r.data.transcript.rawEvents ?? [];
    // rawEvents mirrors messages.jsonl one entry per line — meta.json is read
    // for session facts but is not a raw event.
    expect(raw.length).toBe(capture.sessions[0]?.messages.length);
    expect(raw.length).toBe(13);
    expect(raw.map((e) => e.eventType)).toEqual([
      "message:user",
      "message:assistant",
      "message:user",
      "message:assistant",
      "message:tool",
      "message:assistant",
      "message:tool",
      "message:assistant",
      "message:user",
      "message:assistant",
      "message:user",
      "message:assistant",
      "message:tool",
    ]);
    // The TUI-only `presentation` sidecar is never decoded but never lost.
    expect(raw.some((e) => e.rawJson.includes('"presentation"'))).toBe(true);
    expect(
      r.data.transcript.messages.some((m) => m.text.includes("presentation")),
    ).toBe(false);
  });

  it("parses without meta.json, falling back to the directory name", async () => {
    const r = await parseSessionFile(materialize(0, false));
    expect(r.success).toBe(true);
    if (!r.success) return;
    // Only 8 characters of the uuid are on disk, so the directory name is the
    // one identifier that is both present and unique within the store.
    expect(r.data.externalId).toBe("session_20260101_000000_vibefix1");
    expect(r.data.id).toBe("vibe--session_20260101_000000_vibefix1");
    // Every session-level fact lives in the sidecar and is simply absent.
    expect(r.data.projectPath).toBeUndefined();
    expect(r.data.gitBranch).toBeUndefined();
    expect(r.data.model).toBeUndefined();
    expect(r.data.startedAt).toBeUndefined();
    expect(r.data.transcript.inputTokens).toBeUndefined();
    // The title falls back to the first non-thinking message.
    expect(r.data.title).toContain("append-only JSONL");
    expect(r.data.transcript.messages).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// Session 1 — an API error persisted nothing but the user line
// ---------------------------------------------------------------------------

describe("vibe parser — API-error session", () => {
  it("parses a session whose only surviving line is the user prompt", async () => {
    const r = await parseSessionFile(materialize(1));
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("vibe--vibefix2-3863-0806-d099-000000000002");
    const msgs = s.transcript.messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[0]?.text).toContain("JSONL transcript file");
    // A failed turn writes nothing, so failure is indistinguishable from a
    // session the user walked away from: no status is claimed.
    expect(s.status).toBeUndefined();
    expect(SessionSchema.safeParse(s).success).toBe(true);
  });

  it("omits token totals when every stat is zero", async () => {
    const r = await parseSessionFile(materialize(1));
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    expect(t.inputTokens).toBeUndefined();
    expect(t.outputTokens).toBeUndefined();
    expect(t.cacheReadTokens).toBeUndefined();
    expect(t.rawEvents?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("vibe parser — edges", () => {
  it("fails cleanly for a missing session directory", async () => {
    const r = await parseSessionFile("/nonexistent/session_00000000_000000_ff");
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.issues[0]?.severity).toBe("error");
  });

  it("skips malformed lines and unknown roles, keeping the rest countable", async () => {
    const dir = writeSession("session_20260101_002000_vibefix3", [
      JSON.stringify({
        role: "user",
        content: "first",
        injected: false,
        message_id: "msg_fixture_a",
      }),
      "{ this is not json",
      JSON.stringify({ role: "developer", content: "future role" }),
      JSON.stringify({
        role: "assistant",
        content: "second",
        injected: false,
        message_id: "msg_fixture_b",
      }),
    ]);
    const r = await parseSessionFile(dir);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.transcript.messages.map((m) => m.text)).toEqual([
      "first",
      "second",
    ]);
    expect(r.issues.filter((i) => i.severity === "warning")).toHaveLength(2);
    // The malformed line is not a raw event; the three decodable ones are.
    expect(r.data.transcript.rawEvents?.length).toBe(3);
  });

  it("keeps an injected message at its recorded role", async () => {
    const dir = writeSession("session_20260101_003000_vibefix4", [
      JSON.stringify({
        role: "user",
        content: "<context>repository state</context>",
        injected: true,
        message_id: "msg_fixture_c",
      }),
      JSON.stringify({
        role: "user",
        content: "what changed?",
        injected: false,
        message_id: "msg_fixture_d",
      }),
    ]);
    const r = await parseSessionFile(dir);
    if (!r.success) throw new Error("parse failed");
    // Vibe sends injected content to the model under its recorded role, so it
    // stays a user message; the flag survives in rawEvents for filtering.
    expect(r.data.transcript.messages.map((m) => m.role)).toEqual([
      "user",
      "user",
    ]);
    expect(r.data.transcript.messages[0]?.text).toContain("repository state");
    expect(
      r.data.transcript.rawEvents?.[0]?.rawJson.includes('"injected":true'),
    ).toBe(true);
  });

  it("reports an unresolvable model alias as recorded", async () => {
    const dir = writeSession(
      "session_20260101_004000_vibefix5",
      [
        JSON.stringify({
          role: "user",
          content: "hello",
          injected: false,
          message_id: "msg_fixture_e",
        }),
      ],
      {
        session_id: "vibefix5-0000-0000-0000-000000000005",
        start_time: "2026-01-01T00:40:00.000000+00:00",
        end_time: null,
        git_commit: null,
        git_branch: null,
        environment: { working_directory: "/home/u/project" },
        username: "u",
        config: { active_model: "unregistered-alias", models: {} },
      },
    );
    const r = await parseSessionFile(dir);
    if (!r.success) throw new Error("parse failed");
    // Guessing an upstream slug from a local alias would invent data.
    expect(r.data.model).toBe("unregistered-alias");
    expect(r.data.endedAt).toBeUndefined();
    expect(r.data.gitBranch).toBeUndefined();
  });

  it("resolves the model from a list-shaped config.models too", async () => {
    const dir = writeSession(
      "session_20260101_005000_vibefix6",
      [
        JSON.stringify({
          role: "user",
          content: "hello",
          injected: false,
          message_id: "msg_fixture_f",
        }),
      ],
      {
        session_id: "vibefix6-0000-0000-0000-000000000006",
        start_time: "2026-01-01T00:50:00.000000+00:00",
        parent_session_id: "vibefix1-0545-100f-a727-000000000001",
        config: {
          active_model: "model-alias-9",
          models: [
            { alias: "model-alias-8", name: "model-placeholder-8" },
            { alias: "model-alias-9", name: "model-placeholder-9" },
          ],
        },
      },
    );
    const r = await parseSessionFile(dir);
    if (!r.success) throw new Error("parse failed");
    expect(r.data.model).toBe("model-placeholder-9");
    // Subagent linkage is modeled from the child side.
    expect(r.data.parentSessionId).toBe(
      "vibe--vibefix1-0545-100f-a727-000000000001",
    );
  });

  it("keeps a raw arguments string that did not parse as JSON", async () => {
    const dir = writeSession("session_20260101_006000_vibefix7", [
      JSON.stringify({
        role: "user",
        content: "run it",
        injected: false,
        message_id: "msg_fixture_g",
      }),
      JSON.stringify({
        role: "assistant",
        injected: false,
        message_id: "msg_fixture_h",
        tool_calls: [
          {
            id: "call_fixture_8",
            index: 0,
            function: { name: "bash", arguments: '{"command": "ls' },
            type: "function",
          },
        ],
      }),
    ]);
    const r = await parseSessionFile(dir);
    if (!r.success) throw new Error("parse failed");
    const call = r.data.transcript.messages.flatMap((m) => m.toolCalls)[0];
    expect(call?.name).toBe("bash");
    // A truncated payload leaves `args` undecoded but still hashes distinctly.
    expect(call?.args).toBeUndefined();
    expect(call?.argsPreview).toContain('{\\"command\\": \\"ls');
    expect(call?.exitCode).toBeUndefined();
  });

  it("fails when the directory holds no decodable messages", async () => {
    const dir = writeSession("session_20260101_007000_vibefix8", [
      "{ not json",
    ]);
    const r = await parseSessionFile(dir);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.issues.some((i) => i.severity === "error")).toBe(true);
  });
});
