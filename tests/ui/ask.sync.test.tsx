// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import {
  ASK_SESSION_PREFERENCE,
  ASK_SETTINGS_PREFERENCE,
  AccountClient,
  FallbackAskClient,
  HttpAskClient,
  SYNC_DELETED_PREFERENCE,
  SYNC_PURGE_PREFERENCE,
  pushConversation,
  removeAllRemoteConversations,
  removeRemoteConversation,
  retryPurge,
  syncConversations,
  type AskClientFactory,
  type AskMessage,
  type AskSession,
  type AskSettings,
} from "../../apps/extension/src/sidepanel/ask";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { deleteConversation, getConversation, getPreference, getSyncStatus, listConversations, saveConversation, setPreference } from "../../apps/extension/src/storage/repositories";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { NOW, TENANT } from "../helpers/demoDashboard";
import { hostedHarness, type HostedHarness } from "../helpers/hostedApi";

const BASE = "https://nova.example";
const SCOPE = `${TENANT}|2001`;
const LONG = { timeout: 15_000 };
let server: HostedHarness;
let dbs: NovaDb[] = [];

const wire = (harness: HostedHarness) => {
  let down = false;
  const paths: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (down) throw new TypeError("Failed to fetch");
    return harness.app.request(`${url.pathname}${url.search}`, { method: init?.method, headers: init?.headers, body: init?.body as string | undefined, signal: init?.signal ?? undefined });
  };
  return { fetchImpl, paths, setDown: (value: boolean) => (down = value) };
};

const newDb = (): NovaDb => {
  const db = createNovaDb(`sync-${Date.now()}-${Math.random()}`);
  dbs.push(db);
  return db;
};

/** One device: its own storage, signed in to the same account. */
const device = async (fetchImpl: typeof fetch, email = "ana@villanova.edu", sub = "g-ana") => {
  const db = newDb();
  const account = new AccountClient({ baseUrl: BASE, load: () => getPreference<AskSession | null>(db, ASK_SESSION_PREFERENCE, null), save: (next) => setPreference(db, ASK_SESSION_PREFERENCE, next), fetch: fetchImpl, now: () => server.now().getTime() });
  expect(await account.signIn(await server.google.mint({ email, sub }))).toMatchObject({ ok: true });
  return { db, account };
};

const base: Omit<AskMessage, "id" | "role" | "text"> = { tools: [], rows: [], error: null, usage: null, grounded: null, stopped: false };
const talk = (question: string, answer: string): AskMessage[] => [
  { ...base, id: `u-${question}`, role: "user", text: question },
  { ...base, id: `a-${question}`, role: "assistant", text: answer, grounded: true, model: "m", rows: [{ kind: "course", id: "31001", title: "Microcontrollers", courseId: "31001", open: 3, overdue: 1, dueInRange: 2, pointsInRange: 100, nextDueAt: null, nextDueLocal: null, nextTitle: null, changes: 0, gradedEarned: null, gradedPossible: null, url: null } as never] },
];

beforeEach(async () => {
  server = await hostedHarness();
});

afterEach(async () => {
  cleanup();
  await server.close();
  await Promise.all(dbs.map((db) => db.delete()));
  dbs = [];
});

