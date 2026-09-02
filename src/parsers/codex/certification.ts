/**
 * Internal Codex certification helpers.
 *
 * The normal decoder intentionally remains permissive: a new record is
 * skipped and does not make parsing fail.  Certification uses this exhaustive
 * classifier over raw records to make format drift visible in tests while
 * keeping that tolerant runtime behavior.
 */

import { z } from "zod";
import { IssueCollector } from "../types.js";
import { decodeLine, isCodexControlNoticePayload } from "./events.js";

export type CodexIgnoredRecordReason =
  | "noncanonical-state-snapshot"
  | "transport-metadata-only"
  | "duplicate-derived-message"
  | "lifecycle-bookkeeping";

export type CodexRecordClassification =
  | { kind: "handled" }
  | {
      kind: "explicitly-ignored";
      reason: CodexIgnoredRecordReason;
      recordType: string;
      payloadType?: string;
    }
  | { kind: "unclassified" };

const RawRecordSchema = z.object({
  timestamp: z.string().optional(),
  type: z.string().optional(),
  payload: z.unknown().optional(),
});

const PayloadTypeSchema = z.object({ type: z.string().optional() });
const NonEmptyString = z.string().trim().min(1);
const ObjectPayloadSchema = z.object({}).passthrough();
const TokenCounterSchema = z.number().finite().int().nonnegative();
const ContentPartSchema = z
  .object({ text: z.string().optional() })
  .passthrough();
const UsageSchema = z
  .object({
    input_tokens: TokenCounterSchema.optional(),
    output_tokens: TokenCounterSchema.optional(),
    cached_input_tokens: TokenCounterSchema.optional(),
    cache_write_input_tokens: TokenCounterSchema.optional(),
    reasoning_output_tokens: TokenCounterSchema.optional(),
    total_tokens: TokenCounterSchema.optional(),
  })
  .strict()
  .refine(
    (usage) =>
      [
        usage.input_tokens,
        usage.output_tokens,
        usage.cached_input_tokens,
        usage.cache_write_input_tokens,
        usage.reasoning_output_tokens,
      ].some((value) => typeof value === "number"),
    { message: "usage must contain a decoded token counter" },
  )
  .refine(
    (usage) =>
      usage.total_tokens === undefined ||
      usage.input_tokens === undefined ||
      usage.output_tokens === undefined ||
      usage.total_tokens === usage.input_tokens + usage.output_tokens,
    { message: "total_tokens must equal input_tokens + output_tokens" },
  );
