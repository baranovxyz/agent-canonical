/**
 * Pure decoders for the Claude Code Workflow tool's on-disk orchestration
 * artifacts:
 *
 *   - the run manifest  `<session>/workflows/wf_<id>.json`
 *   - the run journal   `<session>/subagents/workflows/wf_<id>/journal.jsonl`
 *
 * Format knowledge lives here (per the agent-canonical adapter contract); the
 * agentmine consumer stores these files verbatim during ingest and calls these
 * decoders from its extractor. Both functions are pure: they operate on already
 * read JSON / lines, never the filesystem.
 *
 * The manifest's `workflowProgress` array is the source of per-agent linkage:
 * each `workflow_agent` entry carries the agent id, its phase, label, model,
 * state, and per-agent token / tool-call / duration figures plus a result
 * preview. The journal carries each agent call's full, untruncated return value.
 */

import { z } from "zod";
import type { IssueCollector } from "../types.js";
import { fail, ok, type ParseResult } from "../types.js";

// ---------------------------------------------------------------------------
// Public decoded shapes
// ---------------------------------------------------------------------------

export interface WorkflowManifestPhase {
  index: number;
  title?: string;
  detail?: string;
}

export interface WorkflowManifestAgent {
  agentId: string;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  state?: string;
  attempt?: number;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  /** Epoch milliseconds, as recorded by the workflow runtime. */
  startedAtMs?: number;
  resultPreview?: string;
}

export interface WorkflowRunManifest {
  runId: string;
  workflowName?: string;
  status?: string;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  durationMs?: number;
  /** Epoch milliseconds, from the manifest `startTime`. */
  startedAtMs?: number;
  summary?: string;
  scriptPath?: string;
  phases: WorkflowManifestPhase[];
  agents: WorkflowManifestAgent[];
}

export interface WorkflowJournalEvent {
  seq: number;
  type?: string;
  agentId?: string;
  key?: string;
  /** Present on `result` events: the agent call's full return value. */
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Permissive wire schemas — declare only consumed fields, tolerate the rest.
// `.passthrough()` keeps this resilient to an unstable store; `.catch(...)`
// coerces an unexpected field type to `undefined` rather than failing the whole
// object, so one odd value never drops an entire run.
// ---------------------------------------------------------------------------

const optStr = z.string().optional().catch(undefined);
const optNum = z.number().optional().catch(undefined);

const ManifestPhaseSchema = z
  .object({ title: optStr, detail: optStr })
  .passthrough();

const ProgressAgentSchema = z
  .object({
    type: z.literal("workflow_agent"),
    agentId: z.string(),
    label: optStr,
    phaseIndex: optNum,
    phaseTitle: optStr,
    model: optStr,
    state: optStr,
    attempt: optNum,
    tokens: optNum,
    toolCalls: optNum,
    durationMs: optNum,
    startedAt: optNum,
    resultPreview: optStr,
  })
  .passthrough();

const ManifestSchema = z
  .object({
    runId: z.string(),
    workflowName: optStr,
    status: optStr,
    agentCount: optNum,
    totalTokens: optNum,
    totalToolCalls: optNum,
    durationMs: optNum,
    startTime: optNum,
    summary: optStr,
    scriptPath: optStr,
    phases: z.array(ManifestPhaseSchema).optional().catch(undefined),
    workflowProgress: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .catch(undefined),
  })
  .passthrough();

const JournalEventSchema = z
  .object({
    type: optStr,
    agentId: optStr,
    key: optStr,
    result: z.unknown().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/**
 * Decode a workflow run manifest (`wf_<id>.json`). `raw` is the already-parsed
 * JSON value. Fails only when the value is not an object with a `runId`; every
 * other field degrades to `undefined`/empty rather than dropping the run.
 */
export function decodeWorkflowManifest(
  raw: unknown,
  issues: IssueCollector,
): ParseResult<WorkflowRunManifest> {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail([
      {
        severity: "error",
        message: "workflow manifest missing runId or not an object",
      },
    ]);
  }
  const m = parsed.data;

  // phases[] is an ordered list; the 1-based position is the phase index that
  // per-agent `phaseIndex` values reference.
  const phases: WorkflowManifestPhase[] = (m.phases ?? []).map((p, i) => ({
    index: i + 1,
    title: p.title,
    detail: p.detail,
  }));

  const agents: WorkflowManifestAgent[] = [];
  for (const entry of m.workflowProgress ?? []) {
    if (entry.type !== "workflow_agent") continue;
    const a = ProgressAgentSchema.safeParse(entry);
    if (!a.success) {
      issues.warn("skipped malformed workflow_agent progress entry");
      continue;
    }
    agents.push({
      agentId: a.data.agentId,
      label: a.data.label,
      phaseIndex: a.data.phaseIndex,
      phaseTitle: a.data.phaseTitle,
      model: a.data.model,
      state: a.data.state,
      attempt: a.data.attempt,
      tokens: a.data.tokens,
      toolCalls: a.data.toolCalls,
      durationMs: a.data.durationMs,
      startedAtMs: a.data.startedAt,
      resultPreview: a.data.resultPreview,
    });
  }

  return ok(
    {
      runId: m.runId,
      workflowName: m.workflowName,
      status: m.status,
      agentCount: m.agentCount,
      totalTokens: m.totalTokens,
      totalToolCalls: m.totalToolCalls,
      durationMs: m.durationMs,
      startedAtMs: m.startTime,
      summary: m.summary,
      scriptPath: m.scriptPath,
      phases,
      agents,
    },
    issues.list(),
  );
}

/**
 * Decode the run journal lines (`journal.jsonl`). Malformed lines are recorded
 * as warnings and skipped; the sequence index is preserved for each surviving
 * event so callers can order them.
 */
export function decodeWorkflowJournal(
  lines: string[],
  issues: IssueCollector,
): ParseResult<WorkflowJournalEvent[]> {
  const events: WorkflowJournalEvent[] = [];
  lines.forEach((line, seq) => {
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      issues.warn(`seq ${seq}: journal JSON parse failed — line skipped`, {
        seq,
      });
      return;
    }
    const result = JournalEventSchema.safeParse(parsed);
    if (!result.success) {
      issues.warn(`seq ${seq}: journal line schema mismatch — line skipped`, {
        seq,
      });
      return;
    }
    events.push({
      seq,
      type: result.data.type,
      agentId: result.data.agentId,
      key: result.data.key,
      result: result.data.result,
    });
  });
  return ok(events, issues.list());
}
