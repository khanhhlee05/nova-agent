// @vitest-environment jsdom
import "./setup";
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_DISMISSALS, useSessionDismissals } from "../../apps/extension/src/sidepanel/dismissals";
import { DEFAULT_PREFERENCES, MissionControl, type MissionControlActions, type MissionControlProps } from "../../apps/extension/src/sidepanel/MissionControl";
import { buildDashboard } from "../../apps/extension/src/sidepanel/model";
import { INITIAL_SYNC_STATUS } from "../../apps/extension/src/storage/repositories";
import { IDLE_STATE } from "../../apps/extension/src/sync/syncState";
import { NOW, TENANT, demoDashboard } from "../helpers/demoDashboard";

afterEach(cleanup);

const trackedActions = (): MissionControlActions & { calls: Record<string, unknown[][]> } => {
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
    dismissEvent: track("dismissEvent"),
    dismissBanner: track("dismissBanner"),
    restoreDismissed: track("restoreDismissed"),
  };
};

const props = (overrides: Partial<MissionControlProps> = {}): MissionControlProps => ({
  dashboard: null,
  status: { ...INITIAL_SYNC_STATUS, mode: "live", phase: "ready", scope: `${TENANT}|2001`, lastSuccessfulSyncAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), lastAttemptedSyncAt: NOW.toISOString(), lastOutcome: "ready" },
  runtime: IDLE_STATE,
  feasibility: null,
  preferences: { ...DEFAULT_PREFERENCES, collapsedSections: [] },
  hasEverSynced: true,
  announcement: null,
  now: NOW,
  tenantOrigin: TENANT,
  dismissals: EMPTY_DISMISSALS,
  actions: trackedActions(),
  ...overrides,
});

describe("session dismissals: model", () => {
  it("hides a dismissed item from every view and every count", async () => {
    const { snapshot, events } = await demoDashboard({ withChanges: true });
    const base = buildDashboard({ snapshot, events, now: NOW, courseFilter: null });
    const top = base.nextMove?.item as NonNullable<typeof base.nextMove>["item"];
    const dismissed = buildDashboard({ snapshot, events, now: NOW, courseFilter: null, dismissedItemKeys: new Set([top.key]) });

    expect(dismissed.items.some((item) => item.key === top.key)).toBe(false);
    expect(Object.values(dismissed.buckets).flat().some((item) => item.key === top.key)).toBe(false);
    expect(dismissed.week.flatMap((day) => day.entries).some((entry) => entry.item.key === top.key)).toBe(false);
    expect(dismissed.nextMove?.item.key).not.toBe(top.key);
    expect(dismissed.ranked.has(top.key)).toBe(false);
    expect(dismissed.counts.overdue + dismissed.counts.today + dismissed.counts.thisWeek).toBeLessThan(base.counts.overdue + base.counts.today + base.counts.thisWeek);
    expect(dismissed.hidden).toEqual({ items: 1, events: 0 });
    // Change events keep resolving links through the full item map.
    expect(dismissed.itemByKey.has(top.key)).toBe(true);
  });

  it("hides a dismissed change event from the feed and the unread count", async () => {
    const { snapshot, events } = await demoDashboard({ withChanges: true });
    const first = events[0] as (typeof events)[number];
    const dashboard = buildDashboard({ snapshot, events, now: NOW, courseFilter: null, dismissedEventIds: new Set([first.id]) });
    const listed = [...dashboard.changes.today, ...dashboard.changes.yesterday, ...dashboard.changes.earlier];
    expect(listed.some((event) => event.id === first.id)).toBe(false);
    expect(dashboard.totalChanges).toBe(events.length - 1);
    expect(dashboard.counts.unread).toBe(events.length - 1);
    expect(dashboard.hidden).toEqual({ items: 0, events: 1 });
  });
});

describe("session dismissals: hook", () => {
  it("accumulates dismissals and resets when fresh data arrives", () => {
    const { result, rerender } = renderHook(({ key }: { key: string | null }) => useSessionDismissals(key), { initialProps: { key: "snapshot-1" } });
    act(() => {
      result.current.dismissItem("item-a");
      result.current.dismissItem("item-a");
      result.current.dismissEvent("event-1");
      result.current.dismissBanner("stale");
    });
    expect([...result.current.dismissals.items]).toEqual(["item-a"]);
    expect([...result.current.dismissals.events]).toEqual(["event-1"]);
    expect([...result.current.dismissals.banners]).toEqual(["stale"]);

    rerender({ key: "snapshot-2" });
    expect(result.current.dismissals).toBe(EMPTY_DISMISSALS);

    act(() => result.current.dismissItem("item-b"));
    expect(result.current.dismissals.items.size).toBe(1);
    act(() => result.current.restoreAll());
    expect(result.current.dismissals).toBe(EMPTY_DISMISSALS);
  });
});

