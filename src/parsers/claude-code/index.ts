/**
 * Claude Code transcript parser — public API.
 *
 * Layered architecture:
 *   1. `decodeLine`   — pure: one raw JSONL string → DecodedEvent (events.ts)
 *   2. `reduceEvents` — pure: DecodedEvent[] → ReducedSession       (reduce.ts)
 *   3. `parseSessionFile` — IO shell: read file → decode → reduce → Session
 *
 * Format knowledge lives once: both `decodeLine` and `reduceEvents` are
 * exported so an incremental reader can reuse them without the IO shell.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Session } from "../../schemas/session.js";
import type { Transcript } from "../../schemas/transcript.js";
import { SCHEMA_VERSION } from "../../schemas/version.js";
import { buildContentHash, deriveTitle } from "../shared.js";
import { fail, IssueCollector, ok, type ParseResult } from "../types.js";
import { decodeLine } from "./events.js";
import { reduceEvents } from "./reduce.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type {
  DecodedAssistant,
  DecodedEvent,
  DecodedUserArray,
  DecodedUserText,
} from "./events.js";
export { decodeLine } from "./events.js";
export { readEventsSince, snapshotCursor } from "./incremental.js";
export type { ReducedSession } from "./reduce.js";
export { reduceEvents } from "./reduce.js";
export type {
  WorkflowJournalEvent,
  WorkflowManifestAgent,
  WorkflowManifestPhase,
  WorkflowRunManifest,
} from "./workflow.js";
export { decodeWorkflowJournal, decodeWorkflowManifest } from "./workflow.js";

export interface ClaudeCodeParseOptions {
  /**
   * Prefix prepended to the session id (default: "cc").
   * The produced session always uses `claude-code` as its CLI kind.
   */
  idPrefix?: string;
}

// Zod schema for the sibling .meta.json file.
const MetaFileSchema = z.object({
  agentType: z.string().optional(),
});

/**
 * Parse one Claude Code JSONL file into a canonical `Session`.
 *
 * Returns `fail` when:
 *  - The file cannot be read.
 *  - No sessionId was found in the file (empty/no-op file).
 *  - The file produced zero messages after parsing.
 *
 * Malformed individual lines are recorded as warnings (not errors) and skipped;
 * the parse continues. File-level errors are fatal (fail with error issue).
 */
export async function parseSessionFile(
  filePath: string,
  opts: ClaudeCodeParseOptions = {},
): Promise<ParseResult<Session>> {
  const idPfx = opts.idPrefix ?? "cc";
  const issues = new IssueCollector();

  // ---- IO: read file ----
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `Cannot read file: ${msg}`,
        path: filePath,
      },
    ]);
  }

  const rawLines = raw.split("\n").filter((l) => l.length > 0);

  // ---- Decode: pure line decoder ----
  const events = rawLines.map((line, seq) => decodeLine(line, seq, issues));

  // ---- Reduce: pure session reducer ----
  const reduced = reduceEvents(events, rawLines, issues);

  // ---- Validate required fields ----
  if (!reduced.sessionId) {
    return fail([
      {
        severity: "error",
        message: "No sessionId found in file — cannot identify session",
        path: filePath,
      },
    ]);
  }

  if (reduced.messages.length === 0) {
    return fail([
      {
        severity: "error",
        message: "No messages parsed — file produced an empty session",
        path: filePath,
      },
    ]);
  }

  // ---- Assemble Session ----
  // For subagent files, agentId is the session's own identifier.
  const ownId = reduced.agentId ?? reduced.sessionId;
  const ownParentId =
    reduced.parentUuid !== undefined
      ? `${idPfx}--${reduced.parentUuid}`
      : undefined;

  const id = `${idPfx}--${ownId}`;
  const contentHash = buildContentHash(id, reduced.messages);

  const transcript: Transcript = {
    schemaVersion: SCHEMA_VERSION,
    messages: reduced.messages,
    contentHash,
    rawPath: filePath,
    rawEvents: reduced.rawEvents,
  };

  // Cumulative token totals (omit zero values for cleanliness).
  if (reduced.inputTokens > 0) transcript.inputTokens = reduced.inputTokens;
  if (reduced.outputTokens > 0) transcript.outputTokens = reduced.outputTokens;
  if (reduced.cacheReadTokens > 0)
    transcript.cacheReadTokens = reduced.cacheReadTokens;
  if (reduced.cacheCreationTokens > 0)
    transcript.cacheCreationTokens = reduced.cacheCreationTokens;

  const session: Session = {
    schemaVersion: SCHEMA_VERSION,
    id,
    cli: "claude-code",
    externalId: ownId,
    transcript,
  };

  if (ownParentId !== undefined) {
    session.parentSessionId = ownParentId;
    // Read sibling .meta.json for agentType (only present for subagent files).
    // Validated with Zod before accessing optional metadata.
    const metaPath = join(dirname(filePath), `agent-${ownId}.meta.json`);
    try {
      const metaRaw = await readFile(metaPath, "utf8");
      const metaParsed: unknown = JSON.parse(metaRaw);
      const metaResult = MetaFileSchema.safeParse(metaParsed);
      if (metaResult.success && metaResult.data.agentType !== undefined) {
        session.agentType = metaResult.data.agentType;
      }
    } catch {
      // meta.json missing or unreadable — agentType stays undefined.
    }
  }

  if (reduced.projectPath !== undefined)
    session.projectPath = reduced.projectPath;
  if (reduced.gitBranch !== undefined) session.gitBranch = reduced.gitBranch;
  if (reduced.model !== undefined) session.model = reduced.model;
  if (reduced.startedAt !== undefined) session.startedAt = reduced.startedAt;
  if (reduced.endedAt !== undefined) session.endedAt = reduced.endedAt;

  // Title: first non-thinking message's text, clipped to 200 characters.
  const title = deriveTitle(reduced.messages);
  if (title !== undefined) session.title = title;

  return ok(session, issues.list());
}
