import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSessionFile } from "../../src/parsers/cursor/index.js";
import { SessionSchema } from "../../src/schemas/session.js";

// ---------------------------------------------------------------------------
// Helpers for synthetic session files
// ---------------------------------------------------------------------------

const PARENT_UUID = "sess0001-aaaa-bbbb-cccc-dddddddddddd";
const SUB_UUID = "sub0001-eeee-ffff-aaaa-bbbbbbbbbbbb";

/**
 * Synthetic fixture covering parent and child session layouts.
 * Layout: cursor/<project>/<parent-uuid>/<parent-uuid>.jsonl
 *                                       /subagents/<sub-uuid>.jsonl
 */
const PARENT_LINES = [
  JSON.stringify({
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: "<user_query>\nplease list the top-level files\n</user_query>",
        },
      ],
    },
  }),
  JSON.stringify({
    role: "assistant",
    message: {
      content: [
        { type: "text", text: "Reading the repo root." },
        { type: "tool_use", name: "Shell", input: { command: "ls -1" } },
      ],
    },
  }),
  JSON.stringify({
    role: "assistant",
    message: { content: [{ type: "text", text: "Three entries at root." }] },
  }),
  JSON.stringify({
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: "<attached_files>\n--- /Users/u/repo/README.md\n@@ -1 +1,2 @@\n# repo\n+more\n</attached_files>",
        },
      ],
    },
  }),
  JSON.stringify({
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: "<user_query>\nactually show with sizes\n</user_query>\n<external_links>\nhttps://example.com\n</external_links>",
        },
      ],
    },
  }),
  JSON.stringify({
    role: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Shell", input: { command: "ls -lah" } },
        {
          type: "tool_use",
          name: "TodoWrite",
          input: { todos: [{ id: "a", content: "done", status: "completed" }] },
        },
      ],
    },
  }),
  JSON.stringify({
    role: "assistant",
    message: {
      content: [
        { type: "text", text: "" },
        { type: "image", source: "redacted" },
      ],
    },
  }),
].join("\n");

const SUB_LINES = [
  JSON.stringify({
    role: "user",
    message: {
      content: [
        {
          type: "text",
          text: "<user_query>\nfetch the wiki page idx 12345\n</user_query>",
        },
      ],
    },
  }),
  JSON.stringify({
    role: "assistant",
    message: {
      content: [
        { type: "text", text: "Calling the MCP tool." },
        {
          type: "tool_use",
          name: "CallMcpTool",
          input: {
            server: "example-wiki",
            toolName: "get_page_details",
            arguments: { idx: 12345 },
          },
        },
      ],
    },
  }),
].join("\n");

function makeTopSession(dir: string): string {
  const projectDir = join(dir, "cursor", "Users-u-repo", PARENT_UUID);
  mkdirSync(projectDir, { recursive: true });
  const file = join(projectDir, `${PARENT_UUID}.jsonl`);
  writeFileSync(file, `${PARENT_LINES}\n`);
  return file;
}

