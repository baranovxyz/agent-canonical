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
    expect(DIALECTS.copilot.transcriptStore.root).toBe(
      "~/.copilot/session-state",
    );
    expect(DIALECTS.copilot.transcriptStore.pathPattern).toBe(
      "<sessionId>/events.jsonl",
    );
    // Pi nests one cwd-slug directory between the root and the session file.
    expect(DIALECTS.pi.transcriptStore.root).toBe("~/.pi/agent/sessions");
    expect(DIALECTS.pi.transcriptStore.pathPattern).toBe(
      "<cwd-slug>/<ISO-timestamp>_<sessionId>.jsonl",
    );
    // Droid slugs the session cwd into the directory name (`/` becomes `-`).
    expect(DIALECTS.droid.transcriptStore.root).toBe("~/.factory/sessions");
    expect(DIALECTS.droid.transcriptStore.pathPattern).toBe(
      "<dash-slug-cwd>/<sessionId>.jsonl",
    );
    // Vibe's session unit is a directory holding messages.jsonl + meta.json,
    // and only the first 8 characters of the uuid reach the directory name.
    expect(DIALECTS.vibe.transcriptStore.root).toBe("~/.vibe/logs/session");
    expect(DIALECTS.vibe.transcriptStore.pathPattern).toBe(
      "<prefix>_<timestamp>_<short-sessionId>/messages.jsonl",
    );
  });

  it("pins store kinds and watermark axes", () => {
    expect(DIALECTS.opencode.transcriptStore.kind).toBe("sqlite");
    expect(DIALECTS.opencode.transcriptStore.watermarkAxis).toBe(
      "row-time-created",
    );
    // Cline keeps one JSON object per session file (not JSONL, not SQLite).
    expect(DIALECTS.cline.transcriptStore.kind).toBe("json");
    // Copilot's events.jsonl is an append-only typed event stream.
    for (const kind of [
      "claude-code",
      "codex",
      "cursor",
      "gemini",
      "qwen",
      "copilot",
      "pi",
      "droid",
      "vibe",
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
    expect(DIALECTS.copilot.turnEnd.kind).toBe("explicit");
    expect(DIALECTS.copilot.turnEnd.description).toContain(
      "assistant.turn_end",
    );
    expect(DIALECTS.copilot.capabilities.explicitTurnEnd).toBe(true);
    expect(DIALECTS.pi.turnEnd.kind).toBe("explicit");
    expect(DIALECTS.pi.turnEnd.description).toContain("stopReason");
    expect(DIALECTS.pi.capabilities.explicitTurnEnd).toBe(true);
    // Pi's `aborted` stopReason is documented upstream but unobserved here.
    expect(DIALECTS.pi.turnEnd.abortDescription).toBeUndefined();
    expect(DIALECTS.pi.capabilities.abortSignalOnDisk).toBe(false);
    expect(DIALECTS.droid.turnEnd.kind).toBe("explicit");
    expect(DIALECTS.droid.turnEnd.description).toContain("agent_turn_outcome");
    expect(DIALECTS.droid.capabilities.explicitTurnEnd).toBe(true);
    // Droid records completed | error outcomes; no abort marker was observed.
    expect(DIALECTS.droid.turnEnd.abortDescription).toBeUndefined();
    expect(DIALECTS.droid.capabilities.abortSignalOnDisk).toBe(false);
    expect(DIALECTS.vibe.turnEnd.kind).toBe("derived");
    expect(DIALECTS.vibe.turnEnd.description).toContain("no tool_calls");
    expect(DIALECTS.vibe.capabilities.explicitTurnEnd).toBe(false);
    // Vibe's only cancellation marker is tool-scoped (a refused call), so it is
    // described but does not make an aborted TURN detectable on disk.
    expect(DIALECTS.vibe.turnEnd.abortDescription).toContain(
      "user_cancellation",
    );
    expect(DIALECTS.vibe.capabilities.abortSignalOnDisk).toBe(false);

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

  // Droid and Vibe are the counter-examples: their tokens are session-level
  // only, in a sibling file (`<uuid>.settings.json` / `meta.json`).
  it("pins per-message usage: cc, oc, gemini, qwen, kilo, goose, cline, copilot, and pi", () => {
    for (const kind of CliKindSchema.options) {
      expect(DIALECTS[kind].capabilities.perMessageUsage).toBe(
        kind === "claude-code" ||
          kind === "opencode" ||
          kind === "gemini" ||
          kind === "qwen" ||
          kind === "kilo" ||
          kind === "goose" ||
          kind === "cline" ||
          kind === "copilot" ||
          kind === "pi",
      );
    }
  });

  it("pins binary names, including the cursor → cursor-agent split", () => {
    expect(DIALECTS["claude-code"].binary).toBe("claude");
    expect(DIALECTS.codex.binary).toBe("codex");
    expect(DIALECTS.opencode.binary).toBe("opencode");
    expect(DIALECTS.cursor.binary).toBe("cursor-agent");
    expect(DIALECTS.gemini.binary).toBe("gemini");
    expect(DIALECTS.cline.binary).toBe("cline");
    expect(DIALECTS.copilot.binary).toBe("copilot");
    expect(DIALECTS.pi.binary).toBe("pi");
    expect(DIALECTS.droid.binary).toBe("droid");
    expect(DIALECTS.vibe.binary).toBe("vibe");
  });
});
