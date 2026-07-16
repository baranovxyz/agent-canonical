import { z } from "zod";

/**
 * Permissive Zod schemas for opencode on-disk record shapes.
 * Only the fields the parser consumes are declared; all others
 * pass through silently via `.passthrough()`. Every field is
 * optional — validate at point of use (if part.text === undefined …).
 *
 * These schemas are used with `.safeParse()` so callers can degrade
 * to an IssueCollector warning rather than throwing.
 */

export const SessionRecordSchema = z
  .object({
    id: z.string().optional(),
    projectID: z.string().optional(),
    parentID: z.string().optional(),
    directory: z.string().optional(),
    title: z.string().optional(),
    version: z.string().optional(),
    time: z
      .object({
        created: z.number().optional(),
        updated: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const MessageRecordSchema = z
  .object({
    id: z.string().optional(),
    sessionID: z.string().optional(),
    role: z.string().optional(),
    modelID: z.string().optional(),
    time: z.object({ created: z.number().optional() }).optional(),
    tokens: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        reasoning: z.number().optional(),
        cache: z
          .object({
            read: z.number().optional(),
            write: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
    error: z.object({ name: z.string().optional() }).optional(),
    /**
     * Assistant loop marker written by opencode into the message `data` JSON.
     * `"tool-calls"` means still working. Any other non-empty finish is a
     * structural turn-end only when the assistant message has no decoded tool
     * part. Absent on user rows and on in-progress assistant rows. Lands by row
     * UPDATE, not by a new row, so incremental readers must re-query rows they
     * already observed.
     */
    finish: z.string().optional(),
  })
  .passthrough();
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

// Individual part schemas — each has `type` plus type-specific fields.

const BasePartSchema = z.object({
  id: z.string().optional(),
  messageID: z.string().optional(),
});

export const TextPartSchema = BasePartSchema.extend({
  type: z.literal("text"),
  text: z.string().optional(),
}).passthrough();
export type TextPart = z.infer<typeof TextPartSchema>;

export const ReasoningPartSchema = BasePartSchema.extend({
  type: z.literal("reasoning"),
  text: z.string().optional(),
}).passthrough();
export type ReasoningPart = z.infer<typeof ReasoningPartSchema>;

export const ToolStateSchema = z
  .object({
    status: z.string().optional(),
    input: z.unknown().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    title: z.string().optional(),
    metadata: z.unknown().optional(),
    time: z
      .object({
        start: z.number().optional(),
        end: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

export const ToolPartSchema = BasePartSchema.extend({
  type: z.literal("tool"),
  callID: z.string().optional(),
  tool: z.string().optional(),
  state: ToolStateSchema.optional(),
}).passthrough();
export type ToolPart = z.infer<typeof ToolPartSchema>;

export const PatchPartSchema = BasePartSchema.extend({
  type: z.literal("patch"),
  hash: z.string().optional(),
  files: z.array(z.unknown()).optional(),
}).passthrough();
export type PatchPart = z.infer<typeof PatchPartSchema>;

/** Catch-all for step-start, step-finish, and future types. */
export const OtherPartSchema = BasePartSchema.extend({
  type: z.string(),
}).passthrough();
/**
 * OtherPart is declared as an explicit interface (not inferred from the schema)
 * so that:
 *   1. `type` excludes the known literals — TypeScript type guards on those
 *      literals fully narrow the part union to the concrete subtype.
 *   2. `id` / `messageID` stay `string | undefined`, not `unknown` (which
 *      `.passthrough()`'s index signature would give via `z.infer<>`).
 */
export interface OtherPart {
  type: Exclude<string, "text" | "reasoning" | "tool" | "patch">;
  id?: string;
  messageID?: string;
  [key: string]: unknown;
}

/** Returns true when v is a non-null, non-array object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Decode a raw unknown value into a typed part record.
 * Returns `undefined` when the value has no recognisable `type` string —
 * the caller should emit a warning and skip.
 */
export function decodePart(
  raw: unknown,
): TextPart | ReasoningPart | ToolPart | PatchPart | OtherPart | undefined {
  if (!isRecord(raw)) return undefined;
  const type = raw.type;
  if (typeof type !== "string") return undefined;

  switch (type) {
    case "text": {
      const p = TextPartSchema.safeParse(raw);
      return p.success ? p.data : undefined;
    }
    case "reasoning": {
      const p = ReasoningPartSchema.safeParse(raw);
      return p.success ? p.data : undefined;
    }
    case "tool": {
      const p = ToolPartSchema.safeParse(raw);
      return p.success ? p.data : undefined;
    }
    case "patch": {
      const p = PatchPartSchema.safeParse(raw);
      return p.success ? p.data : undefined;
    }
    default: {
      const p = OtherPartSchema.safeParse(raw);
      return p.success ? p.data : undefined;
    }
  }
}

/**
 * Decode a raw unknown value into a MessageRecord.
 * Returns `undefined` on hard parse failure (caller should warn + skip).
 */
export function decodeMessage(raw: unknown): MessageRecord | undefined {
  const p = MessageRecordSchema.safeParse(raw);
  return p.success ? p.data : undefined;
}

/**
 * Decode a raw unknown value into a SessionRecord.
 * Returns `undefined` on hard parse failure.
 */
export function decodeSession(raw: unknown): SessionRecord | undefined {
  const p = SessionRecordSchema.safeParse(raw);
  return p.success ? p.data : undefined;
}