describe("session dismissals: UI", () => {
  it("offers a hide control on task rows and the next move card, and reports what was hidden", async () => {
    const { dashboard } = await demoDashboard();
    const p = props({ dashboard });
    render(<MissionControl {...p} />);
    const top = dashboard.nextMove?.item as NonNullable<typeof dashboard.nextMove>["item"];

    fireEvent.click(screen.getAllByRole("button", { name: `Hide "${top.title}" until next refresh` })[0] as HTMLButtonElement);
    const calls = (p.actions as ReturnType<typeof trackedActions>).calls;
    expect(calls.dismissItem?.[0]).toEqual([top.key, top.title]);
    expect(screen.queryByRole("status", { name: "" })).toBeDefined();
    expect(screen.queryByText(/hidden until the next refresh/i)).toBeNull();
  });

  it("removes hidden items everywhere, shows the hidden bar, and restores on Show all", async () => {
    const { snapshot, events } = await demoDashboard();
    const base = buildDashboard({ snapshot, events, now: NOW, courseFilter: null });
    const top = base.nextMove?.item as NonNullable<typeof base.nextMove>["item"];
    const dismissals = { ...EMPTY_DISMISSALS, items: new Set([top.key]) };
    const dashboard = buildDashboard({ snapshot, events, now: NOW, courseFilter: null, dismissedItemKeys: dismissals.items });
    const p = props({ dashboard, dismissals });
    render(<MissionControl {...p} />);

    expect(screen.queryByText(top.title)).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: dashboard.nextMove?.item.title as string })).toBeTruthy();
    const bar = screen.getByText(/1 item hidden until the next refresh/i).closest(".hidden-bar") as HTMLElement;
    fireEvent.click(within(bar).getByRole("button", { name: /show all/i }));
    expect((p.actions as ReturnType<typeof trackedActions>).calls.restoreDismissed).toHaveLength(1);
  });

  it("hides change events individually and keeps the unread badge honest", async () => {
    const { snapshot, events } = await demoDashboard({ withChanges: true });
    const first = events[0] as (typeof events)[number];
    const p = props({ dashboard: buildDashboard({ snapshot, events, now: NOW, courseFilter: null }), preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" } });
    render(<MissionControl {...p} />);
    const hideButtons = screen.getAllByRole("button", { name: /^Hide change "/ });
    expect(hideButtons).toHaveLength(events.length);
    fireEvent.click(hideButtons[0] as HTMLButtonElement);
    expect((p.actions as ReturnType<typeof trackedActions>).calls.dismissEvent?.[0]?.[0]).toBeTypeOf("string");
    cleanup();

    const dismissals = { ...EMPTY_DISMISSALS, events: new Set([first.id]) };
    const dashboard = buildDashboard({ snapshot, events, now: NOW, courseFilter: null, dismissedEventIds: dismissals.events });
    render(<MissionControl {...props({ dashboard, dismissals, preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" } })} />);
    expect(screen.getAllByRole("button", { name: /^Hide change "/ })).toHaveLength(events.length - 1);
    expect(screen.getByRole("tab", { name: /changes/i }).textContent).toContain(String(events.length - 1));
    expect(screen.getByText(/1 item hidden until the next refresh/i)).toBeTruthy();
  });

  it("lets a banner be hidden for the session", async () => {
    const { dashboard } = await demoDashboard();
    const old = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const p = props({ dashboard, status: { ...props().status, lastSuccessfulSyncAt: old } });
    render(<MissionControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /hide "this may be out of date" until next refresh/i }));
    expect((p.actions as ReturnType<typeof trackedActions>).calls.dismissBanner?.[0]).toEqual(["stale"]);
    cleanup();

    render(<MissionControl {...props({ dashboard, status: { ...props().status, lastSuccessfulSyncAt: old }, dismissals: { ...EMPTY_DISMISSALS, banners: new Set(["stale"]) } })} />);
    expect(screen.queryByText(/this may be out of date/i)).toBeNull();
    expect(screen.getByText(/1 item hidden until the next refresh/i)).toBeTruthy();
  });

  it("offers hide inside the week popover details", async () => {
    const { dashboard } = await demoDashboard();
    const p = props({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "week" } });
    render(<MissionControl {...p} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Lab 3: Timer Interrupts/ })[0] as HTMLButtonElement);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /hide until next refresh/i }));
    const call = (p.actions as ReturnType<typeof trackedActions>).calls.dismissItem?.[0];
    expect(call?.[1]).toBe("Lab 3: Timer Interrupts");
  });
});
