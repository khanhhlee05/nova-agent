// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { OFFLINE_MODEL_ID, ScriptedModel, compactSnapshot, demoRouter } from "@nova-agent/agent";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import type { AskEvent, ChatRequest } from "@nova-agent/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import {
  ASK_SETTINGS_PREFERENCE,
  COUNTER_FROM,
  FEEDBACK_FILE_NAME,
  FallbackAskClient,
  LocalAskClient,
  OFFLINE_NOTE,
  canRate,
  defaultAskClientFactory,
  feedbackEntry,
  feedbackExport,
  historyOf,
  reviveMessages,
  usagePercent,
  type AskClient,
  type AskHealth,
  type AskMessage,
  type AskSettings,
} from "../../apps/extension/src/sidepanel/ask";
import { MissionControl } from "../../apps/extension/src/sidepanel/MissionControl";
import { createNovaDb, type AskFeedbackRecord, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { MAX_ASK_FEEDBACK, askFeedbackId, clearAllData, deleteAskFeedback, getSyncStatus, listAskFeedback, putAskFeedback, setPreference } from "../../apps/extension/src/storage/repositories";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { askProps, baseProps, eventsClient, spyClient, trackedActions } from "../helpers/askHarness";
import { NOW, TENANT, demoDashboard, demoSnapshot } from "../helpers/demoDashboard";

let db: NovaDb;
const LONG = { timeout: 10_000 };
const SCOPE = `${TENANT}|2001`;

beforeEach(() => {
  db = createNovaDb(`resilience-${Date.now()}-${Math.random()}`);
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await db.delete();
});

const request = async (message: string): Promise<ChatRequest> => ({
  message,
  history: [],
  snapshot: compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" }),
  clientTools: ["read_attachment"],
  client: { name: "nova-extension", version: "0.1.0" },
});

const collect = async (client: AskClient, body: ChatRequest, signal = new AbortController().signal, handlers?: Parameters<AskClient["ask"]>[2]): Promise<AskEvent[]> => {
  const events: AskEvent[] = [];
  for await (const event of client.ask(body, signal, handlers)) events.push(event);
  return events;
};

const failing = (code: Extract<AskEvent, { type: "error" }>["code"], before: AskEvent[] = []): AskClient & { asked: number } => {
  const client = {
    asked: 0,
    async *ask(): AsyncIterable<AskEvent> {
      client.asked += 1;
      for (const event of before) yield event;
      yield { type: "error", code, message: `server said ${code}`, retryable: true };
    },
    async health(): Promise<AskHealth> {
      return { ok: false, configured: false, model: null, message: "down" };
    },
  };
  return client;
};

describe("FallbackAskClient", () => {
  it("answers a question one lookup can answer when the server cannot answer at all, and says why", async () => {
    for (const code of ["unreachable", "not_configured", "rate_limited", "budget_exhausted"] as const) {
      const primary = failing(code);
      let toolCalls = 0;
      const events = await collect(new FallbackAskClient(primary), await request("What is overdue?"), undefined, {
        clientTool: async () => {
          toolCalls += 1;
          return { ok: true, summary: "", data: null, rows: [] };
        },
      });
      expect(events.map((event) => event.type), code).toEqual(["tool_call", "tool_result", "text", "done"]);
      expect(events[0], code).toMatchObject({ name: "list_deadlines", input: { range: "overdue" } });
      const result = events[1] as Extract<AskEvent, { type: "tool_result" }>;
      expect(result.rows.map((row) => (row.kind === "item" ? row.title : "")), code).toEqual(["Lab 2: GPIO and Debouncing"]);
      expect(events[2], code).toEqual({ type: "text", delta: `${result.summary.replace(/[.!?]+$/, "")}. The rows below come straight from the data on this device.` });
      expect(events[3], code).toEqual({ type: "done", model: OFFLINE_MODEL_ID, usage: null, rounds: 2, grounded: true, corrected: false, offline: code });
      // One attempt at the server, and nothing read from a file to make the answer.
      expect(primary.asked, code).toBe(1);
      expect(toolCalls, code).toBe(0);
    }
  });

  it("keeps the error for a question the grammar does not recognise", async () => {
    const events = await collect(new FallbackAskClient(failing("unreachable")), await request("Why is Lab 2 my next move?"));
    expect(events).toEqual([{ type: "error", code: "unreachable", message: "server said unreachable", retryable: true }]);
  });

  it("keeps every other error, even for a question it could answer", async () => {
    for (const code of ["unauthorized", "bad_request", "upstream_error", "upstream_timeout", "internal", "aborted"] as const) {
      expect(await collect(new FallbackAskClient(failing(code)), await request("What is overdue?")), code).toEqual([{ type: "error", code, message: `server said ${code}`, retryable: true }]);
    }
  });

  it("does not take over once the server has begun to answer", async () => {
    const begun: AskEvent[] = [{ type: "tool_call", id: "c1", name: "list_deadlines", input: { range: "overdue" } }];
    const events = await collect(new FallbackAskClient(failing("rate_limited", begun)), await request("What is overdue?"));
    expect(events.map((event) => event.type)).toEqual(["tool_call", "error"]);
  });

  it("does not answer a question the student already stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await collect(new FallbackAskClient(failing("unreachable")), await request("What is overdue?"), controller.signal)).map((event) => event.type)).toEqual(["error"]);
  });

  it("passes a working server straight through, and its health too", async () => {
    const spy = spyClient("From the model.");
    const client = new FallbackAskClient(spy);
    expect(await collect(client, await request("What is overdue?"))).toEqual([
      { type: "text", delta: "From the model." },
      { type: "done", model: "spy", usage: null, rounds: 1, grounded: true, corrected: false },
    ]);
    expect(await client.health()).toEqual({ ok: true, configured: true, model: "spy", message: null });
  });

  it("is what the panel uses by default: with nothing listening, a suggested question is still answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const client = defaultAskClientFactory({ enabled: true, apiBaseUrl: "http://localhost:8787", token: null });
    expect(client).toBeInstanceOf(FallbackAskClient);
    const events = await collect(client, await request("What should I start first?"));
    expect(events.at(-1)).toMatchObject({ type: "done", offline: "unreachable", model: OFFLINE_MODEL_ID });
    expect((await collect(client, await request("Tell me a joke"))).at(-1)).toMatchObject({ type: "error", code: "unreachable" });
  });
});

