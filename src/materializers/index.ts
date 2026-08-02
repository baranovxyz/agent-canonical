import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  assembleSession,
  decodeLine,
  reduceEvents,
} from "../parsers/codex/index.js";
import { IssueCollector } from "../parsers/types.js";
import type { Session } from "../schemas/session.js";
import { SessionSchema } from "../schemas/session.js";

export const SESSION_SOURCE_PLAN_VERSION = 1 as const;
export const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_SOURCE_FAMILY_BYTES = 256 * 1024 * 1024;
const MAX_SESSION_META_BYTES = 1024 * 1024;

export interface CodexRolloutFamilyLimits {
  maxDays: number;
  maxDirectoryEntries: number;
  maxRollouts: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_CODEX_ROLLOUT_FAMILY_LIMITS: CodexRolloutFamilyLimits = {
  maxDays: 3,
  maxDirectoryEntries: 4096,
  maxRollouts: 1024,
  maxFileBytes: MAX_SOURCE_FILE_BYTES,
  maxTotalBytes: MAX_SOURCE_FAMILY_BYTES,
};

interface CodexRolloutProbe {
  sourcePath: string;
  size: number;
  sessionId: string;
  parentSessionId: string | undefined;
}

interface FamilyNode {
  sessionId: string;
  parentSessionId: string | undefined;
  startedAt: number | undefined;
}

export interface CodexRolloutFamilyMember {
  sourcePath: string;
  size: number;
  sha256: string;
  content: string;
  session: Session;
}

export interface CodexRolloutFamily {
  rootSessionId: string;
  members: CodexRolloutFamilyMember[];
  inspectedDays: string[];
  inspectedEntries: number;
  totalBytes: number;
}

export interface TokenCoverage {
  reported: number;
  missingSessionIds: string[];
}

export interface CodexSourcePlanMember {
  path: string;
  sessionId: string;
  externalId: string;
  parentSessionId: string | null;
  agentType: string | null;
  model: string | null;
  sourceRecordCount: number;
  content: string;
  contentBytes: number;
  sha256: string;
}

export interface CodexSessionSourcePlan {
  schemaVersion: typeof SESSION_SOURCE_PLAN_VERSION;
  cli: "codex";
  format: "jsonl-tree";
  rootSessionId: string;
  members: CodexSourcePlanMember[];
  tokenUsage: {
    inputTokens: TokenCoverage;
    outputTokens: TokenCoverage;
    cacheReadTokens: TokenCoverage;
    cacheCreationTokens: TokenCoverage;
    reasoningTokens: TokenCoverage;
  };
}

export class SessionSourceMaterializationError extends Error {
  readonly code:
    | "LOSSLESS_SOURCE_MISSING"
    | "LOSSLESS_SOURCE_INVALID"
    | "SOURCE_DIALECT_UNSUPPORTED"
    | "SOURCE_FAMILY_INCOMPLETE"
    | "SOURCE_FAMILY_LIMIT_EXCEEDED"
    | "SOURCE_CHANGED";

  constructor(
    code: SessionSourceMaterializationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "SessionSourceMaterializationError";
    this.code = code;
  }
}

function failure(
  code: SessionSourceMaterializationError["code"],
  message: string,
): never {
  throw new SessionSourceMaterializationError(code, message);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function dayKey(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("/");
}

function addUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate() + 1,
    ),
  );
}

