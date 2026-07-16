import { describe, expect, it } from "vitest";
import type { DialectProvenance } from "../src/dialects/index.js";
import { DIALECTS, getDialect } from "../src/dialects/index.js";
import { CliKindSchema } from "../src/schemas/index.js";

describe("dialect registry", () => {
  it("has exactly one descriptor per CliKind, keyed by its id", () => {
    for (const kind of CliKindSchema.options) {
      expect(DIALECTS[kind].id).toBe(kind);
      expect(getDialect(kind)).toBe(DIALECTS[kind]);
    }
    expect(Object.keys(DIALECTS).sort()).toEqual(
      [...CliKindSchema.options].sort(),
    );
  });

  it("exports the validated provenance shape", () => {
    const provenance: DialectProvenance = { cliVersions: ["1.0.0"] };

    expect(provenance.cliVersions).toEqual(["1.0.0"]);
  });
});

// These facts describe the supported on-disk transcript formats.
describe("dialect golden facts", () => {
  it("pins transcript store locations", () => {
    expect(DIALECTS["claude-code"].transcriptStore.root).toBe(
      "~/.claude/projects",
    );
    expect(DIALECTS.codex.transcriptStore.root).toBe("~/.codex/sessions");
    expect(DIALECTS.opencode.transcriptStore.root).toBe(
      "~/.local/share/opencode",
    );
    expect(DIALECTS.opencode.transcriptStore.pathPattern).toBe("opencode.db");
    expect(DIALECTS.cursor.transcriptStore.root).toBe("~/.cursor/projects");
    expect(DIALECTS.gemini.transcriptStore.root).toBe("~/.gemini/tmp");
    expect(DIALECTS.qwen.transcriptStore.root).toBe("~/.qwen/projects");
    expect(DIALECTS.goose.transcriptStore.root).toBe(
      "<Goose data dir>/sessions",
    );
    expect(DIALECTS.goose.transcriptStore.pathPattern).toBe("sessions.db");
    expect(DIALECTS.cline.transcriptStore.root).toBe("~/.cline/data/sessions");
  });

  it("pins store kinds and watermark axes", () => {
    expect(DIALECTS.opencode.transcriptStore.kind).toBe("sqlite");
    expect(DIALECTS.opencode.transcriptStore.watermarkAxis).toBe(
      "row-time-created",
    );
    // Cline keeps one JSON object per session file (not JSONL, not SQLite).
    expect(DIALECTS.cline.transcriptStore.kind).toBe("json");
    for (const kind of [
      "claude-code",
      "codex",
      "cursor",
      "gemini",
      "qwen",
    ] as const) {
      expect(DIALECTS[kind].transcriptStore.kind).toBe("jsonl");
      expect(DIALECTS[kind].transcriptStore.watermarkAxis).toBe("byte-offset");
    }
  });

  it("pins turn-end signals and incremental-reader availability", () => {
    expect(DIALECTS["claude-code"].turnEnd.kind).toBe("explicit");
    expect(DIALECTS["claude-code"].turnEnd.description).toContain("end_turn");
    expect(DIALECTS.codex.turnEnd.description).toContain("task_complete");
    expect(DIALECTS.opencode.turnEnd.description).toContain('"tool-calls"');
    expect(DIALECTS.cursor.turnEnd.kind).toBe("derived");
    expect(DIALECTS.cursor.capabilities.explicitTurnEnd).toBe(false);
    expect(DIALECTS.gemini.turnEnd.kind).toBe("unavailable");
    expect(DIALECTS.gemini.capabilities.explicitTurnEnd).toBe(false);
    expect(DIALECTS.qwen.turnEnd.kind).toBe("unavailable");

    for (const kind of CliKindSchema.options) {
      expect(DIALECTS[kind].capabilities.incrementalRead).toBe(
        kind === "claude-code" ||
          kind === "codex" ||
          kind === "opencode" ||
          kind === "cursor",
      );
    }
  });

  it("pins abort markers for codex and OpenCode-format stores", () => {
    expect(DIALECTS.codex.turnEnd.abortDescription).toContain("turn_aborted");
    expect(DIALECTS.opencode.turnEnd.abortDescription).toContain(
      "MessageAbortedError",
    );
    expect(DIALECTS.kilo.turnEnd.abortDescription).toContain(
      "MessageAbortedError",
    );
    expect(DIALECTS["claude-code"].turnEnd.abortDescription).toBeUndefined();
    expect(DIALECTS["claude-code"].capabilities.abortSignalOnDisk).toBe(false);
    expect(DIALECTS.cursor.capabilities.abortSignalOnDisk).toBe(false);
  });

  it("pins awaiting capabilities: cc questions only, permission nowhere", () => {
    for (const kind of CliKindSchema.options) {
      expect(DIALECTS[kind].capabilities.permissionAwaitingOnDisk).toBe(false);
      expect(DIALECTS[kind].capabilities.questionAwaitingOnDisk).toBe(
        kind === "claude-code",
      );
    }
  });

  it("pins per-message usage: cc, oc, gemini, qwen, kilo, goose, and cline", () => {
    for (const kind of CliKindSchema.options) {
      expect(DIALECTS[kind].capabilities.perMessageUsage).toBe(
        kind === "claude-code" ||
          kind === "opencode" ||
          kind === "gemini" ||
          kind === "qwen" ||
          kind === "kilo" ||
          kind === "goose" ||
          kind === "cline",
      );
    }
  });

  it("pins binary names, including the cursor → cursor-agent and cline → clite splits", () => {
    expect(DIALECTS["claude-code"].binary).toBe("claude");
    expect(DIALECTS.codex.binary).toBe("codex");
    expect(DIALECTS.opencode.binary).toBe("opencode");
    expect(DIALECTS.cursor.binary).toBe("cursor-agent");
    expect(DIALECTS.gemini.binary).toBe("gemini");
    // The @cline/cli package installs its binary as `clite`, not `cline`.
    expect(DIALECTS.cline.binary).toBe("clite");
  });
});
