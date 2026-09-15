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
