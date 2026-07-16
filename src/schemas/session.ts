import { z } from "zod";
import { TranscriptSchema } from "./transcript.js";
import { SCHEMA_VERSION } from "./version.js";

/**
 * Session represents one CLI instance and embeds its current Transcript
 * snapshot with identity, status, project, model, title, and timestamps.
 */

/** The supported CLI dialects. One `/dialects` descriptor exists per kind. */
export const CliKindSchema = z.enum([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "gemini",
  "qwen",
  "kilo",
]);
export type CliKind = z.infer<typeof CliKindSchema>;

/**
 * Session lifecycle states are intentionally distinct from A2A TaskState:
 * sessions can outlive individual tasks, and `idle` has no direct A2A
 * equivalent.
 */
export const SessionStatusSchema = z.enum([
  "running",
  "idle",
  "awaiting",
  "complete",
  "failed",
  "cancelled",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  id: z.string(),
  cli: CliKindSchema,
  /** The source CLI's own session id, when it differs from `id`. */
  externalId: z.string().optional(),
  url: z.string().optional(),
  parentSessionId: z.string().optional(),
  agentType: z.string().optional(),
  projectPath: z.string().optional(),
  gitBranch: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  status: SessionStatusSchema.optional(),
  /** Unix seconds. */
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  transcript: TranscriptSchema,
});
export type Session = z.infer<typeof SessionSchema>;