const ask = (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /send question/i }));
};

describe("an answer made on the device, in the panel", () => {
  it("shows the answer, its rows, and a note that says no model wrote it and why", async () => {
    const { dashboard, events } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(new FallbackAskClient(failing("unreachable")), events) })} />);
    ask("What is overdue?");
    expect(await screen.findByText(`The Nova server could not be reached. ${OFFLINE_NOTE}`, {}, LONG)).toBeTruthy();
    expect(OFFLINE_NOTE).toBe("Answered on this device without the AI model.");
    expect(screen.getByText("1 item overdue, plus 1 long overdue not listed. The rows below come straight from the data on this device.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 matching item" }));
    expect(within(screen.getByRole("list", { name: /matching items/i })).getByText("Lab 2: GPIO and Debouncing")).toBeTruthy();
    // Follow-ups are offered as for any answer, and no token count is claimed for it.
    expect(screen.getByRole("group", { name: /follow-up questions/i })).toBeTruthy();
    expect(screen.queryByText(/^Last answer:/)).toBeNull();
  });

  it("gives each reason its own words", async () => {
    const { dashboard, events } = await demoDashboard();
    for (const [code, copy] of [
      ["not_configured", "The Nova server has no model key yet."],
      ["rate_limited", "The AI model is busy."],
      ["budget_exhausted", "Ask Nova has hit today's limit."],
    ] as const) {
      const view = render(<MissionControl {...baseProps({ dashboard, ask: askProps(new FallbackAskClient(failing(code)), events) })} />);
      ask("What is due next week?");
      expect(await screen.findByText(`${copy} ${OFFLINE_NOTE}`, {}, LONG)).toBeTruthy();
      view.unmount();
    }
  });

  it("keeps the error banner, with Retry, for a question it cannot answer alone", async () => {
    const { dashboard, events } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(new FallbackAskClient(failing("unreachable")), events) })} />);
    ask("Why is Lab 2 my next move?");
    const alert = await screen.findByRole("alert", {}, LONG);
    expect(within(alert).getByText("Can't reach the Nova server")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText(new RegExp(OFFLINE_NOTE))).toBeNull();
  });
});

