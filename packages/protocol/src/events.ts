import { z } from "zod";
import { calendarDateSchema, compactBucketSchema, compactChangeFieldsSchema, compactChangeKindSchema, compactItemKindSchema, compactItemStatusSchema } from "./snapshot";

export const toolNameSchema = z.enum([
  "get_brief",
  "list_deadlines",
  "get_item_details",
  "get_recent_announcements",
  "get_changes",
  "build_study_plan",
  "get_course_load",
  "propose_mark_done",
  "propose_hide",
  "propose_mark_read",
  "propose_personal_deadline",
  "read_attachment",
  "search_course_materials",
  "read_course_material",
]);
export type ToolName = z.infer<typeof toolNameSchema>;

/**
 * Tools the panel runs, not the server: they need something only the device
 * has (a file behind the student's Brightspace session, text kept in the
 * extension's own storage). The server offers one to the model only when the
 * request says this panel can answer it.
 */
export const clientToolNameSchema = z.enum(["read_attachment", "search_course_materials", "read_course_material"]);
export type ClientToolName = z.infer<typeof clientToolNameSchema>;

export const CLIENT_TOOL_LIMITS = { dataBytes: 24_000, summary: 300, error: 600, rows: 25, text: 12_000, passages: 8, passageChars: 1000 } as const;

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
    kind: z.literal("attachment"),
    /** `${itemId}:${fileId}`. */
    id: z.string(),
    /** The file name. */
    title: z.string(),
    itemId: z.string(),
    itemTitle: z.string(),
    courseId: z.string(),
    courseName: z.string(),
    fileId: z.string(),
    size: z.number().int().min(0).nullable(),
    source: z.enum(["instructor", "submission"]),
    /** Whether its text has been read on this device. */
    read: z.boolean(),
    /** The assignment's own page; a file is opened from there. */
    url,
  }),
  z.object({
    kind: z.literal("material"),
    /** The topic id: one row per topic, however many passages came from it. */
    id: z.string(),
    /** The topic title. */
    title: z.string(),
    courseId: z.string(),
    courseName: z.string(),
    /** The modules it sits under, joined with " › ". */
    module: z.string(),
    /** The page or slide the best passage came from, when the file has them. */
    part: z.number().int().min(1).nullable(),
    partKind: z.enum(["page", "slide"]).nullable(),
    /** The topic's page in Brightspace. */
    url,
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

export const PROPOSAL_LIMITS = { perTurn: 3, items: 20, changes: 60, title: 120 } as const;

const itemRef = z.string().min(2).max(40);
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour time like 17:30.");

/**
 * What a proposal would do. Every kind changes something stored on the
 * student's device and nothing else: none of them can reach Brightspace, and
 * none runs on the server. Items, changes, and deadlines are named by the ids
 * the snapshot sent; a date is a local calendar day and a local clock time,
 * so the device, not the server, turns them into an instant.
 */
export const proposalPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mark_done"), itemIds: z.array(itemRef).min(1).max(PROPOSAL_LIMITS.items) }),
  z.object({ kind: z.literal("hide_item"), itemIds: z.array(itemRef).min(1).max(PROPOSAL_LIMITS.items) }),
  z.object({ kind: z.literal("mark_changes_read"), changeIds: z.array(z.string().min(1).max(80)).min(1).max(PROPOSAL_LIMITS.changes) }),
  z.object({ kind: z.literal("add_personal_deadline"), title: z.string().min(1).max(PROPOSAL_LIMITS.title), dueDate: calendarDateSchema, time: clockTime, courseId: z.string().min(1).max(64).nullable() }),
  z.object({ kind: z.literal("move_personal_deadline"), personalId: z.string().min(1).max(80), dueDate: calendarDateSchema, time: clockTime }),
  z.object({ kind: z.literal("complete_personal_deadline"), personalId: z.string().min(1).max(80) }),
]);
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;
export type ProposalKind = ProposalPayload["kind"];

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

/**
 * Server-sent events for one chat turn, in order: tool_call/tool_result pairs, text, then done or error.
 *
 * Text arrives one of two ways. By default the answer is held back until it has been checked and sent as a
 * single `text` event. When the request sets `streamText`, `text` events carry the model's words as they
 * come, and a `text_reset` event tells the panel to throw away what it has shown so far: the words were a
 * remark before a lookup (`lookup`), or a draft that failed the check and is being written again
 * (`correction`). Either way `done.grounded` is the verdict on the text that finally stands.
 */
export const askEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("text_reset"), reason: z.enum(["lookup", "correction"]) }),
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
  /**
   * A lookup only the panel can make. The server sends it and waits; the panel answers with a POST to
   * `/v1/chat/{turnId}/tool-result`, and the ordinary `tool_result` event follows.
   */
  z.object({ type: z.literal("client_tool"), turnId: z.string().min(8).max(64), id: z.string().min(1).max(120), name: clientToolNameSchema, input: z.unknown() }),
  /**
   * An action the model suggests. It only shows a card: the student confirms or dismisses it, and the
   * extension carries it out. `label` is the server's wording for logs and screen readers; the card
   * writes its own sentence from `payload` and the data on the device, so what is confirmed is what runs.
   */
  z.object({ type: z.literal("proposal"), id: z.string().min(1).max(120), label: z.string().max(300), payload: proposalPayloadSchema }),
  z.object({
    type: z.literal("done"),
    model: z.string().nullable(),
    usage: modelUsageSchema.nullable(),
    rounds: z.number().int().min(0),
    grounded: z.boolean(),
    corrected: z.boolean(),
    /**
     * Client-only: set when the answer was made on the device without a model, because the server could not
     * answer. Carries the reason. The server never emits it.
     */
    offline: z.enum(["unreachable", "not_configured", "rate_limited", "budget_exhausted"]).optional(),
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
export type AskProposalEvent = Extract<AskEvent, { type: "proposal" }>;

/** What the panel sends back for a `client_tool` event. `data` is what the model reads; it is capped so one file cannot flood a turn. */
export const clientToolResultSchema = z
  .object({
    id: z.string().min(1).max(120),
    ok: z.boolean(),
    summary: z.string().max(CLIENT_TOOL_LIMITS.summary),
    data: z.unknown(),
    rows: z.array(toolRowSchema).max(CLIENT_TOOL_LIMITS.rows),
    error: z.string().max(CLIENT_TOOL_LIMITS.error).optional(),
  })
  .refine((result) => JSON.stringify(result.data ?? null).length <= CLIENT_TOOL_LIMITS.dataBytes, { message: "data is too large", path: ["data"] });
export type ClientToolResult = z.infer<typeof clientToolResultSchema>;

export const apiErrorBodySchema = z.object({
  error: z.object({ code: askErrorCodeSchema, message: z.string(), retryable: z.boolean().optional(), retryAfterSeconds: z.number().optional() }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;
