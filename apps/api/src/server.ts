import type { ChatModel } from "@nova-agent/agent";
import { serve as honoServe } from "@hono/node-server";
import { createApp } from "./app";
import { validateDeployment, type ApiConfig } from "./config";
import type { Logger } from "./log";

export type StartOptions = {
  config: ApiConfig;
  model: ChatModel | null;
  logger: Logger;
  /** Injectable for tests; defaults to @hono/node-server. */
  serve?: typeof honoServe;
};

/** Validates the deployment, builds the app, and binds it to the configured host only. */
export const startServer = ({ config, model, logger, serve = honoServe }: StartOptions): ReturnType<typeof honoServe> => {
  validateDeployment(config);
  const app = createApp({ config, model, logger });
  return serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST }, (info) => {
    logger.info("api.listening", {
      host: info.address,
      port: info.port,
      tokenRequired: Boolean(config.NOVA_DEV_TOKEN),
      configured: model !== null,
      model: model ? config.OPENROUTER_MODEL : null,
      corsOrigins: config.CORS_ORIGINS,
    });
  });
};
