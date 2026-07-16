/**
 * Cursor transcript parser — public entry point.
 *
 * Layered design:
 *   events.ts   — pure line decoder  (wire-format knowledge, no IO)
 *   reduce.ts   — pure session reducer (no IO)
 *   index.ts    — thin IO shell (readFile + mtime fallback)
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Session } from "../../schemas/session.js";
import {
  fail,
  type IssueCollector,
  IssueCollector as IssueCollectorClass,
  ok,
  type ParseResult,
} from "../types.js";
import { decodeLine } from "./events.js";
import { assembleSession, reduceEvents, resolveLineage } from "./reduce.js";

export interface CursorParseOptions {
  /** If set, the produced session is marked as a child of this id. */
  parentSessionId?: string;
  /** Override the project path (otherwise derived from filePath). */
  projectPath?: string;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (IO layer only)
// ---------------------------------------------------------------------------

async function getFileMtimeSeconds(
  filePath: string,
): Promise<number | undefined> {
  try {
    const s = await stat(filePath);
    return Math.floor(s.mtimeMs / 1000);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Cursor JSONL session file into a canonical `Session`.
 *
 * Returns `fail` if the file cannot be read or contains no usable messages.
 * Malformed JSONL lines are collected as warnings (the rest of the file
 * continues to parse).
 */
export async function parseSessionFile(
  filePath: string,
  opts: CursorParseOptions = {},
): Promise<ParseResult<Session>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    return fail<Session>([
      {
        severity: "error",
        message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
        path: filePath,
      },
    ]);
  }

  const issues: IssueCollector = new IssueCollectorClass();
  const lines = raw.split("\n").filter(Boolean);
  const events = lines.map((line, seq) => decodeLine(line, seq, issues));

  const reduced = reduceEvents(events, lines);

  if (reduced.messages.length === 0) {
    return fail<Session>([
      {
        severity: "error",
        message: "No usable messages found in Cursor session file",
        path: filePath,
      },
    ]);
  }

  // mtime fallback: keep IO in the shell, not the reducer
  let resolvedStartedAt = reduced.startedAt;
  if (resolvedStartedAt === undefined) {
    resolvedStartedAt = await getFileMtimeSeconds(filePath);
  }

  const sessionUuid = basename(filePath, ".jsonl");
  const lineage = resolveLineage(filePath, opts);
  const session = assembleSession(
    sessionUuid,
    filePath,
    reduced,
    resolvedStartedAt,
    lineage,
  );

  return ok(session, issues.list());
}

// Re-export pure sub-components for consumers that need them directly
export { decodeLine } from "./events.js";
// Incremental turn-event reader.
export { readEventsSince, snapshotCursor } from "./incremental.js";
export { assembleSession, reduceEvents, resolveLineage } from "./reduce.js";
