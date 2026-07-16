/**
 * agent-canonical/dialects — pure-data per-CLI descriptors: transcript store
 * locations, turn-end signals, config paths, capability flags. Zero runtime
 * dependencies.
 */

import type { CliKind } from "../schemas/session.js";
import { claudeCode } from "./claude-code.js";
import { codex } from "./codex.js";
import { cursor } from "./cursor.js";
import { gemini } from "./gemini.js";
import { goose } from "./goose.js";
import { kilo } from "./kilo.js";
import { opencode } from "./opencode.js";
import { qwen } from "./qwen.js";
import type { DialectDescriptor } from "./types.js";

export const DIALECTS: Readonly<Record<CliKind, DialectDescriptor>> = {
  "claude-code": claudeCode,
  codex,
  opencode,
  cursor,
  gemini,
  qwen,
  kilo,
  goose,
};

export function getDialect(id: CliKind): DialectDescriptor {
  return DIALECTS[id];
}

export type {
  DialectCapabilities,
  DialectDescriptor,
  DialectProvenance,
  TranscriptStoreDescriptor,
  TurnEndSignalDescriptor,
} from "./types.js";
export { claudeCode, codex, cursor, gemini, goose, kilo, opencode, qwen };