describe("streamed text in the thread", () => {
  const DONE: AskEvent = { type: "done", model: "m", usage: { promptTokens: 300, completionTokens: 40, totalTokens: 340 }, rounds: 3, grounded: true, corrected: true };

  it("asks for a stream, drops words written before a lookup, and replaces a draft that failed the check", async () => {
    const { dashboard, events } = await demoDashboard();
    const seen: ChatRequest[] = [];
    const client: AskClient = {
      async *ask(body) {
        seen.push(body);
        yield { type: "text", delta: "Let me check your deadlines." };
        yield { type: "text_reset", reason: "lookup" };
        yield { type: "tool_call", id: "c1", name: "list_deadlines", input: { range: "week" } };
        yield { type: "tool_result", id: "c1", name: "list_deadlines", ok: true, summary: "7 items due in the next 7 days", rows: [] };
        yield { type: "text", delta: "Lab 3 is due " };
        yield { type: "text", delta: "Sep 19." };
        yield { type: "text_reset", reason: "correction" };
        yield { type: "text", delta: "Lab 3 is due " };
        yield { type: "text", delta: "Wed, Sep 9." };
        yield DONE;
      },
      async health() {
        return { ok: true, configured: true, model: "m", message: null };
      },
    };
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(client, events) })} />);
    ask("When is Lab 3 due?");
    expect(await screen.findByText("Lab 3 is due Wed, Sep 9.", {}, LONG)).toBeTruthy();
    expect(seen[0]?.streamText).toBe(true);
    expect(screen.queryByText(/Let me check/)).toBeNull();
    expect(screen.queryByText(/Sep 19/)).toBeNull();
    expect(screen.getByText("Nova corrected this answer after checking it against your data.")).toBeTruthy();
    expect(screen.getByText("Last answer: 340 tokens")).toBeTruthy();
    // Screen readers hear the answer that stands, once.
    expect(screen.getByText("Nova answered: Lab 3 is due Wed, Sep 9.")).toBeTruthy();
  });

  it("says so when the answer that stands could not be verified", async () => {
    const { dashboard, events } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(eventsClient([{ type: "text", delta: "Lab 3 is due Sep 19." }, { ...DONE, grounded: false, corrected: false }]), events) })} />);
    ask("When is Lab 3 due?");
    expect(await screen.findByText("Nova could not verify everything in this answer against your data. Check the rows and Brightspace before relying on it.", {}, LONG)).toBeTruthy();
    expect(screen.queryByText(/corrected this answer/)).toBeNull();
  });

  it("keeps a stopped draft out of what the next question sends", () => {
    const base: Omit<AskMessage, "id" | "role" | "text"> = { tools: [], rows: [], error: null, usage: null, grounded: null, stopped: false };
    const messages: AskMessage[] = [
      { ...base, id: "1", role: "user", text: "When is Lab 3 due?" },
      { ...base, id: "2", role: "assistant", text: "Lab 3 is due Sep", stopped: true },
      { ...base, id: "3", role: "user", text: "And Quiz 2?" },
      { ...base, id: "4", role: "assistant", text: "Quiz 2 is due Fri, Sep 11.", grounded: true },
    ];
    expect(historyOf(messages)).toEqual([
      { role: "user", content: "When is Lab 3 due?" },
      { role: "user", content: "And Quiz 2?" },
      { role: "assistant", content: "Quiz 2 is due Fri, Sep 11." },
    ]);
  });

  it("restores how a saved answer was made, and drops what it does not recognise", () => {
    const stored = [
      { id: "1", role: "user", text: "q", tools: [], rows: [], error: null, usage: null, grounded: null, stopped: false },
      { id: "2", role: "assistant", text: "a", tools: [], rows: [], error: null, usage: null, grounded: true, stopped: false, model: "on-device", offline: "unreachable", revised: true },
      { id: "3", role: "assistant", text: "b", tools: [], rows: [], error: null, usage: null, grounded: true, stopped: false, model: 7, offline: "bored", revised: "yes" },
    ];
    const revived = reviveMessages(stored);
    expect(revived[1]).toMatchObject({ model: "on-device", offline: "unreachable", revised: true });
    expect(revived[2]).toMatchObject({ id: "3", text: "b" });
    expect(revived[2]?.offline).toBeUndefined();
    expect(revived[2]?.revised).toBeUndefined();
    expect(revived[2]?.model).toBeUndefined();
    expect("model" in (revived[0] as AskMessage)).toBe(false);
  });
});

