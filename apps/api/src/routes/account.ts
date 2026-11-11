import { ACCOUNT_LIMITS, conversationBodySchema, googleSignInRequestSchema, refreshRequestSchema, type MeResponse, type SessionResponse, type UsageResponse } from "@nova-agent/protocol";
import { Hono, type Context } from "hono";
import type { AppContext, Hosted } from "../app";
import { emailAllowed, hashRefreshToken, newRefreshToken } from "../auth";
import { errorBody } from "../errors";
import type { User } from "../store/accounts";

export type AccountEnv = { Variables: { userId: string } };

const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

const readJson = async (c: Context): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
};

/**
 * Sign-in, the account, its use, and its saved conversations. Only mounted
 * when the server runs with AUTH_MODE=google. Everything but the three
 * `/v1/auth` routes sits behind the access-token check in `app.ts`, which
 * puts the student's id on the request; no route here takes a user id from
 * the client.
 */
export const accountRoute = (context: AppContext, hosted: Hosted): Hono<AccountEnv> => {
  const { store, tokens } = hosted;

  const session = async (user: User): Promise<SessionResponse> => {
    const now = context.now();
    const refreshToken = newRefreshToken();
    await store.putRefreshToken(user.id, hashRefreshToken(refreshToken), new Date(now.getTime() + context.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000), now);
    return { accessToken: await tokens.sign(user.id), refreshToken, expiresIn: tokens.ttlSeconds, user: { id: user.id, email: user.email } };
  };

  return new Hono<AccountEnv>()
    .post("/v1/auth/google", async (c) => {
      const parsed = googleSignInRequestSchema.safeParse(await readJson(c));
      if (!parsed.success) return c.json(errorBody("bad_request", "Expected a Google ID token."), 400);
      const identity = await hosted.verifyGoogle(parsed.data.idToken);
      if (!identity) return c.json(errorBody("unauthorized", "Google did not confirm that sign-in. Try signing in again."), 401);
      if (!emailAllowed(identity.email, context.config.ALLOWED_EMAIL_DOMAINS)) {
        return c.json(errorBody("unauthorized", `This Nova server only accepts accounts from ${context.config.ALLOWED_EMAIL_DOMAINS.join(", ")}.`), 403);
      }
      const user = await store.upsertUser(identity.sub, identity.email, context.now());
      context.logger.info("auth.signin", { userId: user.id });
      return c.json(await session(user));
    })
    .post("/v1/auth/refresh", async (c) => {
      const parsed = refreshRequestSchema.safeParse(await readJson(c));
      if (!parsed.success) return c.json(errorBody("bad_request", "Expected a refresh token."), 400);
      const userId = await store.takeRefreshToken(hashRefreshToken(parsed.data.refreshToken), context.now());
      const user = userId ? await store.getUser(userId) : null;
      if (!user) return c.json(errorBody("unauthorized", "Your sign-in has expired. Sign in again."), 401);
      return c.json(await session(user));
    })
    .post("/v1/auth/signout", async (c) => {
      const parsed = refreshRequestSchema.safeParse(await readJson(c));
      // Signing out always succeeds from the student's side: a token that is already gone is signed out.
      if (parsed.success) await store.deleteRefreshToken(hashRefreshToken(parsed.data.refreshToken));
      return c.json({ ok: true });
    })
    .get("/v1/me", async (c) => {
      const user = await store.getUser(c.get("userId"));
      if (!user) return c.json(errorBody("unauthorized", "This account no longer exists. Sign in again."), 401);
      const usage = await store.usageNow(user.id, context.now());
      const body: MeResponse = { user: { id: user.id, email: user.email }, usage: { ...usage, dailyCap: context.config.USER_DAILY_TOKEN_CAP, turnLimit: context.config.USER_TURNS_PER_10_MIN } };
      return c.json(body);
    })
    .delete("/v1/me", async (c) => {
      const userId = c.get("userId");
      await store.deleteUser(userId);
      context.logger.info("auth.deleted", { userId });
      return c.json({ ok: true });
    })
    .get("/v1/usage", async (c) => {
      const asked = Number(c.req.query("days") ?? "14");
      const days = Number.isInteger(asked) ? Math.min(ACCOUNT_LIMITS.usageDays, Math.max(1, asked)) : 14;
      const body: UsageResponse = { days: await store.usageByDay(c.get("userId"), days, context.now()) };
      return c.json(body);
    })
    .get("/v1/conversations", async (c) => c.json({ conversations: await store.listConversations(c.get("userId")) }))
    .delete("/v1/conversations", async (c) => {
      await store.deleteConversations(c.get("userId"));
      return c.json({ ok: true });
    })
    .get("/v1/conversations/:id", async (c) => {
      const id = c.req.param("id");
      const conversation = CONVERSATION_ID.test(id) ? await store.getConversation(c.get("userId"), id) : null;
      return conversation ? c.json(conversation) : c.json(errorBody("bad_request", "No such conversation."), 404);
    })
    .put("/v1/conversations/:id", async (c) => {
      const id = c.req.param("id");
      if (!CONVERSATION_ID.test(id)) return c.json(errorBody("bad_request", "That conversation id is not one Nova writes."), 400);
      const parsed = conversationBodySchema.safeParse(await readJson(c));
      if (!parsed.success) {
        // Paths only: the body is the student's conversation, which must not reach the logs or the error text.
        const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.slice(0, 2).join(".") || "(root)"))].slice(0, 10);
        return c.json(errorBody("bad_request", `Invalid conversation at: ${paths.join(", ")}.`), 400);
      }
      if (JSON.stringify(parsed.data.messages).length > ACCOUNT_LIMITS.conversationBytes) return c.json(errorBody("bad_request", "That conversation is too long to save."), 413);
      // A token can outlive its account by a few minutes; nothing is saved for an account that is gone.
      if (!(await store.getUser(c.get("userId")))) return c.json(errorBody("unauthorized", "This account no longer exists. Sign in again."), 401);
      await store.putConversation(c.get("userId"), id, parsed.data);
      return c.json({ ok: true });
    })
    .delete("/v1/conversations/:id", async (c) => {
      const id = c.req.param("id");
      if (CONVERSATION_ID.test(id)) await store.deleteConversation(c.get("userId"), id);
      return c.json({ ok: true });
    });
};