describe("keeping saved conversations on the server", () => {
  it("copies a conversation up, and brings it down on another device as it was saved", async () => {
    const { fetchImpl } = wire(server);
    const laptop = await device(fetchImpl);
    await saveConversation(laptop.db, SCOPE, { id: "conversation-1", messages: talk("What is overdue?", "One item.") }, new Date("2026-09-08T18:00:00.000Z"));
    expect(await syncConversations(laptop.account, laptop.db, SCOPE)).toEqual({ pulled: 0, pushed: 1, deleted: 0 });
    // Nothing to do the second time.
    expect(await syncConversations(laptop.account, laptop.db, SCOPE)).toEqual({ pulled: 0, pushed: 0, deleted: 0 });

    const phone = await device(fetchImpl);
    expect(await listConversations(phone.db, SCOPE)).toEqual([]);
    expect(await syncConversations(phone.account, phone.db, SCOPE)).toEqual({ pulled: 1, pushed: 0, deleted: 0 });
    const copy = await getConversation(phone.db, "conversation-1");
    expect(copy).toMatchObject({ id: "conversation-1", title: "What is overdue?", createdAt: "2026-09-08T18:00:00.000Z", updatedAt: "2026-09-08T18:00:00.000Z" });
    expect(copy?.messages.map((message) => message.text)).toEqual(["What is overdue?", "One item."]);
    expect(copy?.messages[1]).toMatchObject({ grounded: true, model: "m" });
  });

  it("lets the newer copy win, in either direction", async () => {
    const { fetchImpl } = wire(server);
    const laptop = await device(fetchImpl);
    const phone = await device(fetchImpl);
    await saveConversation(laptop.db, SCOPE, { id: "c-1", messages: talk("First", "One.") }, new Date("2026-09-08T18:00:00.000Z"));
    await syncConversations(laptop.account, laptop.db, SCOPE);
    await syncConversations(phone.account, phone.db, SCOPE);
    // The phone continues the conversation; the laptop gets the longer one.
    await saveConversation(phone.db, SCOPE, { id: "c-1", messages: [...talk("First", "One."), ...talk("Second", "Two.")] }, new Date("2026-09-08T19:00:00.000Z"));
    expect(await syncConversations(phone.account, phone.db, SCOPE)).toEqual({ pulled: 0, pushed: 1, deleted: 0 });
    expect(await syncConversations(laptop.account, laptop.db, SCOPE)).toEqual({ pulled: 1, pushed: 0, deleted: 0 });
    expect((await getConversation(laptop.db, "c-1"))?.messages).toHaveLength(4);
    // An older local copy never overwrites a newer one on the server.
    const stale = await device(fetchImpl);
    await saveConversation(stale.db, SCOPE, { id: "c-1", messages: talk("Old", "Old.") }, new Date("2026-09-08T17:00:00.000Z"));
    expect(await syncConversations(stale.account, stale.db, SCOPE)).toEqual({ pulled: 1, pushed: 0, deleted: 0 });
    expect((await getConversation(stale.db, "c-1"))?.messages).toHaveLength(4);
  });

  it("keeps a deletion made while the server was out of reach, and finishes it later", async () => {
    const { fetchImpl, setDown } = wire(server);
    const laptop = await device(fetchImpl);
    const phone = await device(fetchImpl);
    await saveConversation(laptop.db, SCOPE, { id: "c-1", messages: talk("First", "One.") }, new Date("2026-09-08T18:00:00.000Z"));
    await syncConversations(laptop.account, laptop.db, SCOPE);
    setDown(true);
    await deleteConversation(laptop.db, "c-1");
    await removeRemoteConversation(laptop.account, laptop.db, "c-1");
    expect(await getPreference(laptop.db, SYNC_DELETED_PREFERENCE, [])).toEqual(["c-1"]);
    expect(await syncConversations(laptop.account, laptop.db, SCOPE)).toBeNull();
    setDown(false);
    // Back in reach: the deletion goes through, and the conversation does not come back from the server.
    expect(await syncConversations(laptop.account, laptop.db, SCOPE)).toEqual({ pulled: 0, pushed: 0, deleted: 1 });
    expect(await getPreference(laptop.db, SYNC_DELETED_PREFERENCE, [])).toEqual([]);
    expect(await listConversations(laptop.db, SCOPE)).toEqual([]);
    expect(await syncConversations(phone.account, phone.db, SCOPE)).toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(await server.sql.query("SELECT id FROM conversations")).toEqual([]);
  });

  it("deletes every copy on the server when turned off, even if that has to wait for the server", async () => {
    const { fetchImpl, setDown } = wire(server);
    const laptop = await device(fetchImpl);
    await saveConversation(laptop.db, SCOPE, { id: "c-1", messages: talk("First", "One.") }, new Date("2026-09-08T18:00:00.000Z"));
    await pushConversation(laptop.account, (await getConversation(laptop.db, "c-1")) as never);
    expect(await server.sql.query("SELECT id FROM conversations")).toHaveLength(1);
    setDown(true);
    expect(await removeAllRemoteConversations(laptop.account, laptop.db)).toBe(false);
    expect(await getPreference(laptop.db, SYNC_PURGE_PREFERENCE, false)).toBe(true);
    expect(await retryPurge(laptop.account, laptop.db)).toBe(false);
    setDown(false);
    expect(await retryPurge(laptop.account, laptop.db)).toBe(true);
    expect(await getPreference(laptop.db, SYNC_PURGE_PREFERENCE, false)).toBe(false);
    expect(await server.sql.query("SELECT id FROM conversations")).toEqual([]);
    // With nothing pending, a retry asks the server nothing.
    expect(await retryPurge(laptop.account, laptop.db)).toBe(true);
  });

  it("never shows one student another student's conversations, and drops what it cannot read", async () => {
    const { fetchImpl } = wire(server);
    const ana = await device(fetchImpl);
    const ben = await device(fetchImpl, "ben@villanova.edu", "g-ben");
    await saveConversation(ana.db, SCOPE, { id: "c-1", messages: talk("Ana's question", "Ana's answer.") }, new Date("2026-09-08T18:00:00.000Z"));
    await syncConversations(ana.account, ana.db, SCOPE);
    expect(await syncConversations(ben.account, ben.db, SCOPE)).toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(await listConversations(ben.db, SCOPE)).toEqual([]);
    // A copy on the server that is not a conversation this build understands is skipped, not shown.
    await ben.account.putConversation("c-junk", { title: "Junk", createdAt: "2026-09-08T18:00:00.000Z", updatedAt: "2026-09-08T18:00:00.000Z", messages: [{ nonsense: true }, 7, null] });
    expect(await syncConversations(ben.account, ben.db, SCOPE)).toEqual({ pulled: 0, pushed: 0, deleted: 0 });
    expect(await listConversations(ben.db, SCOPE)).toEqual([]);
  });
});

