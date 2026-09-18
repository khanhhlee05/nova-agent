import type { HealthResponse } from "@nova-agent/protocol";
import { Hono } from "hono";
import type { AppContext } from "../app";

export const healthRoute = (context: AppContext): Hono =>
  new Hono().get("/healthz", (c) => {
    const body: HealthResponse = {
      status: "ok",
      service: "nova-agent-api",
      configured: context.model !== null,
      model: context.model ? context.config.OPENROUTER_MODEL : null,
      usedToday: context.usage.usedToday(context.now()),
    };
    return c.json(body);
  });
