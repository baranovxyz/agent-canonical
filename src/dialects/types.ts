import type { CliKind } from "../schemas/session.js";

/**
 * Pure-data descriptors for supported CLI dialects. Values describe observed
 * on-disk formats and have no runtime dependencies.
 */

export interface TranscriptStoreDescriptor {
  /** Storage technology of the on-disk session store. */
  kind: "jsonl" | "sqlite";
  /** Store root, `~`-relative; consumers expand against the CLI host's home. */
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
}
