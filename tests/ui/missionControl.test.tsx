// @vitest-environment jsdom
import "./setup";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_DISMISSALS } from "../../apps/extension/src/sidepanel/dismissals";
import { weekHero } from "../../apps/extension/src/sidepanel/heroes";
import { STATUS_LABELS, buildDashboard, isUpcoming, lastWeekOffset, weekPage } from "../../apps/extension/src/sidepanel/model";
import { DEFAULT_PREFERENCES, MissionControl, type MissionControlActions, type MissionControlProps } from "../../apps/extension/src/sidepanel/MissionControl";
import { INITIAL_SYNC_STATUS } from "../../apps/extension/src/storage/repositories";
import { IDLE_STATE } from "../../apps/extension/src/sync/syncState";
import { NOW, TENANT, demoDashboard } from "../helpers/demoDashboard";
import { makeCourse, makeItem, makeSnapshot } from "../helpers/factories";

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
    setLocalDone: track("setLocalDone"),
    deleteEvent: track("deleteEvent"),
    dismissBanner: track("dismissBanner"),
    restoreDismissed: track("restoreDismissed"),
  };
};

const baseProps = (overrides: Partial<MissionControlProps> = {}): MissionControlProps => ({
  dashboard: null,
  status: { ...INITIAL_SYNC_STATUS, mode: "live", phase: "ready", scope: `${TENANT}|2001`, lastSuccessfulSyncAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), lastAttemptedSyncAt: NOW.toISOString(), lastOutcome: "ready" },
  runtime: IDLE_STATE,
  feasibility: null,
  preferences: { ...DEFAULT_PREFERENCES },
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
    expect(screen.getByRole("status", { name: /^refreshing\. no successful refresh yet/i })).toBeTruthy();
    expect((screen.getByRole("button", { name: /refresh now/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("labels demo data clearly and never as live", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, mode: "fixture" } })} />);
    expect(screen.getByRole("status", { name: /^demo data, not your brightspace/i })).toBeTruthy();
    expect(screen.getByText(/these courses are fictional/i)).toBeTruthy();
    expect(screen.queryByText(/^Live$/)).toBeNull();
  });

  it("renders the ready state with counts, next move, and categories", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard })} />);
    expect(screen.getByRole("status", { name: /^live brightspace data\. last successful refresh/i })).toBeTruthy();
    expect(screen.getByText(/live · 4m ago/i)).toBeTruthy();
    const summary = screen.getByRole("group", { name: /workload summary/i });
    expect(within(summary).getByText("Overdue").previousSibling?.textContent).toBe(String(dashboard.counts.overdue));
    expect(within(summary).getByText("This week").previousSibling?.textContent).toBe(String(dashboard.counts.thisWeek));
    expect(within(summary).getByText("New changes").previousSibling?.textContent).toBe(String(dashboard.counts.unread));
    expect(screen.getByRole("heading", { level: 2, name: dashboard.nextMove?.item.title as string })).toBeTruthy();
    expect(screen.getAllByText(/why this first\?/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/AI priority/i)).toBeNull();
    const categories = screen.getByRole("radiogroup", { name: /^category$/i });
    expect(within(categories).getByRole("radio", { name: new RegExp(`^Overdue, ${dashboard.buckets.overdue.length} items?`) })).toBeTruthy();
    expect(within(categories).getByRole("radio", { name: new RegExp(`^Completed, ${dashboard.buckets.completed.length} items?`) })).toBeTruthy();
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
    expect(screen.getByText(/you're all caught up/i)).toBeTruthy();
  });
});

