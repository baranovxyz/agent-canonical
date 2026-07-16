/**
 * Shared parser result vocabulary. Every fallible parser call returns a
 * discriminated result carrying an issues array — never `null`,
 * never throw-by-default. A malformed store line degrades to a recorded
 * issue, not a failed parse.
 */

export interface ParseIssue {
  severity: "error" | "warning";
  message: string;
  /** Raw-event sequence (JSONL line number / row index) the issue points at. */
  seq?: number;
  /** Store path (file or DB) the issue belongs to. */
  path?: string;
}

export type ParseResult<T> =
  | { success: true; data: T; issues: ParseIssue[] }
  | { success: false; issues: ParseIssue[] };

export function ok<T>(data: T, issues: ParseIssue[] = []): ParseResult<T> {
  return { success: true, data, issues };
}

export function fail<T>(issues: ParseIssue[]): ParseResult<T> {
  return { success: false, issues };
}

/** Warning cap per parse, so one corrupt store cannot flood the result. */
export const MAX_WARNINGS = 100;

/**
 * Accumulates issues during a parse, capping warnings at MAX_WARNINGS
 * (errors are never dropped). When the cap trips, the final list ends with
 * a single summarizing warning instead of the overflow.
 */
export class IssueCollector {
  private issues: ParseIssue[] = [];
  private suppressedWarnings = 0;
  private warningCount = 0;

  warn(message: string, at?: { seq?: number; path?: string }): void {
    if (this.warningCount >= MAX_WARNINGS) {
      this.suppressedWarnings += 1;
      return;
    }
    this.warningCount += 1;
    this.issues.push({ severity: "warning", message, ...at });
  }

  error(message: string, at?: { seq?: number; path?: string }): void {
    this.issues.push({ severity: "error", message, ...at });
  }

  list(): ParseIssue[] {
    if (this.suppressedWarnings === 0) return [...this.issues];
    return [
      ...this.issues,
      {
        severity: "warning",
        message: `${this.suppressedWarnings} further warnings suppressed (cap ${MAX_WARNINGS})`,
      },
    ];
  }
}
