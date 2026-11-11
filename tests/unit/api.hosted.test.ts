import { ModelError, ScriptedModel, compactSnapshot } from "@nova-agent/agent";
import { ACCOUNT_LIMITS, askEventSchema, conversationListResponseSchema, conversationResponseSchema, meResponseSchema, parseSseStream, sessionResponseSchema, usageResponseSchema, type AskEvent, type CompactSnapshot } from "@nova-agent/protocol";
import { SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app";
import { AccessTokens, createGoogleVerifier, emailAllowed, hashRefreshToken, newRefreshToken } from "../../apps/api/src/auth";
import { loadConfig, validateDeployment } from "../../apps/api/src/config";
import { MIGRATIONS, migrate } from "../../apps/api/src/store/migrations";
import { CLIENT_ID, JWT_SECRET, fakeGoogle, hostedHarness, type HostedHarness } from "../helpers/hostedApi";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let snapshot: CompactSnapshot;
let open: HostedHarness[] = [];

beforeAll(async () => {
  snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" });
});

afterEach(async () => {
  await Promise.all(open.map((harness) => harness.close()));
  open = [];
});

const start = async (options: Parameters<typeof hostedHarness>[0] = {}) => {
  const harness = await hostedHarness(options);
  open.push(harness);
  return harness;
};

const chatBody = (message = "What is due this week?") => ({ message, history: [], snapshot, client: { name: "nova-extension", version: "0.1.0" } });

const events = async (response: Response): Promise<AskEvent[]> => {
  const out: AskEvent[] = [];
  for await (const frame of parseSseStream(response.body as ReadableStream<Uint8Array>)) out.push(askEventSchema.parse(JSON.parse(frame.data)));
  return out;
};

describe("the schema", () => {
  it("is applied once, in order, and applying it again changes nothing", async () => {
    const { sql } = await start();
    expect(await migrate(sql)).toBe(0);
    expect((await sql.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version")).map((row) => Number(row.version))).toEqual(MIGRATIONS.map((_, index) => index + 1));
    const tables = (await sql.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")).map((row) => row.table_name);
    expect(tables).toEqual(["conversations", "refresh_tokens", "schema_migrations", "usage", "users"]);
  });

  it("has no table for course data", () => {
    const text = MIGRATIONS.join("\n").toLowerCase();
    for (const word of ["course", "assignment", "snapshot", "grade", "brightspace", "attachment", "material"]) expect(text, word).not.toContain(word);
  });
});

describe("checking a Google sign-in", () => {
  const at = () => new Date("2026-09-08T18:00:00.000Z");

  it("accepts a token Google issued to this project for a verified address", async () => {
    const google = await fakeGoogle(at);
    const verify = createGoogleVerifier(CLIENT_ID, google.keys, at);
    expect(await verify(await google.mint({ sub: "abc", email: "Student@Villanova.edu" }))).toEqual({ sub: "abc", email: "student@villanova.edu" });
    expect(await verify(await google.mint({ iss: "accounts.google.com" }))).toMatchObject({ sub: "google-sub-1" });
  });

  it("refuses a token for another client, from another issuer, expired, unverified, forged, or not a token at all", async () => {
    const google = await fakeGoogle(at);
    const verify = createGoogleVerifier(CLIENT_ID, google.keys, at);
    expect(await verify(await google.mint({ aud: "someone-else.apps.googleusercontent.com" }))).toBeNull();
    expect(await verify(await google.mint({ iss: "https://accounts.example.com" }))).toBeNull();
    expect(await verify(await google.mint({ expiresInSeconds: -60 }))).toBeNull();
    expect(await verify(await google.mint({ email_verified: false }))).toBeNull();
    expect(await verify(await google.mintWithWrongKey())).toBeNull();
    // Signed with a shared secret instead of Google's key: the algorithm is not one this server accepts.
    const hs = await new SignJWT({ email: "a@b.co", email_verified: true }).setProtectedHeader({ alg: "HS256" }).setSubject("x").setIssuer("https://accounts.google.com").setAudience(CLIENT_ID).setExpirationTime("1h").sign(new TextEncoder().encode(JWT_SECRET));
    expect(await verify(hs)).toBeNull();
    const [header, payload] = (await google.mint()).split(".");
    expect(await verify(`${header}.${payload}.`)).toBeNull();
    expect(await verify("not a token")).toBeNull();
    expect(await verify("")).toBeNull();
  });
});

describe("the server's own tokens", () => {
  it("come back as the user they were issued to, until they expire", async () => {
    let clock = new Date("2026-09-08T18:00:00.000Z");
    const tokens = new AccessTokens(JWT_SECRET, 900, () => clock);
    const token = await tokens.sign("user-1");
    expect(await tokens.verify(token)).toBe("user-1");
    clock = new Date(clock.getTime() + 899_000);
    expect(await tokens.verify(token)).toBe("user-1");
    clock = new Date(clock.getTime() + 2_000);
    expect(await tokens.verify(token)).toBeNull();
  });

  it("are refused when altered, signed with another secret, or made for something else", async () => {
    const at = () => new Date("2026-09-08T18:00:00.000Z");
    const tokens = new AccessTokens(JWT_SECRET, 900, at);
    const token = await tokens.sign("user-1");
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(payload, "base64url").toString()) as object), sub: "user-2" })).toString("base64url");
    expect(await tokens.verify(`${header}.${forged}.${signature}`)).toBeNull();
    expect(await new AccessTokens("another-secret-that-is-also-long-enough-123", 900, at).verify(token)).toBeNull();
    const google = await fakeGoogle(at);
    expect(await tokens.verify(await google.mint())).toBeNull();
    const none = `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`;
    expect(await tokens.verify(none)).toBeNull();
    expect(await tokens.verify("")).toBeNull();
  });

  it("refresh tokens are long, random, and stored only as a hash", () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashRefreshToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(a)).not.toContain(a);
    expect(hashRefreshToken(a)).toBe(hashRefreshToken(a));
  });

  it("an email domain list admits only its own domains", () => {
    expect(emailAllowed("a@villanova.edu", [])).toBe(true);
    expect(emailAllowed("a@villanova.edu", ["villanova.edu"])).toBe(true);
    expect(emailAllowed("a@VILLANOVA.EDU", ["villanova.edu"])).toBe(true);
    expect(emailAllowed("a@evil-villanova.edu", ["villanova.edu"])).toBe(false);
    expect(emailAllowed("a@villanova.edu.evil.com", ["villanova.edu"])).toBe(false);
    expect(emailAllowed("villanova.edu", ["villanova.edu"])).toBe(false);
    expect(loadConfig({ ALLOWED_EMAIL_DOMAINS: " @Villanova.edu , law.villanova.edu ," }).ALLOWED_EMAIL_DOMAINS).toEqual(["villanova.edu", "law.villanova.edu"]);
  });
});