const TokenCountPayloadSchema = z
  .object({
    type: z.literal("token_count"),
    info: z
      .object({
        total_token_usage: UsageSchema.optional(),
        last_token_usage: UsageSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough()
  .refine(
    (payload) =>
      payload.info.total_token_usage !== undefined ||
      payload.info.last_token_usage !== undefined,
  );
const SessionMetaPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  id: NonEmptyString,
  cwd: NonEmptyString,
  cli_version: NonEmptyString,
});
const TurnContextPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  model: NonEmptyString,
});
const TaskStartedPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("task_started"),
  started_at: z.number().finite().int().nonnegative().max(253_402_300_799),
});
const ExecCommandEndPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("exec_command_end"),
  call_id: NonEmptyString,
  exit_code: z.number().finite(),
});
const MessagePayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "developer", "system"]),
  content: z.array(ContentPartSchema).min(1),
}).refine((payload) =>
  payload.content.some((part) => (part.text ?? "").trim().length > 0),
);
const ReasoningPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("reasoning"),
  reasoning_text: NonEmptyString.optional(),
  summary: z.array(ContentPartSchema).min(1).optional(),
}).refine(
  (payload) =>
    payload.reasoning_text !== undefined ||
    payload.summary?.some((part) => (part.text ?? "").trim().length > 0),
);
const FunctionCallPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("function_call"),
  name: NonEmptyString,
  arguments: z.string(),
  call_id: NonEmptyString,
});
const FunctionCallOutputPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("function_call_output"),
  call_id: NonEmptyString,
  output: z.union([NonEmptyString, z.array(ContentPartSchema).min(1)]),
});
const CustomToolCallPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("custom_tool_call"),
  name: NonEmptyString,
  input: z.string(),
  call_id: NonEmptyString,
});
const CustomToolCallOutputPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("custom_tool_call_output"),
  call_id: NonEmptyString,
  output: z.union([NonEmptyString, z.array(ContentPartSchema).min(1)]),
});
const WebSearchCallPayloadEvidenceSchema = ObjectPayloadSchema.extend({
  type: z.literal("web_search_call"),
  status: NonEmptyString.optional(),
  action: ObjectPayloadSchema.optional(),
}).refine(
  (payload) => payload.status !== undefined || payload.action !== undefined,
);
const IgnoredObjectPayloadSchema = ObjectPayloadSchema.refine(
  (payload) => Object.keys(payload).length > 0,
);
const IgnoredMessagePayloadSchema = ObjectPayloadSchema.extend({
  message: NonEmptyString,
});
const IgnoredItemPayloadSchema = ObjectPayloadSchema.refine(
  (payload) => payload.item !== undefined,
);
const IgnoredSettingsPayloadSchema = ObjectPayloadSchema.extend({
  thread_settings: ObjectPayloadSchema.extend({
    model: NonEmptyString,
    model_provider_id: NonEmptyString,
    approval_policy: NonEmptyString,
    approvals_reviewer: NonEmptyString,
    permission_profile: ObjectPayloadSchema.extend({ type: NonEmptyString }),
    cwd: NonEmptyString,
    reasoning_effort: NonEmptyString,
    reasoning_summary: NonEmptyString,
    personality: NonEmptyString,
    collaboration_mode: ObjectPayloadSchema.extend({
      mode: NonEmptyString,
      settings: ObjectPayloadSchema.extend({
        model: NonEmptyString,
        reasoning_effort: NonEmptyString,
        developer_instructions: z.null(),
      }),
    }),
  }),
});
const IgnoredGoalPayloadSchema = ObjectPayloadSchema.extend({
  threadId: NonEmptyString,
  goal: ObjectPayloadSchema.extend({
    threadId: NonEmptyString,
    objective: NonEmptyString,
    status: NonEmptyString,
    tokensUsed: TokenCounterSchema,
    timeUsedSeconds: z.number().finite().nonnegative(),
    createdAt: z.number().finite().nonnegative(),
    updatedAt: z.number().finite().nonnegative(),
  }),
}).refine((payload) => payload.threadId === payload.goal.threadId);
const IgnoredRollbackPayloadSchema = ObjectPayloadSchema.extend({
  reason: NonEmptyString,
});
const IgnoredAgentMessagePayloadSchema = ObjectPayloadSchema.extend({
  id: NonEmptyString,
  author: NonEmptyString,
  recipient: NonEmptyString,
  content: z.array(ContentPartSchema).min(1),
  internal_chat_message_metadata_passthrough: ObjectPayloadSchema,
}).refine((payload) =>
  payload.content.some((part) => (part.text ?? "").trim().length > 0),
);

const HANDLED_TOP_LEVEL = new Set(["session_meta", "turn_context"]);
const IGNORED_TOP_LEVEL = new Map<string, CodexIgnoredRecordReason>([
  ["world_state", "noncanonical-state-snapshot"],
  ["compacted", "noncanonical-state-snapshot"],
  ["inter_agent_communication_metadata", "transport-metadata-only"],
]);
const HANDLED_EVENT_MESSAGES = new Set([
  "token_count",
  "task_started",
  "exec_command_end",
  "turn_aborted",
  "task_complete",
]);
const IGNORED_EVENT_MESSAGES = new Map<string, CodexIgnoredRecordReason>([
  ["user_message", "duplicate-derived-message"],
  ["agent_message", "duplicate-derived-message"],
  ["item_completed", "lifecycle-bookkeeping"],
  ["thread_settings_applied", "lifecycle-bookkeeping"],
  ["thread_goal_updated", "lifecycle-bookkeeping"],
  ["thread_rolled_back", "lifecycle-bookkeeping"],
]);
const HANDLED_RESPONSE_ITEMS = new Set([
  "message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "web_search_call",
]);
const IGNORED_RESPONSE_ITEMS = new Map<string, CodexIgnoredRecordReason>([
  ["agent_message", "duplicate-derived-message"],
]);

