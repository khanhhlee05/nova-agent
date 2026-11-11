import { z } from "zod";
import { calendarDateSchema, compactBucketSchema, compactChangeFieldsSchema, compactChangeKindSchema, compactItemKindSchema, compactItemStatusSchema } from "./snapshot";

export const toolNameSchema = z.enum(["get_brief", "list_deadlines", "get_item_details", "get_recent_announcements", "get_changes", "build_study_plan", "get_course_load"]);
export type ToolName = z.infer<typeof toolNameSchema>;

const url = z.url({ protocol: /^https?$/ }).nullable();

/** One block of work on one day of a study plan. */
export const planSlotSchema = z.object({
  itemId: z.string(),
  title: z.string(),
  courseId: z.string(),
  courseName: z.string(),
  minutes: z.number().int().min(1).max(1440),
  /** Why the slot sits where it does, in the planner's own words. */
  reason: z.string().max(240),
  dueAt: z.string().nullable(),
  url,
});
export type PlanSlot = z.infer<typeof planSlotSchema>;

export const PLAN_LIMITS = { days: 14, slotsPerDay: 8 } as const;

/** Rows are what the UI renders under an answer; the model never retypes them. */
export const toolRowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("item"),
    id: z.string(),
    title: z.string(),
    courseId: z.string(),
    courseName: z.string(),
    itemKind: compactItemKindSchema,
    dueAt: z.string().nullable(),
    dueLocal: z.string().nullable(),
    bucket: compactBucketSchema,
    status: compactItemStatusSchema,
    /** Marked done by the student on this device. */
    doneLocally: z.boolean().optional(),
    url,
    priority: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("personal"),
    id: z.string(),
    title: z.string(),
    courseId: z.string().nullable(),
    courseName: z.string().nullable(),
    dueAt: z.string(),
    dueLocal: z.string(),
    bucket: compactBucketSchema,
    done: z.boolean(),
    fromPlan: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("plan-day"),
    /** `${planId}:${date}`. */
    id: z.string(),
    /** The same for every day of one plan, and the same again for the same request, so adding it to the Week tab twice replaces instead of doubling. */
    planId: z.string().min(1).max(120),
    /** The day as a short label, for example "Tue, Sep 8". */
    title: z.string(),
    date: calendarDateSchema,
    totalMinutes: z.number().int().min(0),
    capacityMinutes: z.number().int().min(0),
    slots: z.array(planSlotSchema).max(PLAN_LIMITS.slotsPerDay),
  }),
  z.object({
    kind: z.literal("course"),
    /** The course id. */
    id: z.string(),
    /** The course name. */
    title: z.string(),
    courseId: z.string(),
    courseName: z.string(),
    open: z.number().int().min(0),
    overdue: z.number().int().min(0),
    /** Open items due in the period asked about. */
    dueInPeriod: z.number().int().min(0),
    /** Points possible across those items, where Brightspace says. */
    pointsAtStake: z.number().min(0),
    nextDueAt: z.string().nullable(),
    nextDueLocal: z.string().nullable(),
    /** Changes detected in the last two weeks. */
    changes: z.number().int().min(0),
    url,
  }),
  z.object({
    kind: z.literal("announcement"),
    id: z.string(),
    title: z.string(),
    courseId: z.string(),
    courseName: z.string(),
    createdAt: z.string().nullable(),
    createdLocal: z.string().nullable(),
    pinned: z.boolean(),
    url,
  }),
  z.object({
    kind: z.literal("change"),
    id: z.string(),
    changeKind: compactChangeKindSchema,
    title: z.string(),
    courseId: z.string(),
    courseName: z.string(),
    detectedAt: z.string(),
    detectedLocal: z.string(),
    before: compactChangeFieldsSchema.nullable(),
    after: compactChangeFieldsSchema.nullable(),
    url,
  }),
]);
export type ToolRow = z.infer<typeof toolRowSchema>;

export const askErrorCodeSchema = z.enum([
  /** Client-only: the Nova API could not be reached at all. The server never emits it. */
  "unreachable",
  "bad_request",
  "unauthorized",
  "not_configured",
  "rate_limited",
  "budget_exhausted",
  "upstream_error",
  "upstream_timeout",
  "aborted",
  "internal",
]);
export type AskErrorCode = z.infer<typeof askErrorCodeSchema>;

export const modelUsageSchema = z.object({
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

/** Server-sent events for one chat turn, in order: tool_call/tool_result pairs, text deltas, then done or error. */
export const askEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("tool_call"), id: z.string(), name: toolNameSchema, input: z.unknown() }),
  z.object({
    type: z.literal("tool_result"),
    id: z.string(),
    name: toolNameSchema,
    ok: z.boolean(),
    summary: z.string(),
    rows: z.array(toolRowSchema),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("done"),
    model: z.string().nullable(),
    usage: modelUsageSchema.nullable(),
    rounds: z.number().int().min(0),
    grounded: z.boolean(),
    corrected: z.boolean(),
  }),
  z.object({
    type: z.literal("error"),
    code: askErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().optional(),
  }),
]);
export type AskEvent = z.infer<typeof askEventSchema>;
export type AskErrorEvent = Extract<AskEvent, { type: "error" }>;
export type AskDoneEvent = Extract<AskEvent, { type: "done" }>;

export const apiErrorBodySchema = z.object({
  error: z.object({ code: askErrorCodeSchema, message: z.string(), retryable: z.boolean().optional(), retryAfterSeconds: z.number().optional() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