describe("signing in", () => {
  it("creates the account on first sign-in, returns a session, and says who is signed in", async () => {
    const { call, signIn, sql } = await start();
    const response = await call("/v1/auth/google", { body: { idToken: await (await start()).google.mint() } });
    // A token from another Google (another key) is not accepted.
    expect(response.status).toBe(401);
    const session = await signIn({ sub: "g-1", email: "Ana@villanova.edu" });
    expect(sessionResponseSchema.safeParse(session).success).toBe(true);
    expect(session).toMatchObject({ expiresIn: 900, user: { email: "ana@villanova.edu" } });
    const me = await call("/v1/me", { token: session.accessToken });
    expect(me.status).toBe(200);
    expect(meResponseSchema.parse(await me.json())).toEqual({ user: session.user, usage: { usedToday: 0, recentTurns: 0, dailyCap: 40_000, turnLimit: 20 } });
    // Signing in again is the same account; a changed address follows Google's.
    const again = await signIn({ sub: "g-1", email: "ana.b@villanova.edu" });
    expect(again.user).toEqual({ id: session.user.id, email: "ana.b@villanova.edu" });
    expect(await sql.query("SELECT id FROM users")).toHaveLength(1);
    // The refresh token itself is nowhere in the database.
    expect(JSON.stringify(await sql.query("SELECT * FROM refresh_tokens"))).not.toContain(session.refreshToken);
  });

  it("refuses a bad body, a refused token, and an address outside the allowed domains", async () => {
    const { call, google, sql } = await start({ env: { ALLOWED_EMAIL_DOMAINS: "villanova.edu" } });
    expect((await call("/v1/auth/google", { body: {} })).status).toBe(400);
    expect((await call("/v1/auth/google", { body: "{not json" })).status).toBe(400);
    expect((await call("/v1/auth/google", { body: { idToken: await google.mint({ aud: "other" }) } })).status).toBe(401);
    const outside = await call("/v1/auth/google", { body: { idToken: await google.mint({ email: "someone@gmail.com" }) } });
    expect(outside.status).toBe(403);
    expect(await outside.json()).toMatchObject({ error: { code: "unauthorized", message: "This Nova server only accepts accounts from villanova.edu." } });
    expect(await sql.query("SELECT id FROM users")).toEqual([]);
    expect((await call("/v1/auth/google", { body: { idToken: await google.mint({ email: "ok@villanova.edu" }) } })).status).toBe(200);
  });

  it("needs this server's token on everything else, and nothing else will do", async () => {
    const { call, signIn, google } = await start({ env: { NOVA_DEV_TOKEN: "dev-token" } });
    const session = await signIn();
    for (const [path, init] of [
      ["/v1/me", {}],
      ["/v1/usage", {}],
      ["/v1/conversations", {}],
      ["/v1/chat", { body: chatBody() }],
      ["/v1/chat/0123abcd-0123/tool-result", { body: { id: "c1", ok: true, summary: "", data: null, rows: [] } }],
    ] as const) {
      expect((await call(path, init)).status, path).toBe(401);
      expect((await call(path, { ...init, token: "dev-token" })).status, path).toBe(401);
      expect((await call(path, { ...init, token: await google.mint() })).status, path).toBe(401);
      expect((await call(path, { ...init, token: session.refreshToken })).status, path).toBe(401);
    }
    expect(await (await call("/v1/me")).json()).toMatchObject({ error: { code: "unauthorized", message: "Sign in to use this Nova server." } });
    // Health needs nothing, and says that sign-in is required.
    expect(await (await call("/healthz")).json()).toMatchObject({ status: "ok", auth: "google" });
  });

  it("renews a session with a refresh token that works exactly once", async () => {
    const { call, signIn, advance } = await start();
    const first = await signIn();
    advance(16 * 60_000);
    expect((await call("/v1/me", { token: first.accessToken })).status).toBe(401);
    const renewed = await call("/v1/auth/refresh", { body: { refreshToken: first.refreshToken } });
    expect(renewed.status).toBe(200);
    const second = sessionResponseSchema.parse(await renewed.json());
    expect(second.user).toEqual(first.user);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await call("/v1/me", { token: second.accessToken })).status).toBe(200);
    // The used token is gone; a copy of it is worth nothing.
    const replay = await call("/v1/auth/refresh", { body: { refreshToken: first.refreshToken } });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: "unauthorized", message: "Your sign-in has expired. Sign in again." } });
    expect((await call("/v1/auth/refresh", { body: { refreshToken: "x".repeat(43) } })).status).toBe(401);
    expect((await call("/v1/auth/refresh", { body: {} })).status).toBe(400);
  });

  it("ends a session after thirty days without use, and at once on sign-out", async () => {
    const { call, signIn, advance, sql } = await start();
    const session = await signIn();
    advance(31 * 86_400_000);
    expect((await call("/v1/auth/refresh", { body: { refreshToken: session.refreshToken } })).status).toBe(401);
    const fresh = await signIn();
    expect((await call("/v1/auth/signout", { body: { refreshToken: fresh.refreshToken } })).status).toBe(200);
    expect((await call("/v1/auth/refresh", { body: { refreshToken: fresh.refreshToken } })).status).toBe(401);
    // Signing out twice, or with nothing, is still signed out.
    expect((await call("/v1/auth/signout", { body: { refreshToken: fresh.refreshToken } })).status).toBe(200);
    expect((await call("/v1/auth/signout", { body: {} })).status).toBe(200);
    expect(await sql.query("SELECT token_hash FROM refresh_tokens")).toEqual([]);
  });
});

