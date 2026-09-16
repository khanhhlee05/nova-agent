import { OpenAiCompatibleModel } from "@nova-agent/agent";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { startServer } from "./server";

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

try {
  startServer({ config, model, logger });
} catch (error) {
  logger.error("api.refused", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
