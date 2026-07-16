import { createHash } from "node:crypto";
import type { Message, ToolCall } from "../schemas/transcript.js";

/**
 * Helpers shared by every dialect parser. They feed `contentHash` and
 * `argsHash`, so any behavioral change here affects every transcript hash.
 */

export const PREVIEW_MAX = 300;
export const OUTPUT_PREVIEW_MAX = 2000;

/** Deterministic JSON: object keys sorted, recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Args hash + preview for a tool call, from the source CLI's args value. */
export function hashArgs(input: unknown): {
  argsHash: string;
  argsPreview: string;
} {
  const argsJson = stableStringify(input ?? {});
  return {
    argsHash: sha256Hex(argsJson),
    argsPreview: argsJson.slice(0, PREVIEW_MAX),
  };
}

/**
 * Canonical content hash: stable JSON of the core message stream. The
 * deduplication and idempotency key for a transcript.
 */
export function buildContentHash(
  id: string,
  messages: Pick<Message, "turn" | "role" | "text" | "toolCalls">[],
): string {
  const canonical = JSON.stringify({
    id,
    messages: messages.map((m) => ({
      turn: m.turn,
      role: m.role,
      text: m.text,
      toolCalls: m.toolCalls.map((tc: ToolCall) => ({
        name: tc.name,
        argsHash: tc.argsHash,
      })),
    })),
  });
  return sha256Hex(canonical);
}

/**
 * Transcript title: first non-thinking message's text, clipped. Thinking
 * blocks are skipped because they are supporting context, not the title.
 */
export function deriveTitle(
  messages: Pick<Message, "role" | "text">[],
): string | undefined {
  const first = messages.find((m) => m.role !== "thinking");
  if (first === undefined || first.text === "") return undefined;
  return first.text.slice(0, 200);
}