describe("asking while signed in", () => {
  it("answers, and counts what the answer cost against the student who asked", async () => {
    const { call, signIn, sql, lines } = await start();
    const ana = await signIn({ sub: "g-ana", email: "ana@villanova.edu" });
    const ben = await signIn({ sub: "g-ben", email: "ben@villanova.edu" });
    const response = await call("/v1/chat", { body: chatBody(), token: ana.accessToken });
    expect(response.status).toBe(200);
    const stream = await events(response);
    const done = stream.at(-1) as Extract<AskEvent, { type: "done" }>;
    expect(done.type).toBe("done");
    const rows = await sql.query<{ user_id: string; tokens: number; settled: boolean; model: string }>("SELECT user_id, tokens, settled, model FROM usage");
    expect(rows).toEqual([{ user_id: ana.user.id, tokens: done.usage?.totalTokens, settled: true, model: "scripted" }]);
    const mine = meResponseSchema.parse(await (await call("/v1/me", { token: ana.accessToken })).json());
    expect(mine.usage).toMatchObject({ usedToday: done.usage?.totalTokens, recentTurns: 1 });
    expect(meResponseSchema.parse(await (await call("/v1/me", { token: ben.accessToken })).json()).usage).toMatchObject({ usedToday: 0, recentTurns: 0 });
    // The log names the account by id and still carries no question, no title, and no email.
    const turn = lines.find((line) => line.includes('"chat.turn"')) as string;
    expect(turn).toContain(ana.user.id);
    expect(lines.join("\n")).not.toMatch(/ana@villanova\.edu|What is due this week|Lab 3/);
  });

  it("stops a student at their daily allowance without touching anyone else's", async () => {
    const { call, signIn, usage, now } = await start({ env: { USER_DAILY_TOKEN_CAP: "3000", MAX_TOKENS: "700", MAX_ROUNDS: "4" } });
    const ana = await signIn({ sub: "g-ana" });
    const ben = await signIn({ sub: "g-ben", email: "ben@villanova.edu" });
    // Each scripted turn costs a few hundred tokens; the worst case reserved per turn is 2,800.
    expect((await call("/v1/chat", { body: chatBody(), token: ana.accessToken })).status).toBe(200);
    const before = usage.usedToday(now());
    const refused = await call("/v1/chat", { body: chatBody(), token: ana.accessToken });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "budget_exhausted", message: "You have used your Ask Nova allowance for today. It resets at midnight UTC.", retryable: true } });
    // A refused question costs the server's own budget nothing.
    expect(usage.usedToday(now())).toBe(before);
    expect((await call("/v1/chat", { body: chatBody(), token: ben.accessToken })).status).toBe(200);
  });

  it("gives the allowance back at midnight UTC", async () => {
    const { call, signIn, advance } = await start({ env: { USER_DAILY_TOKEN_CAP: "3000" } });
    const ana = await signIn();
    expect((await call("/v1/chat", { body: chatBody(), token: ana.accessToken })).status).toBe(200);
    expect((await call("/v1/chat", { body: chatBody(), token: ana.accessToken })).status).toBe(429);
    advance(6 * 3_600_000 + 60_000);
    const next = (await (await call("/v1/auth/refresh", { body: { refreshToken: ana.refreshToken } })).json()) as { accessToken: string };
    expect((await call("/v1/chat", { body: chatBody(), token: next.accessToken })).status).toBe(200);
  });

  it("slows a student who asks too fast, and says when to try again", async () => {
    const { call, signIn, advance } = await start({ env: { USER_TURNS_PER_10_MIN: "2", USER_DAILY_TOKEN_CAP: "0" } });
    const ana = await signIn();
    expect((await call("/v1/chat", { body: chatBody(), token: ana.accessToken })).status).toBe(200);
    advance(60_000);
    expect((await call("/v1/chat", { body: chatBody(), token: ana.accessToken })).status).toBe(200);
    advance(60_000);
    const refused = await call("/v1/chat", { body: chatBody(), token: ana.accessToken });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "rate_limited", message: "You are asking faster than this server allows. Try again shortly.", retryable: true, retryAfterSeconds: 480 } });
    advance(8 * 60_000 + 1000);
    expect((await call("/v1/chat", { body: chatBody(), token: ana.accessToken })).status).toBe(200);
  });

  it("lets only one of two questions sent at once through the last of an allowance", async () => {
    const { store, signIn, now } = await start();
    const ana = await signIn();
    const limits = { dailyCap: 3000, turnLimit: 0 };
    const results = await Promise.all([store.reserveTurn(ana.user.id, 2800, limits, now()), store.reserveTurn(ana.user.id, 2800, limits, now())]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toEqual({ ok: false, reason: "daily_cap" });
    expect(await store.reserveTurn("00000000-0000-4000-8000-000000000000", 10, limits, now())).toEqual({ ok: false, reason: "no_user" });
  });

  it("charges the ceiling for a turn that failed without reporting what it used", async () => {
    const { call, signIn, sql } = await start({ model: new ScriptedModel([{ throw: new ModelError("upstream_error", "boom", true) }]), env: { MAX_TOKENS: "700" } });
    const ana = await signIn();
    const stream = await events(await call("/v1/chat", { body: chatBody(), token: ana.accessToken }));
    expect(stream.at(-1)).toMatchObject({ type: "error", code: "upstream_error" });
    expect(await sql.query("SELECT tokens, settled FROM usage")).toEqual([{ tokens: 700, settled: true }]);
  });

  it("can be paused for everyone with one setting", async () => {
    const { call, signIn, sql } = await start({ env: { ASK_DISABLED: "1" } });
    const ana = await signIn();
    const refused = await call("/v1/chat", { body: chatBody(), token: ana.accessToken });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: { code: "budget_exhausted", message: "Ask Nova is paused on this server for now.", retryable: true } });
    expect(await sql.query("SELECT id FROM usage")).toEqual([]);
    // Signing in and the account still work while questions are paused.
    expect((await call("/v1/me", { token: ana.accessToken })).status).toBe(200);
  });

  it("reports use per day", async () => {
    const { call, signIn, advance } = await start({ env: { USER_DAILY_TOKEN_CAP: "0" } });
    const ana = await signIn();
    await events(await call("/v1/chat", { body: chatBody(), token: ana.accessToken }));
    await events(await call("/v1/chat", { body: chatBody("What is overdue?"), token: ana.accessToken }));
    advance(10 * 60_000);
    const sameDay = (await (await call("/v1/auth/refresh", { body: { refreshToken: ana.refreshToken } })).json()) as { accessToken: string; refreshToken: string };
    advance(24 * 3_600_000);
    const nextDay = (await (await call("/v1/auth/refresh", { body: { refreshToken: sameDay.refreshToken } })).json()) as { accessToken: string };
    await events(await call("/v1/chat", { body: chatBody(), token: nextDay.accessToken }));
    const usage = usageResponseSchema.parse(await (await call("/v1/usage?days=14", { token: nextDay.accessToken })).json());
    expect(usage.days.map((day) => [day.day, day.turns])).toEqual([
      ["2026-09-08", 2],
      ["2026-09-09", 1],
    ]);
    expect(usage.days.every((day) => day.tokens > 0)).toBe(true);
    expect(usageResponseSchema.parse(await (await call("/v1/usage?days=1", { token: nextDay.accessToken })).json()).days.map((day) => day.day)).toEqual(["2026-09-09"]);
    expect((await call("/v1/usage?days=junk", { token: nextDay.accessToken })).status).toBe(200);
  });
});

