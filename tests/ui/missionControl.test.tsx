// @vitest-environment jsdom
import "./setup";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_DISMISSALS } from "../../apps/extension/src/sidepanel/dismissals";
import { DEFAULT_PREFERENCES, MissionControl, type MissionControlActions, type MissionControlProps } from "../../apps/extension/src/sidepanel/MissionControl";
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
    dismissEvent: track("dismissEvent"),
    dismissBanner: track("dismissBanner"),
    restoreDismissed: track("restoreDismissed"),
  };
};

const baseProps = (overrides: Partial<MissionControlProps> = {}): MissionControlProps => ({
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
  actions: actions(),
  ...overrides,
});

describe("Mission Control states", () => {
  it("shows the first-run state before any sync", () => {
    render(<MissionControl {...baseProps({ status: INITIAL_SYNC_STATUS, hasEverSynced: false })} />);
    expect(screen.getByRole("heading", { name: /know what changed/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect to brightspace/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /explore with demo data/i })).toBeTruthy();
  });

  it("shows loading skeletons while the first sync runs", () => {
    render(<MissionControl {...baseProps({ status: { ...INITIAL_SYNC_STATUS, mode: "live", lastAttemptedSyncAt: NOW.toISOString() }, runtime: { ...IDLE_STATE, phase: "loading-course-data", progress: { completed: 1, total: 4 } }, hasEverSynced: false })} />);
    expect(screen.getByTestId("skeleton")).toBeTruthy();
    expect(screen.getByText("Refreshing…")).toBeTruthy();
    expect(screen.getByRole("status", { name: /connection: refreshing/i })).toBeTruthy();
    expect((screen.getByRole("button", { name: /refresh now/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels demo data clearly and never as live", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, mode: "fixture" } })} />);
    expect(screen.getByRole("status", { name: /connection: demo data/i })).toBeTruthy();
    expect(screen.getByText(/these courses are fictional/i)).toBeTruthy();
    expect(screen.queryByText(/^Live$/)).toBeNull();
  });

  it("renders the ready state with counts, next move, and sections", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard })} />);
    expect(screen.getByRole("status", { name: /connection: live/i })).toBeTruthy();
    expect(screen.getByText(/live · 4m ago/i)).toBeTruthy();
    const summary = screen.getByRole("group", { name: /workload summary/i });
    expect(within(summary).getByText("Overdue").previousSibling?.textContent).toBe(String(dashboard.counts.overdue));
    expect(within(summary).getByText("Today").previousSibling?.textContent).toBe(String(dashboard.counts.today));
    expect(screen.getByRole("heading", { level: 2, name: dashboard.nextMove?.item.title as string })).toBeTruthy();
    expect(screen.getAllByText(/suggested priority/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/AI priority/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^Overdue/ })).toBeTruthy();
  });

  it("shows stale, partial, session-expired, permission-required, and offline states with retry", async () => {
    const { dashboard } = await demoDashboard();
    const old = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const { unmount } = render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, lastSuccessfulSyncAt: old } })} />);
    expect(screen.getByText(/stale · 2h ago/i)).toBeTruthy();
    expect(screen.getByText(/this may be out of date/i)).toBeTruthy();
    unmount();

    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, phase: "partial", failedCourseIds: ["31002"] } })} />);
    const partial = screen.getByText(/1 course could not be refreshed/i).closest(".banner") as HTMLElement;
    fireEvent.click(within(partial).getByText("Details"));
    expect(within(partial).getByText("Computer Architecture")).toBeTruthy();
    cleanup();

    const props = baseProps({ dashboard, status: { ...baseProps().status, phase: "session-expired", error: { kind: "session-expired" } } });
    render(<MissionControl {...props} />);
    expect(screen.getByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Brightspace session expired"));
    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    expect((props.actions as ReturnType<typeof actions>).calls.refresh).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /open brightspace/i }));
    expect((props.actions as ReturnType<typeof actions>).calls.openUrl?.[0]?.[0]).toBe(`${TENANT}/d2l/home`);
    cleanup();

    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, phase: "permission-required", error: { kind: "permission-denied", operation: "whoami" } } })} />);
    expect(screen.getByText(/connection requires authorization/i)).toBeTruthy();
    cleanup();

    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, phase: "offline", error: { kind: "network", retryable: true, operation: "no-brightspace-tab" } } })} />);
    expect(screen.getByText(/open brightspace.villanova.edu in a tab/i)).toBeTruthy();
  });

  it("shows an empty state when nothing is visible", async () => {
    const { dashboard } = await demoDashboard({ courseFilter: "does-not-exist" });
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, courseFilter: "does-not-exist" } })} />);
    expect(screen.getByText(/no assignments or quizzes yet/i)).toBeTruthy();
    expect(screen.getByText(/nothing active right now/i)).toBeTruthy();
  });
});

