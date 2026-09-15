import { OpenAiCompatibleModel } from "@nova-agent/agent";
import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createLogger } from "./log";

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  // No .env file: environment variables only.
}

const config = loadConfig(process.env);
const logger = createLogger();
const model = config.OPENROUTER_API_KEY
  ? new OpenAiCompatibleModel({
      baseUrl: config.OPENROUTER_BASE_URL,
      apiKey: config.OPENROUTER_API_KEY,
      model: config.OPENROUTER_MODEL,
      headers: { "HTTP-Referer": "https://github.com/khanhhlee05/nova-agent", "X-Title": "Nova Agent" },
      timeoutMs: config.REQUEST_TIMEOUT_MS,
    })
  : null;

const app = createApp({ config, model, logger });

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info("api.listening", { port: info.port, configured: model !== null, model: model ? config.OPENROUTER_MODEL : null, corsOrigins: config.CORS_ORIGINS });
});
