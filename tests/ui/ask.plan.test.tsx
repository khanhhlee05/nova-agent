// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { ScriptedModel, compactSnapshot, demoRouter, executeTool } from "@nova-agent/agent";
import type { AskEvent, ToolRow } from "@nova-agent/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { ASK_SETTINGS_PREFERENCE, LocalAskClient, followUpQuestions, formatDuration, localDay, planDrafts, type AskSettings } from "../../apps/extension/src/sidepanel/ask";
import { MissionControl } from "../../apps/extension/src/sidepanel/MissionControl";
import type { PersonalDeadline } from "../../apps/extension/src/sidepanel/model";
import { createNovaDb, type NovaDb, type PersonalItemRecord } from "../../apps/extension/src/storage/novaDb";
import { MAX_PERSONAL_ITEMS, deletePlanItems, getSyncStatus, listPersonalItems, putPersonalItem, replacePlanItems, setPreference } from "../../apps/extension/src/storage/repositories";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { askProps, baseProps, eventsClient, type TrackedActions } from "../helpers/askHarness";
import { NOW, demoDashboard } from "../helpers/demoDashboard";

let db: NovaDb | null = null;

afterEach(async () => {
  cleanup();
  await db?.delete();
  db = null;
});

const LONG = { timeout: 10_000 };
const SCOPE = "https://brightspace.villanova.edu|2001";

const ask = (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /send question/i }));
};

const answer = (rows: ToolRow[], name: "build_study_plan" | "get_course_load", summary: string): AskEvent[] => [
  { type: "tool_call", id: "c1", name, input: { days: 3 } },
  { type: "tool_result", id: "c1", name, ok: true, summary, rows },
  { type: "text", delta: "Here is the plan." },
  { type: "done", model: "fake", usage: null, rounds: 2, grounded: true, corrected: false },
];

const demoPlan = async () => {
  const { dashboard, events, snapshot } = await demoDashboard({ withChanges: true });
  const compact = compactSnapshot(snapshot, events, NOW, { mode: "live" });
  const result = executeTool("build_study_plan", { days: 3 }, { snapshot: compact });
  if (!result.ok) throw new Error(result.error);
  return { dashboard, events, compact, result, days: result.rows as Extract<ToolRow, { kind: "plan-day" }>[] };
};

