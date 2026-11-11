import type { ChatModel } from "@nova-agent/agent";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ApiConfig } from "./config";
import { matchOrigin } from "./cors";
import { errorBody } from "./errors";
import { silentLogger, type Logger } from "./log";
import type { AccessTokens, GoogleVerifier } from "./auth";
import { PendingClientCalls } from "./pending";
import { accountRoute } from "./routes/account";
import { chatRoute } from "./routes/chat";
import { healthRoute } from "./routes/health";
import type { AccountStore } from "./store/accounts";
import { UsageCounter } from "./usage";

/** What the server needs to know its students: where accounts live, how its tokens are signed, and how a Google sign-in is checked. */
export type Hosted = { store: AccountStore; tokens: AccessTokens; verifyGoogle: GoogleVerifier };

export type AppDeps = {
  config: ApiConfig;
  /** Null means "no key": /v1/chat answers 503 not_configured. */
  model: ChatModel | null;
  logger?: Logger;
  usage?: UsageCounter;
  now?: () => Date;
  pending?: PendingClientCalls;
  /** Required when the config says AUTH_MODE=google; ignored otherwise. */
  hosted?: Hosted;
};

export type AppContext = { config: ApiConfig; model: ChatModel | null; logger: Logger; usage: UsageCounter; now: () => Date; pending: PendingClientCalls; hosted: Hosted | null };

/** Routes anyone may call without an access token: signing in, and renewing or ending a session with its own refresh token. */
const OPEN_ROUTES = new Set(["/v1/auth/google", "/v1/auth/refresh", "/v1/auth/signout"]);

export const MAX_BODY_BYTES = 256 * 1024;

const constantTimeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
};

/** The whole HTTP surface, with every dependency injected so tests run it with `app.request()` and a scripted model. */
export const createApp = (deps: AppDeps): Hono<{ Variables: { userId: string } }> => {
  const context: AppContext = {
    config: deps.config,
    model: deps.model,
    logger: deps.logger ?? silentLogger,
    usage: deps.usage ?? new UsageCounter(deps.config.DAILY_TOKEN_CAP),
    now: deps.now ?? (() => new Date()),
    pending: deps.pending ?? new PendingClientCalls(),
    hosted: deps.config.AUTH_MODE === "google" ? (deps.hosted ?? null) : null,
  };
  if (deps.config.AUTH_MODE === "google" && !context.hosted) throw new Error("AUTH_MODE=google needs a store, a token signer, and a Google verifier.");
  const hosted = context.hosted;
  const app = new Hono<{ Variables: { userId: string } }>();

  app.use(
    "*",
    cors({
      origin: (origin) => (matchOrigin(origin, context.config.CORS_ORIGINS) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );
  app.use("/v1/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(errorBody("bad_request", "Request body is too large."), 413) }));
  app.use("/v1/*", async (c, next) => {
    if (hosted) {
      // Signed-in mode: every route but sign-in itself needs this server's own access token.
      if (OPEN_ROUTES.has(c.req.path)) return next();
      const header = c.req.header("authorization") ?? "";
      const userId = header.startsWith("Bearer ") ? await hosted.tokens.verify(header.slice(7)) : null;
      if (!userId) return c.json(errorBody("unauthorized", "Sign in to use this Nova server."), 401);
      c.set("userId", userId);
      return next();
    }
    const token = context.config.NOVA_DEV_TOKEN;
    if (!token) return next();
    const header = c.req.header("authorization") ?? "";
    if (!constantTimeEqual(header, `Bearer ${token}`)) return c.json(errorBody("unauthorized", "Missing or wrong bearer token."), 401);
    await next();
  });

  app.route("/", healthRoute(context));
  if (hosted) app.route("/", accountRoute(context, hosted));
  app.route("/", chatRoute(context));
  app.notFound((c) => c.json(errorBody("bad_request", "Not found."), 404));
  app.onError((error, c) => {
    context.logger.error("request.failed", { name: error.name, message: error.message, path: c.req.path });
    return c.json(errorBody("internal", "Nova hit an unexpected problem."), 500);
  });
  return app;
};
