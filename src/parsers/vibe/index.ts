/**
 * Mistral Vibe transcript parser — public surface.
 *
 * Vibe (`mistral-vibe` on PyPI, binary `vibe`, open source) writes each session
 * as a DIRECTORY under `~/.vibe/logs/session/`, named
 * `<prefix>_<YYYYmmdd_HHMMSS>_<first-8-of-uuid>`, holding two files:
 * `messages.jsonl` (one raw OpenAI chat-completions message per line) and
 * `meta.json` (the sidecar, rewritten atomically after every turn). A
 * `.last_session/<tty>` pointer file sits at the store root beside the session
 * directories and is ignored.
 *
 * This shell accepts either the session directory or its `messages.jsonl` path,
 * decodes each line, reads the sibling `meta.json` when present, builds the
 * lossless raw-event array (one entry per decoded line), and reduces. All Vibe
 * format knowledge lives in records.ts (decoders) and reduce.ts (reducer).
 *
 * `meta.json` is read for the session-level facts the JSONL does not carry
 * (identity, timing, cwd, git branch, model, token totals) but it is not a raw
 * event: `rawEvents` mirrors `messages.jsonl` exactly, one entry per line, so a
 * consumer can count lines from it. The sidecar itself stays on disk next to
 * `transcript.rawPath`.
 *
 * `messages.jsonl` is NOT strictly append-only. Vibe appends when the new
 * message list extends the persisted one, but rewinding or editing the tail
 * takes a full-file rewrite path instead, so a byte-offset watermark can go
 * stale mid-session. This entry is full-store-only for that reason.
 *
 * @example
 *   import { parseSessionFile } from "agent-canonical/parsers/vibe";
 *   const r = await parseSessionFile("/path/to/session_20260101_000000_f1000001");
 *   if (r.success) console.log(r.data.id);
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Session } from "../../schemas/session.js";
import type { RawEvent } from "../../schemas/transcript.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import type { VibeMessageRecord } from "./records.js";
import {
  decodeMessageLine,
  decodeMetaFile,
  MESSAGES_FILENAME,
  METADATA_FILENAME,
} from "./records.js";
import { buildSession } from "./reduce.js";

export type {
  VibeChildSessionLink,
  VibeMessageRecord,
  VibeSessionMeta,
  VibeSessionStats,
  VibeToolCall,
  VibeToolResult,
} from "./records.js";
export {
  decodeMessageLine,
  decodeMetaFile,
  MESSAGES_FILENAME,
  METADATA_FILENAME,
  USER_CANCELLATION_MARKER,
} from "./records.js";
export { buildSession } from "./reduce.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve the two file paths from whatever the caller passed: the session
 * directory, or the `messages.jsonl` inside it. Both forms are accepted because
 * Vibe's unit of a session is the directory, not a single file.
 */
function resolvePaths(sessionPath: string): {
  sessionDir: string;
  messagesPath: string;
  metaPath: string;
} {
  const sessionDir =
    basename(sessionPath) === MESSAGES_FILENAME
      ? dirname(sessionPath)
      : sessionPath;
  return {
    sessionDir,
    messagesPath: join(sessionDir, MESSAGES_FILENAME),
    metaPath: join(sessionDir, METADATA_FILENAME),
  };
}

/** Raw-event type for one line: `message:<role>`, or undefined when roleless. */
function rawEventType(obj: unknown): string | undefined {
  if (!isRecord(obj) || typeof obj.role !== "string") return undefined;
  return `message:${obj.role}`;
}

/**
 * Parse one Vibe session into a canonical Session. Accepts the session
 * directory or its `messages.jsonl` path.
 *
 * The session id comes from `meta.json`'s `session_id` (the full uuid). Without
 * the sidecar it falls back to the session DIRECTORY NAME: the directory keeps
 * only the first 8 characters of the uuid, so the full id is unrecoverable from
 * the filesystem alone, and the directory name is the one identifier that is
 * both on disk and unique within the store.
 *
 * Failure cases:
 *   - `messages.jsonl` read error → fail with an error issue.
 *   - Zero decodable lines → fail with an error issue.
 *   - Zero usable messages after reduction → fail with an error issue.
 */
export async function parseSessionFile(
  sessionPath: string,
): Promise<ParseResult<Session>> {
  const collector = new IssueCollector();
  const { sessionDir, messagesPath, metaPath } = resolvePaths(sessionPath);

  let text: string;
  try {
    text = await readFile(messagesPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `failed to read vibe messages file: ${message}`,
        path: messagesPath,
      },
    ]);
  }

  const records: VibeMessageRecord[] = [];
  const rawEvents: RawEvent[] = [];
  let seq = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      collector.warn("skipping malformed vibe message line", {
        seq,
        path: messagesPath,
      });
      continue;
    }

    const decoded = decodeMessageLine(obj);
    if (decoded === null) {
      collector.warn("skipping undecodable vibe message line", {
        seq,
        path: messagesPath,
      });
      continue;
    }

    // No line in messages.jsonl carries a timestamp, so a raw event never has
    // one either — the session window lives in meta.json.
    const eventType = rawEventType(obj);
    const rawEvent: RawEvent = { seq, rawJson: trimmed };
    if (eventType !== undefined) rawEvent.eventType = eventType;
    rawEvents.push(rawEvent);
    seq += 1;
    records.push(decoded);
  }

  if (records.length === 0) {
    return fail([
      {
        severity: "error",
        message: "vibe session has no decodable messages",
        path: messagesPath,
      },
    ]);
  }

  let meta: ReturnType<typeof decodeMetaFile> | undefined;
  try {
    meta = decodeMetaFile(JSON.parse(await readFile(metaPath, "utf8")));
  } catch {
    meta = undefined; // absent/unreadable sidecar is non-fatal
  }

  const sessionId = meta?.sessionId ?? basename(sessionDir);

  const session = buildSession(
    records,
    meta,
    sessionId,
    messagesPath,
    rawEvents,
    collector,
  );
  if (!session) {
    return fail([
      {
        severity: "error",
        message: "vibe session produced zero messages",
        path: messagesPath,
      },
    ]);
  }

  return ok(session, collector.list());
}
