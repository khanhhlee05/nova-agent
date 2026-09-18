// @vitest-environment jsdom
import "./setup";
import { ModelError, ScriptedModel, compactSnapshot, demoRouter, executeTool, type ChatModel, type ModelEvent, type ModelInput } from "@nova-agent/agent";
import type { AskEvent, ChatRequest } from "@nova-agent/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { LocalAskClient, type AskClient } from "../../apps/extension/src/sidepanel/ask/askClient";
import { DEFAULT_ASK_SETTINGS, type AskSettings } from "../../apps/extension/src/sidepanel/ask/askSettings";
import { EMPTY_DISMISSALS } from "../../apps/extension/src/sidepanel/dismissals";
import { DEFAULT_PREFERENCES, MissionControl, type AskProps, type MissionControlActions, type MissionControlProps } from "../../apps/extension/src/sidepanel/MissionControl";
import { INITIAL_SYNC_STATUS } from "../../apps/extension/src/storage/repositories";
import { IDLE_STATE } from "../../apps/extension/src/sync/syncState";
import { NOW, TENANT, demoDashboard } from "../helpers/demoDashboard";

afterEach(cleanup);

const actions = (): MissionControlActions & { calls: Record<string, unknown[][]> } => {
  const calls: Record<string, unknown[][]> = {};
  const track =
    (name: string) =>
    (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
    };
  return {
    calls,
    refresh: track("refresh"),
    setPreferences: track("setPreferences"),
    markAllRead: track("markAllRead"),
    setEventRead: track("setEventRead"),
    openUrl: track("openUrl"),
    connectLive: track("connectLive"),
    useDemoData: track("useDemoData"),
    clearData: track("clearData"),
    dismissItem: track("dismissItem"),
    deleteEvent: track("deleteEvent"),
    dismissBanner: track("dismissBanner"),
    restoreDismissed: track("restoreDismissed"),
  };
};

const ENABLED: AskSettings = { enabled: true, apiBaseUrl: "http://localhost:8787", token: null };

const askProps = (client: AskClient | null, events: AskProps["events"], settings: AskSettings = ENABLED): AskProps & { settingsCalls: Partial<AskSettings>[] } => {
  const settingsCalls: Partial<AskSettings>[] = [];
  return { client, settings, setSettings: (patch) => settingsCalls.push(patch), clientFactory: () => client ?? new LocalAskClient(new ScriptedModel(demoRouter)), events, settingsCalls };
};

const baseProps = (overrides: Partial<MissionControlProps> = {}): MissionControlProps => ({
  dashboard: null,
  status: { ...INITIAL_SYNC_STATUS, mode: "live", phase: "ready", scope: `${TENANT}|2001`, lastSuccessfulSyncAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), lastAttemptedSyncAt: NOW.toISOString(), lastOutcome: "ready" },
  runtime: IDLE_STATE,
  feasibility: null,
  preferences: { ...DEFAULT_PREFERENCES, activeTab: "ask", collapsedSections: [] },
  hasEverSynced: true,
  announcement: null,
  now: NOW,
  tenantOrigin: TENANT,
  dismissals: EMPTY_DISMISSALS,
  actions: actions(),
  ...overrides,
});

const scripted = () => new LocalAskClient(new ScriptedModel(demoRouter));

/** A model that pauses mid-answer until released, so tests can press Stop. */
const gated = () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: ChatModel = {
    id: "gated",
    async *complete(input: ModelInput): AsyncIterable<ModelEvent> {
      yield { type: "tool_call", call: { id: "c1", name: "get_brief", arguments: "{}" } };
      if (input.messages.some((message) => message.role === "tool")) {
        yield { type: "text", delta: "First part." };
        await gate;
        if (input.signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        yield { type: "text", delta: " Second part." };
      }
      yield { type: "done", stop: "end", usage: null, model: "gated" };
    },
  };
  return { model, release: () => release() };
};

const eventsClient = (events: AskEvent[]): AskClient => ({
  async *ask() {
    for (const event of events) yield event;
  },
  async health() {
    return { ok: true, configured: true, model: "fake", message: null };
  },
});

