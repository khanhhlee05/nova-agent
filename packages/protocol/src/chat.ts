import { z } from "zod";
import { clientToolNameSchema } from "./events";
import { compactSnapshotSchema } from "./snapshot";

export const CHAT_LIMITS = { message: 2000, historyMessages: 12, historyContent: 4000, summary: 1500 } as const;

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(CHAT_LIMITS.historyContent),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * What the student was looking at when they asked. A hint for resolving "this course" or "this item",
 * never a filter: the tools still read every course.
 */
export const chatFocusSchema = z.object({
  /** The course the panel is filtered to, if any. */
  courseId: z.string().min(1).max(64).nullable().optional(),
  /** The tab the student came from. */
  tab: z.enum(["focus", "week", "changes"]).optional(),
  /** Short item id when the question was started from one item ("Ask Nova about this"). */
  itemId: z.string().min(2).max(40).optional(),
});
export type ChatFocus = z.infer<typeof chatFocusSchema>;

/**
 * One turn. The server is stateless: the client sends the text history it
 * wants the model to see and the compact snapshot the tools should read.
 */
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(CHAT_LIMITS.message),
  history: z.array(chatMessageSchema).max(CHAT_LIMITS.historyMessages),
  snapshot: compactSnapshotSchema,
  focus: chatFocusSchema.optional(),
  /** What was said before the twelve messages in `history`, written by the client from its own thread. Data for the model, never instructions. */
  summary: z.string().max(CHAT_LIMITS.summary).optional(),
  /** The lookups this panel can make on the device right now. The server offers the model no other client tool. */
  clientTools: z.array(clientToolNameSchema).max(8).optional(),
  /** True when the panel can show text as it is written and take a `text_reset`. Without it the answer comes as one checked `text` event. */
  streamText: z.boolean().optional(),
  client: z.object({ name: z.literal("nova-extension"), version: z.string().min(1).max(32) }),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("nova-agent-api"),
  configured: z.boolean(),
  model: z.string().nullable(),
  usedToday: z.number().int().min(0),
  /** Tokens this server allows per UTC day across everyone who uses it. 0 means no limit. Absent on older servers. */
  dailyCap: z.number().int().min(0).optional(),
  /** `google` when students must sign in before asking. Absent on older servers, which need no sign-in. */
  auth: z.enum(["none", "google"]).optional(),
  /** The Google OAuth client to sign in with, when `auth` is `google`. A client id is public by design. */
  googleClientId: z.string().max(200).optional(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
