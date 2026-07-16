/**
 * Pure line decoder for the Cursor JSONL transcript format.
 *
 * Knows the wire format only — no IO, no session assembly.
 * A streaming reader can import `decodeLine` directly without
 * pulling in the session reducer or IO shell.
 *
 * Cursor JSONL format summary:
 *   - Each line: { role: "user"|"assistant", message: { content: ContentPart[] } }
 *   - No structured timestamp field, model, parentUuid, tool_use_id, or usage stats.
 *   - Content parts: text, tool_use, image.
 *   - There are NO `tool_result` parts — only the agent's writes are recorded.
 *   - startedAt is recovered from a `<timestamp>` tag injected into user text.
 */

import { z } from "zod";
import type { IssueCollector } from "../types.js";

// ---------------------------------------------------------------------------
// Wire-format schemas (permissive — only fields the parser consumes)
// ---------------------------------------------------------------------------

const TextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string().optional(),
});

const ToolUsePartSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string().optional(),
  input: z.unknown().optional(),
});

const ImagePartSchema = z.object({
  type: z.literal("image"),
});

// Fallback: any other content-part shape — decoded as "other"
const OtherPartSchema = z.object({
  type: z.string(),
});

const ContentPartSchema = z.union([
  TextPartSchema,
  ToolUsePartSchema,
  ImagePartSchema,
  OtherPartSchema,
]);

export type DecodedContentPart = z.infer<typeof ContentPartSchema>;