describe("trustworthy state and focus", () => {
  it("shows a broken connection on every tab and never offers to hide it", async () => {
    const { dashboard } = await demoDashboard();
    const status = { ...baseProps().status, phase: "session-expired" as const, error: { kind: "session-expired" as const } };
    for (const activeTab of ["focus", "week", "changes"] as const) {
      render(<MissionControl {...baseProps({ dashboard, status, preferences: { ...DEFAULT_PREFERENCES, activeTab } })} />);
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("Brightspace session expired");
      expect(within(alert).queryByRole("button", { name: /hide/i })).toBeNull();
      cleanup();
    }
    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, phase: "offline", error: { kind: "network", retryable: true, operation: "fetch" } } })} />);
    expect(within(screen.getByRole("alert")).queryByRole("button", { name: /hide/i })).toBeNull();
  });

  it("never shows demo data as freshly refreshed when the last refresh failed", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, status: { ...baseProps().status, mode: "fixture", phase: "failed", lastSuccessfulSyncAt: NOW.toISOString() } })} />);
    const fresh = screen.getByRole("status", { name: /^demo data\. the last refresh failed/i });
    expect(fresh.textContent).toBe("Demo · Refresh failed");
  });

  it("offers a skip link and keeps the kind icon out of the tab order", async () => {
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard })} />);
    const skip = screen.getByRole("link", { name: /skip to content/i });
    fireEvent.click(skip);
    expect(document.activeElement?.id).toBe("panel-main");
    expect(document.querySelectorAll(".kind-chip[tabindex]")).toHaveLength(0);
  });
});

describe("one definition of this week", () => {
  it("gives the counts strip, the sections, and the Week headline the same seven-day number", async () => {
    const { dashboard } = await demoDashboard({ withChanges: true });
    const { buckets, counts } = dashboard;
    const upcomingOnWeekTab = dashboard.week.flatMap((day) => day.entries).filter((entry) => isUpcoming(entry.bucket)).length;
    expect(counts.thisWeek).toBe(buckets.today.length + buckets.tomorrow.length + buckets["this-week"].length);
    expect(upcomingOnWeekTab).toBe(counts.thisWeek);
    expect(weekHero(dashboard).title).toMatch(new RegExp(`^${["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][counts.thisWeek] ?? counts.thisWeek} deadlines?`, "i"));
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

    render(<MissionControl {...baseProps({ dashboard: one.dashboard, preferences: { ...DEFAULT_PREFERENCES, courseFilter: "31001" } })} />);
    expect(screen.getByRole("combobox", { name: /filter by course/i }).textContent).toContain("Microcontrollers");
    expect(screen.queryByText("Homework 4: Pipelining Hazards")).toBeNull();
  });
});