describe("rating an answer", () => {
  const base: Omit<AskMessage, "id" | "role" | "text"> = { tools: [], rows: [], error: null, usage: null, grounded: null, stopped: false };
  const thread: AskMessage[] = [
    { ...base, id: "u1", role: "user", text: "What is overdue?" },
    { ...base, id: "a1", role: "assistant", text: "1 overdue item.", grounded: true, model: "m1", tools: [{ id: "c1", name: "list_deadlines", status: "ok", summary: "1 overdue item", rows: 1 }] },
    { ...base, id: "u2", role: "user", text: "And next week?" },
    { ...base, id: "a2", role: "assistant", text: "Two things.", grounded: false, revised: true, model: OFFLINE_MODEL_ID, offline: "unreachable" },
    { ...base, id: "a3", role: "assistant", text: "", error: { type: "error", code: "internal", message: "x", retryable: true } },
    { ...base, id: "a4", role: "assistant", text: "Half an ans", stopped: true },
    { ...base, id: "a5", role: "assistant", text: "Still being written" },
  ];

  it("is offered for a finished answer only", () => {
    expect(thread.map(canRate)).toEqual([false, true, false, true, false, false, false]);
  });

  it("records the question and how the answer was made, never the answer", () => {
    expect(feedbackEntry(thread, "a1", "conv-1")).toEqual({ messageId: "a1", conversationId: "conv-1", question: "What is overdue?", toolNames: ["list_deadlines"], grounded: true, revised: false, model: "m1", offline: null });
    expect(feedbackEntry(thread, "a2", "conv-1")).toEqual({ messageId: "a2", conversationId: "conv-1", question: "And next week?", toolNames: [], grounded: false, revised: true, model: OFFLINE_MODEL_ID, offline: "unreachable" });
    for (const id of ["u1", "a3", "a4", "a5", "missing"]) expect(feedbackEntry(thread, id, "conv-1"), id).toBeNull();
    expect(JSON.stringify(feedbackEntry(thread, "a1", "conv-1"))).not.toContain("1 overdue item.");
  });

  const record = (index: number, verdict: "up" | "down" = "up"): AskFeedbackRecord => ({ id: askFeedbackId(SCOPE, `m${index}`), scope: SCOPE, messageId: `m${index}`, conversationId: "c", verdict, question: `Question ${index}`, toolNames: ["get_brief"], grounded: true, revised: false, model: "m", offline: null, at: new Date(NOW.getTime() + index * 1000).toISOString() });

  it("is stored per account, replaced by a second rating, and capped at the newest", async () => {
    await putAskFeedback(db, record(1));
    await putAskFeedback(db, { ...record(1, "down") });
    await putAskFeedback(db, record(2));
    await putAskFeedback(db, { ...record(3), id: askFeedbackId("other|scope", "m3"), scope: "other|scope" });
    expect((await listAskFeedback(db, SCOPE)).map((entry) => [entry.messageId, entry.verdict])).toEqual([
      ["m1", "down"],
      ["m2", "up"],
    ]);
    await deleteAskFeedback(db, SCOPE, "m1");
    expect((await listAskFeedback(db, SCOPE)).map((entry) => entry.messageId)).toEqual(["m2"]);
    await db.askFeedback.bulkPut(Array.from({ length: MAX_ASK_FEEDBACK + 5 }, (_, index) => record(100 + index)));
    await putAskFeedback(db, record(9999));
    const kept = await listAskFeedback(db, SCOPE);
    expect(kept).toHaveLength(MAX_ASK_FEEDBACK);
    expect(kept.at(-1)?.messageId).toBe("m9999");
    expect(kept.some((entry) => entry.messageId === "m2")).toBe(false);
    expect(await db.askFeedback.where("scope").equals("other|scope").count()).toBe(1);
    await clearAllData(db);
    expect(await db.askFeedback.count()).toBe(0);
  });

  it("exports as plain JSON with counts, and without the account or any ids", () => {
    const text = feedbackExport([record(1), record(2, "down")], NOW);
    const parsed = JSON.parse(text) as { kind: string; version: number; exportedAt: string; count: number; up: number; down: number; ratings: Record<string, unknown>[] };
    expect(parsed).toMatchObject({ kind: "nova-ask-feedback", version: 1, exportedAt: NOW.toISOString(), count: 2, up: 1, down: 1 });
    expect(parsed.ratings[0]).toEqual({ at: record(1).at, verdict: "up", question: "Question 1", tools: ["get_brief"], grounded: true, revised: false, model: "m", offline: null });
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain("2001");
    expect(text).not.toMatch(/messageId|conversationId|scope/);
    expect(JSON.parse(feedbackExport([], NOW))).toMatchObject({ count: 0, ratings: [] });
  });

  it("is given with a thumb under the answer, taken back with the same thumb, and exported from settings", { timeout: 40_000 }, async () => {
    await setPreference(db, ASK_SETTINGS_PREFERENCE, { enabled: true, apiBaseUrl: "http://localhost:8787", token: null } satisfies AskSettings);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    const saved: { name: string; text: string }[] = [];
    render(<App db={db} host={createStubHost()} now={() => NOW} transportFactory={factory} autoSync={false} askClientFactory={() => new LocalAskClient(new ScriptedModel(demoRouter))} saveFile={(name, text) => saved.push({ name, text })} />);
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await waitFor(async () => expect((await getSyncStatus(db)).lastSuccessfulSyncAt).toBe(NOW.toISOString()), LONG);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Ask" }, LONG));
    await screen.findByRole("textbox", { name: /ask nova a question/i }, LONG);
    const scope = (await getSyncStatus(db)).scope as string;

    ask("What is overdue?");
    const rate = await screen.findByRole("group", { name: "Rate this answer" }, LONG);
    const up = within(rate).getByRole("button", { name: "Good answer" });
    const down = within(rate).getByRole("button", { name: "Bad answer" });
    expect(up.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(up);
    await waitFor(() => expect(up.getAttribute("aria-pressed")).toBe("true"), LONG);
    expect(await listAskFeedback(db, scope)).toEqual([expect.objectContaining({ verdict: "up", question: "What is overdue?", toolNames: ["list_deadlines"], grounded: true, revised: false, model: "scripted", offline: null, at: NOW.toISOString() })]);
    // The other thumb replaces the rating; the same thumb takes it back.
    fireEvent.click(down);
    await waitFor(() => expect(down.getAttribute("aria-pressed")).toBe("true"), LONG);
    expect(up.getAttribute("aria-pressed")).toBe("false");
    expect((await listAskFeedback(db, scope)).map((entry) => entry.verdict)).toEqual(["down"]);
    fireEvent.click(down);
    await waitFor(async () => expect(await listAskFeedback(db, scope)).toEqual([]), LONG);
    fireEvent.click(up);
    await waitFor(async () => expect(await listAskFeedback(db, scope)).toHaveLength(1), LONG);

    fireEvent.click(screen.getByRole("button", { name: "Ask Nova settings" }));
    expect(await screen.findByText("1 answer rated. Ratings stay on this device until you export them.", {}, LONG)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Export ratings" }));
    await waitFor(() => expect(saved).toHaveLength(1), LONG);
    expect(saved[0]?.name).toBe(FEEDBACK_FILE_NAME);
    expect(JSON.parse(saved[0]?.text ?? "{}")).toMatchObject({ kind: "nova-ask-feedback", count: 1, up: 1, down: 0, ratings: [{ verdict: "up", question: "What is overdue?", tools: ["list_deadlines"] }] });
  });

  it("is not offered while an answer is being written, after an error, or without anywhere to keep it", async () => {
    const { dashboard, events } = await demoDashboard();
    const view = render(<MissionControl {...baseProps({ dashboard, ask: askProps(eventsClient([{ type: "error", code: "internal", message: "x", retryable: true }]), events, { feedback: { votes: new Map(), onVote: () => undefined, onExport: () => undefined } }) })} />);
    ask("What is overdue?");
    await screen.findByRole("alert", {}, LONG);
    expect(screen.queryByRole("group", { name: "Rate this answer" })).toBeNull();
    view.unmount();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(spyClient("Fine."), events) })} />);
    ask("What is overdue?");
    await screen.findByText("Fine.", {}, LONG);
    expect(screen.queryByRole("group", { name: "Rate this answer" })).toBeNull();
  });
});