describe("Ask tab", () => {
  it("adds a fourth tab after Changes and keeps arrow-key order", async () => {
    const user = userEvent.setup();
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    const props = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" }, ask: askProps(scripted(), events) });
    render(<MissionControl {...props} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, ""))).toEqual(["Focus", "Week", "Changes", "Ask"]);
    screen.getByRole("tab", { name: /changes/i }).focus();
    await user.keyboard("{ArrowRight}");
    expect((props.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ activeTab: "ask" });
    const panel = document.querySelector(".tab-content-ask") as HTMLElement;
    expect(panel.hidden).toBe(true);
  });

  it("shows the setup card until turned on and normalizes the address", async () => {
    const { dashboard, events } = await demoDashboard();
    const ask = askProps(null, events, DEFAULT_ASK_SETTINGS);
    render(<MissionControl {...baseProps({ dashboard, ask })} />);
    expect(screen.getByRole("heading", { level: 2, name: /ask nova is off/i })).toBeTruthy();
    expect(screen.getByText(/what leaves this device/i)).toBeTruthy();
    expect(screen.getByText(/never leave this device/i)).toBeTruthy();
    const offInput = screen.getByRole("textbox", { name: /ask nova a question/i }) as HTMLTextAreaElement;
    expect(offInput.readOnly).toBe(true);
    expect(offInput.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("group", { name: /suggested questions/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /nova server address/i })).toBeNull();
    expect(screen.getByText("localhost:8787")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /change nova server address/i }));
    const address = screen.getByRole("textbox", { name: /nova server address/i }) as HTMLInputElement;
    expect(address.value).toBe("http://localhost:8787");
    fireEvent.change(address, { target: { value: "not a url" } });
    expect(screen.getByText(/enter the full address/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /turn on ask nova/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(address, { target: { value: "http://nova.example:8787" } });
    expect(screen.getByText(/must start with https/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /turn on ask nova/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(address, { target: { value: "https://nova.example:8787" } });
    expect(screen.queryByText(/must start with https/i)).toBeNull();
    expect((screen.getByRole("button", { name: /turn on ask nova/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(address, { target: { value: " http://localhost:8787/ " } });
    fireEvent.click(screen.getByRole("button", { name: /turn on ask nova/i }));
    expect(ask.settingsCalls).toEqual([{ enabled: true, apiBaseUrl: "http://localhost:8787", token: null }]);
  });

  it("tests the connection from the setup card", async () => {
    const { dashboard, events } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(null, events, DEFAULT_ASK_SETTINGS) })} />);
    fireEvent.click(screen.getByRole("button", { name: /test connection/i }));
    expect(await screen.findByText(/connected\. answers come from scripted/i)).toBeTruthy();
  });

  it("answers a suggested question with text and rows that match the tool result", async () => {
    const { dashboard, events, snapshot } = await demoDashboard({ withChanges: true });
    const props = baseProps({ dashboard, ask: askProps(scripted(), events) });
    render(<MissionControl {...props} />);
    fireEvent.click(within(screen.getByRole("group", { name: /suggested questions/i })).getByRole("button", { name: /what should i start first/i }));
    const conversation = await screen.findByRole("list", { name: /conversation/i });
    expect(within(conversation).getByText("What should I start first?")).toBeTruthy();
    await screen.findByText(/looked up your workload/i);
    await within(conversation).findByText(/the rows below come straight from your brightspace data/i);
    const compact = compactSnapshot(snapshot, events, NOW, { mode: "live" });
    const expected = executeTool("get_brief", {}, { snapshot: compact });
    if (!expected.ok) throw new Error(expected.error);
    const rows = within(screen.getByRole("list", { name: /matching items/i })).getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector(".task-title")?.textContent)).toEqual(expected.rows.map((row) => row.title));
    expect(rows.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: `Open ${expected.rows[0]?.title} in Brightspace` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Open ${expected.rows[0]?.title} in Brightspace` }));
    expect((props.actions as ReturnType<typeof actions>).calls.openUrl?.[0]?.[0]).toContain(TENANT);
    // The live region carries the answer itself, not just "Nova answered."
    await waitFor(() => expect(screen.getByText(/^Nova answered: .*the rows below come straight from your brightspace data/i)).toBeTruthy());
  });

  it("sends on Enter, keeps Shift+Enter as a newline, and rejects empty questions", async () => {
    const user = userEvent.setup();
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(scripted(), events) })} />);
    const input = screen.getByRole("textbox", { name: /ask nova a question/i }) as HTMLTextAreaElement;
    expect(screen.getByRole("button", { name: /send question/i }).getAttribute("aria-disabled")).toBe("true");
    await user.type(input, "What changed{Shift>}{Enter}{/Shift}today?");
    expect(input.value).toBe("What changed\ntoday?");
    expect(screen.queryByRole("list", { name: /conversation/i })).toBeNull();
    await user.keyboard("{Enter}");
    expect(input.value).toBe("");
    expect(await screen.findByText("What changed today?")).toBeTruthy();
    await screen.findByText(/looked up changes/i);
  });

  it("lets the student stop an answer before any unchecked text is shown", async () => {
    const { dashboard, events } = await demoDashboard();
    const { model, release } = gated();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(new LocalAskClient(model), events) })} />);
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: "Go" } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    await screen.findByText(/looked up your workload/i);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
    // One button: Send turns into Stop in place, and the textarea stays editable for the next question.
    const stop = screen.getByRole("button", { name: /stop answering/i });
    expect(screen.queryByRole("button", { name: /send question/i })).toBeNull();
    expect((screen.getByRole("textbox", { name: /ask nova a question/i }) as HTMLTextAreaElement).readOnly).toBe(false);
    fireEvent.click(stop);
    release();
    expect(await screen.findByText(/stopped before nova finished/i)).toBeTruthy();
    expect(screen.queryByText("First part.")).toBeNull();
    expect(screen.queryByText(/second part/i)).toBeNull();
    expect(screen.getByRole("button", { name: /send question/i })).toBe(stop);
  });

  it("renders typed error copy with retry and settings actions", async () => {
    const { dashboard, events } = await demoDashboard();
    const unreachable = askProps(eventsClient([{ type: "error", code: "unreachable", message: "no", retryable: true }]), events);
    render(<MissionControl {...baseProps({ dashboard, ask: unreachable })} />);
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/can't reach the nova server/i)).toBeTruthy();
    expect(within(alert).getByText(/localhost:8787/)).toBeTruthy();
    expect(within(alert).getByRole("button", { name: /retry/i })).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("heading", { level: 3, name: /ask nova settings/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn off/i })).toBeTruthy();
    cleanup();

    const limited = askProps(new LocalAskClient(new ScriptedModel([{ throw: new ModelError("rate_limited", "slow", true, 30) }])), events);
    render(<MissionControl {...baseProps({ dashboard, ask: limited })} />);
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    expect(await screen.findByText(/try again in 30 seconds/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/nova could not answer/i)).toBeTruthy());
  });

  it("labels demo data and hides Open for rows outside the tenant", async () => {
    const { dashboard, events } = await demoDashboard();
    const rowsClient = eventsClient([
      { type: "tool_call", id: "c1", name: "list_deadlines", input: {} },
      {
        type: "tool_result",
        id: "c1",
        name: "list_deadlines",
        ok: true,
        summary: "1 item.",
        rows: [{ kind: "item", id: "a1", title: "Foreign item", courseId: "999", courseName: "Elsewhere", itemKind: "assignment", dueAt: null, dueLocal: null, bucket: "no-date", status: "unknown", url: "https://evil.example/x", priority: null }],
      },
      { type: "text", delta: "One item." },
      { type: "done", model: "fake", usage: null, rounds: 2, grounded: true, corrected: false },
    ]);
    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, mode: "fixture" }, ask: askProps(rowsClient, events) })} />);
    expect(screen.getByText(/answers describe fictional demo courses/i)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    await screen.findByText("Foreign item");
    expect(screen.queryByRole("button", { name: /open foreign item/i })).toBeNull();
  });

  it("keeps the conversation when switching tabs and back", async () => {
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    const ask = askProps(scripted(), events);
    const { rerender } = render(<MissionControl {...baseProps({ dashboard, ask })} />);
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: "What is due today?" } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    await screen.findByText(/looked up deadlines/i);
    rerender(<MissionControl {...baseProps({ dashboard, ask, preferences: { ...DEFAULT_PREFERENCES, activeTab: "focus", collapsedSections: [] } })} />);
    const panel = screen.getByText("What is due today?").closest(".tab-content-ask") as HTMLElement;
    expect(panel.hidden).toBe(true);
    rerender(<MissionControl {...baseProps({ dashboard, ask })} />);
    expect((screen.getByText("What is due today?").closest(".tab-content-ask") as HTMLElement).hidden).toBe(false);
    expect(screen.getByText(/looked up deadlines/i)).toBeTruthy();
  });

  it("does not add the tab when Ask is not wired", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, collapsedSections: [] } })} />);
    expect(screen.getAllByRole("tab")).toHaveLength(3);
  });

  it("builds a demo-labeled request from the dashboard", async () => {
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    const seen: ChatRequest[] = [];
    const spy: AskClient = {
      async *ask(request) {
        seen.push(request);
        yield { type: "text", delta: "ok" };
        yield { type: "done", model: "spy", usage: null, rounds: 1, grounded: true, corrected: false };
      },
      async health() {
        return { ok: true, configured: true, model: "spy", message: null };
      },
    };
    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, mode: "fixture" }, ask: askProps(spy, events) })} />);
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    await screen.findByText("ok");
    expect(seen[0]?.snapshot.mode).toBe("demo");
    expect(seen[0]?.snapshot.changes.length).toBe(events.length);
    expect(seen[0]?.client).toEqual({ name: "nova-extension", version: "0.1.0" });
    expect(JSON.stringify(seen[0])).not.toContain("2001");
  });
});
