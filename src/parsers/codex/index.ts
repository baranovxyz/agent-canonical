/**
 * Codex transcript parser — public surface.
 *
 * Thin IO shell: read the rollout file, decode each line, reduce, assemble.
 * Format knowledge lives entirely in events.ts (decoder) and reduce.ts (reducer).
 *
 * @example
 *   import { parseSessionFile } from "agent-canonical/parsers/codex";
 *   const result = await parseSessionFile("/path/to/rollout.jsonl");
 *   if (result.success) console.log(result.data.id);
 */

import { readFile } from "node:fs/promises";
import type { Session } from "../../schemas/session.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import { decodeLine } from "./events.js";
import { assembleSession, reduceEvents } from "./reduce.js";

export type { ParseResult } from "../types.js";
export type { DecodedEvent } from "./events.js";
export { decodeLine } from "./events.js";
export { readEventsSince, snapshotCursor } from "./incremental.js";
export { assembleSession, reduceEvents } from "./reduce.js";

/**
 * Parse a Codex rollout JSONL file into a canonical Session.
 *
 * Failure cases:
 *   - File read error → fail with error issue
 *   - No sessionId in session_meta → fail with error issue
 *   - Zero messages after parsing → fail with error issue
 *
 * Malformed individual lines become warnings (never fatal).
 */
export async function parseSessionFile(
  filePath: string,
): Promise<ParseResult<Session>> {
  const collector = new IssueCollector();

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `failed to read codex rollout file: ${message}`,
        path: filePath,
      },
    ]);
  }

  const rawLines = raw.split("\n").filter(Boolean);
  const events = rawLines.map((line, seq) => decodeLine(line, seq, collector));

  const result = reduceEvents(events, rawLines, collector);

  if (!result.sessionId) {
    return fail([
      {
        severity: "error",
        message: "no session_meta with id found — cannot build session",
        path: filePath,
      },
    ]);
  }

  if (result.messages.length === 0) {
    return fail([
      {
        severity: "error",
        message: "session has zero messages after parsing",
        path: filePath,
      },
    ]);
  }

  const session = assembleSession(result, filePath);
  if (session === undefined) {
    // Should not happen given the guards above, but be explicit
    return fail([
      {
        severity: "error",
        message: "failed to assemble session (internal)",
        path: filePath,
      },
    ]);
  }

  return ok(session, collector.list());
}