describe("the server copy in the panel: end to end", () => {
  const ask = (text: string) => {
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
  };

  const mount = async (db: NovaDb, fetchImpl: typeof fetch) => {
    if ((await getPreference<AskSettings | null>(db, ASK_SETTINGS_PREFERENCE, null)) === null) await setPreference(db, ASK_SETTINGS_PREFERENCE, { enabled: true, apiBaseUrl: BASE, token: null } satisfies AskSettings);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    const host = createStubHost({ getGoogleIdToken: async () => server.google.mint({ email: "ana@villanova.edu", sub: "g-ana" }) });
    const askClientFactory: AskClientFactory = (settings, auth) => new FallbackAskClient(new HttpAskClient({ baseUrl: settings.apiBaseUrl, token: settings.token, fetch: fetchImpl, auth }));
    const view = render(<App db={db} host={host} now={() => NOW} transportFactory={factory} autoSync={false} askClientFactory={askClientFactory} accountFetch={fetchImpl} />);
    const explore = await screen.findByRole("button", { name: /explore with demo data/i }).catch(() => null);
    if (explore) fireEvent.click(explore);
    await waitFor(async () => expect((await getSyncStatus(db)).lastSuccessfulSyncAt).toBe(NOW.toISOString()), LONG);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Ask" }, LONG));
    await screen.findByRole("textbox", { name: /ask nova a question/i }, LONG);
    return view;
  };

  const signIn = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    const account = await screen.findByRole("group", { name: "Nova account" }, LONG);
    fireEvent.click(within(account).getByRole("button", { name: "Sign in with Google" }));
    await within(account).findByText("ana@villanova.edu", {}, LONG);
  };

  it("is offered only when signed in, is off until chosen, and then follows the student to a second device", { timeout: 90_000 }, async () => {
    const { fetchImpl, paths } = wire(server);
    const laptop = newDb();
    const first = await mount(laptop, fetchImpl);
    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    // Signed out: saving can be turned on, and there is no server copy to choose.
    fireEvent.click(await screen.findByRole("checkbox", { name: /save conversations on this device/i }, LONG));
    expect(screen.queryByRole("checkbox", { name: /also keep them on the nova server/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await signIn();
    fireEvent.click(screen.getByRole("checkbox", { name: /save conversations on this device/i }));
    const serverCopy = (await screen.findByRole("checkbox", { name: /also keep them on the nova server/i }, LONG)) as HTMLInputElement;
    expect(serverCopy.checked).toBe(false);
    expect(screen.getByText("Off: saved conversations stay on this device only.")).toBeTruthy();
    // Saving alone sends no conversation anywhere.
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    ask("What is overdue?");
    await screen.findByText(/^Looked up deadlines: 1 item overdue/, {}, LONG);
    await waitFor(async () => expect(await listConversations(laptop, (await getSyncStatus(laptop)).scope as string)).toHaveLength(1), LONG);
    expect(paths.filter((path) => path.includes("/v1/conversations"))).toEqual([]);
    expect(await server.sql.query("SELECT id FROM conversations")).toEqual([]);

    // Turned on: what is saved here is copied there, and a later answer updates the copy.
    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /also keep them on the nova server/i }, LONG));
    expect(screen.getByText(/They include the course titles and dates in the answers\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await server.sql.query("SELECT id FROM conversations")).toHaveLength(1), LONG);
    ask("What is due next week?");
    await screen.findByText(/^Looked up deadlines: 1 item due next week/, {}, LONG);
    await waitFor(async () => expect((await server.sql.query<{ n: number }>("SELECT jsonb_array_length(messages) AS n FROM conversations"))[0]?.n).toBe(4), LONG);
    first.unmount();

    // A second device, same account: sign in, turn both on, and the conversation is there to open.
    const phone = newDb();
    await mount(phone, fetchImpl);
    await signIn();
    fireEvent.click(screen.getByRole("checkbox", { name: /save conversations on this device/i }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /also keep them on the nova server/i }, LONG));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Conversations" }, LONG));
    const list = await screen.findByRole("dialog", {}, LONG);
    // The row has two buttons that name the conversation; the one that opens it is not the one that deletes it.
    await within(list).findByRole("button", { name: 'Delete conversation "What is overdue?"' }, LONG);
    fireEvent.click(within(list).getAllByRole("button", { name: /What is overdue\?/ }).find((button) => !button.getAttribute("aria-label")?.startsWith("Delete")) as HTMLElement);
    expect(await screen.findByText("What is due next week?", { selector: ".ask-bubble" }, LONG)).toBeTruthy();
    expect(screen.getAllByText(/^Looked up deadlines:/)).toHaveLength(2);

    // Turning the server copy off deletes what the server holds and leaves this device's copy alone.
    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /also keep them on the nova server/i }, LONG));
    expect(screen.getByText("Saving this turns it off and deletes the copies on the server.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await server.sql.query("SELECT id FROM conversations")).toEqual([]), LONG);
    expect(await listConversations(phone, (await getSyncStatus(phone)).scope as string)).toHaveLength(1);
    expect((await getPreference<AskSettings>(phone, ASK_SETTINGS_PREFERENCE, {} as AskSettings)).syncConversations).toBe(false);
  });
});
