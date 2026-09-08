import { z } from "zod";

/** Side-panel-side validation of what the content-script bridge returns. */
export const rawResponseSchema = z.object({
  status: z.number().int().min(0).max(999),
  contentType: z.string().max(256).nullable(),
  isJson: z.boolean(),
  body: z.unknown(),
  redirected: z.boolean(),
  finalPath: z.string().max(2048).nullable(),
  headers: z.object({
    retryAfter: z.string().max(64).nullable(),
    rateLimitRemaining: z.string().max(64).nullable(),
    rateLimitReset: z.string().max(64).nullable(),
  }),
});

export const fetchBridgeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), response: rawResponseSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["unsafe-path", "network", "timeout", "no-tab", "no-bridge"]) }),
]);

export const pingResultSchema = z.object({ ok: z.literal(true), origin: z.string().max(256) });