describe("keyboard navigation", () => {
  it("moves between tabs with arrow keys and switches categories and rows from the keyboard", async () => {
    const user = userEvent.setup();
    const { dashboard } = await demoDashboard();
    const props = baseProps({ dashboard });
    render(<MissionControl {...props} />);
    const focusTab = screen.getByRole("tab", { name: "Focus" });
    focusTab.focus();
    await user.keyboard("{ArrowRight}");
    expect((props.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ activeTab: "week" });

    const completed = screen.getByRole("radio", { name: /^Completed,/ });
    completed.focus();
    await user.keyboard("{Enter}");
    expect((props.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ focusCategory: "completed" });

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
    expect(screen.getByRole("dialog")).toHaveProperty("textContent", expect.stringContaining("Priority, out of 100"));
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

describe("focus categories", () => {
  it("opens on Overdue when anything is overdue, shows one category at a time, and remembers the pick", async () => {
    const { dashboard } = await demoDashboard();
    expect(dashboard.buckets.overdue.length).toBeGreaterThan(0);
    const overdueTitle = dashboard.buckets.overdue[0]?.title as string;
    const doneTitle = dashboard.buckets.completed[0]?.title as string;
    const p = baseProps({ dashboard });
    const { unmount } = render(<MissionControl {...p} />);
    expect(screen.getByRole("radio", { name: /^Overdue,/ }).getAttribute("aria-checked")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Overdue" })).getByText(overdueTitle)).toBeTruthy();
    expect(screen.queryByText(doneTitle)).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /^Upcoming,/ }));
    expect((p.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ focusCategory: "upcoming" });
    unmount();

    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "upcoming" } })} />);
    expect(screen.getByRole("radio", { name: /^Upcoming,/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("heading", { level: 3, name: /^Today/ })).toBeTruthy();
    expect(screen.queryAllByText(overdueTitle).filter((node) => node.closest(".task")).length).toBe(0);
    expect(screen.queryByRole("heading", { level: 3, name: /^Overdue/ })).toBeNull();
    cleanup();

    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "completed" } })} />);
    expect(screen.getByRole("list", { name: "Completed" })).toBeTruthy();
    expect(screen.getByText(doneTitle)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: new RegExp(`^${doneTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (submitted|completed) in Brightspace`) })).toHaveProperty("disabled", true);
  });

  it("drops the day groups when sorting by course and keeps the order inside one list", async () => {
    const { dashboard } = await demoDashboard();
    const p = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "upcoming", sort: "course" } });
    render(<MissionControl {...p} />);
    expect(screen.queryByRole("heading", { level: 3, name: /^Today/ })).toBeNull();
    const list = screen.getByRole("list", { name: "Upcoming" });
    const courses = within(list)
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".task-course")?.textContent ?? "");
    expect(courses).toEqual([...courses].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    fireEvent.click(screen.getByRole("combobox", { name: /sort by/i }));
    fireEvent.click(screen.getByRole("option", { name: /recently updated/i }));
    expect((p.actions as ReturnType<typeof actions>).calls.setPreferences?.at(-1)?.[0]).toEqual({ sort: "updated" });
  });

  it("jumps from the count strip to the Overdue category, the Week tab, and the Changes tab", async () => {
    const { dashboard } = await demoDashboard({ withChanges: true });
    const p = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "upcoming" } });
    render(<MissionControl {...p} />);
    const summary = screen.getByRole("group", { name: /workload summary/i });
    fireEvent.click(within(summary).getByRole("button", { name: /overdue/i }));
    fireEvent.click(within(summary).getByRole("button", { name: /this week/i }));
    fireEvent.click(within(summary).getByRole("button", { name: /new changes/i }));
    const calls = (p.actions as ReturnType<typeof actions>).calls.setPreferences ?? [];
    expect(calls.slice(-3).map((call) => call[0])).toEqual([{ activeTab: "focus", focusCategory: "overdue" }, { activeTab: "week" }, { activeTab: "changes" }]);
  });

  it("flags rows that appear in the change feed", async () => {
    const { dashboard } = await demoDashboard({ withChanges: true });
    const changedKey = [...dashboard.changedAt.keys()].find((key) => dashboard.buckets.overdue.some((item) => item.key === key) || dashboard.buckets.today.some((item) => item.key === key) || dashboard.buckets["this-week"].some((item) => item.key === key)) as string;
    const item = dashboard.itemByKey.get(changedKey) as NonNullable<ReturnType<typeof dashboard.itemByKey.get>>;
    const category = dashboard.buckets.overdue.some((entry) => entry.key === changedKey) ? "overdue" : "upcoming";
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: category } })} />);
    const row = screen.getByText(item.title).closest(".task") as HTMLElement;
    expect(within(row).getByText("Changed")).toBeTruthy();
  });
});

