/**
 * Kilo Code parser tests — driven by a sanitized, capture-derived Kilo 7.4.9
 * fixture.
 *
 * The `capture-derived.json` fixture contains two sessions — "Read fixture"
 * (read + bash tool calls → final reply) and "Create fixture note" (bash + a
 * `patch` part → more bash → final reply). The fixture preserves the
 * reader-facing `session`/`message`/`part` row shapes derived from `kilo.db`. Paths, opaque
 * identifiers, timestamps, costs, usage values, repository fingerprints,
 * routing metadata, and tool payloads are deterministic placeholders; record
 * structure and parser behavior are preserved.
 *
 * Kilo exposes an OpenCode-compatible reader shape, so these tests also lock
 * the identity split: kilo stamps `cli:"kilo"` / `kilo--` ids / `kilo_patch`, while
 * the same rows parsed through opencode's default identity still yield
 * `cli:"opencode"` / `oc--` / `opencode_patch` (regression guard on the shared
 * reducer's parameterization).
 *
 * DB access uses a structural stub — no better-sqlite3 dependency.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  listSessionIds,
  parseSessionFromDb,
} from "../../src/parsers/kilo/index.js";
import type { OpencodeDb } from "../../src/parsers/opencode/index.js";
import { parseSessionFromDb as parseOpencodeFromDb } from "../../src/parsers/opencode/index.js";
import { SessionSchema } from "../../src/schemas/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE = join(__dirname, "../fixtures/kilo/capture-derived.json");

// ---------------------------------------------------------------------------
// Fixture load (validated) + structural FakeDb
// ---------------------------------------------------------------------------

const RowSchema = z.record(z.string(), z.unknown());
const CaptureSchema = z.object({
  sessions: z.array(RowSchema),
  messages: z.array(RowSchema),
  parts: z.array(RowSchema),
});

const capture = CaptureSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));

/**
 * Build a structural OpencodeDb over the fixture rows. `data` is stored as a
 * parsed object in the fixture (readable); the real store keeps it as a JSON
 * string, so we re-stringify it here to match what the parser expects.
 */
function makeCaptureDb(): OpencodeDb {
  const stringifyData = (
    r: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...r,
    data: typeof r.data === "string" ? r.data : JSON.stringify(r.data),
  });
  const sessions = capture.sessions;
  const messages = capture.messages.map(stringifyData);
  const parts = capture.parts.map(stringifyData);

  return {
    prepare(sql: string) {
      return {
        all(...params: unknown[]): unknown[] {
          const sid = params[0];
          if (sql.includes("FROM session") && sql.includes("WHERE id = ?")) {
            return sessions.filter((r) => r.id === sid);
          }
          if (sql.includes("FROM session")) return sessions;
          if (sql.includes("FROM message")) {
            return messages.filter((r) => r.session_id === sid);
          }
          if (sql.includes("FROM part")) {
            return parts.filter((r) => r.session_id === sid);
          }
          return [];
        },
        get(...params: unknown[]): unknown {
          const sid = params[0];
          if (sql.includes("FROM session")) {
            return sessions.find((r) => r.id === sid);
          }
          return undefined;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Capture-derived fixture — session 1
// ---------------------------------------------------------------------------

describe("kilo parser — capture-derived fixture", () => {
  it("stamps kilo identity and session metadata", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "ses_fixture0001",
      "/x/kilo.db",
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data;
    expect(s.id).toBe("kilo--ses_fixture0001");
    expect(s.cli).toBe("kilo");
    expect(s.externalId).toBe("ses_fixture0001");
    expect(s.projectPath).toBe("/home/u/kilo-fixture");
    expect(s.title).toBe("Fixture metadata session");
    // model is derived from message.modelID (the underlying provider model).
    expect(s.model).toBe("model-placeholder");
    expect(SessionSchema.safeParse(s).success).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("emits one message per user + assistant step in order", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "ses_fixture0001",
      "/x/kilo.db",
    );
    if (!r.success) throw new Error("parse failed");
    const roles = r.data.transcript.messages.map((m) => m.role);
    // user prompt, then three assistant steps (read tool, bash tool, final text).
    expect(roles).toEqual(["user", "assistant", "assistant", "assistant"]);
  });

  it("decodes tool parts into ToolCalls with output + exit code", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "ses_fixture0001",
      "/x/kilo.db",
    );
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls.map((c) => c.name)).toEqual(["read", "bash"]);
    const read = calls[0];
    expect(read?.exitCode).toBe(0);
    expect(read?.callId).toBe("call-placeholder-01");
    // The read tool returned package.json contents.
    expect(read?.outputFull).toContain("kilo-fixture");
  });

  it("sums per-message token usage into transcript totals", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "ses_fixture0001",
      "/x/kilo.db",
    );
    if (!r.success) throw new Error("parse failed");
    const t = r.data.transcript;
    expect(t.inputTokens).toBe(10 + 20 + 30);
    expect(t.outputTokens).toBe(1 + 2 + 3);
  });

  it("preserves the final assistant reply text", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "ses_fixture0001",
      "/x/kilo.db",
    );
    if (!r.success) throw new Error("parse failed");
    const last = r.data.transcript.messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.text).toContain("kilo-fixture");
  });

  it("lists both captured session ids", () => {
    const ids = listSessionIds(makeCaptureDb());
    expect(ids).toContain("ses_fixture0001");
    expect(ids).toContain("ses_fixture0002");
  });
});

// ---------------------------------------------------------------------------
// Capture-derived fixture — session 2: patch part + identity split
// ---------------------------------------------------------------------------

describe("kilo parser — patch parts and identity split", () => {
  it("emits a patch part as a kilo_patch tool call", () => {
    const r = parseSessionFromDb(
      makeCaptureDb(),
      "ses_fixture0002",
      "/x/kilo.db",
    );
    if (!r.success) throw new Error("parse failed");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    const patch = calls.find((c) => c.name === "kilo_patch");
    expect(patch).toBeDefined();
    expect(patch?.name).not.toBe("opencode_patch");
    const args = z
      .object({ files: z.array(z.string()) })
      .safeParse(patch?.args);
    expect(args.success).toBe(true);
    expect(args.data?.files.some((f) => f.endsWith("notes.txt"))).toBe(true);
  });

  it("keeps opencode's defaults when the same rows parse via opencode identity", () => {
    // Regression guard: the shared reducer's identity parameterization must not
    // change opencode's original output when no identity is passed.
    const r = parseOpencodeFromDb(
      makeCaptureDb(),
      "ses_fixture0002",
      "/x/kilo.db",
    );
    if (!r.success) throw new Error("parse failed");
    expect(r.data.id).toBe("oc--ses_fixture0002");
    expect(r.data.cli).toBe("opencode");
    const calls = r.data.transcript.messages.flatMap((m) => m.toolCalls);
    expect(calls.some((c) => c.name === "opencode_patch")).toBe(true);
    expect(calls.some((c) => c.name === "kilo_patch")).toBe(false);
  });
});
