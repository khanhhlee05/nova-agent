import { ScriptedModel, demoRouter } from "@nova-agent/agent";
import type { AskEvent, ChatRequest } from "@nova-agent/protocol";
import { LocalAskClient, type AskClient } from "../../apps/extension/src/sidepanel/ask/askClient";
import type { AskSettings } from "../../apps/extension/src/sidepanel/ask/askSettings";
import { EMPTY_DISMISSALS } from "../../apps/extension/src/sidepanel/dismissals";
import { DEFAULT_PREFERENCES, type AskProps, type MissionControlActions, type MissionControlProps } from "../../apps/extension/src/sidepanel/MissionControl";
import { INITIAL_SYNC_STATUS } from "../../apps/extension/src/storage/repositories";
import { IDLE_STATE } from "../../apps/extension/src/sync/syncState";
import { NOW, TENANT } from "./demoDashboard";

export type TrackedActions = MissionControlActions & { calls: Record<string, unknown[][]> };

/** Every action records its arguments, so a test can assert which handler a control reached. */
export const trackedActions = (): TrackedActions => {
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
    setLocalDone: track("setLocalDone"),
    addPersonal: track("addPersonal"),
    updatePersonal: track("updatePersonal"),
    deletePersonal: track("deletePersonal"),
    setPersonalDone: track("setPersonalDone"),
    addPlanToWeek: track("addPlanToWeek"),
    removePlanFromWeek: track("removePlanFromWeek"),
    deleteEvent: track("deleteEvent"),
    dismissBanner: track("dismissBanner"),
    restoreDismissed: track("restoreDismissed"),
  };
};

export const ASK_ENABLED: AskSettings = { enabled: true, apiBaseUrl: "http://localhost:8787", token: null };

export const scriptedClient = (): AskClient => new LocalAskClient(new ScriptedModel(demoRouter));

export const askProps = (client: AskClient | null, events: AskProps["events"], overrides: Partial<AskProps> = {}): AskProps & { settingsCalls: Partial<AskSettings>[] } => {
  const settingsCalls: Partial<AskSettings>[] = [];
  return { client, settings: ASK_ENABLED, setSettings: (patch) => settingsCalls.push(patch), clientFactory: () => client ?? scriptedClient(), events, settingsCalls, ...overrides };
};

export const baseProps = (overrides: Partial<MissionControlProps> = {}): MissionControlProps => ({
  dashboard: null,
  status: { ...INITIAL_SYNC_STATUS, mode: "live", phase: "ready", scope: `${TENANT}|2001`, lastSuccessfulSyncAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), lastAttemptedSyncAt: NOW.toISOString(), lastOutcome: "ready" },
  runtime: IDLE_STATE,
  feasibility: null,
  preferences: { ...DEFAULT_PREFERENCES, activeTab: "ask" },
  hasEverSynced: true,
  announcement: null,
  now: NOW,
  tenantOrigin: TENANT,
  dismissals: EMPTY_DISMISSALS,
  actions: trackedActions(),
  ...overrides,
});

/** A client that replays fixed events, for states a model would not produce on demand. */
export const eventsClient = (events: AskEvent[]): AskClient => ({
  async *ask() {
    for (const event of events) yield event;
  },
  async health() {
    return { ok: true, configured: true, model: "fake", message: null };
  },
});

/** Records every request and answers with one grounded sentence. */
export const spyClient = (answer = "ok"): AskClient & { seen: ChatRequest[] } => {
  const seen: ChatRequest[] = [];
  return {
    seen,
    async *ask(request) {
      seen.push(request);
      yield { type: "text", delta: answer };
      yield { type: "done", model: "spy", usage: null, rounds: 1, grounded: true, corrected: false };
    },
    async health() {
      return { ok: true, configured: true, model: "spy", message: null };
    },
  };
};