describe("local done marks", () => {
  it("offers a checkbox on open rows that asks for an on-device mark, never a Brightspace write", async () => {
    const { dashboard } = await demoDashboard();
    const p = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "upcoming" } });
    render(<MissionControl {...p} />);
    const open = dashboard.buckets.today[0] ?? dashboard.buckets["this-week"][0];
    const box = screen.getByRole("checkbox", { name: `Mark "${open?.title}" done on this device` }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect((p.actions as ReturnType<typeof actions>).calls.setLocalDone?.[0]).toEqual([open?.key, open?.title, true]);
  });

  it("moves a marked item to Completed, labels it as the student's own mark, and keeps it out of the counts and the hero", async () => {
    const { snapshot, events } = await demoDashboard();
    const base = buildDashboard({ snapshot, events, now: NOW, courseFilter: null });
    const top = base.nextMove?.item as NonNullable<typeof base.nextMove>["item"];
    const markedAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
    const dashboard = buildDashboard({ snapshot, events, now: NOW, courseFilter: null, localMarks: new Map([[top.key, markedAt]]) });
    expect(dashboard.nextMove?.item.key).not.toBe(top.key);
    expect(dashboard.buckets.completed.some((item) => item.key === top.key)).toBe(true);
    expect(dashboard.buckets.overdue.concat(dashboard.buckets.today, dashboard.buckets.tomorrow, dashboard.buckets["this-week"], dashboard.buckets.later).some((item) => item.key === top.key)).toBe(false);
    expect(dashboard.counts.overdue + dashboard.counts.thisWeek).toBeLessThanOrEqual(base.counts.overdue + base.counts.thisWeek);
    expect(dashboard.week.flatMap((day) => day.entries).find((entry) => entry.item.key === top.key)?.bucket ?? "completed").toBe("completed");

    const p = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "completed" } });
    render(<MissionControl {...p} />);
    const row = screen.getByText(top.title).closest(".task") as HTMLElement;
    expect(within(row).getByText("Marked done by you")).toBeTruthy();
    const box = within(row).getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(false);
    fireEvent.click(box);
    expect((p.actions as ReturnType<typeof actions>).calls.setLocalDone?.[0]).toEqual([top.key, top.title, false]);
    fireEvent.click(within(row).getByRole("button", { name: /show details for/i }));
    expect(within(row).getByText(/Brightspace still lists it as open/)).toBeTruthy();
    expect(within(row).getByText(STATUS_LABELS[top.status])).toBeTruthy();
  });
});

describe("long overdue", () => {
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  const course = makeCourse("c1", { name: "Ethics" });
  const recent = makeItem({ sourceId: "recent", courseId: "c1", title: "Recent lab", dueAt: daysAgo(3), pointsPossible: 10 });
  const edge = makeItem({ sourceId: "edge", courseId: "c1", title: "Edge case", dueAt: daysAgo(13.9), pointsPossible: 10 });
  const stale = makeItem({ sourceId: "stale", courseId: "c1", title: "Forgotten reading response", dueAt: daysAgo(40), pointsPossible: 100 });
  const older = makeItem({ sourceId: "older", courseId: "c1", title: "Ancient quiz", kind: "quiz", dueAt: daysAgo(70), status: "unknown" });
  const soon = makeItem({ sourceId: "soon", courseId: "c1", title: "Due tonight", dueAt: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(), pointsPossible: 10 });
  const build = (items: ReturnType<typeof makeItem>[]) => buildDashboard({ snapshot: makeSnapshot(NOW.toISOString(), items, { courses: [course] }), events: [], now: NOW, courseFilter: null });

  it("splits the overdue bucket at two weeks, counts only the recent ones, and never ranks an old item first", () => {
    const dashboard = build([recent, edge, stale, older, soon]);
    expect(dashboard.buckets.overdue.map((item) => item.title)).toEqual(["Edge case", "Recent lab"]);
    expect(dashboard.longOverdue.map((item) => item.title)).toEqual(["Ancient quiz", "Forgotten reading response"]);
    expect(dashboard.counts.overdue).toBe(2);
    expect(dashboard.nextMove?.item.title).not.toBe("Forgotten reading response");
    expect(dashboard.ranked.has(stale.key)).toBe(false);
    expect(dashboard.ranked.has(recent.key)).toBe(true);
  });

  it("folds old items away under Overdue until asked for, then lists them with their own heading", async () => {
    const dashboard = build([recent, stale, older, soon]);
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "overdue" } })} />);
    expect(screen.getByRole("radio", { name: /^Overdue, 1 item$/ })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: /workload summary/i })).getByText("Overdue").previousSibling?.textContent).toBe("1");
    expect(within(screen.getByRole("list", { name: "Overdue" })).getByText("Recent lab")).toBeTruthy();
    expect(screen.queryByText("Forgotten reading response")).toBeNull();

    const fold = screen.getByRole("button", { name: /show 2 long overdue items/i });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(screen.getByRole("heading", { level: 3, name: /^Long overdue/ })).toBeTruthy();
    expect(screen.getByText(/often closed or no longer tracked by the instructor/i)).toBeTruthy();
    const group = screen.getByRole("heading", { level: 3, name: /^Long overdue/ }).closest(".group") as HTMLElement;
    expect(within(group).getAllByRole("listitem").map((row) => row.querySelector(".task-title")?.textContent)).toEqual(["Ancient quiz", "Forgotten reading response"]);
    expect(within(group).getByText(/Overdue · 1 month ago/)).toBeTruthy();
    expect(within(group).getByRole("checkbox", { name: `Mark "Forgotten reading response" done on this device` })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /hide long overdue/i }));
    expect(screen.queryByText("Forgotten reading response")).toBeNull();
  });

  it("says so when the only overdue items are old ones", async () => {
    const dashboard = build([stale, soon]);
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, focusCategory: "overdue" } })} />);
    expect(screen.getByText(/nothing overdue in the last two weeks/i)).toBeTruthy();
    expect(screen.getByText(/1 older item is hidden/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /show 1 long overdue item/i }));
    expect(screen.getByText("Forgotten reading response")).toBeTruthy();
  });

  it("opens on Upcoming when the only overdue items are old ones", () => {
    const dashboard = build([stale, soon]);
    render(<MissionControl {...baseProps({ dashboard })} />);
    expect(screen.getByRole("radio", { name: /^Upcoming,/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "Due tonight" })).toBeTruthy();
  });
});