const healthy = (usedToday: number, dailyCap: number | undefined): AskClient & { checks: number } => {
  const client = {
    checks: 0,
    async *ask(): AsyncIterable<AskEvent> {
      yield { type: "text", delta: "Done." };
      yield { type: "done", model: "m", usage: { promptTokens: 1200, completionTokens: 34, totalTokens: 1234 }, rounds: 1, grounded: true, corrected: false };
    },
    async health(): Promise<AskHealth> {
      client.checks += 1;
      return { ok: true, configured: true, model: "m", message: null, usedToday, ...(dailyCap !== undefined ? { dailyCap } : {}) };
    },
  };
  return client;
};

describe("usage", () => {
  it("shows the server's use for the day against its limit, and the tokens of the last answer", async () => {
    const { dashboard, events } = await demoDashboard();
    const client = healthy(90_000, 200_000);
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(client, events) })} />);
    const meter = await screen.findByRole("meter", { name: "Share of the Nova server's daily limit used today" }, LONG);
    expect(meter.getAttribute("aria-valuenow")).toBe("45");
    expect(screen.getByText("Server use today: 45%")).toBeTruthy();
    expect(screen.queryByText(/^Last answer:/)).toBeNull();
    expect(screen.queryByText(/nearly out/i)).toBeNull();
    expect(client.checks).toBe(1);
    ask("Go");
    expect(await screen.findByText("Last answer: 1,234 tokens", {}, LONG)).toBeTruthy();
    // Asked again after the answer, so the bar follows what the answer cost.
    await waitFor(() => expect(client.checks).toBe(2), LONG);
  });

  it("warns from ninety percent on", async () => {
    const { dashboard, events } = await demoDashboard();
    const view = render(<MissionControl {...baseProps({ dashboard, ask: askProps(healthy(180_000, 200_000), events) })} />);
    expect(await screen.findByText("Nearly out for today. Simple questions are still answered on this device.", {}, LONG)).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("90");
    view.unmount();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(healthy(179_000, 200_000), events) })} />);
    await screen.findByRole("meter", {}, LONG);
    expect(screen.queryByText(/nearly out/i)).toBeNull();
    expect(usagePercent({ usedToday: 500_000, dailyCap: 200_000 })).toBe(100);
    expect(usagePercent({ usedToday: 0, dailyCap: 200_000 })).toBe(0);
  });

  it("shows no bar for a server with no limit, an older server, or a tab that is not open", async () => {
    const { dashboard, events } = await demoDashboard();
    for (const client of [healthy(5000, 0), healthy(5000, undefined)]) {
      const view = render(<MissionControl {...baseProps({ dashboard, ask: askProps(client, events) })} />);
      await waitFor(() => expect(client.checks).toBe(1), LONG);
      await act(async () => undefined);
      expect(screen.queryByRole("meter")).toBeNull();
      view.unmount();
    }
    const unopened = healthy(90_000, 200_000);
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...baseProps().preferences, activeTab: "focus" }, ask: askProps(unopened, events) })} />);
    await act(async () => undefined);
    expect(unopened.checks).toBe(0);
  });
});