function isValidTimestamp(timestamp: string | undefined): timestamp is string {
  return timestamp !== undefined && Number.isFinite(Date.parse(timestamp));
}

function isValidEvidencePayload(
  recordType: string,
  payloadType: string | undefined,
  payload: unknown,
): boolean {
  if (recordType === "session_meta") {
    return SessionMetaPayloadEvidenceSchema.safeParse(payload).success;
  }
  if (recordType === "turn_context") {
    return TurnContextPayloadEvidenceSchema.safeParse(payload).success;
  }
  if (
    recordType === "world_state" ||
    recordType === "compacted" ||
    recordType === "inter_agent_communication_metadata"
  ) {
    return IgnoredObjectPayloadSchema.safeParse(payload).success;
  }
  if (recordType === "event_msg") {
    const schemaByType: Record<string, z.ZodType> = {
      token_count: TokenCountPayloadSchema,
      task_started: TaskStartedPayloadEvidenceSchema,
      exec_command_end: ExecCommandEndPayloadEvidenceSchema,
      turn_aborted: z.object({ type: z.literal("turn_aborted") }).passthrough(),
      task_complete: z
        .object({ type: z.literal("task_complete") })
        .passthrough(),
      user_message: IgnoredMessagePayloadSchema,
      agent_message: IgnoredMessagePayloadSchema,
      item_completed: IgnoredItemPayloadSchema,
      thread_settings_applied: IgnoredSettingsPayloadSchema,
      thread_goal_updated: IgnoredGoalPayloadSchema,
      thread_rolled_back: IgnoredRollbackPayloadSchema,
    };
    if (payloadType === undefined) return false;
    const schema = schemaByType[payloadType];
    return schema?.safeParse(payload).success === true;
  }
  if (recordType === "response_item") {
    const schemaByType: Record<string, z.ZodType> = {
      message: MessagePayloadEvidenceSchema,
      reasoning: ReasoningPayloadEvidenceSchema,
      function_call: FunctionCallPayloadEvidenceSchema,
      function_call_output: FunctionCallOutputPayloadEvidenceSchema,
      custom_tool_call: CustomToolCallPayloadEvidenceSchema,
      custom_tool_call_output: CustomToolCallOutputPayloadEvidenceSchema,
      web_search_call: WebSearchCallPayloadEvidenceSchema,
      agent_message: IgnoredAgentMessagePayloadSchema,
    };
    return (
      payloadType !== undefined &&
      schemaByType[payloadType]?.safeParse(payload).success === true
    );
  }
  return false;
}

function isControlNoticeRecord(raw: unknown): boolean {
  const record = RawRecordSchema.safeParse(raw);
  if (!record.success || record.data.type !== "response_item") return false;
  return isCodexControlNoticePayload(record.data.payload);
}

function decodedResult(raw: unknown): { kind: string; hasWarnings: boolean } {
  const line = JSON.stringify(raw);
  if (typeof line !== "string") return { kind: "skip", hasWarnings: false };
  const collector = new IssueCollector();
  const decoded = decodeLine(line, 0, collector);
  return { kind: decoded.kind, hasWarnings: collector.list().length > 0 };
}