function makeSubSession(dir: string): string {
  const subDir = join(dir, "cursor", "Users-u-repo", PARENT_UUID, "subagents");
  mkdirSync(subDir, { recursive: true });
  const file = join(subDir, `${SUB_UUID}.jsonl`);
  writeFileSync(file, `${SUB_LINES}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cursor parser", () => {
  it("derives id, cli, externalId, projectPath from file location", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      const file = makeTopSession(dir);
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const s = result.data;
      expect(s.id).toBe(`cur--${PARENT_UUID}`);
      expect(s.cli).toBe("cursor");
      expect(s.externalId).toBe(PARENT_UUID);
      // "Users-u-repo" decodes to "/Users/u/repo"
      expect(s.projectPath).toBe("/Users/u/repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips wrapper tags from user text and drops wrapper-only turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      const file = makeTopSession(dir);
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const msgs = result.data.transcript.messages;
      const roles = msgs.map((m) => m.role);
      // wrapper-only user turn (seq 3, attached_files only) is dropped
      expect(roles).toEqual([
        "user",
        "assistant",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(msgs[0]?.text).toBe("please list the top-level files");
      expect(msgs[3]?.text).toBe("actually show with sizes");
      expect(msgs[3]?.text).not.toContain("external_links");
      expect(msgs[3]?.text).not.toContain("https://example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds tool calls without output (Cursor stores no tool_result)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      const file = makeTopSession(dir);
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const toolCalls = result.data.transcript.messages.flatMap(
        (m) => m.toolCalls,
      );
      expect(toolCalls.map((tc) => tc.name)).toEqual([
        "Shell",
        "Shell",
        "TodoWrite",
      ]);
      for (const tc of toolCalls) {
        expect(tc.argsHash).toMatch(/^[0-9a-f]{64}$/);
        expect(tc.outputPreview).toBeUndefined();
        expect(tc.outputBytes).toBeUndefined();
        expect(tc.exitCode).toBeUndefined();
      }
      const todo = toolCalls.find((tc) => tc.name === "TodoWrite");
      expect(todo?.argsPreview).toContain("completed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves raw events and ordered content parts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      const file = makeTopSession(dir);
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const { rawEvents, messageParts } = result.data.transcript;

      expect(rawEvents?.map((ev) => ev.eventType)).toEqual([
        "cursor:user",
        "cursor:assistant",
        "cursor:assistant",
        "cursor:user",
        "cursor:user",
        "cursor:assistant",
        "cursor:assistant",
      ]);
      expect(rawEvents?.[0]?.rawJson).toContain("<user_query>");

      expect(
        messageParts?.map((p) => ({
          sourceSeq: p.sourceSeq,
          partIdx: p.partIdx,
          turn: p.turn,
          role: p.role,
          partType: p.partType,
          toolName: p.toolName,
          toolCallIdx: p.toolCallIdx,
          includedInMessageText: p.includedInMessageText,
        })),
      ).toEqual([
        {
          sourceSeq: 0,
          partIdx: 0,
          turn: 1,
          role: "user",
          partType: "text",
          toolName: undefined,
          toolCallIdx: undefined,
          includedInMessageText: true,
        },
        {
          sourceSeq: 1,
          partIdx: 0,
          turn: 2,
          role: "assistant",
          partType: "text",
          toolName: undefined,
          toolCallIdx: undefined,
          includedInMessageText: true,
        },
        {
          sourceSeq: 1,
          partIdx: 1,
          turn: 2,
          role: "assistant",
          partType: "tool_use",
          toolName: "Shell",
          toolCallIdx: 0,
          includedInMessageText: false,
        },
        {
          sourceSeq: 2,
          partIdx: 0,
          turn: 3,
          role: "assistant",
          partType: "text",
          toolName: undefined,
          toolCallIdx: undefined,
          includedInMessageText: true,
        },
        {
          sourceSeq: 3,
          partIdx: 0,
          turn: undefined,
          role: "user",
          partType: "text",
          toolName: undefined,
          toolCallIdx: undefined,
          includedInMessageText: false,
        },
        {
          sourceSeq: 4,
          partIdx: 0,
          turn: 4,
          role: "user",
          partType: "text",
          toolName: undefined,
          toolCallIdx: undefined,
          includedInMessageText: true,
        },
        {
          sourceSeq: 5,
          partIdx: 0,
          turn: 5,
          role: "assistant",
          partType: "tool_use",
          toolName: "Shell",
          toolCallIdx: 0,
          includedInMessageText: false,
        },
        {
          sourceSeq: 5,
          partIdx: 1,
          turn: 5,
          role: "assistant",
          partType: "tool_use",
          toolName: "TodoWrite",
          toolCallIdx: 1,
          includedInMessageText: false,
        },
        {
          sourceSeq: 6,
          partIdx: 0,
          turn: undefined,
          role: "assistant",
          partType: "text",
          toolName: undefined,
          toolCallIdx: undefined,
          includedInMessageText: false,
        },
        {
          sourceSeq: 6,
          partIdx: 1,
          turn: undefined,
          role: "assistant",
          partType: "image",
          toolName: undefined,
          toolCallIdx: undefined,
          includedInMessageText: false,
        },
      ]);

      const imagePart = messageParts?.find((p) => p.partType === "image");
      expect(imagePart?.payloadJson).toContain("redacted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computes a stable content hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      const file = makeTopSession(dir);
      const [a, b] = await Promise.all([
        parseSessionFile(file),
        parseSessionFile(file),
      ]);
      expect(a.success && b.success).toBe(true);
      if (!a.success || !b.success) return;
      expect(a.data.transcript.contentHash).toBe(b.data.transcript.contentHash);
      expect(a.data.transcript.contentHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects subagent files by parent dir and links via parentSessionId", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      // need parent tree to exist for resolveLineage to walk correctly
      makeTopSession(dir);
      const file = makeSubSession(dir);
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const s = result.data;
      expect(s.id).toBe(`cur--${SUB_UUID}`);
      expect(s.parentSessionId).toBe(`cur--${PARENT_UUID}`);
      expect(s.projectPath).toBe("/Users/u/repo");
      expect(s.transcript.messages).toHaveLength(2);
      const mcp = s.transcript.messages[1]?.toolCalls[0];
      expect(mcp?.name).toBe("CallMcpTool");
      expect(mcp?.argsPreview).toContain("get_page_details");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not set parentSessionId for top-level sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      const file = makeTopSession(dir);
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      expect(result.data.parentSessionId).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the first user prompt (post-sanitization) as the title", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-"));
    try {
      const file = makeTopSession(dir);
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      expect(result.data.title).toBe("please list the top-level files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets startedAt from the first Cursor timestamp tag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-ts-"));
    try {
      const file = join(dir, "timestamped.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: "<timestamp>Monday, Jun 1, 2026, 10:46 AM (UTC+3)</timestamp>\n<user_query>go</user_query>",
              },
            ],
          },
        })}\n`,
      );
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      expect(result.data.startedAt).toBe(Date.UTC(2026, 5, 1, 7, 46) / 1000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to file mtime when no timestamp tag exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-mtime-"));
    try {
      const file = join(dir, "no-timestamp.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "<user_query>go</user_query>" }],
          },
        })}\n`,
      );
      const mtime = new Date("2026-03-04T08:20:21Z");
      utimesSync(file, mtime, mtime);
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      expect(result.data.startedAt).toBe(Math.floor(mtime.getTime() / 1000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails with error when file does not exist", async () => {
    const result = await parseSessionFile("/nonexistent/path/session.jsonl");
    expect(result.success).toBe(false);
    expect(result.issues[0]?.severity).toBe("error");
    expect(result.issues[0]?.message).toMatch(/Failed to read file/);
  });

  it("fails with error for a file with zero usable messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-empty-"));
    try {
      const file = join(dir, "empty.jsonl");
      // role is present but message.content is absent → skip, no messages
      writeFileSync(file, `${JSON.stringify({ role: "user", message: {} })}\n`);
      const result = await parseSessionFile(file);
      expect(result.success).toBe(false);
      expect(result.issues[0]?.severity).toBe("error");
      expect(result.issues[0]?.message).toMatch(/No usable messages/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces a warning issue for a malformed JSONL line while parsing the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-malformed-"));
    try {
      const file = join(dir, "malformed.jsonl");
      writeFileSync(
        file,
        `${[
          "NOT VALID JSON }{",
          JSON.stringify({
            role: "user",
            message: {
              content: [
                { type: "text", text: "<user_query>hello</user_query>" },
              ],
            },
          }),
          JSON.stringify({
            role: "assistant",
            message: {
              content: [{ type: "text", text: "hi there" }],
            },
          }),
        ].join("\n")}\n`,
      );
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      // malformed line produced a warning
      const warns = result.issues.filter((i) => i.severity === "warning");
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(warns[0]?.message).toMatch(/JSON parse failed/);
      // the rest still parsed
      expect(result.data.transcript.messages).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes SessionSchema.parse for a clean fixture with no issues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-schema-"));
    try {
      const file = makeTopSession(dir);
      const result = await parseSessionFile(file);
      expect(result.success).toBe(true);
      if (!result.success) return;
      // issues must be empty for a clean fixture
      expect(result.issues).toEqual([]);
      // full schema validation must pass (throws on failure)
      expect(() => SessionSchema.parse(result.data)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("options.parentSessionId and options.projectPath override positional lineage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-opts-"));
    try {
      const file = join(dir, "session.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({
          role: "user",
          message: { content: [{ type: "text", text: "hi" }] },
        })}\n${JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "hey" }] },
        })}\n`,
      );
      const result = await parseSessionFile(file, {
        parentSessionId: "cc--parent-override",
        projectPath: "/override/path",
      });
      if (!result.success) throw new Error("parse failed");
      expect(result.data.parentSessionId).toBe("cc--parent-override");
      expect(result.data.projectPath).toBe("/override/path");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("payloadJson for a text part equals JSON.stringify of the wire part object with no extra keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-payload-"));
    try {
      const wirePart = { type: "text", text: "hi" };
      const file = join(dir, "payload.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({
          role: "user",
          message: { content: [wirePart] },
        })}\n${JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: "hello" }] },
        })}\n`,
      );
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const parts = result.data.transcript.messageParts ?? [];
      const textPart = parts.find(
        (p) => p.role === "user" && p.partType === "text",
      );
      if (!textPart) throw new Error("expected a user text part");
      expect(textPart.payloadJson).toBe(JSON.stringify(wirePart));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips Composer's trailing [REDACTED] reasoning token from assistant text while preserving the raw payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-redacted-"));
    try {
      const file = join(dir, "redacted.jsonl");
      writeFileSync(
        file,
        `${JSON.stringify({
          role: "user",
          message: {
            content: [
              {
                type: "text",
                text: "<user_query>\ninspect the configuration\n</user_query>",
              },
            ],
          },
        })}\n${JSON.stringify({
          // Silent tool round: text part is purely the reasoning placeholder.
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "[REDACTED]" },
              {
                type: "tool_use",
                name: "Grep",
                input: { pattern: "timeout" },
              },
            ],
          },
        })}\n${JSON.stringify({
          // Final turn: real prose with the placeholder appended.
          role: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "Inspection complete: configuration is valid.\n\n[REDACTED]",
              },
            ],
          },
        })}\n`,
      );
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const { messages, messageParts } = result.data.transcript;

      // The silent-tool-round turn keeps its tool call but has no leftover text.
      const toolTurn = messages.find((m) =>
        m.toolCalls.some((tc) => tc.name === "Grep"),
      );
      expect(toolTurn?.text).toBe("");

      // The final turn keeps its prose, minus the trailing placeholder.
      const finalTurn = messages.find((m) =>
        m.text.includes("Inspection complete"),
      );
      expect(finalTurn?.text).toBe(
        "Inspection complete: configuration is valid.",
      );

      // No normalized assistant text anywhere still carries the marker.
      for (const m of messages.filter((m) => m.role === "assistant")) {
        expect(m.text).not.toContain("[REDACTED]");
      }

      // Fidelity: the raw wire object is preserved verbatim in payloadJson.
      const rawHasMarker = (messageParts ?? []).some(
        (p) => p.partType === "text" && p.payloadJson.includes("[REDACTED]"),
      );
      expect(rawHasMarker).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a mid-text [REDACTED] mention untouched (anchored to end-of-string only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ac-cursor-midtext-"));
    try {
      const file = join(dir, "midtext.jsonl");
      const prose = "The log line showed [REDACTED] before the timestamp.";
      writeFileSync(
        file,
        `${JSON.stringify({
          role: "user",
          message: {
            content: [{ type: "text", text: "<user_query>\nq\n</user_query>" }],
          },
        })}\n${JSON.stringify({
          role: "assistant",
          message: { content: [{ type: "text", text: prose }] },
        })}\n`,
      );
      const result = await parseSessionFile(file);
      if (!result.success) throw new Error("parse failed");
      const finalTurn = result.data.transcript.messages.find(
        (m) => m.role === "assistant",
      );
      expect(finalTurn?.text).toBe(prose);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