describe("week paging", () => {
  it("builds later pages from the same items, forward only, up to the last known deadline", async () => {
    const { dashboard } = await demoDashboard();
    const page0 = weekPage(dashboard, NOW, 0);
    expect(page0.days).toBe(dashboard.week);
    const page1 = weekPage(dashboard, NOW, 1);
    expect(page1.days).toHaveLength(7);
    expect(page1.days[0]?.date.getTime()).toBe(dashboard.week[6]!.date.getTime() + 86_400_000);
    expect(page1.days.every((day) => !day.isToday)).toBe(true);
    const onPage1 = page1.days.flatMap((day) => day.entries.map((entry) => entry.item.title));
    expect(onPage1).toContain("Problem Set 7: Sampling");
    expect(page1.days.flatMap((day) => day.entries).every((entry) => entry.bucket === "later")).toBe(true);
    const last = lastWeekOffset(dashboard, NOW);
    expect(last).toBeGreaterThanOrEqual(2);
    expect(weekPage(dashboard, NOW, last).days.flatMap((day) => day.entries).length).toBeGreaterThan(0);
    expect(weekPage(dashboard, NOW, last + 1).days.flatMap((day) => day.entries)).toHaveLength(0);
  });

  it("pages with the arrows, disables forward at the last deadline, clears the picked day, and returns with Today", async () => {
    const { dashboard } = await demoDashboard();
    const p = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "week" } });
    render(<MissionControl {...p} />);
    const previous = () => screen.getByRole("button", { name: /previous 7 days/i }) as HTMLButtonElement;
    const next = () => screen.getByRole("button", { name: /^next 7 days$/i }) as HTMLButtonElement;
    expect(previous().disabled).toBe(true);
    expect(next().disabled).toBe(false);
    expect(screen.getByText(/^Sep 8 to Sep 14/)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/deadlines?/i);

    // Pick a day, then page: the selection does not carry over.
    fireEvent.click(screen.getByRole("button", { name: /^Wednesday, September 9/ }));
    expect(screen.getByRole("button", { name: /show all days/i })).toBeTruthy();
    fireEvent.click(next());
    expect(screen.queryByRole("button", { name: /show all days/i })).toBeNull();
    expect(screen.getByText(/^Sep 15 to Sep 21/)).toBeTruthy();
    expect(screen.getAllByText(/1 week ahead/).length).toBeGreaterThan(0);
    expect(previous().disabled).toBe(false);
    expect(screen.getByRole("list", { name: /seven days starting September 15/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Problem Set 7: Sampling/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 3, name: /^Today/ })).toBeNull();

    // Forward until the last deadline, then the arrow is disabled with a reason.
    const last = lastWeekOffset(dashboard, NOW);
    for (let offset = 1; offset < last; offset++) fireEvent.click(next());
    expect(next().disabled).toBe(true);
    expect(screen.getAllByText(new RegExp(`${last} weeks ahead`)).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Today$/ }));
    expect(screen.getByText(/^Sep 8 to Sep 14/)).toBeTruthy();
    expect(previous().disabled).toBe(true);
  });

  it("writes the hero for a later page from that page's items", async () => {
    const { dashboard } = await demoDashboard();
    const page1 = weekPage(dashboard, NOW, 1);
    const hero = weekHero(dashboard, null, page1);
    expect(hero.meta).toBe("1 week ahead · Sep 15 to Sep 21");
    const open = page1.days.flatMap((day) => day.entries).filter((entry) => entry.bucket !== "completed").length;
    expect(hero.title).toMatch(new RegExp(`^${["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][open] ?? open} deadlines?`, "i"));
    const empty = weekHero(dashboard, null, weekPage(dashboard, NOW, lastWeekOffset(dashboard, NOW) + 1));
    expect(empty.title).toMatch(/^Nothing due /);
    expect(weekHero(dashboard, null, weekPage(dashboard, NOW, 0))).toEqual(weekHero(dashboard));
  });
});