/** Classify one already-decoded raw Codex rollout record. */
export function classifyCodexRawRecord(
  raw: unknown,
): CodexRecordClassification {
  const record = RawRecordSchema.safeParse(raw);
  if (!record.success || record.data.type === undefined) {
    return { kind: "unclassified" };
  }
  if (!isValidTimestamp(record.data.timestamp)) {
    return { kind: "unclassified" };
  }

  const topLevelType = record.data.type;
  const decoded = decodedResult(raw);
  if (
    HANDLED_TOP_LEVEL.has(topLevelType) &&
    isValidEvidencePayload(topLevelType, undefined, record.data.payload) &&
    decoded.kind !== "skip" &&
    !decoded.hasWarnings
  ) {
    return { kind: "handled" };
  }
  const ignoredTopLevelReason = IGNORED_TOP_LEVEL.get(topLevelType);
  if (
    ignoredTopLevelReason !== undefined &&
    isValidEvidencePayload(topLevelType, undefined, record.data.payload)
  ) {
    return {
      kind: "explicitly-ignored",
      reason: ignoredTopLevelReason,
      recordType: topLevelType,
    };
  }

  if (topLevelType === "event_msg") {
    const payload = PayloadTypeSchema.safeParse(record.data.payload);
    if (!payload.success || payload.data.type === undefined) {
      return { kind: "unclassified" };
    }
    if (
      !isValidEvidencePayload(
        topLevelType,
        payload.data.type,
        record.data.payload,
      )
    ) {
      return { kind: "unclassified" };
    }
    const ignoredEventReason = IGNORED_EVENT_MESSAGES.get(payload.data.type);
    if (ignoredEventReason !== undefined) {
      return {
        kind: "explicitly-ignored",
        reason: ignoredEventReason,
        recordType: topLevelType,
        payloadType: payload.data.type,
      };
    }
    if (
      HANDLED_EVENT_MESSAGES.has(payload.data.type) &&
      decoded.kind !== "skip" &&
      !decoded.hasWarnings
    ) {
      return { kind: "handled" };
    }
    return { kind: "unclassified" };
  }

  if (topLevelType === "response_item") {
    const payload = PayloadTypeSchema.safeParse(record.data.payload);
    if (!payload.success || payload.data.type === undefined) {
      return { kind: "unclassified" };
    }
    if (
      !isValidEvidencePayload(
        topLevelType,
        payload.data.type,
        record.data.payload,
      )
    ) {
      return { kind: "unclassified" };
    }
    const ignoredResponseReason = IGNORED_RESPONSE_ITEMS.get(payload.data.type);
    if (ignoredResponseReason !== undefined) {
      return {
        kind: "explicitly-ignored",
        reason: ignoredResponseReason,
        recordType: topLevelType,
        payloadType: payload.data.type,
      };
    }
    if (
      HANDLED_RESPONSE_ITEMS.has(payload.data.type) &&
      decoded.kind !== "skip" &&
      !decoded.hasWarnings
    ) {
      return { kind: "handled" };
    }
    // Developer/system messages are deliberately discarded by the decoder;
    // classify that intentional drop explicitly rather than as format drift.
    if (payload.data.type === "message" && decoded.kind === "skip") {
      if (isControlNoticeRecord(raw) && !decoded.hasWarnings) {
        return {
          kind: "explicitly-ignored",
          reason: "lifecycle-bookkeeping",
          recordType: topLevelType,
          payloadType: payload.data.type,
        };
      }
      const payloadRecord = z
        .object({ role: z.string().optional() })
        .safeParse(record.data.payload);
      if (
        payloadRecord.success &&
        (payloadRecord.data.role === "developer" ||
          payloadRecord.data.role === "system") &&
        !decoded.hasWarnings
      ) {
        return {
          kind: "explicitly-ignored",
          reason: "transport-metadata-only",
          recordType: topLevelType,
          payloadType: payload.data.type,
        };
      }
    }
    return { kind: "unclassified" };
  }

  return { kind: "unclassified" };
}

/** Classify a JSONL line, treating malformed JSON as unclassified. */
export function classifyCodexJsonLine(
  rawLine: string,
): CodexRecordClassification {
  try {
    const parsed: unknown = JSON.parse(rawLine);
    return classifyCodexRawRecord(parsed);
  } catch {
    return { kind: "unclassified" };
  }
}
