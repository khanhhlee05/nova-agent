import { z } from "zod";

/**
 * The hosted mode of the Nova API: a student signs in with Google, the
 * server gives the panel a short-lived access token and a longer-lived
 * refresh token, and use is counted per student. A server run on one's own
 * machine (`auth: "none"`) needs none of this.
 */
export const authModeSchema = z.enum(["none", "google"]);
export type AuthMode = z.infer<typeof authModeSchema>;

export const ACCOUNT_LIMITS = { idToken: 4096, refreshToken: 256, conversations: 20, conversationBytes: 200_000, conversationTitle: 120, conversationId: 80, usageDays: 90 } as const;

export const accountUserSchema = z.object({ id: z.string().min(1), email: z.string().min(3).max(320) });
export type AccountUser = z.infer<typeof accountUserSchema>;

export const googleSignInRequestSchema = z.object({ idToken: z.string().min(20).max(ACCOUNT_LIMITS.idToken) });
export const refreshRequestSchema = z.object({ refreshToken: z.string().min(20).max(ACCOUNT_LIMITS.refreshToken) });

/** What a sign-in or a refresh returns. The refresh token is single use: each refresh returns a new one. */
export const sessionResponseSchema = z.object({
  accessToken: z.string().min(20),
  refreshToken: z.string().min(20),
  /** Seconds until the access token expires. */
  expiresIn: z.number().int().min(1),
  user: accountUserSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const accountUsageSchema = z.object({
  /** Tokens this student has used today (UTC), and the daily limit; 0 means no limit. */
  usedToday: z.number().int().min(0),
  dailyCap: z.number().int().min(0),
  /** Questions asked in the last ten minutes, and how many are allowed; 0 means no limit. */
  recentTurns: z.number().int().min(0),
  turnLimit: z.number().int().min(0),
});
export type AccountUsage = z.infer<typeof accountUsageSchema>;

export const meResponseSchema = z.object({ user: accountUserSchema, usage: accountUsageSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const usageResponseSchema = z.object({ days: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), tokens: z.number().int().min(0), turns: z.number().int().min(0) })) });
export type UsageResponse = z.infer<typeof usageResponseSchema>;

const conversationId = z.string().min(1).max(ACCOUNT_LIMITS.conversationId).regex(/^[A-Za-z0-9_.:-]+$/);
const isoTime = z.string().datetime({ offset: true });

export const conversationSummarySchema = z.object({ id: conversationId, title: z.string().max(ACCOUNT_LIMITS.conversationTitle), createdAt: isoTime, updatedAt: isoTime, messageCount: z.number().int().min(0) });
export type RemoteConversationSummary = z.infer<typeof conversationSummarySchema>;

/**
 * A conversation as the panel saves it. `messages` is the panel's own shape,
 * stored as it is and handed back as it is: the server never reads it, and
 * the panel validates it again when it comes back.
 */
export const conversationBodySchema = z.object({ title: z.string().max(ACCOUNT_LIMITS.conversationTitle), createdAt: isoTime, updatedAt: isoTime, messages: z.array(z.unknown()).max(400) });
export type ConversationBody = z.infer<typeof conversationBodySchema>;

export const conversationResponseSchema = conversationBodySchema.extend({ id: conversationId });
export type RemoteConversation = z.infer<typeof conversationResponseSchema>;

export const conversationListResponseSchema = z.object({ conversations: z.array(conversationSummarySchema) });
