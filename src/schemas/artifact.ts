import { z } from "zod";
import { SCHEMA_VERSION } from "./version.js";

/**
 * Artifact uses A2A-style artifactId/name/parts while keeping content
 * reference-first through a URI or path plus optional integrity metadata.
 * Inline content is supported but is not the default, avoiding large inline
 * artifact envelopes.
 */

export const ArtifactPartSchema = z
  .object({
    /** Reference to the part's content — at least one of uri/path required. */
    uri: z.string().optional(),
    path: z.string().optional(),
    contentHash: z.string().optional(),
    byteCount: z.number().int().nonnegative().optional(),
    mediaType: z.string().optional(),
    /** Optional inline copy of the content. Never the default channel. */
    inlineContent: z.string().optional(),
  })
  .refine((part) => part.uri !== undefined || part.path !== undefined, {
    message: "artifact parts are reference-first: provide uri or path",
  });
export type ArtifactPart = z.infer<typeof ArtifactPartSchema>;

export const ArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  artifactId: z.string(),
  name: z.string().optional(),
  parts: z.array(ArtifactPartSchema).default([]),
});
export type Artifact = z.infer<typeof ArtifactSchema>;