describe("the plan card", () => {
  it("shows every day and slot open, with estimates labeled, and no matching-items toggle for plan rows", async () => {
    const { dashboard, events, result, days } = await demoPlan();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(eventsClient(answer(result.rows, "build_study_plan", result.summary)), events, { personal: [] }) })} />);
    ask("Plan my next three days");
    const card = await screen.findByRole("region", { name: /study plan/i });
    expect(within(card).getByText("3 days · 2 h a day")).toBeTruthy();
    expect(within(card).getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent?.slice(0, 5))).toEqual(["Today", "WedSe", "ThuSe"]);
    const slots = days.flatMap((day) => day.slots);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) expect(within(card).getAllByText(slot.title).length).toBeGreaterThan(0);
    expect(within(card).getAllByText(slots[0]?.reason ?? "").length).toBeGreaterThan(0);
    expect(within(card).getByText(/times are nova's estimates/i)).toBeTruthy();
    expect(screen.getByText(`Built a study plan: ${result.summary.replace(/\.$/, "")}`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /matching item/i })).toBeNull();
    // Follow-ups come from the lookup: a three-day plan offers the week.
    expect(within(screen.getByRole("group", { name: /follow-up questions/i })).getByRole("button", { name: "Plan the next 7 days" })).toBeTruthy();
    expect(followUpQuestions([{ id: "t", name: "build_study_plan", status: "ok", summary: null, rows: 7, input: { days: 7 } }])).toEqual(["What should I start first?"]);
  });

  it("adds the plan to the Week tab through one action, one deadline per slot, and offers removal once it is there", async () => {
    const { dashboard, events, result, days } = await demoPlan();
    const client = eventsClient(answer(result.rows, "build_study_plan", result.summary));
    const state = askProps(client, events, { personal: [] });
    const props = baseProps({ dashboard, ask: state });
    const calls = (props.actions as TrackedActions).calls;
    const view = render(<MissionControl {...props} />);
    ask("Plan my next three days");
    const card = await screen.findByRole("region", { name: /study plan/i });
    fireEvent.click(within(card).getByRole("button", { name: /add to week/i }));
    const planId = days[0]?.planId as string;
    const drafts = planDrafts(days, (courseId) => dashboard.courseById.has(courseId));
    expect(calls.addPlanToWeek).toEqual([[planId, drafts]]);
    expect(drafts).toHaveLength(days.reduce((sum, day) => sum + day.slots.length, 0));
    expect(drafts.every((draft) => draft.title.startsWith("Work on: ") && draft.title.length <= 120 && draft.id.startsWith(`personal-${planId}-`))).toBe(true);
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(drafts.length);
    // Once the deadlines exist, the card says so and offers removal instead.
    const onWeek: PersonalDeadline[] = drafts.map((draft) => ({ ...draft, completedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), planId }));
    view.rerender(<MissionControl {...baseProps({ dashboard, actions: props.actions, ask: { ...state, personal: onWeek } })} />);
    expect(within(card).getByText("On your Week tab")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /add to week/i })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /remove from week/i }));
    expect(calls.removePlanFromWeek).toEqual([[planId]]);
  });

  it("offers nothing to add for an empty plan, and nothing at all without the actions", async () => {
    const { dashboard, events } = await demoDashboard();
    const empty: ToolRow[] = [{ kind: "plan-day", id: "plan-x:2026-09-08", planId: "plan-x", title: "Tue, Sep 8", date: "2026-09-08", totalMinutes: 0, capacityMinutes: 120, slots: [] }];
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(eventsClient(answer(empty, "build_study_plan", "Nothing open to plan.")), events) })} />);
    ask("Plan today");
    const card = await screen.findByRole("region", { name: /study plan/i });
    expect(within(card).getByText("Nothing planned.")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /add to week/i })).toBeNull();
  });

  it("places each slot at 11:59 PM of its day, or at the item's own deadline when that is earlier the same day", () => {
    const slot = (title: string, dueAt: string | null) => ({ itemId: "a1", title, courseId: "31001", courseName: "Microcontrollers", minutes: 60, reason: "r", dueAt, url: null });
    const day = { kind: "plan-day" as const, id: "p:2026-09-10", planId: "p", title: "Thu, Sep 10", date: "2026-09-10", totalMinutes: 180, capacityMinutes: 180, slots: [slot("Due that afternoon", "2026-09-10T21:00:00.000Z"), slot("Due another day", "2026-09-12T03:59:00.000Z"), slot("x".repeat(200), null)] };
    const drafts = planDrafts([day], (courseId) => courseId === "nope");
    expect(drafts.map((draft) => draft.dueAt)).toEqual(["2026-09-10T21:00:00.000Z", "2026-09-11T03:59:00.000Z", "2026-09-11T03:59:00.000Z"]);
    expect(drafts.map((draft) => draft.id)).toEqual(["personal-p-2026-09-10-0", "personal-p-2026-09-10-1", "personal-p-2026-09-10-2"]);
    expect(drafts[2]?.title).toHaveLength(120);
    expect(drafts[2]?.title.endsWith("…")).toBe(true);
    // A course the panel does not know is dropped, not guessed.
    expect(drafts.every((draft) => draft.courseId === null)).toBe(true);
    expect(planDrafts([day], () => true)[0]?.courseId).toBe("31001");
    expect(localDay("2026-09-10").getDate()).toBe(10);
    expect([formatDuration(45), formatDuration(60), formatDuration(90), formatDuration(125)]).toEqual(["45 min", "1 h", "1 h 30 min", "2 h 5 min"]);
  });
});

describe("course rows", () => {
  it("lists each course with its load and filters the Focus tab to one", async () => {
    const { dashboard, events, compact } = await demoPlan();
    const load = executeTool("get_course_load", {}, { snapshot: compact });
    if (!load.ok) throw new Error(load.error);
    const props = baseProps({ dashboard, ask: askProps(eventsClient(answer(load.rows, "get_course_load", load.summary)), events) });
    render(<MissionControl {...props} />);
    ask("Which course needs the most attention?");
    await screen.findByText(`Compared your courses: ${load.summary.replace(/\.$/, "")}`);
    fireEvent.click(screen.getByRole("button", { name: `Show ${load.rows.length} matching items` }));
    const list = screen.getByRole("list", { name: /matching items/i });
    const first = load.rows[0] as Extract<ToolRow, { kind: "course" }>;
    expect(within(list).getAllByRole("listitem").map((row) => row.querySelector(".task-title")?.textContent)).toEqual(load.rows.map((row) => row.title));
    expect(within(list).getAllByText(`${first.open} open ${first.open === 1 ? "item" : "items"}`).length).toBeGreaterThan(0);
    fireEvent.click(within(list).getByRole("button", { name: `Show ${first.title} on the Focus tab` }));
    expect((props.actions as TrackedActions).calls.setPreferences?.at(-1)).toEqual([{ activeTab: "focus", courseFilter: first.courseId }]);
    expect(within(list).getByRole("button", { name: `Open ${first.title} in Brightspace` })).toBeTruthy();
  });
});