const conversation = (title: string, updatedAt: string, messages: unknown[] = [{ id: "1", role: "user", text: "q" }]) => ({ title, createdAt: "2026-09-08T17:00:00.000Z", updatedAt, messages });

describe("saved conversations on the server", () => {
  it("are saved, listed newest first, read back as they were saved, and deleted", async () => {
    const { call, signIn } = await start();
    const { accessToken: token } = await signIn();
    expect(await (await call("/v1/conversations", { token })).json()).toEqual({ conversations: [] });
    const messages = [
      { id: "1", role: "user", text: "What is overdue?" },
      { id: "2", role: "assistant", text: "One item.", rows: [{ kind: "item", id: "a1" }], anything: { the: ["panel", "keeps"] } },
    ];
    expect((await call("/v1/conversations/conversation-abc", { method: "PUT", body: conversation("Overdue", "2026-09-08T18:00:00.000Z", messages), token })).status).toBe(200);
    expect((await call("/v1/conversations/conversation-def", { method: "PUT", body: conversation("Next week", "2026-09-08T19:00:00.000Z"), token })).status).toBe(200);
    const list = conversationListResponseSchema.parse(await (await call("/v1/conversations", { token })).json());
    expect(list.conversations.map((entry) => [entry.id, entry.title, entry.messageCount])).toEqual([
      ["conversation-def", "Next week", 1],
      ["conversation-abc", "Overdue", 2],
    ]);
    const read = conversationResponseSchema.parse(await (await call("/v1/conversations/conversation-abc", { token })).json());
    expect(read).toEqual({ id: "conversation-abc", ...conversation("Overdue", "2026-09-08T18:00:00.000Z", messages) });
    // Saving again replaces it and keeps when it was first made.
    await call("/v1/conversations/conversation-abc", { method: "PUT", body: { ...conversation("Overdue, again", "2026-09-08T20:00:00.000Z"), createdAt: "2026-09-09T00:00:00.000Z" }, token });
    const replaced = conversationResponseSchema.parse(await (await call("/v1/conversations/conversation-abc", { token })).json());
    expect(replaced).toMatchObject({ title: "Overdue, again", createdAt: "2026-09-08T17:00:00.000Z", updatedAt: "2026-09-08T20:00:00.000Z" });
    expect((await call("/v1/conversations/conversation-abc", { method: "DELETE", token })).status).toBe(200);
    expect((await call("/v1/conversations/conversation-abc", { token })).status).toBe(404);
    expect((await call("/v1/conversations", { method: "DELETE", token })).status).toBe(200);
    expect(await (await call("/v1/conversations", { token })).json()).toEqual({ conversations: [] });
  });

  it("belong to one student: another cannot list, read, overwrite, or delete them", async () => {
    const { call, signIn } = await start();
    const ana = (await signIn({ sub: "g-ana" })).accessToken;
    const ben = (await signIn({ sub: "g-ben", email: "ben@villanova.edu" })).accessToken;
    await call("/v1/conversations/shared-id", { method: "PUT", body: conversation("Ana's", "2026-09-08T18:00:00.000Z"), token: ana });
    expect(await (await call("/v1/conversations", { token: ben })).json()).toEqual({ conversations: [] });
    expect((await call("/v1/conversations/shared-id", { token: ben })).status).toBe(404);
    await call("/v1/conversations/shared-id", { method: "PUT", body: conversation("Ben's", "2026-09-08T19:00:00.000Z"), token: ben });
    await call("/v1/conversations/shared-id", { method: "DELETE", token: ben });
    await call("/v1/conversations", { method: "DELETE", token: ben });
    expect(await (await call("/v1/conversations/shared-id", { token: ana })).json()).toMatchObject({ title: "Ana's" });
  });

  it("keeps the newest twenty, and refuses what is malformed or too long", async () => {
    const { call, signIn, lines } = await start();
    const { accessToken: token } = await signIn();
    for (let index = 0; index < ACCOUNT_LIMITS.conversations + 3; index++) {
      const at = new Date(Date.UTC(2026, 8, 8, 12, index)).toISOString();
      expect((await call(`/v1/conversations/c-${String(index).padStart(2, "0")}`, { method: "PUT", body: conversation(`Talk ${index}`, at), token })).status).toBe(200);
    }
    const kept = conversationListResponseSchema.parse(await (await call("/v1/conversations", { token })).json()).conversations;
    expect(kept).toHaveLength(ACCOUNT_LIMITS.conversations);
    expect(kept[0]?.id).toBe("c-22");
    expect(kept.at(-1)?.id).toBe("c-03");
    expect((await call("/v1/conversations/bad%20id", { method: "PUT", body: conversation("x", "2026-09-08T18:00:00.000Z"), token })).status).toBe(400);
    expect((await call("/v1/conversations/ok", { method: "PUT", body: { title: "x" }, token })).status).toBe(400);
    expect((await call("/v1/conversations/ok", { method: "PUT", body: conversation("x", "yesterday"), token })).status).toBe(400);
    const secret = "the student's private words";
    const invalid = await call("/v1/conversations/ok", { method: "PUT", body: { ...conversation("x", "2026-09-08T18:00:00.000Z"), messages: secret }, token });
    expect(invalid.status).toBe(400);
    expect(JSON.stringify(await invalid.json())).not.toContain(secret);
    const long = await call("/v1/conversations/ok", { method: "PUT", body: conversation("x", "2026-09-08T18:00:00.000Z", [{ text: "y".repeat(ACCOUNT_LIMITS.conversationBytes) }]), token });
    expect(long.status).toBe(413);
    expect(lines.join("\n")).not.toContain("Talk 1");
  });
});