describe("week day filter", () => {
  it("shows one day when a day is picked and the whole week by default", async () => {
    const user = userEvent.setup();
    const { dashboard } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "week" } })} />);
    const before = screen.getAllByRole("heading", { level: 3 }).filter((h) => h.className.includes("agenda-day-label")).length;
    expect(before).toBe(7);

    // Nothing selected: today is marked but nobody wears the selected pill.
    const today = screen.getByRole("button", { name: /^Tuesday, September 8/ });
    expect(today.getAttribute("data-today")).toBe("true");
    expect(today.getAttribute("data-selected")).toBe("false");

    await user.click(screen.getByRole("button", { name: /^Thursday, September 10/ }));
    expect(screen.getByRole("button", { name: /^Thursday, September 10/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Thursday, September 10/ }).getAttribute("data-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /^Tuesday, September 8/ }).getAttribute("data-selected")).toBe("false");
    expect(screen.getAllByRole("heading", { level: 3 }).filter((h) => h.className.includes("agenda-day-label"))).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toMatch(/^Thursday: /);
    expect(screen.getByText("MATLAB Lab: Filters")).toBeTruthy();
    expect(screen.queryByText("Lab 3: Timer Interrupts")).toBeNull();
    expect(screen.queryByText("Problem Set 6: Fourier Series")).toBeNull();

    await user.click(screen.getByRole("button", { name: /show all days/i }));
    expect(screen.getAllByRole("heading", { level: 3 }).filter((h) => h.className.includes("agenda-day-label"))).toHaveLength(7);

    await user.click(screen.getByRole("button", { name: /^Thursday, September 10/ }));
    await user.click(screen.getByRole("button", { name: /^Thursday, September 10.*selected/ }));
    expect(screen.getAllByRole("heading", { level: 3 }).filter((h) => h.className.includes("agenda-day-label"))).toHaveLength(7);
  });
});