describe("course filtering", () => {
  it("keeps chips, sections, next move, week, and changes consistent for one course", async () => {
    const all = await demoDashboard({ withChanges: true });
    const one = await demoDashboard({ withChanges: true, courseFilter: "31001" });
    expect(one.dashboard.items.every((item) => item.courseId === "31001")).toBe(true);
    expect(one.dashboard.counts.thisWeek).toBeLessThan(all.dashboard.counts.thisWeek);
    expect(one.dashboard.counts.overdue + one.dashboard.counts.today).toBeLessThanOrEqual(all.dashboard.counts.overdue + all.dashboard.counts.today);
    expect(one.dashboard.nextMove?.item.courseId).toBe("31001");
    expect(one.dashboard.week.flatMap((day) => day.entries).every((entry) => entry.item.courseId === "31001")).toBe(true);
    const events = [...one.dashboard.changes.today, ...one.dashboard.changes.yesterday, ...one.dashboard.changes.earlier];
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.courseId === "31001")).toBe(true);
    expect(one.dashboard.counts.unread).toBe(events.filter((event) => event.readAt === null).length);
    const total = Object.values(one.dashboard.buckets).reduce((sum, list) => sum + list.length, 0);
    expect(total).toBe(one.dashboard.items.length);

    render(<MissionControl {...baseProps({ dashboard: one.dashboard, preferences: { ...DEFAULT_PREFERENCES, courseFilter: "31001", collapsedSections: [] } })} />);
    expect(screen.getByRole("combobox", { name: /filter by course/i }).textContent).toContain("Microcontrollers");
    expect(screen.queryByText("Homework 4: Pipelining Hazards")).toBeNull();
  });
});

describe("keyboard navigation", () => {
  it("moves between tabs with arrow keys and toggles sections and rows from the keyboard", async () => {
    const user = userEvent.setup();
    const { dashboard } = await demoDashboard();
    const props = baseProps({ dashboard });
    render(<MissionControl {...props} />);
    const focusTab = screen.getByRole("tab", { name: "Focus" });
    focusTab.focus();
    await user.keyboard("{ArrowRight}");
    expect((props.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ activeTab: "week" });

    const overdue = screen.getByRole("button", { name: /^Overdue/ });
    overdue.focus();
    await user.keyboard("{Enter}");
    expect((props.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ collapsedSections: ["overdue"] });

    const expand = screen.getAllByRole("button", { name: /show details for/i })[0] as HTMLButtonElement;
    expand.focus();
    await user.keyboard("{Enter}");
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: /show breakdown/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /show breakdown/i }));
    expect(screen.getByText(/total \(rounded, 0 to 100\)/i)).toBeTruthy();
  });

  it("renders the week view with seven days and item popovers", async () => {
    const user = userEvent.setup();
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "week" } })} />);
    expect(screen.getByRole("list", { name: /next seven days/i }).children).toHaveLength(7);
    const chip = screen.getAllByRole("button", { name: /Lab 3: Timer Interrupts/ })[0] as HTMLButtonElement;
    await user.click(chip);
    expect(screen.getByRole("dialog")).toHaveProperty("textContent", expect.stringContaining("Suggested priority"));
  });
});