describe("deleting an account", () => {
  it("removes the account and everything stored for it, and leaves other students alone", async () => {
    const { call, signIn, sql } = await start();
    const ana = await signIn({ sub: "g-ana" });
    const ben = await signIn({ sub: "g-ben", email: "ben@villanova.edu" });
    for (const session of [ana, ben]) {
      await events(await call("/v1/chat", { body: chatBody(), token: session.accessToken }));
      await call("/v1/conversations/c-1", { method: "PUT", body: conversation("Saved", "2026-09-08T18:00:00.000Z"), token: session.accessToken });
    }
    expect((await call("/v1/me", { method: "DELETE", token: ana.accessToken })).status).toBe(200);
    for (const table of ["users", "refresh_tokens", "usage", "conversations"]) {
      const rows = await sql.query<{ user_id?: string; id?: string }>(`SELECT * FROM ${table}`);
      expect(rows, table).toHaveLength(1);
      expect(JSON.stringify(rows), table).not.toContain(ana.user.id);
    }
    // Tokens that were issued to the deleted account open nothing.
    expect((await call("/v1/me", { token: ana.accessToken })).status).toBe(401);
    expect((await call("/v1/chat", { body: chatBody(), token: ana.accessToken })).status).toBe(401);
    expect((await call("/v1/auth/refresh", { body: { refreshToken: ana.refreshToken } })).status).toBe(401);
    expect(await (await call("/v1/conversations", { token: ana.accessToken })).json()).toEqual({ conversations: [] });
    expect((await call("/v1/conversations/c-2", { method: "PUT", body: conversation("After", "2026-09-08T19:00:00.000Z"), token: ana.accessToken })).status).toBe(401);
    expect(await sql.query("SELECT id FROM conversations")).toHaveLength(1);
    expect((await call("/v1/me", { token: ben.accessToken })).status).toBe(200);
  });
});