function sourceLayout(rootPath: string): {
  sessionsRoot: string;
  firstDay: Date;
} {
  const absolute = resolve(rootPath);
  if (!/^rollout-.+\.jsonl$/.test(basename(absolute))) {
    return failure(
      "LOSSLESS_SOURCE_INVALID",
      "Codex root source is not a rollout JSONL file",
    );
  }
  const dayDirectory = dirname(absolute);
  const day = basename(dayDirectory);
  const monthDirectory = dirname(dayDirectory);
  const month = basename(monthDirectory);
  const yearDirectory = dirname(monthDirectory);
  const year = basename(yearDirectory);
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    return failure(
      "LOSSLESS_SOURCE_INVALID",
      "Codex root source is outside the YYYY/MM/DD rollout layout",
    );
  }
  const firstDay = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (Number.isNaN(firstDay.getTime())) {
    return failure(
      "LOSSLESS_SOURCE_INVALID",
      "Codex root source has an invalid rollout date",
    );
  }
  return { sessionsRoot: dirname(yearDirectory), firstDay };
}

async function probeStableRollout(
  path: string,
): Promise<CodexRolloutProbe | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size === 0) {
      return undefined;
    }
    const probeBytes = Math.min(before.size, MAX_SESSION_META_BYTES);
    const buffer = Buffer.alloc(probeBytes);
    const { bytesRead } = await handle.read(buffer, 0, probeBytes, 0);
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      return failure("SOURCE_CHANGED", "Codex rollout changed while probed");
    }
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = prefix.indexOf("\n");
    if (newline < 0 && before.size > MAX_SESSION_META_BYTES) return undefined;
    const firstLine = newline < 0 ? prefix : prefix.slice(0, newline);
    const issues = new IssueCollector();
    const event = decodeLine(firstLine, 0, issues);
    if (event.kind !== "session_meta" || event.id === undefined)
      return undefined;
    const sessionId = event.id.startsWith("cx--")
      ? event.id
      : `cx--${event.id}`;
    const parentSessionId =
      event.directParentId === undefined
        ? undefined
        : event.directParentId.startsWith("cx--")
          ? event.directParentId
          : `cx--${event.directParentId}`;
    return {
      sourcePath: path,
      size: before.size,
      sessionId,
      parentSessionId,
    };
  } finally {
    await handle.close();
  }
}

type DecodedCodexEvent = ReturnType<typeof decodeLine>;

interface SpawnCallRecord {
  type: "function_call" | "custom_tool_call";
  seq: number;
}

interface SpawnRecordEvidence {
  callIds: Set<string>;
  startedChildIds: Map<string, string>;
}

function payloadRecord(record: unknown): Record<string, unknown> | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const payload = (record as Record<string, unknown>).payload;
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : undefined;
}