const RawLineSchema = z.object({
  role: z.string().optional(),
  message: z
    .object({
      content: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
});

type RawLine = z.infer<typeof RawLineSchema>;

// ---------------------------------------------------------------------------
// Decoded event vocabulary
// ---------------------------------------------------------------------------

export interface DecodedTextPart {
  kind: "text";
  partType: "text";
  partIdx: number;
  /** Sanitized (user) or raw (assistant) text. */
  text: string;
  /** Raw JSON of the original wire part object (no extra keys). */
  payloadJson: string;
}

export interface DecodedToolUsePart {
  kind: "tool_use";
  partType: "tool_use";
  partIdx: number;
  name: string;
  input: unknown;
  /** Raw JSON of the original wire part object (no extra keys). */
  payloadJson: string;
}

export interface DecodedOtherPart {
  kind: "other";
  /** The source part's own type string (e.g. "image"). */
  partType: string;
  partIdx: number;
  /** Raw JSON of the original wire part object (no extra keys). */
  payloadJson: string;
}

export type DecodedPart =
  | DecodedTextPart
  | DecodedToolUsePart
  | DecodedOtherPart;

export interface DecodedUserLine {
  kind: "user";
  seq: number;
  parts: DecodedPart[];
}

export interface DecodedAssistantLine {
  kind: "assistant";
  seq: number;
  parts: DecodedPart[];
}

export interface DecodedMalformed {
  kind: "malformed";
  seq: number;
}

export interface DecodedSkip {
  kind: "skip";
  seq: number;
}

export type DecodedEvent =
  | DecodedUserLine
  | DecodedAssistantLine
  | DecodedMalformed
  | DecodedSkip;

// ---------------------------------------------------------------------------
// Tag stripping constants
// ---------------------------------------------------------------------------

/**
 * User-text wrapper sections injected by the Cursor IDE. We strip the whole
 * block because these are editor context, not user input.
 * `<user_query>` wraps the actual user prompt — strip the wrapper but keep
 * the inner content.
 */
const STRIP_BLOCK_TAGS = [
  "external_links",
  "attached_files",
  "git_status",
  "uploaded_documents",
  "image_files",
  "token",
  "open_and_recently_viewed_files",
  "system_reminder",
  "EXTREMELY_IMPORTANT",
  "EXTREMELY-IMPORTANT",
  "SUBAGENT-STOP",
] as const;

/**
 * Composer (cursor-agent) persists its redacted reasoning trace as a trailing
 * `[REDACTED]` token on assistant text parts — either the whole part or
 * appended after a short status preamble (`"Inspecting files…\n\n[REDACTED]"`).
 * The token carries no content; left in place it floods both reply capture and
 * normalized transcripts with one `[REDACTED]` line per tool round. Strip it
 * from assistant text only. The raw wire object is preserved verbatim in
 * `payloadJson` (and thus `rawEvents`), so the marker stays queryable at the raw
 * layer — fidelity is not lost, only the normalized text is cleaned. Anchoring
 * to the end of the string preserves any mid-text marker.
 */
const CURSOR_REDACTED_REASONING_RE = /\s*\[REDACTED\]\s*$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeUserText(text: string): string {
  let out = text;
  for (const tag of STRIP_BLOCK_TAGS) {
    const pattern = new RegExp(
      `<${escapeRegex(tag)}[^>]*>[\\s\\S]*?</${escapeRegex(tag)}>`,
      "g",
    );
    out = out.replace(pattern, "");
  }
  out = out.replace(/<\/?user_query[^>]*>/g, "");
  return out.trim();
}

function decodeContentParts(
  rawParts: readonly Record<string, unknown>[],
  role: "user" | "assistant",
): DecodedPart[] {
  const parts: DecodedPart[] = [];
  for (let partIdx = 0; partIdx < rawParts.length; partIdx++) {
    const raw = rawParts[partIdx];
    if (!raw || typeof raw !== "object") continue;

    const parsed = ContentPartSchema.safeParse(raw);
    if (!parsed.success) continue;

    const p = parsed.data;

    const payloadJson = JSON.stringify(raw);
    if (p.type === "text") {
      const rawText = typeof raw.text === "string" ? raw.text : "";
      const text =
        role === "user"
          ? sanitizeUserText(rawText)
          : rawText.replace(CURSOR_REDACTED_REASONING_RE, "");
      parts.push({
        kind: "text",
        partType: "text",
        partIdx,
        text,
        payloadJson,
      });
    } else if (p.type === "tool_use") {
      const name = typeof raw.name === "string" ? raw.name : "?";
      const input = raw.input;
      parts.push({
        kind: "tool_use",
        partType: "tool_use",
        partIdx,
        name,
        input,
        payloadJson,
      });
    } else {
      // image or any other type — store raw payload
      parts.push({ kind: "other", partType: p.type, partIdx, payloadJson });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Public decoder
// ---------------------------------------------------------------------------

/**
 * Decode one raw Cursor JSONL line into a `DecodedEvent`.
 * Never throws. Malformed JSON → `DecodedMalformed`. Unknown role or
 * missing content → `DecodedSkip` with a warning.
 */
export function decodeLine(
  rawLine: string,
  seq: number,
  issues: IssueCollector,
): DecodedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    issues.warn(`seq ${seq}: JSON parse failed — line skipped`, { seq });
    return { kind: "malformed", seq };
  }

  const result = RawLineSchema.safeParse(parsed);
  if (!result.success) {
    issues.warn(`seq ${seq}: line schema validation failed — line skipped`, {
      seq,
    });
    return { kind: "skip", seq };
  }

  const obj: RawLine = result.data;
  const role = obj.role;

  if (role !== "user" && role !== "assistant") {
    if (role !== undefined) {
      issues.warn(`seq ${seq}: unknown role "${role}" — line skipped`, { seq });
    }
    return { kind: "skip", seq };
  }

  const content = obj.message?.content;
  if (!Array.isArray(content)) {
    return { kind: "skip", seq };
  }

  const parts = decodeContentParts(content, role);

  if (role === "user") {
    return { kind: "user", seq, parts };
  }
  return { kind: "assistant", seq, parts };
}

// ---------------------------------------------------------------------------
// Timestamp extraction (used by the reducer)
// ---------------------------------------------------------------------------

export const TIMESTAMP_TAG_RE = /<timestamp>([\s\S]*?)<\/timestamp>/;

/**
 * Extract Unix seconds from a Cursor `<timestamp>` tag embedded in user text.
 * Returns undefined if the tag is absent or unparseable.
 */
export function parseCursorTimestamp(text: string): number | undefined {
  const match = TIMESTAMP_TAG_RE.exec(text);
  const raw = match?.[1]?.trim();
  if (!raw) return undefined;

  const normalized = raw.replace(
    /\(UTC([+-]\d{1,2})\)/,
    (_m, offset: string) => {
      const sign = offset.startsWith("-") ? "-" : "+";
      const hours = offset.replace(/^[+-]/, "").padStart(2, "0");
      return `${sign}${hours}:00`;
    },
  );
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}
