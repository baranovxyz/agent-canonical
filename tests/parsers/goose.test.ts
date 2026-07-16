/**
 * Goose parser tests — driven by a sanitized, capture-derived Goose 1.43.0
 * fixture.
 *
 * The `capture-derived.json` fixture holds the `sessions` + `messages` rows for
 * three sessions:
 *   - "Fixture ping session" (session_type=hidden): a plain text turn.
 *   - "Fixture shell session": a text turn, then a `shell` tool call whose
 *     `toolRequest` (assistant row) pairs with a `toolResponse` (later user row),
 *     then the final reply — exercising cross-row tool correlation + per-message
 *     usage.
 *   - "Fixture reasoning session": a `thinking` block and answer text in one
 *     assistant row.
 * Paths, opaque identifiers, timestamps, costs, model/provider names, and tool
 * payloads are deterministic placeholders; the `content_json` row shape,
 * per-message usage values, and parser behavior are preserved.
 *
 * DB access uses a structural stub — no better-sqlite3 dependency. The fixture
 * stores `content_json` / `metadata_json` as parsed objects for readability; the
 * real store keeps them as JSON strings, so the stub re-stringifies them to
 * match what the parser expects.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GooseDb } from "../../src/parsers/goose/index.js";
import {
  listSessionIds,
  parseSessionFromDb,
} from "../../src/parsers/goose/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/goose/capture-derived.json");

const RowSchema = z.record(z.string(), z.unknown());
const CaptureSchema = z.object({
  sessions: z.array(RowSchema),
  messages: z.array(RowSchema),
});

const capture = CaptureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

/**
 * Build a structural GooseDb over the fixture rows. Message rows carry
 * `content_json` / `metadata_json` as objects in the fixture; the parser expects
 * JSON strings, so re-stringify them here.
 */
function makeCaptureDb(): GooseDb {
  const stringify = (
    r: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> =>
    typeof r[key] === "string" || r[key] == null
      ? r
      : { ...r, [key]: JSON.stringify(r[key]) };

  const sessions = capture.sessions;
  const messages = capture.messages.map((r) =>
    stringify(stringify(r, "content_json"), "metadata_json"),
  );

  return {
    prepare(sql: string) {
      return {
        all(...params: unknown[]): unknown[] {
          const sid = params[0];
          if (sql.includes("FROM messages")) {
            return messages.filter((r) => r.session_id === sid);
          }
          // list: SELECT id FROM sessions ORDER BY created_at
          return sessions;
        },
        get(...params: unknown[]): unknown {
          const sid = params[0];
          if (sql.includes("FROM sessions")) {
            return sessions.find((r) => r.id === sid);
          }
          return undefined;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// "Fixture shell session" — text + cross-row tool call
// ---------------------------------------------------------------------------

describe("goose parser — capture-derived fixture (tool call)", () => {
  it("stamps goose identity and session metadata", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "goose_fixture_2",
      "/x/sessions.db",
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("goose--goose_fixture_2");
    expect(s.cli).toBe("goose");
    expect(s.externalId).toBe("goose_fixture_2");
    expect(s.projectPath).toBe("/home/u/goose-cap");
    expect(s.title).toBe("Fixture shell session");
    // model is derived from model_config_json.model_name.
    expect(s.model).toBe("model-placeholder");
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("emits user + assistant messages, consuming the tool-result user row", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "goose_fixture_2",
      "/x/sessions.db",
    );
    if (!r.success) throw new Error("parse failed");
    const roles = r.data.transcript.messages.map((m) => m.role);
    // user prompt, reply; user prompt, tool-call turn, final reply. The
    // toolResponse-only user row is consumed at the request site (no message).
    expect(roles).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
  });

  it("correlates the toolRequest with its later toolResponse row", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "goose_fixture_2",
      "/x/sessions.db",
    );
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls).toHaveLength(1);
    const shell = calls[0];
    expect(shell?.name).toBe("shell");
    expect(shell?.exitCode).toBe(0);
    expect(shell?.callId).toMatch(/^call_/);
    expect(shell?.outputFull).toContain("tool-ran-ok");
    const args = z.object({ command: z.string() }).safeParse(shell?.args);
    expect(args.success).toBe(true);
    expect(args.data?.command).toBe("echo tool-ran-ok");
  });

  it("sums per-message usage from metadata_json.usage", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "goose_fixture_2",
      "/x/sessions.db",
    );
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    // assistant input 5122 + 4478 + 4527; output 5 + 28 + 8.
    expect(t.inputTokens).toBe(5122 + 4478 + 4527);
    expect(t.outputTokens).toBe(5 + 28 + 8);
    // per-message usage rides on assistant messages only.
    const withUsage = t.messages.filter((m) => m.usage !== undefined);
    expect(withUsage.every((m) => m.role === "assistant")).toBe(true);
  });

  it("preserves the final assistant reply text", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "goose_fixture_2",
      "/x/sessions.db",
    );
    if (!r.success) throw new Error("parse failed");
    const last = r.data.transcript.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.text).toBe("tool-ran-ok");
  });
});

// ---------------------------------------------------------------------------
// "Fixture reasoning session" — thinking block split into its own message
// ---------------------------------------------------------------------------

describe("goose parser — thinking blocks and list", () => {
  it("splits a thinking block into a role:thinking message before the reply", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "goose_fixture_3",
      "/x/sessions.db",
    );
    if (!r.success) throw new Error("parse failed");
    const roles = r.data.transcript.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "thinking", "assistant"]);
    const thinking = r.data.transcript.messages.find(
      (m) => m.role === "thinking",
    );
    expect(thinking?.text).toContain("17");
    // The thinking text is not inlined into the assistant reply.
    const assistant = r.data.transcript.messages.at(-1);
    expect(assistant?.text).not.toContain(thinking?.text ?? "");
    expect(r.data.model).toBe("reasoning-model-placeholder");
  });

  it("parses a hidden session (session_type=hidden) like any other", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "goose_fixture_1",
      "/x/sessions.db",
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.title).toBe("Fixture ping session");
    const roles = r.data.transcript.messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("lists all captured session ids, oldest first", () => {
    const ids = listSessionIds(makeCaptureDb());
    expect(ids).toEqual([
      "goose_fixture_1",
      "goose_fixture_2",
      "goose_fixture_3",
    ]);
  });

  it("fails cleanly for an unknown session id", () => {
    const r = parseSessionFromDb(makeCaptureDb(), "nope", "/x/sessions.db");
    expect(r.success).toBe(false);
  });
});