function validateSpawnRecords(
  records: readonly unknown[],
  events: readonly DecodedCodexEvent[],
): SpawnRecordEvidence {
  const spawnCalls = new Map<string, SpawnCallRecord>();
  for (let seq = 0; seq < records.length; seq += 1) {
    const value = payloadRecord(records[seq]);
    if (value === undefined) continue;
    const leafName =
      typeof value.name === "string"
        ? value.name.split(/[.:/]/).at(-1)
        : undefined;
    if (
      (value.type !== "function_call" && value.type !== "custom_tool_call") ||
      leafName !== "spawn_agent"
    ) {
      continue;
    }
    if (typeof value.call_id !== "string" || value.call_id.length === 0) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout contains a malformed spawn_agent call at record ${seq}`,
      );
    }
    if (spawnCalls.has(value.call_id)) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout repeats spawn_agent call id ${value.call_id}`,
      );
    }
    const expectedKind =
      value.type === "function_call"
        ? "response_function_call"
        : "response_custom_tool_call";
    if (events[seq]?.kind !== expectedKind) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout could not decode spawn_agent call ${value.call_id}`,
      );
    }
    spawnCalls.set(value.call_id, { type: value.type, seq });
  }

  const spawnOutputs = new Map<string, number>();
  const startedChildIds = new Map<string, string>();
  for (let seq = 0; seq < records.length; seq += 1) {
    const value = payloadRecord(records[seq]);
    if (value === undefined) continue;
    if (
      (value.type === "function_call_output" ||
        value.type === "custom_tool_call_output") &&
      typeof value.call_id === "string" &&
      spawnCalls.has(value.call_id)
    ) {
      if (spawnOutputs.has(value.call_id)) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex rollout repeats spawn_agent output ${value.call_id}`,
        );
      }
      const call = spawnCalls.get(value.call_id);
      if (call === undefined) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex rollout lost spawn_agent call ${value.call_id}`,
        );
      }
      const expectedOutputType =
        call.type === "function_call"
          ? "function_call_output"
          : "custom_tool_call_output";
      const expectedKind =
        call.type === "function_call"
          ? "response_function_call_output"
          : "response_custom_tool_call_output";
      if (
        value.type !== expectedOutputType ||
        events[seq]?.kind !== expectedKind
      ) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex rollout could not decode spawn_agent output ${value.call_id}`,
        );
      }
      if (seq <= call.seq) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex rollout has spawn_agent output ${value.call_id} before its call`,
        );
      }
      spawnOutputs.set(value.call_id, seq);
      continue;
    }
    if (value.type !== "sub_agent_activity" || value.kind !== "started") {
      continue;
    }
    if (typeof value.event_id !== "string" || value.event_id.length === 0) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout has started sub_agent_activity without an exact spawn_agent call id at record ${seq}`,
      );
    }
    const call = spawnCalls.get(value.event_id);
    if (call === undefined) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout has started sub_agent_activity for unknown spawn_agent call ${value.event_id}`,
      );
    }
    if (seq <= call.seq) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout has started sub_agent_activity ${value.event_id} before its call`,
      );
    }
    if (
      typeof value.agent_thread_id !== "string" ||
      value.agent_thread_id.length === 0
    ) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout has malformed started sub_agent_activity for spawn_agent call ${value.event_id}`,
      );
    }
    if (startedChildIds.has(value.event_id)) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout repeats started sub_agent_activity for spawn_agent call ${value.event_id}`,
      );
    }
    const childId = value.agent_thread_id.startsWith("cx--")
      ? value.agent_thread_id
      : `cx--${value.agent_thread_id}`;
    startedChildIds.set(value.event_id, childId);
  }
  for (const callId of spawnCalls.keys()) {
    if (!spawnOutputs.has(callId)) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex rollout has no terminal output for spawn_agent call ${callId}`,
      );
    }
  }
  return {
    callIds: new Set(spawnCalls.keys()),
    startedChildIds,
  };
}

async function readStableRollout(
  path: string,
  limits: CodexRolloutFamilyLimits,
): Promise<CodexRolloutFamilyMember> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return failure(
      "SOURCE_FAMILY_INCOMPLETE",
      `Selected Codex rollout cannot be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        "Selected Codex rollout is not a single-link regular file",
      );
    }
    if (before.size > limits.maxFileBytes) {
      return failure(
        "SOURCE_FAMILY_LIMIT_EXCEEDED",
        `Codex rollout exceeds ${limits.maxFileBytes} bytes`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    ) {
      return failure("SOURCE_CHANGED", "Codex rollout changed while read");
    }
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) {
      return failure(
        "LOSSLESS_SOURCE_INVALID",
        "Selected Codex rollout is not valid UTF-8",
      );
    }
    const rawLines = raw.split("\n").filter((line) => line.length > 0);
    const issues = new IssueCollector();
    const events = rawLines.map((line, seq) => decodeLine(line, seq, issues));
    const parseIssues = issues.list();
    if (parseIssues.length > 0) {
      const examples = parseIssues
        .slice(0, 3)
        .map((issue) => issue.message)
        .join("; ");
      return failure(
        "LOSSLESS_SOURCE_INVALID",
        `Selected Codex rollout has ${parseIssues.length} parser issue(s); complete family membership cannot be established: ${examples}`,
      );
    }
    const parsedLines = rawLines.map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    });
    validateSpawnRecords(parsedLines, events);
    const reduced = reduceEvents(events, rawLines, issues);
    const session = assembleSession(reduced, path);
    if (session === undefined) {
      return failure(
        "LOSSLESS_SOURCE_INVALID",
        "Selected Codex rollout has no usable session metadata or messages",
      );
    }
    return {
      sourcePath: path,
      size: bytes.length,
      sha256: sha256(bytes),
      content: raw,
      session,
    };
  } finally {
    await handle.close();
  }
}