describe("starting in signed-in mode", () => {
  const base = { HOST: "0.0.0.0", AUTH_MODE: "google", GOOGLE_CLIENT_ID: CLIENT_ID, JWT_SECRET, DATABASE_URL: "postgres://db/nova" };

  it("may listen on a public address, because students sign in", () => {
    expect(() => validateDeployment(loadConfig(base))).not.toThrow();
    expect(() => validateDeployment(loadConfig({ HOST: "0.0.0.0" }))).toThrow(/AUTH_MODE=google/);
  });

  it("refuses to start without its client id, a real secret, a database, or a workable allowance", () => {
    expect(() => validateDeployment(loadConfig({ ...base, GOOGLE_CLIENT_ID: "" }))).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => validateDeployment(loadConfig({ ...base, JWT_SECRET: "short" }))).toThrow(/JWT_SECRET of at least 32 characters/);
    expect(() => validateDeployment(loadConfig({ ...base, JWT_SECRET: "" }))).toThrow(/JWT_SECRET/);
    expect(() => validateDeployment(loadConfig({ ...base, DATABASE_URL: "" }))).toThrow(/DATABASE_URL/);
    expect(() => validateDeployment(loadConfig({ ...base, USER_DAILY_TOKEN_CAP: "100" }))).toThrow(/USER_DAILY_TOKEN_CAP=100 is below one turn's reservation/);
    expect(() => validateDeployment(loadConfig({ ...base, USER_DAILY_TOKEN_CAP: "0" }))).not.toThrow();
    expect(() => createApp({ config: loadConfig(base), model: null })).toThrow(/needs a store/);
  });

  it("is off by default, and then nothing about accounts exists", async () => {
    const app = createApp({ config: loadConfig({}), model: null });
    expect(loadConfig({}).AUTH_MODE).toBe("none");
    for (const path of ["/v1/me", "/v1/conversations", "/v1/usage"]) expect((await app.request(path)).status, path).toBe(404);
    expect((await app.request("/v1/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(404);
    expect(await (await app.request("/healthz")).json()).toMatchObject({ auth: "none" });
  });
});