describe("changes feed", () => {
  it("shows the unread count, old and new deadlines, and read controls", async () => {
    const { dashboard } = await demoDashboard({ withChanges: true });
    const props = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" } });
    render(<MissionControl {...props} />);
    expect(screen.getByRole("tab", { name: /changes/i }).textContent).toContain(String(dashboard.counts.unread));
    expect(dashboard.counts.unread).toBeGreaterThan(0);
    const moved = screen.getByRole("listitem", { name: /Moved: Lab 3: Timer Interrupts/ });
    expect(moved.querySelector(".old")?.textContent).toMatch(/\d/);
    expect(moved.querySelector(".new")?.textContent).toMatch(/\d/);
    expect(within(moved).getByText(/detected/i)).toBeTruthy();
    fireEvent.click(within(moved).getByRole("button", { name: /mark "lab 3: timer interrupts" as read/i }));
    const calls = (props.actions as ReturnType<typeof actions>).calls;
    expect(calls.setEventRead?.[0]?.[1]).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /mark all read/i }));
    expect(calls.markAllRead).toHaveLength(1);
    expect(screen.getByRole("listitem", { name: /Submitted: Homework 4/ })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: /Added: Quiz 3/ })).toBeTruthy();
    expect(screen.getByRole("listitem", { name: /Posted: Lab 3 deadline extended/ })).toBeTruthy();
  });

  it("hides the badge and disables mark-all-read when everything is read", async () => {
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    const read = events.map((event) => ({ ...event, readAt: NOW.toISOString() }));
    const readDashboard = { ...dashboard, counts: { ...dashboard.counts, unread: 0 }, changes: { today: read, yesterday: [], earlier: [] } };
    render(<MissionControl {...baseProps({ dashboard: readDashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" } })} />);
    expect(screen.getByRole("tab", { name: /changes/i }).querySelector(".count-pill")).toBeNull();
    expect((screen.getByRole("button", { name: /mark all read/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains the baseline when the first sync produced no events", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" } })} />);
    expect(screen.getByText(/baseline captured/i)).toBeTruthy();
  });
});

describe("safe links", () => {
  it("only opens tenant links and falls back to the course home otherwise", async () => {
    const { dashboard } = await demoDashboard();
    const next = dashboard.nextMove as NonNullable<typeof dashboard.nextMove>;
    const poisoned = { ...dashboard, nextMove: { ...next, item: { ...next.item, url: "https://phish.example/d2l/lms/x" } } };
    const props = baseProps({ dashboard: poisoned });
    render(<MissionControl {...props} />);
    expect(screen.queryByRole("button", { name: /open in brightspace/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^open course$/i }));
    const calls = (props.actions as ReturnType<typeof actions>).calls;
    expect(String(calls.openUrl?.[0]?.[0])).toMatch(new RegExp(`^${TENANT}/d2l/home/`));
    cleanup();

    const safeProps = baseProps({ dashboard });
    render(<MissionControl {...safeProps} />);
    fireEvent.click(screen.getByRole("button", { name: /open in brightspace/i }));
    expect(String((safeProps.actions as ReturnType<typeof actions>).calls.openUrl?.[0]?.[0])).toBe(next.item.url);
  });

  it("marks the aria-live region for sync announcements", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, announcement: "Refresh complete. 3 new changes." })} />);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Refresh complete. 3 new changes.");
  });
});

describe("theme", () => {
  it("defaults to light, applies the preference to the document root, and switches on request", async () => {
    const { dashboard } = await demoDashboard();
    const p = baseProps({ dashboard });
    const { unmount } = render(<MissionControl {...p} />);
    expect(document.documentElement.dataset.theme).toBe("light");
    const dark = screen.getByRole("button", { name: /dark theme/i });
    expect(dark.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(dark);
    expect((p.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ theme: "dark" });
    unmount();

    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, theme: "dark" } })} />);
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: /dark theme/i }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("collapse all", () => {
  it("collapses every section at once, then offers to expand them all", async () => {
    const { dashboard } = await demoDashboard();
    const p = baseProps({ dashboard });
    const { unmount } = render(<MissionControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /collapse all sections/i }));
    expect((p.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({
      collapsedSections: ["overdue", "today", "tomorrow", "this-week", "later", "completed"],
    });
    unmount();

    const all = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, collapsedSections: ["overdue", "today", "tomorrow", "this-week", "later", "completed"] } });
    render(<MissionControl {...all} />);
    expect(screen.queryByRole("button", { name: /show details for Lab 2/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand all sections/i }));
    expect((all.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ collapsedSections: [] });
  });
});