function familyClosure<T extends FamilyNode>(
  rootSessionId: string,
  candidates: readonly T[],
): T[] {
  const byId = new Map<string, T>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.sessionId);
    if (existing !== undefined) {
      return failure(
        "LOSSLESS_SOURCE_INVALID",
        `Duplicate Codex session id ${candidate.sessionId}`,
      );
    }
    byId.set(candidate.sessionId, candidate);
  }
  if (!byId.has(rootSessionId)) {
    return failure(
      "SOURCE_FAMILY_INCOMPLETE",
      `Bound Codex root ${rootSessionId} was not found in the source layout`,
    );
  }
  if (byId.get(rootSessionId)?.parentSessionId !== undefined) {
    return failure(
      "LOSSLESS_SOURCE_INVALID",
      `Bound Codex root ${rootSessionId} must not have a parent session`,
    );
  }

  const selected = new Set<string>([rootSessionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      const parent = candidate.parentSessionId;
      if (
        parent !== undefined &&
        selected.has(parent) &&
        !selected.has(candidate.sessionId)
      ) {
        selected.add(candidate.sessionId);
        changed = true;
      }
    }
  }

  const depth = new Map<string, number>([[rootSessionId, 0]]);
  for (let pass = 0; pass < selected.size; pass += 1) {
    for (const id of selected) {
      if (depth.has(id)) continue;
      const parent = byId.get(id)?.parentSessionId;
      const parentDepth = parent === undefined ? undefined : depth.get(parent);
      if (parentDepth !== undefined) {
        depth.set(id, parentDepth + 1);
      }
    }
  }
  if (depth.size !== selected.size) {
    return failure(
      "LOSSLESS_SOURCE_INVALID",
      "Codex rollout family contains a parent cycle",
    );
  }

  const family = [...selected].map((id) => {
    const candidate = byId.get(id);
    if (candidate === undefined) {
      return failure(
        "LOSSLESS_SOURCE_INVALID",
        `Codex rollout family lost selected session ${id}`,
      );
    }
    return candidate;
  });
  return family.sort((left, right) => {
    const leftDepth = depth.get(left.sessionId);
    const rightDepth = depth.get(right.sessionId);
    if (leftDepth === undefined || rightDepth === undefined) {
      return failure(
        "LOSSLESS_SOURCE_INVALID",
        "Codex rollout family contains an unresolved depth",
      );
    }
    return (
      leftDepth - rightDepth ||
      (left.startedAt ?? Number.MAX_SAFE_INTEGER) -
        (right.startedAt ?? Number.MAX_SAFE_INTEGER) ||
      left.sessionId.localeCompare(right.sessionId)
    );
  });
}

function readDirectoryError(error: unknown, directory: string): never | [] {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  ) {
    return [];
  }
  return failure(
    "SOURCE_FAMILY_INCOMPLETE",
    `Cannot enumerate Codex rollout directory ${directory}`,
  );
}

function agentIdsFromSpawnOutput(output: string): Set<string> {
  const externalIds = new Set<string>();
  const queue: unknown[] = [output];
  const parsedStrings = new Set<string>();
  while (queue.length > 0) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
    } else if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      for (const key of ["agent_id", "agentId"]) {
        if (typeof record[key] === "string" && record[key].length > 0) {
          externalIds.add(record[key]);
        }
      }
      queue.push(...Object.values(record));
    } else if (typeof value === "string" && !parsedStrings.has(value)) {
      parsedStrings.add(value);
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed !== value) queue.push(parsed);
      } catch {
        for (const match of value.matchAll(
          /["'](?:agent_id|agentId)["']\s*[:=]\s*["']([^"']+)["']/g,
        )) {
          if (match[1] !== undefined) externalIds.add(match[1]);
        }
      }
    }
  }
  return externalIds;
}

