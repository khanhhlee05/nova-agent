import { OpenAiCompatibleModel } from "@nova-agent/agent";
import { fileURLToPath } from "node:url";
import type { Hosted } from "./app";
import { AccessTokens, createGoogleVerifier } from "./auth";
import { loadConfig, validateDeployment } from "./config";
import { createLogger } from "./log";
import { startServer } from "./server";
import { AccountStore } from "./store/accounts";
import { migrate } from "./store/migrations";
import { pgSql } from "./store/sql";

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

/** Signed-in mode: connect to Postgres, bring the schema up to date, and build what sign-in needs. */
const openHosted = async (): Promise<Hosted | undefined> => {
  if (config.AUTH_MODE !== "google") return undefined;
  validateDeployment(config);
  const { Pool } = await import("pg");
  const sql = pgSql(new Pool({ connectionString: config.DATABASE_URL, max: 5 }));
  const applied = await migrate(sql);
  logger.info("db.ready", { migrationsApplied: applied });
  return { store: new AccountStore(sql), tokens: new AccessTokens(config.JWT_SECRET as string, config.ACCESS_TOKEN_TTL_SECONDS), verifyGoogle: createGoogleVerifier(config.GOOGLE_CLIENT_ID as string) };
};

try {
  startServer({ config, model, logger, hosted: await openHosted() });
} catch (error) {
  logger.error("api.refused", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}
