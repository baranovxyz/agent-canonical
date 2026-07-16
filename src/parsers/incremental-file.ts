/**
 * Shared incremental window over a JSONL transcript file (claude-code,
 * codex, cursor). Owns the cursor mechanics: file-identity keying,
 * truncation/rotation reset, and the complete-lines-only contract. Dialect
 * entries layer their event decoding on top.
 */

import { open, stat } from "node:fs/promises";
import type { FileCursor } from "./turn-events.js";
import { fail, ok, type ParseResult } from "./types.js";

const NEWLINE = 0x0a;

/**
 * Cursor at the file's current end-of-file — the pre-turn watermark.
 * A missing or unreadable file yields offset 0 (a later read scans the
 * just-created file from the start). Never fails.
 */
export async function snapshotFileCursor(
  filePath: string,
): Promise<FileCursor> {
  try {
    const st = await stat(filePath);
    return { kind: "file", path: filePath, offsetBytes: st.size };
  } catch {
    return { kind: "file", path: filePath, offsetBytes: 0 };
  }
}

export interface FileDelta {
  /** Complete (newline-terminated) lines appended past the cursor, in order. */
  lines: string[];
  nextCursor: FileCursor;
}

/**
 * Read the complete lines appended to `filePath` past `cursor`.
 *
 * - No cursor, a cursor for a different path (the CLI rotated stores), or a
 *   cursor past the current size (truncation) → read from offset 0.
 * - Only newline-terminated lines are consumed; an unterminated trailing
 *   line (mid-append) stays unconsumed so `nextCursor` always lands on a
 *   line boundary. A record the CLI never terminates with a newline is
 *   therefore invisible here — the application's bounded fallback covers it.
 * - An unreadable file fails with an error issue (the store may not be
 *   flushed yet); an empty delta is a success with zero lines.
 */
export async function readFileDelta(
  filePath: string,
  cursor?: FileCursor,
): Promise<ParseResult<FileDelta>> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
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
  try {
    const st = await handle.stat();
    const offset =
      cursor !== undefined &&
      cursor.path === filePath &&
      cursor.offsetBytes <= st.size
        ? cursor.offsetBytes
        : 0;
    if (st.size === offset) {
      return ok({
        lines: [],
        nextCursor: { kind: "file", path: filePath, offsetBytes: offset },
      });
    }
    const buf = Buffer.alloc(st.size - offset);
    await handle.read(buf, 0, buf.length, offset);
    const lastNewline = buf.lastIndexOf(NEWLINE);
    if (lastNewline === -1) {
      return ok({
        lines: [],
        nextCursor: { kind: "file", path: filePath, offsetBytes: offset },
      });
    }
    const consumed = buf.subarray(0, lastNewline + 1);
    const lines = consumed
      .toString("utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    return ok({
      lines,
      nextCursor: {
        kind: "file",
        path: filePath,
        offsetBytes: offset + consumed.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return fail([
      {
        severity: "error",
        message: `Cannot read file: ${msg}`,
        path: filePath,
      },
    ]);
  } finally {
    await handle.close().catch(() => {});
  }
}
