import { describe, expect, it } from "vitest";
import {
  ArtifactPartSchema,
  ArtifactSchema,
  RoleSchema,
  SCHEMA_VERSION,
  SessionSchema,
  SettingsSchema,
  TranscriptSchema,
} from "../src/schemas/index.js";

describe("SessionSchema", () => {
  it("parses a minimal session and applies defaults at both levels", () => {
    const session = SessionSchema.parse({
      id: "s1",
      cli: "claude-code",
      transcript: { contentHash: "abc" },
    });
    expect(session.schemaVersion).toBe(SCHEMA_VERSION);
    expect(session.transcript.schemaVersion).toBe(SCHEMA_VERSION);
    expect(session.transcript.messages).toEqual([]);
  });

  it("round-trips the lossless tier when the dialect provides it", () => {
    const session = SessionSchema.parse({
      id: "s2",
      cli: "opencode",
      status: "complete",
      startedAt: 1_700_000_000,
      transcript: {
        contentHash: "def",
        inputTokens: 100,
        outputTokens: 50,
        messages: [
          { turn: 1, role: "user", text: "do the thing" },
          {
            turn: 1,
            role: "assistant",
            text: "done",
            usage: { outputTokens: 50, cacheReadTokens: 10 },
            toolCalls: [
              {
                name: "bash",
                argsHash: "h",
                argsPreview: "ls",
                outputPreview: "files",
                outputFull: "files and more files",
              },
            ],
          },
        ],
        rawEvents: [{ seq: 0, rawJson: "{}" }],
        messageParts: [
          {
            sourceSeq: 0,
            partIdx: 0,
            role: "assistant",
            partType: "text",
            payloadJson: "{}",
          },
        ],
      },
    });
    expect(session.transcript.messages[1]?.usage?.outputTokens).toBe(50);
    expect(session.transcript.messages[1]?.toolCalls[0]?.outputFull).toContain(
      "more files",
    );
    expect(session.transcript.rawEvents).toHaveLength(1);
    expect(session.transcript.messageParts?.[0]?.includedInMessageText).toBe(
      false,
    );
  });

  it("rejects a cli kind without a dialect", () => {
    const result = SessionSchema.safeParse({
      id: "s3",
      cli: "aider",
      transcript: { contentHash: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown schemaVersion", () => {
    const result = SessionSchema.safeParse({
      schemaVersion: SCHEMA_VERSION + 1,
      id: "s4",
      cli: "codex",
      transcript: { contentHash: "x" },
    });
    expect(result.success).toBe(false);
  });
});

describe("RoleSchema", () => {
  it("accepts only the five core conversational roles", () => {
    expect(RoleSchema.options).toEqual([
      "user",
      "assistant",
      "thinking",
      "system",
      "subagent",
    ]);
    expect(RoleSchema.safeParse("review_comment").success).toBe(false);
  });
});

describe("TranscriptSchema", () => {
  it("rejects a message with a non-core role", () => {
    const result = TranscriptSchema.safeParse({
      contentHash: "x",
      messages: [{ turn: 1, role: "commit_message", text: "hi" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("ArtifactSchema (reference-first)", () => {
  it("rejects a part with no uri/path reference", () => {
    const result = ArtifactPartSchema.safeParse({
      inlineContent: "big blob",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a referenced part, with inline content as an optional extra", () => {
    const artifact = ArtifactSchema.parse({
      artifactId: "a1",
      name: "report",
      parts: [
        {
          path: "artifacts/report.md",
          contentHash: "sha256:abc",
          byteCount: 1024,
          inlineContent: "# Report",
        },
      ],
    });
    expect(artifact.parts[0]?.path).toBe("artifacts/report.md");
    expect(artifact.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("SettingsSchema (stub)", () => {
  it("parses with the schemaVersion default", () => {
    const settings = SettingsSchema.parse({ cli: "cursor" });
    expect(settings.schemaVersion).toBe(SCHEMA_VERSION);
  });
});
