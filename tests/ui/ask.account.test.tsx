// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { compactSnapshot } from "@nova-agent/agent";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import type { AskEvent, ChatRequest } from "@nova-agent/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { idTokenFromRedirect } from "../../apps/extension/src/platform/googleSignIn";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { ASK_SESSION_PREFERENCE, ASK_SETTINGS_PREFERENCE, AccountClient, FallbackAskClient, HttpAskClient, type AskClientFactory, type AskSession, type AskSettings } from "../../apps/extension/src/sidepanel/ask";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { getPreference, getSyncStatus, setPreference } from "../../apps/extension/src/storage/repositories";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";
import { hostedHarness, type HostedHarness } from "../helpers/hostedApi";

const BASE = "https://nova.example";
const LONG = { timeout: 15_000 };
let db: NovaDb;
let server: HostedHarness;

/** The panel's `fetch`, answered by the server in this process. Counts what it is asked. */
const wire = (harness: HostedHarness) => {
  const calls: { method: string; path: string; authorization: string | null }[] = [];
  let down = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ method: init?.method ?? "GET", path: url.pathname, authorization: new Headers(init?.headers).get("authorization") });
    if (down) throw new TypeError("Failed to fetch");
    return harness.app.request(`${url.pathname}${url.search}`, { method: init?.method, headers: init?.headers, body: init?.body as string | undefined, signal: init?.signal ?? undefined });
  };
  return { fetchImpl, calls, setDown: (value: boolean) => (down = value) };
};

beforeEach(async () => {
  db = createNovaDb(`account-${Date.now()}-${Math.random()}`);
  server = await hostedHarness();
});

afterEach(async () => {
  cleanup();
  await server.close();
  await db.delete();
});

/** A session kept in a variable, the way the app keeps it in its preferences. */
const memory = () => {
  let stored: AskSession | null = null;
  return { load: async () => stored, save: async (next: AskSession | null) => void (stored = next), get: () => stored };
};

describe("AccountClient", () => {
  it("signs in with a Google ID token and keeps the session, and says why when the server refuses", async () => {
    const { fetchImpl } = wire(server);
    const store = memory();
    const client = new AccountClient({ baseUrl: `${BASE}/`, ...store, fetch: fetchImpl, now: () => server.now().getTime() });
    expect(await client.accessToken()).toBeNull();
    expect(await client.signIn(await server.google.mint({ aud: "another-client" }))).toEqual({ ok: false, message: "Google did not confirm that sign-in. Try signing in again." });
    expect(store.get()).toBeNull();
    expect(await client.signIn(await server.google.mint({ email: "ana@villanova.edu" }))).toEqual({ ok: true, email: "ana@villanova.edu" });
    expect(store.get()).toMatchObject({ apiBaseUrl: BASE, email: "ana@villanova.edu", expiresAt: server.now().getTime() + 900_000 });
    expect(await client.accessToken()).toBe(store.get()?.accessToken);
    expect(await client.usage()).toEqual({ usedToday: 0, recentTurns: 0, dailyCap: 40_000, turnLimit: 20 });
  });

  it("renews a token that is about to expire, once, however many callers ask at the same moment", async () => {
    const { fetchImpl, calls } = wire(server);
    const store = memory();
    const client = new AccountClient({ baseUrl: BASE, ...store, fetch: fetchImpl, now: () => server.now().getTime() });
    await client.signIn(await server.google.mint());
    const first = store.get() as AskSession;
    server.advance(14 * 60_000 + 30_000);
    const tokens = await Promise.all([client.accessToken(), client.accessToken(), client.refresh()]);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).not.toBe(first.accessToken);
    expect(calls.filter((call) => call.path === "/v1/auth/refresh")).toHaveLength(1);
    expect(store.get()?.refreshToken).not.toBe(first.refreshToken);
    expect(await client.usage()).not.toBeNull();
  });

  it("forgets a session the server has ended, and keeps one it merely could not reach", async () => {
    const { fetchImpl, setDown } = wire(server);
    const store = memory();
    const client = new AccountClient({ baseUrl: BASE, ...store, fetch: fetchImpl, now: () => server.now().getTime() });
    await client.signIn(await server.google.mint());
    setDown(true);
    expect(await client.refresh()).toBeNull();
    expect(store.get()).not.toBeNull();
    expect(await client.signIn("x".repeat(40))).toEqual({ ok: false, message: "The Nova server could not be reached. Try again." });
    setDown(false);
    server.advance(31 * 86_400_000);
    expect(await client.accessToken()).toBeNull();
    expect(store.get()).toBeNull();
  });

  it("never sends a session to a server it was not made with", async () => {
    const { fetchImpl, calls } = wire(server);
    const store = memory();
    await new AccountClient({ baseUrl: BASE, ...store, fetch: fetchImpl }).signIn(await server.google.mint());
    const elsewhere = new AccountClient({ baseUrl: "https://other.example", ...store, fetch: fetchImpl });
    const before = calls.length;
    expect(await elsewhere.accessToken()).toBeNull();
    expect(await elsewhere.refresh()).toBeNull();
    expect(await elsewhere.usage()).toBeNull();
    expect(await elsewhere.deleteAccount()).toBe(false);
    expect(calls).toHaveLength(before);
    expect(store.get()).not.toBeNull();
  });

  it("signs out here even when the server cannot be told, and deletes the account only when the server confirms", async () => {
    const { fetchImpl, setDown } = wire(server);
    const store = memory();
    const client = new AccountClient({ baseUrl: BASE, ...store, fetch: fetchImpl, now: () => server.now().getTime() });
    await client.signIn(await server.google.mint());
    setDown(true);
    expect(await client.deleteAccount()).toBe(false);
    expect(store.get()).not.toBeNull();
    await client.signOut();
    expect(store.get()).toBeNull();
    setDown(false);
    await client.signIn(await server.google.mint());
    expect(await client.deleteAccount()).toBe(true);
    expect(store.get()).toBeNull();
    expect(await server.sql.query("SELECT id FROM users")).toEqual([]);
  });
});

