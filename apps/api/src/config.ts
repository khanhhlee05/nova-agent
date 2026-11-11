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
  /** How long a turn waits for the panel to answer a lookup only it can make. */
  CLIENT_TOOL_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(30_000),
  DAILY_TOKEN_CAP: z.coerce.number().int().min(0).default(200_000),
  /** Worst-case tokens reserved per request before the model is called. Defaults to MAX_TOKENS × MAX_ROUNDS. */
  TURN_TOKEN_ESTIMATE: z.coerce.number().int().min(1).optional(),
  LOG_PROMPTS: flag,
  /** `google`: students sign in with Google and use is counted per student. `none`: one person's own server. */
  AUTH_MODE: z.enum(["none", "google"]).default("none"),
  /** The OAuth client the extension signs in with. ID tokens issued to any other client are refused. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  /** Signs this server's access tokens. At least 32 characters; changing it signs everyone out. */
  JWT_SECRET: z.string().optional(),
  /** Postgres, for accounts, sessions, per-student use, and saved conversations. Required with AUTH_MODE=google. */
  DATABASE_URL: z.string().optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Comma-separated email domains allowed to sign in, such as villanova.edu. Empty allows any Google account. */
  ALLOWED_EMAIL_DOMAINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((entry) => entry.trim().toLowerCase().replace(/^@/, "")).filter(Boolean)),
  /** Tokens one student may use per UTC day. 0 means no limit. */
  USER_DAILY_TOKEN_CAP: z.coerce.number().int().min(0).default(40_000),
  /** Questions one student may ask per ten minutes. 0 means no limit. */
  USER_TURNS_PER_10_MIN: z.coerce.number().int().min(0).default(20),
  /** The kill switch: 1 refuses every question at once, without a restart of anything else. */
  ASK_DISABLED: flag,
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
export const validateDeployment = (
  config: Pick<ApiConfig, "HOST" | "NOVA_DEV_TOKEN" | "DAILY_TOKEN_CAP" | "MAX_TOKENS" | "MAX_ROUNDS" | "TURN_TOKEN_ESTIMATE"> & Partial<Pick<ApiConfig, "AUTH_MODE" | "GOOGLE_CLIENT_ID" | "JWT_SECRET" | "DATABASE_URL" | "USER_DAILY_TOKEN_CAP">>,
): void => {
  const hosted = config.AUTH_MODE === "google";
  if (!isLoopbackHost(config.HOST) && !config.NOVA_DEV_TOKEN && !hosted) {
    throw new Error(`HOST=${config.HOST} is reachable from other machines. Set NOVA_DEV_TOKEN so /v1/* requires a bearer token, set AUTH_MODE=google so students sign in, or bind HOST=127.0.0.1.`);
  }
  if (hosted) {
    if (!config.GOOGLE_CLIENT_ID) throw new Error("AUTH_MODE=google needs GOOGLE_CLIENT_ID: the OAuth client the extension signs in with.");
    if (!config.JWT_SECRET || config.JWT_SECRET.length < 32) throw new Error("AUTH_MODE=google needs JWT_SECRET of at least 32 characters. Generate one with: openssl rand -base64 48");
    if (!config.DATABASE_URL) throw new Error("AUTH_MODE=google needs DATABASE_URL: a Postgres database for accounts and per-student use.");
  }
  const estimate = turnTokenEstimate(config);
  if (hosted && (config.USER_DAILY_TOKEN_CAP ?? 0) > 0 && (config.USER_DAILY_TOKEN_CAP ?? 0) < estimate) {
    throw new Error(`USER_DAILY_TOKEN_CAP=${config.USER_DAILY_TOKEN_CAP} is below one turn's reservation (${estimate}), so every question would be refused. Raise the cap or lower TURN_TOKEN_ESTIMATE.`);
  }
  if (config.DAILY_TOKEN_CAP > 0 && config.DAILY_TOKEN_CAP < estimate) {
    throw new Error(`DAILY_TOKEN_CAP=${config.DAILY_TOKEN_CAP} is below one turn's reservation (${estimate}), so every request would be refused. Raise the cap or lower TURN_TOKEN_ESTIMATE.`);
  }
};

/**
 * Tokens reserved per request up front. The estimate ignores prompt tokens
 * on purpose: its job is to bound how far concurrent requests can overshoot
 * the cap; the real total is charged when the turn settles.
 */
export const turnTokenEstimate = (config: Pick<ApiConfig, "MAX_TOKENS" | "MAX_ROUNDS" | "TURN_TOKEN_ESTIMATE">): number =>
  config.TURN_TOKEN_ESTIMATE ?? config.MAX_TOKENS * config.MAX_ROUNDS;