function normalizedChildId(externalId: string): string {
  return externalId.startsWith("cx--") ? externalId : `cx--${externalId}`;
}

function successfulSpawnedSessionIds(session: Session): string[] {
  const rawEvents = session.transcript.rawEvents ?? [];
  const rawLines = rawEvents.map((event) => event.rawJson);
  const rawIssues = new IssueCollector();
  const decoded = rawLines.map((line, seq) => decodeLine(line, seq, rawIssues));
  const parsed = rawLines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return undefined;
    }
  });
  const rawEvidence = validateSpawnRecords(parsed, decoded);
  const normalizedCalls = new Map<
    string,
    (typeof session.transcript.messages)[number]["toolCalls"][number]
  >();
  const unkeyedCalls: (typeof session.transcript.messages)[number]["toolCalls"] =
    [];
  for (const message of session.transcript.messages) {
    for (const call of message.toolCalls) {
      const leafName = call.name.split(/[.:/]/).at(-1);
      if (leafName !== "spawn_agent") continue;
      if (call.callId === undefined) {
        unkeyedCalls.push(call);
        continue;
      }
      if (normalizedCalls.has(call.callId)) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex session ${session.id} repeats normalized spawn_agent call id ${call.callId}`,
        );
      }
      normalizedCalls.set(call.callId, call);
    }
  }
  for (const callId of rawEvidence.callIds) {
    if (!normalizedCalls.has(callId)) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex session ${session.id} could not normalize live spawn_agent call ${callId}`,
      );
    }
  }

  const ids: string[] = [];
  for (const call of [...normalizedCalls.values(), ...unkeyedCalls]) {
    const activityChildId =
      call.callId === undefined
        ? undefined
        : rawEvidence.startedChildIds.get(call.callId);
    if ((call.exitCode ?? 0) !== 0) {
      if (activityChildId !== undefined) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex session ${session.id} observed child ${activityChildId} for failed spawn_agent call ${call.callId}`,
        );
      }
      continue;
    }
    const output = call.outputFull;
    if (output === undefined) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex session ${session.id} has an unresolved spawn_agent result`,
      );
    }
    const externalIds = agentIdsFromSpawnOutput(output);
    const [externalId] = externalIds;
    const rejectedOutput =
      /\b(?:failed|failure|rejected|unavailable|capacity|limit exceeded)\b/i.test(
        output,
      );
    if (activityChildId !== undefined) {
      if (externalIds.size === 0 && rejectedOutput) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex session ${session.id} observed child ${activityChildId} for a rejected spawn_agent call ${call.callId}`,
        );
      }
      if (
        externalIds.size > 1 ||
        (externalId !== undefined &&
          normalizedChildId(externalId) !== activityChildId)
      ) {
        return failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex session ${session.id} has conflicting child identities for spawn_agent call ${call.callId}`,
        );
      }
      ids.push(activityChildId);
      continue;
    }
    if (externalIds.size === 0) {
      if (call.exitCode === undefined && rejectedOutput) {
        continue;
      }
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex session ${session.id} has a successful spawn_agent result without exactly one child agent id`,
      );
    }
    if (externalIds.size !== 1 || externalId === undefined) {
      return failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex session ${session.id} has a successful spawn_agent result without exactly one child agent id`,
      );
    }
    ids.push(normalizedChildId(externalId));
  }
  return ids.sort();
}