describe("the composer", () => {
  const box = () => screen.getByRole("textbox", { name: /ask nova a question/i }) as HTMLTextAreaElement;

  it("brings back the last question with the Up arrow when the field is empty, and only then", async () => {
    const { dashboard, events } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(spyClient("Fine."), events) })} />);
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().value).toBe("");
    ask("What is overdue?");
    await screen.findByText("Fine.", {}, LONG);
    ask("And next week?");
    await waitFor(() => expect(screen.getAllByText("Fine.")).toHaveLength(2), LONG);
    expect(box().value).toBe("");
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().value).toBe("And next week?");
    // With text in the field the arrow is the caret's.
    fireEvent.change(box(), { target: { value: "typing" } });
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    expect(box().value).toBe("typing");
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.keyDown(box(), { key: "ArrowUp", shiftKey: true });
    expect(box().value).toBe("");
  });

  it("counts characters once a question is long", async () => {
    const { dashboard, events } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(spyClient(), events) })} />);
    fireEvent.change(box(), { target: { value: "a".repeat(COUNTER_FROM) } });
    expect(screen.queryByLabelText(/of 2000 characters/)).toBeNull();
    fireEvent.change(box(), { target: { value: "a".repeat(COUNTER_FROM + 1) } });
    expect(screen.getByLabelText("1501 of 2000 characters").textContent).toBe("1,501 / 2,000");
    fireEvent.change(box(), { target: { value: "a".repeat(2000) } });
    expect(screen.getByLabelText("2000 of 2000 characters").getAttribute("data-full")).toBe("true");
    expect(box().maxLength).toBe(2000);
  });

  it("takes focus on a slash from anywhere in the panel, once the Ask tab is showing", async () => {
    const { dashboard, events } = await demoDashboard();
    const actions = trackedActions();
    const ask_ = askProps(spyClient(), events);
    const props = (activeTab: "focus" | "ask") => baseProps({ dashboard, actions, preferences: { ...baseProps().preferences, activeTab }, ask: ask_ });
    const view = render(<MissionControl {...props("focus")} />);
    const hiddenBox = () => screen.getByRole("textbox", { name: /ask nova a question/i, hidden: true }) as HTMLTextAreaElement;
    fireEvent.keyDown(document.body, { key: "/" });
    // The key asks for the Ask tab; focus waits until the tab is on screen, where it can land.
    expect(actions.calls.setPreferences).toEqual([[{ activeTab: "ask" }]]);
    expect(document.activeElement).not.toBe(hiddenBox());
    view.rerender(<MissionControl {...props("ask")} />);
    await waitFor(() => expect(document.activeElement).toBe(box()), LONG);
    // The slash itself is not typed.
    expect(box().value).toBe("");
    // Coming back to the tab later does not pull focus again.
    (document.activeElement as HTMLElement).blur();
    view.rerender(<MissionControl {...props("focus")} />);
    view.rerender(<MissionControl {...props("ask")} />);
    await act(async () => undefined);
    expect(document.activeElement).not.toBe(box());
    // On the Ask tab already, the key goes straight to the field.
    fireEvent.keyDown(document.body, { key: "/" });
    await waitFor(() => expect(document.activeElement).toBe(box()), LONG);
  });

  it("leaves the slash alone while the student is typing, holds a modifier, or has a dialog open, and when Ask is off", async () => {
    const { dashboard, events } = await demoDashboard();
    const actions = trackedActions();
    const view = render(<MissionControl {...baseProps({ dashboard, actions, ask: askProps(spyClient(), events) })} />);
    box().blur();
    fireEvent.keyDown(box(), { key: "/" });
    fireEvent.keyDown(document.body, { key: "/", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "/", metaKey: true });
    fireEvent.keyDown(document.body, { key: "/", altKey: true });
    fireEvent.keyDown(document.body, { key: "k" });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(document.body, { key: "/" });
    dialog.remove();
    expect(actions.calls.setPreferences).toBeUndefined();
    expect(document.activeElement).not.toBe(box());
    view.unmount();
    const off = trackedActions();
    render(<MissionControl {...baseProps({ dashboard, actions: off, preferences: { ...baseProps().preferences, activeTab: "focus" }, ask: askProps(spyClient(), events, { settings: { enabled: false, apiBaseUrl: "http://localhost:8787", token: null } }) })} />);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(off.calls.setPreferences).toBeUndefined();
  });
});