const collect = async (client: HttpAskClient, body: ChatRequest): Promise<AskEvent[]> => {
  const events: AskEvent[] = [];
  for await (const event of client.ask(body, new AbortController().signal)) events.push(event);
  return events;
};

describe("asking a hosted server", () => {
  const body = async (): Promise<ChatRequest> => ({ message: "What is overdue?", history: [], snapshot: compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" }), client: { name: "nova-extension", version: "0.1.0" } });

  it("is refused in the server's own words until the student signs in, then answered and counted", async () => {
    const { fetchImpl } = wire(server);
    const store = memory();
    const account = new AccountClient({ baseUrl: BASE, ...store, fetch: fetchImpl, now: () => server.now().getTime() });
    const client = new HttpAskClient({ baseUrl: BASE, token: null, fetch: fetchImpl, auth: account });
    expect(await collect(client, await body())).toEqual([{ type: "error", code: "unauthorized", message: "Sign in to use this Nova server.", retryable: false }]);
    expect(await client.health()).toMatchObject({ ok: true, auth: "google", googleClientId: expect.stringContaining(".apps.googleusercontent.com") });
    await account.signIn(await server.google.mint());
    const events = await collect(client, await body());
    expect(events.at(-1)).toMatchObject({ type: "done", grounded: true });
    expect((await account.usage())?.recentTurns).toBe(1);
  });

  it("renews an expired sign-in in the middle of a question, without the student seeing it", async () => {
    const { fetchImpl, calls } = wire(server);
    const store = memory();
    // This panel's clock stands still, so it believes its token is good; the server's moves on.
    const account = new AccountClient({ baseUrl: BASE, ...store, fetch: fetchImpl, now: () => new Date("2026-09-08T18:00:00.000Z").getTime() });
    const client = new HttpAskClient({ baseUrl: BASE, token: null, fetch: fetchImpl, auth: account });
    await account.signIn(await server.google.mint());
    server.advance(20 * 60_000);
    const events = await collect(client, await body());
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(calls.filter((call) => call.path === "/v1/chat")).toHaveLength(2);
    expect(calls.filter((call) => call.path === "/v1/auth/refresh")).toHaveLength(1);
  });

  it("reports the end of a session as a sign-in problem, not as a broken server", async () => {
    const { fetchImpl } = wire(server);
    const store = memory();
    const account = new AccountClient({ baseUrl: BASE, ...store, fetch: fetchImpl, now: () => new Date("2026-09-08T18:00:00.000Z").getTime() });
    const client = new HttpAskClient({ baseUrl: BASE, token: null, fetch: fetchImpl, auth: account });
    await account.signIn(await server.google.mint());
    server.advance(31 * 86_400_000);
    expect(await collect(client, await body())).toEqual([{ type: "error", code: "unauthorized", message: "Sign in to use this Nova server.", retryable: false }]);
    expect(store.get()).toBeNull();
  });
});

describe("the address Google sends the sign-in window back to", () => {
  const token = (claims: object) => `${btoa(JSON.stringify({ alg: "RS256" }))}.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.signature`;

  it("yields the ID token only when it answers the request this panel made", () => {
    const good = token({ sub: "1", nonce: "n-123" });
    expect(idTokenFromRedirect(`https://abcdefghijklmnop.chromiumapp.org/#id_token=${good}&authuser=0`, "n-123")).toBe(good);
    expect(idTokenFromRedirect(`https://abcdefghijklmnop.chromiumapp.org/#id_token=${good}`, "another-nonce")).toBeNull();
    expect(idTokenFromRedirect(`https://abcdefghijklmnop.chromiumapp.org/#id_token=${token({ sub: "1" })}`, "n-123")).toBeNull();
    expect(idTokenFromRedirect("https://abcdefghijklmnop.chromiumapp.org/#error=access_denied", "n-123")).toBeNull();
    expect(idTokenFromRedirect(`https://abcdefghijklmnop.chromiumapp.org/?id_token=${good}`, "n-123")).toBeNull();
    expect(idTokenFromRedirect("https://abcdefghijklmnop.chromiumapp.org/#id_token=not.a-token.x", "n-123")).toBeNull();
    expect(idTokenFromRedirect("not a url", "n-123")).toBeNull();
  });
});

describe("signing in from the panel: end to end", () => {
  const ask = (text: string) => {
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
  };

  const mount = async (options: { withGoogle?: boolean } = {}) => {
    const { fetchImpl, calls } = wire(server);
    await setPreference(db, ASK_SETTINGS_PREFERENCE, { enabled: true, apiBaseUrl: BASE, token: null } satisfies AskSettings);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    const signIns: string[] = [];
    let closeWindow = false;
    const host = createStubHost(
      options.withGoogle === false
        ? {}
        : {
            getGoogleIdToken: async (clientId) => {
              signIns.push(clientId);
              return closeWindow ? null : server.google.mint({ email: "ana@villanova.edu" });
            },
          },
    );
    // The real client the extension ships, with the server in this process behind its fetch.
    const askClientFactory: AskClientFactory = (settings, auth) => new FallbackAskClient(new HttpAskClient({ baseUrl: settings.apiBaseUrl, token: settings.token, fetch: fetchImpl, auth }));
    render(<App db={db} host={host} now={() => NOW} transportFactory={factory} autoSync={false} askClientFactory={askClientFactory} accountFetch={fetchImpl} />);
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await waitFor(async () => expect((await getSyncStatus(db)).lastSuccessfulSyncAt).toBe(NOW.toISOString()), LONG);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Ask" }, LONG));
    await screen.findByRole("textbox", { name: /ask nova a question/i }, LONG);
    return { calls, signIns, setCloseWindow: (value: boolean) => (closeWindow = value) };
  };

  it("asks for a sign-in, signs in with Google, answers, and then signs out", { timeout: 60_000 }, async () => {
    const { calls, signIns, setCloseWindow } = await mount();
    ask("Why is Lab 2 my next move?");
    const alert = await screen.findByRole("alert", {}, LONG);
    expect(within(alert).getByText("Sign in to ask Nova")).toBeTruthy();
    expect(within(alert).getByText("Sign in to use this Nova server. Open Settings to sign in with Google.")).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Settings" }));
    const account = await screen.findByRole("group", { name: "Nova account" }, LONG);
    expect(account.textContent).toContain("This Nova server asks you to sign in with Google, so it can count use per student. It keeps your email address and how much you use. Nothing about your courses is kept there unless you choose to keep saved conversations on it.");
    // Closing Google's window is not an error on the server and changes nothing.
    setCloseWindow(true);
    fireEvent.click(within(account).getByRole("button", { name: "Sign in with Google" }));
    expect((await within(account).findByRole("alert", {}, LONG)).textContent).toBe("Google's sign-in window was closed before it finished.");
    expect(await getPreference(db, ASK_SESSION_PREFERENCE, null)).toBeNull();
    setCloseWindow(false);
    fireEvent.click(within(account).getByRole("button", { name: "Sign in with Google" }));
    await within(account).findByText("ana@villanova.edu", {}, LONG);
    expect(signIns).toEqual([server.config.GOOGLE_CLIENT_ID, server.config.GOOGLE_CLIENT_ID]);
    await waitFor(() => expect(account.textContent).toMatch(/Used today: 0 of 40,000 tokens\./), LONG);
    expect(within(account).queryByRole("alert")).toBeNull();
    const session = (await getPreference<AskSession | null>(db, ASK_SESSION_PREFERENCE, null)) as AskSession;
    expect(session).toMatchObject({ apiBaseUrl: BASE, email: "ana@villanova.edu" });

    // The question that was refused is asked again and answered, under this student's account.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    ask("What is overdue?");
    await screen.findByText(/^Looked up deadlines: 1 item overdue/, {}, LONG);
    const chat = calls.filter((call) => call.path === "/v1/chat");
    expect(chat.at(-1)?.authorization).toMatch(/^Bearer ey/);
    expect(await server.sql.query("SELECT settled FROM usage")).toEqual([{ settled: true }]);
    // The Google token went to the sign-in route only, and the refresh token to no route but the two that take one.
    expect(calls.filter((call) => call.authorization?.includes(session.refreshToken))).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    const again = await screen.findByRole("group", { name: "Nova account" }, LONG);
    fireEvent.click(await within(again).findByRole("button", { name: "Sign out" }, LONG));
    await within(again).findByRole("button", { name: "Sign in with Google" }, LONG);
    expect(await getPreference(db, ASK_SESSION_PREFERENCE, null)).toBeNull();
    expect(await server.sql.query("SELECT token_hash FROM refresh_tokens")).toEqual([]);
    expect(await server.sql.query("SELECT id FROM users")).toHaveLength(1);
  });

  it("deletes the account, and everything the server kept for it, after a second press", { timeout: 60_000 }, async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    const account = await screen.findByRole("group", { name: "Nova account" }, LONG);
    fireEvent.click(within(account).getByRole("button", { name: "Sign in with Google" }));
    await within(account).findByText("ana@villanova.edu", {}, LONG);
    fireEvent.click(within(account).getByRole("button", { name: "Delete my account…" }));
    // One press only asks; nothing is deleted yet.
    expect(await server.sql.query("SELECT id FROM users")).toHaveLength(1);
    fireEvent.click(within(account).getByRole("button", { name: "Delete the account and everything stored for it" }));
    await within(account).findByRole("button", { name: "Sign in with Google" }, LONG);
    expect(await server.sql.query("SELECT id FROM users")).toEqual([]);
    expect(await getPreference(db, ASK_SESSION_PREFERENCE, null)).toBeNull();
  });

  it("still answers a suggested question on the device when the hosted server has paused or run out", { timeout: 60_000 }, async () => {
    await server.close();
    server = await hostedHarness({ env: { ASK_DISABLED: "1" } });
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    const account = await screen.findByRole("group", { name: "Nova account" }, LONG);
    fireEvent.click(within(account).getByRole("button", { name: "Sign in with Google" }));
    await within(account).findByText("ana@villanova.edu", {}, LONG);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    ask("What is overdue?");
    expect(await screen.findByText("Ask Nova has hit today's limit. Answered on this device without the AI model.", {}, LONG)).toBeTruthy();
  });

  it("says where sign-in works when this panel cannot open Google's window", { timeout: 60_000 }, async () => {
    await mount({ withGoogle: false });
    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    const account = await screen.findByRole("group", { name: "Nova account" }, LONG);
    expect((within(account).getByRole("button", { name: "Sign in with Google" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(account).getByText("Signing in works in the installed extension, not in this preview.")).toBeTruthy();
  });
});
