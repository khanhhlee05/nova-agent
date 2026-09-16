import { z } from "zod";

const flag = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((value) => value === "1" || value === "true");

export const configSchema = z.object({
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default("meta-llama/llama-3.3-70b-instruct:free"),
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Bind address. Loopback by default; anything else needs NOVA_DEV_TOKEN (see validateDeployment). */
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  CORS_ORIGINS: z
    .string()
    .default("chrome-extension://*,http://localhost:5174")
    .transform((value) => value.split(",").map((entry) => entry.trim()).filter(Boolean)),
  NOVA_DEV_TOKEN: z.string().optional(),
  MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(700),
  MAX_ROUNDS: z.coerce.number().int().min(1).max(8).default(4),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  DAILY_TOKEN_CAP: z.coerce.number().int().min(0).default(200_000),
  LOG_PROMPTS: flag,
});

export type ApiConfig = z.infer<typeof configSchema>;

/** Empty strings in .env mean "unset", so defaults apply. */
export const loadConfig = (env: Record<string, string | undefined>): ApiConfig =>
  configSchema.parse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== "")));

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3})$/i;

/** True only for addresses other machines cannot reach. */
export const isLoopbackHost = (host: string): boolean => LOOPBACK.test(host.trim());

/**
 * Startup rule, kept pure so tests cover it without listening: a bind that
 * other machines can reach exposes the model key to anyone who can send a
 * request, so it requires the bearer token. CORS is not authentication.
 */
export const validateDeployment = (config: Pick<ApiConfig, "HOST" | "NOVA_DEV_TOKEN">): void => {
  if (isLoopbackHost(config.HOST) || config.NOVA_DEV_TOKEN) return;
  throw new Error(`HOST=${config.HOST} is reachable from other machines. Set NOVA_DEV_TOKEN so /v1/* requires a bearer token, or bind HOST=127.0.0.1.`);
};
