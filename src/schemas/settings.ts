import { z } from "zod";
import { CliKindSchema } from "./session.js";
import { SCHEMA_VERSION } from "./version.js";

/**
 * Minimal persisted settings document identifying the target CLI dialect.
 */
export const SettingsSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  cli: CliKindSchema.optional(),
});
export type Settings = z.infer<typeof SettingsSchema>;
