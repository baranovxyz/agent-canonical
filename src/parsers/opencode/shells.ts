/**
 * IO shells for the opencode parser.
 *
 * These are the thin entry points that perform IO (file reads, DB queries),
 * then hand decoded records to the pure `buildSession` reducer.
 *
 * Neither shell carries format knowledge — that lives in reduce.ts.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Session } from "../../schemas/session.js";
import type { RawEvent } from "../../schemas/transcript.js";
import type { ParseResult } from "../types.js";
import { fail, IssueCollector, ok } from "../types.js";
import type {
  OtherPart,
  PatchPart,
  ReasoningPart,
  TextPart,
  ToolPart,
} from "./records.js";
import { decodeMessage, decodePart, decodeSession } from "./records.js";
import type { RawMessageBundle, ReducerIdentity } from "./reduce.js";
import { buildSession, OPENCODE_IDENTITY } from "./reduce.js";

/** Returns true when v is a non-null, non-array object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OpencodeParseOptions {
  /**
   * Root containing `session/`, `message/`, and `part/` subdirs.
   * Defaults to three levels above the session file path:
   *   `<dataRoot>/session/<projectId>/ses_*.json`
   */
  dataRoot?: string;
}

/**
 * Minimal structural DB handle matching the subset of better-sqlite3 used by
 * this parser. Consumers open and own the DB connection.
 */
export interface OpencodeDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

// ---------------------------------------------------------------------------
// File-based shell
// ---------------------------------------------------------------------------

/**
 * Parse one opencode session from its file-based store.
 *
 * Fails with `{success:false}` when:
 *   - the session file cannot be read or has no `id`
 *   - the message directory is missing / unreadable
 *
 * Malformed individual message/part files add warnings and are skipped
 * (IssueCollector). Returns `{success:false}` when the assembled session
 * has no usable messages.
 */
export async function parseSessionFile(
  sessionFilePath: string,
  opts: OpencodeParseOptions = {},
): Promise<ParseResult<Session>> {
  const collector = new IssueCollector();

  let sessionRaw: string;
  try {
    sessionRaw = await readFile(sessionFilePath, "utf8");
  } catch (err) {
    return fail([
      {
        severity: "error",
        message: `Cannot read session file: ${String(err)}`,
        path: sessionFilePath,
      },
    ]);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(sessionRaw);
  } catch {
    return fail([
      {
        severity: "error",
        message: "Session file is not valid JSON",
        path: sessionFilePath,
      },
    ]);
  }

  const session = decodeSession(rawJson);
  if (!session?.id) {
    return fail([
      {
        severity: "error",
        message: "Session record missing id",
        path: sessionFilePath,
      },
    ]);
  }

  const sessionId = session.id;
  const dataRoot = opts.dataRoot ?? dirname(dirname(dirname(sessionFilePath)));
  const messageDir = join(dataRoot, "message", sessionId);

  let messageFilenames: string[];
  try {
    messageFilenames = (await readdir(messageDir))
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch (err) {
    return fail([
      {
        severity: "error",
        message: `Cannot read message directory for session ${sessionId}: ${String(err)}`,
        path: messageDir,
      },
    ]);
  }

  const rawMessages: RawMessageBundle[] = [];

  for (const fname of messageFilenames) {
    const msgPath = join(messageDir, fname);
    let msgRaw: string;
    try {
      msgRaw = await readFile(msgPath, "utf8");
    } catch {
      collector.warn(`Cannot read message file ${fname}`, { path: msgPath });
      continue;
    }

    let msgJson: unknown;
    try {
      msgJson = JSON.parse(msgRaw);
    } catch {
      collector.warn(`Message file ${fname} is not valid JSON`, {
        path: msgPath,
      });
      continue;
    }

    const msg = decodeMessage(msgJson);
    if (!msg?.id) {
      collector.warn(`Message file ${fname} missing id, skipped`, {
        path: msgPath,
      });
      continue;
    }

    const partDir = join(dataRoot, "part", msg.id);
    const parts: Array<
      TextPart | ReasoningPart | ToolPart | PatchPart | OtherPart
    > = [];

    try {
      const partFilenames = (await readdir(partDir))
        .filter((n) => n.endsWith(".json"))
        .sort();

      for (const pf of partFilenames) {
        const partPath = join(partDir, pf);
        let partRaw: string;
        try {
          partRaw = await readFile(partPath, "utf8");
        } catch {
          collector.warn(`Cannot read part file ${pf}`, { path: partPath });
          continue;
        }
        let partJson: unknown;
        try {
          partJson = JSON.parse(partRaw);
        } catch {
          collector.warn(`Part file ${pf} is not valid JSON`, {
            path: partPath,
          });
          continue;
        }
        const part = decodePart(partJson);
        if (!part) {
          collector.warn(`Part file ${pf} has unrecognised shape, skipped`, {
            path: partPath,
          });
          continue;
        }
        parts.push(part);
      }
    } catch {
      // No parts directory — empty message; keep iterating.
    }

    rawMessages.push({ msg, parts });
  }

  // Build raw events with the session first, then messages and parts interleaved.
  const rawEvents: RawEvent[] = [
    { seq: 0, eventType: "session", rawJson: sessionRaw },
    ...rawMessages.flatMap(({ msg, parts }, idx) => [
      {
        seq: idx * 100 + 1,
        eventType: "message",
        rawJson: JSON.stringify(msg),
      },
      ...parts.map((part, partIdx) => ({
        seq: idx * 100 + partIdx + 2,
        eventType: part.type,
        rawJson: JSON.stringify(part),
      })),
    ]),
  ];

  const result = buildSession(
    session,
    rawMessages,
    sessionFilePath,
    rawEvents,
    collector,
  );
  if (!result) {
    collector.error("Session has no usable messages", {
      path: sessionFilePath,
    });
    return fail(collector.list());
  }

  return ok(result, collector.list());
}

// ---------------------------------------------------------------------------
// DB-based shell
// ---------------------------------------------------------------------------

// Permissive row schemas — require only the exact columns the code dereferences.
// Nullable columns are z.union([...]) or z.null() so real SQL NULLs pass.

const SessionRowSchema = z.object({
  id: z.string(),
  parent_id: z.union([z.string(), z.null()]),
  directory: z.union([z.string(), z.null()]),
  title: z.union([z.string(), z.null()]),
  version: z.union([z.string(), z.null()]),
  time_created: z.union([z.number(), z.null()]),
  time_updated: z.union([z.number(), z.null()]),
});
type SessionRow = z.infer<typeof SessionRowSchema>;

const MessageRowSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  time_created: z.union([z.number(), z.null()]),
  data: z.string(),
});
type MessageRow = z.infer<typeof MessageRowSchema>;