describe("plan storage", () => {
  const record = (id: string, overrides: Partial<PersonalItemRecord> = {}): PersonalItemRecord => ({ id, scope: SCOPE, title: id, dueAt: NOW.toISOString(), courseId: null, completedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...overrides });

  it("replaces an earlier plan, keeps what the student typed in, and removes one plan on request", async () => {
    db = createNovaDb(`plans-${Date.now()}`);
    await putPersonalItem(db, record("typed-1"));
    await replacePlanItems(db, SCOPE, [record("a1", { planId: "plan-a" }), record("a2", { planId: "plan-a" })]);
    expect((await listPersonalItems(db, SCOPE)).map((item) => item.id).sort()).toEqual(["a1", "a2", "typed-1"]);
    await replacePlanItems(db, SCOPE, [record("b1", { planId: "plan-b" })]);
    expect((await listPersonalItems(db, SCOPE)).map((item) => item.id).sort()).toEqual(["b1", "typed-1"]);
    await replacePlanItems(db, "other|scope", [record("o1", { planId: "plan-o", scope: "other|scope" })]);
    expect(await deletePlanItems(db, SCOPE, "plan-a")).toBe(0);
    expect(await deletePlanItems(db, SCOPE, "plan-b")).toBe(1);
    expect((await listPersonalItems(db, SCOPE)).map((item) => item.id)).toEqual(["typed-1"]);
    expect(await listPersonalItems(db, "other|scope")).toHaveLength(1);
  });

  it("changes nothing when the plan would pass the cap", async () => {
    db = createNovaDb(`plans-${Date.now()}`);
    await db.personalItems.bulkPut(Array.from({ length: MAX_PERSONAL_ITEMS - 1 }, (_, i) => record(`typed-${i}`)));
    await replacePlanItems(db, SCOPE, [record("a1", { planId: "plan-a" })]);
    await expect(replacePlanItems(db, SCOPE, [record("b1", { planId: "plan-b" }), record("b2", { planId: "plan-b" })])).rejects.toThrow(/at most 200/);
    const ids = (await listPersonalItems(db, SCOPE)).map((item) => item.id);
    expect(ids).toContain("a1");
    expect(ids).not.toContain("b1");
    expect(ids).toHaveLength(MAX_PERSONAL_ITEMS);
  });
});

describe("a plan from question to Week tab: end to end", () => {
  it("builds a plan, adds it to the Week tab as study plan entries, and removes it again", { timeout: 30_000 }, async () => {
    db = createNovaDb(`ask-plan-${Date.now()}`);
    await setPreference(db, ASK_SETTINGS_PREFERENCE, { enabled: true, apiBaseUrl: "http://localhost:8787", token: null } satisfies AskSettings);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    render(<App db={db} host={createStubHost()} now={() => NOW} transportFactory={factory} autoSync={false} askClientFactory={() => new LocalAskClient(new ScriptedModel(demoRouter))} />);
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await waitFor(async () => expect((await getSyncStatus(db as NovaDb)).lastSuccessfulSyncAt).toBe(NOW.toISOString()), LONG);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Ask" }, LONG));
    await screen.findByRole("textbox", { name: /ask nova a question/i }, LONG);
    ask("Plan my next three days");
    const card = await screen.findByRole("region", { name: /study plan/i }, LONG);
    const titles = [...card.querySelectorAll(".ask-plan-slot .task-title")].map((node) => node.textContent ?? "");
    expect(titles.length).toBeGreaterThan(0);
    fireEvent.click(within(card).getByRole("button", { name: /add to week/i }));
    await within(card).findByText("On your Week tab", {}, LONG);
    const scope = (await getSyncStatus(db)).scope as string;
    const stored = await listPersonalItems(db, scope);
    expect(stored).toHaveLength(titles.length);
    expect(stored.every((item) => item.planId?.startsWith("plan-2026-09-08-3d-120m-all") && item.title.startsWith("Work on: "))).toBe(true);
    expect(screen.getByText(new RegExp(`Added the plan to your Week tab: ${titles.length} `))).toBeTruthy();

    // The Week tab shows them as study plan entries, apart from Brightspace items and from hand-typed deadlines.
    await user.click(screen.getByRole("tab", { name: /week/i }));
    const entries = await screen.findAllByRole("button", { name: /, from your study plan, /i }, LONG);
    expect(entries.length).toBeGreaterThan(0);
    expect(within(entries[0] as HTMLElement).getByText("Study plan")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /, added by you, /i })).toBeNull();

    // Asking again for the same plan does not double it; removing clears every entry.
    await user.click(screen.getByRole("tab", { name: "Ask" }));
    // The tab switch lands through the stored preference, so the card is awaited, not assumed.
    fireEvent.click(within(await screen.findByRole("region", { name: /study plan/i }, LONG)).getByRole("button", { name: /remove from week/i }));
    await waitFor(async () => expect(await listPersonalItems(db as NovaDb, scope)).toHaveLength(0), LONG);
    await within(screen.getByRole("region", { name: /study plan/i })).findByRole("button", { name: /add to week/i }, LONG);
    expect(screen.getByText("Removed the plan from your Week tab.")).toBeTruthy();
  });
});