function assertSpawnedChildrenPresent(sessions: readonly Session[]): void {
  const present = new Map(sessions.map((session) => [session.id, session]));
  const claimed = new Map<string, string>();
  for (const session of sessions) {
    for (const childId of successfulSpawnedSessionIds(session)) {
      const previous = claimed.get(childId);
      if (previous !== undefined) {
        failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex child ${childId} is claimed by multiple spawn_agent results (${previous}, ${session.id})`,
        );
      }
      claimed.set(childId, session.id);
      const child = present.get(childId);
      if (child === undefined) {
        failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex child ${childId} spawned by ${session.id} is missing`,
        );
      }
      if (child.parentSessionId !== session.id) {
        failure(
          "SOURCE_FAMILY_INCOMPLETE",
          `Codex child ${childId} does not name its spawning session ${session.id} as direct parent`,
        );
      }
    }
  }
  for (const session of sessions) {
    if (session.parentSessionId === undefined) continue;
    const parent = claimed.get(session.id);
    if (parent === undefined) {
      failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex child ${session.id} names parent ${session.parentSessionId} but has no successful spawn_agent claim`,
      );
    }
    if (parent !== session.parentSessionId) {
      failure(
        "SOURCE_FAMILY_INCOMPLETE",
        `Codex child ${session.id} is claimed by ${parent} but names ${session.parentSessionId} as direct parent`,
      );
    }
  }
}

export async function collectCodexRolloutFamily(options: {
  rootPath: string;
  rootSessionId: string;
  captureEndedAtMs: number;
  limits?: Partial<CodexRolloutFamilyLimits>;
}): Promise<CodexRolloutFamily> {
  const limits = {
    ...DEFAULT_CODEX_ROLLOUT_FAMILY_LIMITS,
    ...options.limits,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return failure(
        "LOSSLESS_SOURCE_INVALID",
        `Codex rollout family limit ${name} must be a positive integer`,
      );
    }
  }
  const layout = sourceLayout(options.rootPath);
  const captureEnd = new Date(options.captureEndedAtMs);
  if (Number.isNaN(captureEnd.getTime())) {
    return failure(
      "LOSSLESS_SOURCE_INVALID",
      "Codex rollout capture end must be a valid timestamp",
    );
  }
  if (captureEnd.getTime() < layout.firstDay.getTime()) {
    return failure(
      "LOSSLESS_SOURCE_INVALID",
      "Codex rollout capture end predates the bound root day",
    );
  }

  const inspectedDays: string[] = [];
  const probes: CodexRolloutProbe[] = [];
  let inspectedEntries = 0;
  for (
    let date = layout.firstDay;
    date.getTime() <= captureEnd.getTime();
    date = addUtcDay(date)
  ) {
    if (inspectedDays.length >= limits.maxDays) {
      return failure(
        "SOURCE_FAMILY_LIMIT_EXCEEDED",
        `Codex rollout family exceeds ${limits.maxDays} day directories`,
      );
    }
    const key = dayKey(date);
    inspectedDays.push(key);
    const directory = join(layout.sessionsRoot, ...key.split("/"));
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => readDirectoryError(error, directory),
    );
    inspectedEntries += entries.length;
    if (inspectedEntries > limits.maxDirectoryEntries) {
      return failure(
        "SOURCE_FAMILY_LIMIT_EXCEEDED",
        `Codex rollout discovery exceeds ${limits.maxDirectoryEntries} directory entries`,
      );
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^rollout-.+\.jsonl$/.test(entry.name)) continue;
      const probe = await probeStableRollout(join(directory, entry.name));
      if (probe === undefined) continue;
      probes.push(probe);
      if (probes.length > limits.maxRollouts) {
        return failure(
          "SOURCE_FAMILY_LIMIT_EXCEEDED",
          `Codex rollout discovery exceeds ${limits.maxRollouts} files`,
        );
      }
    }
  }

  const absoluteRootPath = resolve(options.rootPath);
  const exactRoot = probes.find(
    (probe) => resolve(probe.sourcePath) === absoluteRootPath,
  );
  if (exactRoot?.sessionId !== options.rootSessionId) {
    return failure(
      "SOURCE_FAMILY_INCOMPLETE",
      `Bound Codex root ${options.rootSessionId} does not match its exact source file`,
    );
  }
  const selectedProbes = familyClosure(
    options.rootSessionId,
    probes.map((probe) => ({
      ...probe,
      startedAt: undefined,
    })),
  );
  const selectedBytes = selectedProbes.reduce(
    (sum, probe) => sum + probe.size,
    0,
  );
  if (selectedBytes > limits.maxTotalBytes) {
    return failure(
      "SOURCE_FAMILY_LIMIT_EXCEEDED",
      `Codex rollout family exceeds ${limits.maxTotalBytes} bytes`,
    );
  }
  const members = await Promise.all(
    selectedProbes.map(async (probe) => {
      const member = await readStableRollout(probe.sourcePath, limits);
      if (
        member.session.id !== probe.sessionId ||
        member.session.parentSessionId !== probe.parentSessionId ||
        member.size !== probe.size
      ) {
        return failure(
          "SOURCE_CHANGED",
          `Codex rollout identity changed while captured: ${probe.sourcePath}`,
        );
      }
      return member;
    }),
  );
  const actualTotalBytes = members.reduce(
    (sum, member) => sum + member.size,
    0,
  );
  if (actualTotalBytes > limits.maxTotalBytes) {
    return failure(
      "SOURCE_FAMILY_LIMIT_EXCEEDED",
      `Codex rollout family exceeds ${limits.maxTotalBytes} bytes after stable reads`,
    );
  }
  assertSpawnedChildrenPresent(members.map((member) => member.session));
  return {
    rootSessionId: options.rootSessionId,
    members,
    inspectedDays,
    inspectedEntries,
    totalBytes: actualTotalBytes,
  };
}

function tokenCoverage(
  sessions: readonly Session[],
  field:
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheCreationTokens"
    | "reasoningTokens",
): TokenCoverage {
  let reported = 0;
  const missingSessionIds: string[] = [];
  for (const session of sessions) {
    const value = session.transcript[field];
    if (value === undefined) missingSessionIds.push(session.id);
    else reported += value;
  }
  return { reported, missingSessionIds };
}

export function createCodexSessionSourcePlan(options: {
  rootSessionId: string;
  members: readonly Pick<CodexRolloutFamilyMember, "session" | "content">[];
}): CodexSessionSourcePlan {
  const members = options.members.map((member) => ({
    session: SessionSchema.parse(member.session),
    content:
      typeof member.content === "string"
        ? member.content
        : failure(
            "LOSSLESS_SOURCE_INVALID",
            "Codex source planning requires exact UTF-8 source content",
          ),
  }));
  const sessions = members.map((member) => member.session);
  if (
    sessions.length === 0 ||
    sessions.some((session) => session.cli !== "codex")
  ) {
    return failure(
      "SOURCE_DIALECT_UNSUPPORTED",
      "Codex source planning requires at least one Codex session",
    );
  }
  const family = familyClosure(
    options.rootSessionId,
    sessions.map((session) => ({
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      startedAt: session.startedAt,
      sourcePath: session.transcript.rawPath ?? "",
      size: 0,
      sha256: "",
      session,
    })),
  );
  if (family.length !== sessions.length) {
    return failure(
      "SOURCE_FAMILY_INCOMPLETE",
      "Codex source input contains sessions outside the bound root family",
    );
  }
  assertSpawnedChildrenPresent(sessions);

  let totalBytes = 0;
  const sourceBySessionId = new Map(
    members.map((member) => [member.session.id, member.content]),
  );
  const plannedMembers = family.map(
    ({ session }, index): CodexSourcePlanMember => {
      const rawEvents = session.transcript.rawEvents;
      if (rawEvents === undefined || rawEvents.length === 0) {
        return failure(
          "LOSSLESS_SOURCE_MISSING",
          `Codex session ${session.id} has no lossless raw events`,
        );
      }
      for (let eventIndex = 1; eventIndex < rawEvents.length; eventIndex += 1) {
        const currentEvent = rawEvents[eventIndex];
        const previousEvent = rawEvents[eventIndex - 1];
        if (currentEvent === undefined || previousEvent === undefined) {
          return failure(
            "LOSSLESS_SOURCE_INVALID",
            `Codex session ${session.id} has sparse raw events`,
          );
        }
        if (currentEvent.seq <= previousEvent.seq) {
          return failure(
            "LOSSLESS_SOURCE_INVALID",
            `Codex session ${session.id} has unordered raw events`,
          );
        }
      }
      const externalId = session.externalId;
      if (externalId === undefined || externalId.length === 0) {
        return failure(
          "LOSSLESS_SOURCE_INVALID",
          `Codex session ${session.id} has no external id`,
        );
      }
      const content = sourceBySessionId.get(session.id);
      if (content === undefined) {
        return failure(
          "LOSSLESS_SOURCE_MISSING",
          `Codex session ${session.id} has no exact source content`,
        );
      }
      const sourceRecords = content
        .split("\n")
        .filter((line) => line.length > 0);
      if (
        sourceRecords.length !== rawEvents.length ||
        sourceRecords.some(
          (record, recordIndex) => record !== rawEvents[recordIndex]?.rawJson,
        )
      ) {
        return failure(
          "LOSSLESS_SOURCE_INVALID",
          `Codex session ${session.id} source content differs from its parsed raw events`,
        );
      }
      const sourceIssues = new IssueCollector();
      sourceRecords.forEach((record, recordIndex) => {
        decodeLine(record, recordIndex, sourceIssues);
      });
      const parseIssues = sourceIssues.list();
      if (parseIssues.length > 0) {
        const examples = parseIssues
          .slice(0, 3)
          .map((issue) => issue.message)
          .join("; ");
        return failure(
          "LOSSLESS_SOURCE_INVALID",
          `Codex session ${session.id} has ${parseIssues.length} parser issue(s): ${examples}`,
        );
      }
      const contentBytes = Buffer.byteLength(content);
      if (contentBytes > MAX_SOURCE_FILE_BYTES) {
        return failure(
          "SOURCE_FAMILY_LIMIT_EXCEEDED",
          `Codex session ${session.id} exceeds ${MAX_SOURCE_FILE_BYTES} source bytes`,
        );
      }
      totalBytes += contentBytes;
      if (totalBytes > MAX_SOURCE_FAMILY_BYTES) {
        return failure(
          "SOURCE_FAMILY_LIMIT_EXCEEDED",
          `Codex rollout family exceeds ${MAX_SOURCE_FAMILY_BYTES} source bytes`,
        );
      }
      return {
        path: `rollouts/${String(index).padStart(4, "0")}.jsonl`,
        sessionId: session.id,
        externalId,
        parentSessionId: session.parentSessionId ?? null,
        agentType: session.agentType ?? null,
        model: session.model ?? null,
        sourceRecordCount: rawEvents.length,
        content,
        contentBytes,
        sha256: sha256(content),
      };
    },
  );

  const orderedSessions = family.map((member) => member.session);
  return {
    schemaVersion: SESSION_SOURCE_PLAN_VERSION,
    cli: "codex",
    format: "jsonl-tree",
    rootSessionId: options.rootSessionId,
    members: plannedMembers,
    tokenUsage: {
      inputTokens: tokenCoverage(orderedSessions, "inputTokens"),
      outputTokens: tokenCoverage(orderedSessions, "outputTokens"),
      cacheReadTokens: tokenCoverage(orderedSessions, "cacheReadTokens"),
      cacheCreationTokens: tokenCoverage(
        orderedSessions,
        "cacheCreationTokens",
      ),
      reasoningTokens: tokenCoverage(orderedSessions, "reasoningTokens"),
    },
  };
}
