import { z } from "zod";
import { compactSnapshotSchema } from "./snapshot";

export const CHAT_LIMITS = { message: 2000, historyMessages: 12, historyContent: 4000 } as const;

export const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(CHAT_LIMITS.historyContent),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * One turn. The server is stateless: the client sends the text history it
 * wants the model to see and the compact snapshot the tools should read.
 */
export const chatRequestSchema = z.object({
  message: z.string().trim().min(1).max(CHAT_LIMITS.message),
  history: z.array(chatMessageSchema).max(CHAT_LIMITS.historyMessages),
  snapshot: compactSnapshotSchema,
  client: z.object({ name: z.literal("nova-extension"), version: z.string().min(1).max(32) }),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("nova-agent-api"),
  configured: z.boolean(),
  model: z.string().nullable(),
  usedToday: z.number().int().min(0),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
