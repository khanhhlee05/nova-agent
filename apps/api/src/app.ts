import type { ChatModel } from "@nova-agent/agent";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ApiConfig } from "./config";
import { matchOrigin } from "./cors";
import { errorBody } from "./errors";
import { silentLogger, type Logger } from "./log";
import { chatRoute } from "./routes/chat";
import { healthRoute } from "./routes/health";
import { UsageCounter } from "./usage";

export type AppDeps = {
  config: ApiConfig;
  /** Null means "no key": /v1/chat answers 503 not_configured. */
  model: ChatModel | null;
  logger?: Logger;
  usage?: UsageCounter;
  now?: () => Date;
};

export type AppContext = { config: ApiConfig; model: ChatModel | null; logger: Logger; usage: UsageCounter; now: () => Date };

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
export const createApp = (deps: AppDeps): Hono => {
  const context: AppContext = {
    config: deps.config,
    model: deps.model,
    logger: deps.logger ?? silentLogger,
    usage: deps.usage ?? new UsageCounter(deps.config.DAILY_TOKEN_CAP),
    now: deps.now ?? (() => new Date()),
  };
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: (origin) => (matchOrigin(origin, context.config.CORS_ORIGINS) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );
  app.use("/v1/*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(errorBody("bad_request", "Request body is too large."), 413) }));
  app.use("/v1/*", async (c, next) => {
    const token = context.config.NOVA_DEV_TOKEN;
    if (!token) return next();
    const header = c.req.header("authorization") ?? "";
    if (!constantTimeEqual(header, `Bearer ${token}`)) return c.json(errorBody("unauthorized", "Missing or wrong bearer token."), 401);
    await next();
  });

  app.route("/", healthRoute(context));
  app.route("/", chatRoute(context));
  app.notFound((c) => c.json(errorBody("bad_request", "Not found."), 404));
  app.onError((error, c) => {
    context.logger.error("request.failed", { name: error.name, message: error.message, path: c.req.path });
    return c.json(errorBody("internal", "Nova hit an unexpected problem."), 500);
  });
  return app;
};
