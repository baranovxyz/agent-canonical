/**
 * Exact Codex versions covered by sanitized rollout captures.
 *
 * This is deliberately a data-only source.  It is kept separate from the
 * parser so the public dialect descriptor can report its tested baseline
 * without importing parser code.
 */
export interface CodexCaptureEvidence {
  cliVersion: string;
}

export const CODEX_CAPTURE_EVIDENCE: readonly CodexCaptureEvidence[] = [
  {
    cliVersion: "0.141.0",
  },
  {
    cliVersion: "0.150.1",
  },
];
