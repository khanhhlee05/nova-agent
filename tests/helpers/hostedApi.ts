import { PGlite } from "@electric-sql/pglite";
import { ScriptedModel, demoRouter, type ChatModel } from "@nova-agent/agent";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createApp, type Hosted } from "../../apps/api/src/app";
import { AccessTokens, createGoogleVerifier } from "../../apps/api/src/auth";
import { loadConfig } from "../../apps/api/src/config";
import { createLogger } from "../../apps/api/src/log";
import { AccountStore } from "../../apps/api/src/store/accounts";
import { migrate } from "../../apps/api/src/store/migrations";
import type { Sql } from "../../apps/api/src/store/sql";
import { UsageCounter } from "../../apps/api/src/usage";

export const CLIENT_ID = "1234567890-nova.apps.googleusercontent.com";
export const JWT_SECRET = "test-secret-that-is-long-enough-for-hs256-signing";

/** An embedded Postgres behind the store's own interface, so tests run the SQL the server runs. */
export const pgliteSql = (db: PGlite): Sql => ({
  query: async <T>(text: string, params: readonly unknown[] = []) => (await db.query(text, [...params])).rows as T[],
  transaction: (work) => db.transaction((tx) => work({ query: async <T>(text: string, params: readonly unknown[] = []) => (await tx.query(text, [...params])).rows as T[] })) as never,
  close: () => db.close(),
});

export type GoogleClaims = { sub?: string; email?: string; email_verified?: boolean; aud?: string; iss?: string; expiresInSeconds?: number };

/** A stand-in for Google: a key pair whose public half the server trusts, and a way to mint ID tokens with it. */
export const fakeGoogle = async (now: () => Date) => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const mint = async (claims: GoogleClaims = {}, key: CryptoKey = privateKey as CryptoKey): Promise<string> => {
    const issuedAt = Math.floor(now().getTime() / 1000);
    return new SignJWT({ email: claims.email ?? "student@villanova.edu", email_verified: claims.email_verified ?? true })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject(claims.sub ?? "google-sub-1")
      .setIssuer(claims.iss ?? "https://accounts.google.com")
      .setAudience(claims.aud ?? CLIENT_ID)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (claims.expiresInSeconds ?? 3600))
      .sign(key);
  };
  return { keys: createLocalJWKSet({ keys: [jwk] }), mint, mintWithWrongKey: (claims: GoogleClaims = {}) => mint(claims, other.privateKey as CryptoKey) };
};

export type HostedHarness = Awaited<ReturnType<typeof hostedHarness>>;

/** The whole server in signed-in mode, in process: a real schema, real tokens, and a Google whose keys the test holds. */
export const hostedHarness = async (options: { env?: Record<string, string>; model?: ChatModel | null; start?: Date; cap?: number } = {}) => {
  let clock = options.start ?? new Date("2026-09-08T18:00:00.000Z");
  const now = () => clock;
  const db = new PGlite();
  const sql = pgliteSql(db);
  await migrate(sql, now);
  const store = new AccountStore(sql);
  const google = await fakeGoogle(now);
  const config = loadConfig({ OPENROUTER_API_KEY: "sk-test", CORS_ORIGINS: "chrome-extension://abc", AUTH_MODE: "google", GOOGLE_CLIENT_ID: CLIENT_ID, JWT_SECRET, DATABASE_URL: "postgres://test", ...options.env });
  const hosted: Hosted = { store, tokens: new AccessTokens(JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS, now), verifyGoogle: createGoogleVerifier(CLIENT_ID, google.keys, now) };
  const lines: string[] = [];
  const usage = new UsageCounter(options.cap ?? config.DAILY_TOKEN_CAP);
  const app = createApp({ config, model: options.model === undefined ? new ScriptedModel(demoRouter) : options.model, logger: createLogger((line) => lines.push(line), now), usage, now, hosted });
  const call = (path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: { Origin: "chrome-extension://abc", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
      ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
    });
  const signIn = async (claims: GoogleClaims = {}) => {
    const response = await call("/v1/auth/google", { body: { idToken: await google.mint(claims) } });
    return (await response.json()) as { accessToken: string; refreshToken: string; expiresIn: number; user: { id: string; email: string } };
  };
  return { app, call, signIn, google, store, sql, db, config, hosted, lines, usage, now, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)), close: () => db.close() };
};
