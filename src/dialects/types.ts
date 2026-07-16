import type { CliKind } from "../schemas/session.js";

/**
 * Pure-data descriptors for supported CLI dialects. Values describe observed
 * on-disk formats and have no runtime dependencies.
 */

export interface TranscriptStoreDescriptor {
  /** Storage technology of the on-disk session store. */
  kind: "jsonl" | "sqlite" | "json";
  /**
   * Human-readable store root. Usually `~`-relative; a CLI with platform or
   * environment-dependent placement may use a resolver placeholder instead.
   */
  root: string;
  /**
   * Path layout under the root — a human-readable pattern, not a glob.
   * `<encoded-cwd>` / `<slug>` are the dialect's own cwd encoding.
   */
  pathPattern: string;
  /** Axis an incremental-read cursor advances along. */
  watermarkAxis: "byte-offset" | "row-time-created";
}

export interface TurnEndSignalDescriptor {
  /**
   * `explicit` — the store carries a per-turn terminal marker;
   * `derived` — turn end is reliably inferred from record structure;
   * `unavailable` — the store has no trustworthy live terminal fact.
   */
  kind: "explicit" | "derived" | "unavailable";
  /** Where the turn-end fact lives in the store, in the dialect's own terms. */
  description: string;
  /** Abort marker in the store, when one exists. */
  abortDescription?: string;
}

export interface DialectCapabilities {
  /** Package exports a reliable `snapshotCursor` / `readEventsSince` pair. */
  incrementalRead: boolean;
  /** Store carries an explicit per-turn terminal marker (vs derived). */
  explicitTurnEnd: boolean;
  /** Aborted turns are marked in the store. */
  abortSignalOnDisk: boolean;
  /** Pending questions land in the store before the user answers. */
  questionAwaitingOnDisk: boolean;
  /** Permission gates land in the store (no supported CLI does today). */
  permissionAwaitingOnDisk: boolean;
  /** Assistant messages carry per-message token usage. */
  perMessageUsage: boolean;
}

export interface DialectDescriptor {
  id: CliKind;
  /** Product name, for display. */
  displayName: string;
  /** CLI binary name (differs from `id` for cursor → `cursor-agent`). */
  binary: string;
  transcriptStore: TranscriptStoreDescriptor;
  turnEnd: TurnEndSignalDescriptor;
  /** Where the CLI reads its per-user configuration. */
  configPaths: {
    /** Global (per-user) config directory, `~`-relative. */
    globalDir: string;
  };
  capabilities: DialectCapabilities;
  /**
   * Provenance of the parser's validated baseline: the CLI version(s) and
   * on-disk store version a captured session confirmed this dialect against. These
   * stores drift fast (Qwen and Gemini have both changed layouts across releases;
   * Kilo ships a legacy `message`/`part` model alongside a newer event-sourced
   * one), so recording the tested baseline flags when a post-upgrade format may
   * have moved past what the parser has seen. Parsers
   * stay version-agnostic and permissive — this documents the baseline, it does
   * not gate decoding. Optional: absent on dialects validated before this field.
   */
  validatedAgainst?: DialectProvenance;
}

/** Validated-baseline provenance for a dialect's parser (see `validatedAgainst`). */
export interface DialectProvenance {
  /** CLI product version(s) a captured session was taken from (e.g. "1.43.0"). */
  cliVersions: string[];
  /** On-disk store / schema version, when the store carries one (e.g. goose "15"). */
  storeSchemaVersion?: string;
}