const PartRowSchema = z.object({
  id: z.string(),
  message_id: z.string(),
  time_created: z.union([z.number(), z.null()]),
  data: z.string(),
});
type PartRow = z.infer<typeof PartRowSchema>;

const SessionIdRowSchema = z.object({ id: z.string() });

/**
 * Parse one opencode session from an open `opencode.db`.
 *
 * This DB-backed entry point is synchronous.
 * Fails with `{success:false}` when:
 *   - the session id does not exist in the DB
 *   - the assembled session has no usable messages
 *
 * Malformed part data rows add warnings and are skipped.
 *
 * `identity` selects the canonical `cli` / id prefix stamped on the result; it
 * defaults to opencode. Forks with a compatible reader-facing storage shape
 * (e.g. Kilo Code) reuse this shell and pass their own identity.
 */
export function parseSessionFromDb(
  db: OpencodeDb,
  sessionId: string,
  rawPath: string,
  identity: ReducerIdentity = OPENCODE_IDENTITY,
): ParseResult<Session> {
  const collector = new IssueCollector();

  const sessionRowRaw = db
    .prepare(
      "SELECT id, parent_id, directory, title, version, time_created, time_updated FROM session WHERE id = ?",
    )
    .get(sessionId);

  if (sessionRowRaw === undefined || sessionRowRaw === null) {
    return fail([
      {
        severity: "error",
        message: `Session id ${sessionId} not found in DB`,
        path: rawPath,
      },
    ]);
  }

  const sessionRowParsed = SessionRowSchema.safeParse(sessionRowRaw);
  if (!sessionRowParsed.success) {
    return fail([
      {
        severity: "error",
        message: `Session row for ${sessionId} has unexpected shape: ${sessionRowParsed.error.message}`,
        path: rawPath,
      },
    ]);
  }
  const sessionRow: SessionRow = sessionRowParsed.data;

  const session = {
    id: sessionRow.id,
    parentID: sessionRow.parent_id ?? undefined,
    title: sessionRow.title ?? undefined,
    version: sessionRow.version ?? undefined,
    directory: sessionRow.directory ?? undefined,
    time: {
      created: sessionRow.time_created ?? undefined,
      updated: sessionRow.time_updated ?? undefined,
    },
  };

  const messageRowsRaw = db
    .prepare(
      "SELECT id, session_id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created",
    )
    .all(sessionId);

  const messageRows: MessageRow[] = [];
  for (const raw of messageRowsRaw) {
    const parsed = MessageRowSchema.safeParse(raw);
    if (parsed.success) {
      messageRows.push(parsed.data);
    } else {
      collector.warn(
        `Skipping malformed message row: ${parsed.error.message}`,
        { path: rawPath },
      );
    }
  }

  if (messageRows.length === 0) {
    return fail([
      {
        severity: "error",
        message: `Session ${sessionId} has no message rows`,
        path: rawPath,
      },
    ]);
  }

  const partRowsRaw = db
    .prepare(
      "SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created",
    )
    .all(sessionId);

  const partRows: PartRow[] = [];
  for (const raw of partRowsRaw) {
    const parsed = PartRowSchema.safeParse(raw);
    if (parsed.success) {
      partRows.push(parsed.data);
    } else {
      collector.warn(`Skipping malformed part row: ${parsed.error.message}`, {
        path: rawPath,
      });
    }
  }

  const partsByMsg = new Map<
    string,
    Array<TextPart | ReasoningPart | ToolPart | PatchPart | OtherPart>
  >();

  for (const pr of partRows) {
    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(pr.data);
    } catch {
      collector.warn(`Part row ${pr.id} has invalid JSON data, skipped`, {
        path: rawPath,
      });
      continue;
    }

    // Merge DB columns (id, message_id) back onto the payload so file- and
    // DB-backed records share the same decoded shape.
    const merged = isRecord(payloadJson)
      ? { ...payloadJson, id: pr.id, messageID: pr.message_id }
      : { id: pr.id, messageID: pr.message_id, type: "unknown" };

    const part = decodePart(merged);
    if (!part) {
      collector.warn(`Part row ${pr.id} has unrecognised shape, skipped`, {
        path: rawPath,
      });
      continue;
    }

    const arr = partsByMsg.get(pr.message_id) ?? [];
    arr.push(part);
    partsByMsg.set(pr.message_id, arr);
  }

  const rawMessages: RawMessageBundle[] = [];
  for (const mr of messageRows) {
    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(mr.data);
    } catch {
      collector.warn(`Message row ${mr.id} has invalid JSON data, skipped`, {
        path: rawPath,
      });
      continue;
    }

    const merged = isRecord(payloadJson)
      ? { ...payloadJson, id: mr.id, sessionID: mr.session_id }
      : { id: mr.id, sessionID: mr.session_id };

    const msg = decodeMessage(merged);
    if (!msg) {
      collector.warn(`Message row ${mr.id} failed decode, skipped`, {
        path: rawPath,
      });
      continue;
    }

    rawMessages.push({ msg, parts: partsByMsg.get(mr.id) ?? [] });
  }

  // Build raw events: session row first, then message rows, then part rows.
  const rawEvents: RawEvent[] = [
    { seq: 0, eventType: "session", rawJson: JSON.stringify(sessionRow) },
    ...messageRows.map((mr, idx) => ({
      seq: idx + 1,
      eventType: "message",
      ...(typeof mr.time_created === "number"
        ? { ts: Math.floor(mr.time_created / 1000) }
        : {}),
      rawJson: JSON.stringify(mr),
    })),
    ...partRows.map((pr, idx) => ({
      seq: messageRows.length + idx + 1,
      eventType: "part",
      ...(typeof pr.time_created === "number"
        ? { ts: Math.floor(pr.time_created / 1000) }
        : {}),
      rawJson: JSON.stringify(pr),
    })),
  ];

  const result = buildSession(
    session,
    rawMessages,
    rawPath,
    rawEvents,
    collector,
    identity,
  );
  if (!result) {
    collector.error(`Session ${sessionId} has no usable messages`, {
      path: rawPath,
    });
    return fail(collector.list());
  }

  return ok(result, collector.list());
}

// ---------------------------------------------------------------------------
// List helper
// ---------------------------------------------------------------------------

/**
 * List all session ids in an opencode DB, oldest first.
 * Infallible: driver errors propagate naturally.
 */
export function listSessionIds(db: OpencodeDb): string[] {
  const rows = db.prepare("SELECT id FROM session ORDER BY time_created").all();
  const ids: string[] = [];
  for (const row of rows) {
    const parsed = SessionIdRowSchema.safeParse(row);
    if (parsed.success) {
      ids.push(parsed.data.id);
    }
    // schema-reject rows silently skipped (no collector in scope)
  }
  return ids;
}
