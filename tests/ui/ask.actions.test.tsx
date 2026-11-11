// @vitest-environment jsdom
import "./setup";
import { compactSnapshot, executeTool, shortId } from "@nova-agent/agent";
import type { AskEvent, ToolRow } from "@nova-agent/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { dataQuestion, followUpQuestions, suggestedQuestions } from "../../apps/extension/src/sidepanel/ask/AskChips";
import type { AskTool } from "../../apps/extension/src/sidepanel/ask/useAskThread";
import { DEFAULT_PREFERENCES, MissionControl } from "../../apps/extension/src/sidepanel/MissionControl";
import { buildDashboard, type PersonalDeadline } from "../../apps/extension/src/sidepanel/model";
import { askProps, baseProps, eventsClient, scriptedClient, spyClient, trackedActions, type TrackedActions } from "../helpers/askHarness";
import { NOW, demoDashboard } from "../helpers/demoDashboard";

afterEach(cleanup);

const ask = (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /send question/i }));
};

const rowsAnswer = (rows: ToolRow[], name: "list_deadlines" | "get_changes" = "list_deadlines"): AskEvent[] => [
  { type: "tool_call", id: "c1", name, input: {} },
  { type: "tool_result", id: "c1", name, ok: true, summary: `${rows.length} rows.`, rows },
  { type: "text", delta: "Here they are." },
  { type: "done", model: "fake", usage: null, rounds: 2, grounded: true, corrected: false },
];

const personal = (overrides: Partial<PersonalDeadline> = {}): PersonalDeadline => ({ id: "personal-1", title: "Email lab partner", dueAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), courseId: null, completedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...overrides });

describe("rows under an answer carry the controls of the tab they came from", () => {
  it("marks an item done and hides it through the same handlers as the Focus tab", async () => {
    const { dashboard, events, snapshot } = await demoDashboard({ withChanges: true });
    const compact = compactSnapshot(snapshot, events, NOW, { mode: "live" });
    const week = executeTool("list_deadlines", {}, { snapshot: compact });
    if (!week.ok) throw new Error(week.error);
    const lab3 = snapshot.items.find((item) => item.title === "Lab 3: Timer Interrupts");
    if (!lab3) throw new Error("fixture changed");
    const props = baseProps({ dashboard, ask: askProps(eventsClient(rowsAnswer(week.rows)), events, { localMarks: new Map(), personal: [] }) });
    const calls = (props.actions as TrackedActions).calls;
    render(<MissionControl {...props} />);
    ask("What is due this week?");
    fireEvent.click(await screen.findByRole("button", { name: `Show ${week.rows.length} matching items` }));
    const list = screen.getByRole("list", { name: /matching items/i });
    const box = within(list).getByRole("checkbox", { name: 'Mark "Lab 3: Timer Interrupts" done on this device' }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(calls.setLocalDone).toEqual([[lab3.key, "Lab 3: Timer Interrupts", true]]);
    fireEvent.click(within(list).getByRole("button", { name: 'Hide "Lab 3: Timer Interrupts" until next refresh' }));
    expect(calls.dismissItem).toEqual([[lab3.key, "Lab 3: Timer Interrupts"]]);
    // Opening still works beside the new controls.
    expect(within(list).getByRole("button", { name: "Open Lab 3: Timer Interrupts in Brightspace" })).toBeTruthy();
  });

  it("shows a mark or a hide made after the answer, because rows read live state", async () => {
    const { dashboard, events, snapshot } = await demoDashboard({ withChanges: true });
    const compact = compactSnapshot(snapshot, events, NOW, { mode: "live" });
    const week = executeTool("list_deadlines", {}, { snapshot: compact });
    if (!week.ok) throw new Error(week.error);
    const lab3 = snapshot.items.find((item) => item.title === "Lab 3: Timer Interrupts");
    const pset = snapshot.items.find((item) => item.title === "Problem Set 6: Fourier Series");
    if (!lab3 || !pset) throw new Error("fixture changed");
    const client = eventsClient(rowsAnswer(week.rows));
    const first = askProps(client, events, { localMarks: new Map(), personal: [] });
    const actions = trackedActions();
    const { rerender } = render(<MissionControl {...baseProps({ dashboard, actions, ask: first })} />);
    ask("What is due this week?");
    fireEvent.click(await screen.findByRole("button", { name: `Show ${week.rows.length} matching items` }));
    expect(screen.queryByText("Marked done by you")).toBeNull();
    rerender(<MissionControl {...baseProps({ dashboard, actions, dismissals: { items: new Set([pset.key]), banners: new Set() }, ask: { ...first, localMarks: new Map([[lab3.key, NOW.toISOString()]]) } })} />);
    const list = screen.getByRole("list", { name: /matching items/i });
    const marked = within(list).getByRole("checkbox", { name: "Lab 3: Timer Interrupts: marked done by you. Uncheck to put it back." }) as HTMLInputElement;
    expect(marked.checked).toBe(true);
    expect(within(list).getByText("Marked done by you")).toBeTruthy();
    fireEvent.click(marked);
    expect(actions.calls.setLocalDone?.at(-1)).toEqual([lab3.key, "Lab 3: Timer Interrupts", false]);
    expect(within(list).getByText("Hidden until next refresh")).toBeTruthy();
    expect(within(list).queryByRole("button", { name: 'Hide "Problem Set 6: Fourier Series" until next refresh' })).toBeNull();
    expect(within(list).getByRole("button", { name: 'Hide "Lab 3: Timer Interrupts" until next refresh' })).toBeTruthy();
  });

  it("keeps a row read-only when its item is no longer in the data, and disables the box for submitted work", async () => {
    const { dashboard, events, snapshot } = await demoDashboard();
    const done = snapshot.items.find((item) => item.status === "submitted" || item.status === "completed");
    if (!done) throw new Error("fixture changed");
    const rows: ToolRow[] = [
      { kind: "item", id: "a999999", title: "Gone assignment", courseId: done.courseId, courseName: "Microcontrollers", itemKind: "assignment", dueAt: null, dueLocal: null, bucket: "no-date", status: "not-started", url: null, priority: null },
      { kind: "item", id: shortId(done.key, done.kind), title: done.title, courseId: done.courseId, courseName: "Microcontrollers", itemKind: done.kind, dueAt: done.dueAt, dueLocal: null, bucket: "completed", status: done.status, url: done.url, priority: null },
    ];
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(eventsClient(rowsAnswer(rows)), events) })} />);
    ask("Hi");
    fireEvent.click(await screen.findByRole("button", { name: "Show 2 matching items" }));
    const list = screen.getByRole("list", { name: /matching items/i });
    expect(within(list).queryByRole("checkbox", { name: /gone assignment/i })).toBeNull();
    expect(within(list).queryByRole("button", { name: /hide "gone assignment"/i })).toBeNull();
    const submitted = within(list).getByRole("checkbox", { name: `${done.title}: ${done.status} in Brightspace` }) as HTMLInputElement;
    expect(submitted.checked).toBe(true);
    expect(submitted.disabled).toBe(true);
  });

  it("marks a change read from its row", async () => {
    const { dashboard, events, snapshot } = await demoDashboard({ withChanges: true });
    const compact = compactSnapshot(snapshot, events, NOW, { mode: "live" });
    const changes = executeTool("get_changes", {}, { snapshot: compact });
    if (!changes.ok) throw new Error(changes.error);
    const first = changes.rows[0];
    if (!first) throw new Error("fixture changed");
    const props = baseProps({ dashboard, ask: askProps(eventsClient(rowsAnswer(changes.rows, "get_changes")), events) });
    render(<MissionControl {...props} />);
    ask("What changed?");
    fireEvent.click(await screen.findByRole("button", { name: `Show ${changes.rows.length} matching items` }));
    fireEvent.click(within(screen.getByRole("list", { name: /matching items/i })).getAllByRole("button", { name: `Mark "${first.title}" as read` })[0] as HTMLElement);
    expect((props.actions as TrackedActions).calls.setEventRead).toEqual([[events.find((event) => event.id.slice(0, 80) === first.id)?.id, true]]);
  });

  it("completes one of the student's own deadlines and shows it on the Week tab", async () => {
    const { dashboard, events } = await demoDashboard();
    const own = personal();
    const rows: ToolRow[] = [{ kind: "personal", id: own.id, title: own.title, courseId: null, courseName: null, dueAt: own.dueAt, dueLocal: "Fri, Sep 11, 2:00 PM", bucket: "this-week", done: false }];
    const props = baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "ask", courseFilter: dashboard.courses[0]?.id ?? null }, ask: askProps(eventsClient(rowsAnswer(rows)), events, { personal: [own] }) });
    const calls = (props.actions as TrackedActions).calls;
    render(<MissionControl {...props} />);
    ask("What did I add?");
    fireEvent.click(await screen.findByRole("button", { name: "Show 1 matching item" }));
    const list = screen.getByRole("list", { name: /matching items/i });
    expect(within(list).getByText("Added by you")).toBeTruthy();
    fireEvent.click(within(list).getByRole("checkbox", { name: 'Mark your deadline "Email lab partner" done' }));
    expect(calls.setPersonalDone).toEqual([[own.id, own.title, true]]);
    fireEvent.click(within(list).getByRole("button", { name: 'Show "Email lab partner" on the Week tab' }));
    // The Week tab opens, and the course filter that would hide a deadline with no course is cleared.
    expect(calls.setPreferences?.at(-1)).toEqual([{ activeTab: "week", courseFilter: null }]);
  });
});

describe("questions started from the other tabs", () => {
  it("writes a question about one item into the composer and sends its exact id as the focus", async () => {
    const { dashboard, events, snapshot } = await demoDashboard();
    const lab3 = snapshot.items.find((item) => item.title === "Lab 3: Timer Interrupts");
    if (!lab3) throw new Error("fixture changed");
    const client = spyClient();
    const actions = trackedActions();
    const askState = askProps(client, events);
    const focusPrefs = { ...DEFAULT_PREFERENCES, activeTab: "focus" as const, focusCategory: "upcoming" as const };
    const { rerender } = render(<MissionControl {...baseProps({ dashboard, actions, preferences: focusPrefs, ask: askState })} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details for Lab 3: Timer Interrupts" }));
    fireEvent.click(screen.getByRole("button", { name: /ask nova about this/i }));
    expect(actions.calls.setPreferences?.at(-1)).toEqual([{ activeTab: "ask" }]);
    rerender(<MissionControl {...baseProps({ dashboard, actions, ask: askState })} />);
    const input = screen.getByRole("textbox", { name: /ask nova a question/i }) as HTMLTextAreaElement;
    expect(input.value).toBe('Why is "Lab 3: Timer Interrupts" ranked where it is?');
    expect(screen.getByText("Lab 3: Timer Interrupts", { selector: ".ask-about strong" })).toBeTruthy();
    // Nothing is sent until the student sends it.
    expect(client.seen).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    await screen.findByText("ok");
    expect(client.seen[0]?.message).toBe('Why is "Lab 3: Timer Interrupts" ranked where it is?');
    expect(client.seen[0]?.focus).toEqual({ courseId: null, tab: "focus", itemId: shortId(lab3.key, lab3.kind) });
    // The item rides along with one question only.
    expect(document.querySelector(".ask-about")).toBeNull();
    ask("And after that?");
    await waitFor(() => expect(client.seen).toHaveLength(2));
    expect(client.seen[1]?.focus).toEqual({ courseId: null, tab: "focus" });
  });

  it("lets the student drop the item and ask about everything instead", async () => {
    const { dashboard, events } = await demoDashboard();
    const client = spyClient();
    const actions = trackedActions();
    const askState = askProps(client, events);
    const { rerender } = render(<MissionControl {...baseProps({ dashboard, actions, preferences: { ...DEFAULT_PREFERENCES, activeTab: "focus", focusCategory: "upcoming" }, ask: askState })} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details for Lab 3: Timer Interrupts" }));
    fireEvent.click(screen.getByRole("button", { name: /ask nova about this/i }));
    rerender(<MissionControl {...baseProps({ dashboard, actions, ask: askState })} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop asking about Lab 3: Timer Interrupts" }));
    expect(document.querySelector(".ask-about")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    await screen.findByText("ok");
    expect(client.seen[0]?.focus).toEqual({ courseId: null, tab: "focus" });
  });

  it("asks what a change means from the Changes tab, and why from the next move", async () => {
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    const moved = events.find((event) => event.kind === "due-date-changed");
    const item = moved ? dashboard.itemByKey.get(moved.entityKey) : undefined;
    if (!moved || !item) throw new Error("fixture changed");
    const client = spyClient();
    const actions = trackedActions();
    const askState = askProps(client, events);
    const { rerender } = render(<MissionControl {...baseProps({ dashboard, actions, preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" }, ask: askState })} />);
    fireEvent.click(screen.getByRole("button", { name: `Ask Nova what the change to "${item.title}" means` }));
    expect(actions.calls.setPreferences?.at(-1)).toEqual([{ activeTab: "ask" }]);
    rerender(<MissionControl {...baseProps({ dashboard, actions, ask: askState })} />);
    expect((screen.getByRole("textbox", { name: /ask nova a question/i }) as HTMLTextAreaElement).value).toBe(`What does this change to "${item.title}" mean for me?`);
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
    await screen.findByText("ok");
    expect(client.seen[0]?.focus).toEqual({ courseId: null, tab: "changes", itemId: shortId(item.key, item.kind) });
    cleanup();

    const next = dashboard.nextMove?.item;
    if (!next) throw new Error("fixture changed");
    const second = trackedActions();
    const hero = render(<MissionControl {...baseProps({ dashboard, actions: second, preferences: { ...DEFAULT_PREFERENCES, activeTab: "focus" }, ask: askState })} />);
    fireEvent.click(screen.getByRole("button", { name: /ask why/i }));
    hero.rerender(<MissionControl {...baseProps({ dashboard, actions: second, ask: askState })} />);
    expect((screen.getByRole("textbox", { name: /ask nova a question/i }) as HTMLTextAreaElement).value).toBe(`Why is "${next.title}" my next move?`);
  });

  it("offers no entry point while Ask Nova is off or not wired", async () => {
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    const off = askProps(null, events, { settings: { enabled: false, apiBaseUrl: "http://localhost:8787", token: null } });
    const view = render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "focus", focusCategory: "upcoming" }, ask: off })} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details for Lab 3: Timer Interrupts" }));
    expect(screen.queryByRole("button", { name: /ask nova about this/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /ask why/i })).toBeNull();
    view.rerender(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "changes" }, ask: off })} />);
    expect(screen.queryByRole("button", { name: /ask nova what the change/i })).toBeNull();
    cleanup();
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "focus" } })} />);
    expect(screen.queryByRole("button", { name: /ask why/i })).toBeNull();
  });
});

describe("what a question carries", () => {
  it("sends done marks, the student's own deadlines, and the hidden count, and leaves hidden items out", async () => {
    const { snapshot, events } = await demoDashboard({ withChanges: true });
    const lab3 = snapshot.items.find((item) => item.title === "Lab 3: Timer Interrupts");
    const pset = snapshot.items.find((item) => item.title === "Problem Set 6: Fourier Series");
    if (!lab3 || !pset) throw new Error("fixture changed");
    const marks = new Map([[lab3.key, NOW.toISOString()]]);
    const dismissed = new Set([pset.key]);
    // Filtered to another course on purpose: Ask reads every course and every mark regardless.
    const other = snapshot.courses.find((course) => course.id !== lab3.courseId);
    const dashboard = buildDashboard({ snapshot, events, now: NOW, courseFilter: other?.id ?? null, dismissedItemKeys: dismissed, localMarks: marks });
    const client = spyClient();
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...DEFAULT_PREFERENCES, activeTab: "ask", courseFilter: other?.id ?? null }, dismissals: { items: dismissed, banners: new Set() }, ask: askProps(client, events, { localMarks: marks, personal: [personal()] }) })} />);
    ask("Hello");
    await screen.findByText("ok");
    const sent = client.seen[0]?.snapshot;
    expect(sent?.version).toBe(3);
    expect(sent?.items.find((item) => item.title === "Lab 3: Timer Interrupts")).toMatchObject({ doneLocally: true, bucket: "completed" });
    expect(sent?.items.some((item) => item.title === "Problem Set 6: Fourier Series")).toBe(false);
    expect(sent?.hiddenCount).toBe(1);
    expect(sent?.personal?.map((deadline) => deadline.title)).toEqual(["Email lab partner"]);
    expect(client.seen[0]?.focus).toEqual({ courseId: other?.id ?? null, tab: "focus" });
  });
});

describe("chips", () => {
  const tool = (name: AskTool["name"], rows: number, input: unknown = {}, status: AskTool["status"] = "ok"): AskTool => ({ id: `${name}-${rows}`, name, status, summary: null, rows, input });

  it("derives follow-ups from the lookups, at most three, and none from a failed lookup", () => {
    expect(followUpQuestions([tool("list_deadlines", 3)])).toEqual(["What should I start first among these?", "What is due next week?"]);
    expect(followUpQuestions([tool("list_deadlines", 1, { range: "next-week" })])).toEqual(["What is due in the next 7 days?"]);
    expect(followUpQuestions([tool("get_brief", 4)])).toEqual(["Why that one?"]);
    expect(followUpQuestions([tool("get_changes", 2)])).toEqual(["Which of these moved later?"]);
    expect(followUpQuestions([tool("get_changes", 0)])).toEqual([]);
    expect(followUpQuestions([tool("get_item_details", 1)])).toEqual(["What else is due in that course?"]);
    expect(followUpQuestions([tool("get_recent_announcements", 2)])).toEqual([]);
    expect(followUpQuestions([tool("list_deadlines", 3, {}, "error")])).toEqual([]);
    expect(followUpQuestions([tool("get_brief", 1), tool("list_deadlines", 3), tool("get_changes", 2), tool("get_item_details", 1)])).toEqual(["Why that one?", "What should I start first among these?", "What is due next week?"]);
    expect(followUpQuestions([tool("get_brief", 1), tool("get_brief", 1)])).toEqual(["Why that one?"]);
  });

  it("shows follow-ups under the latest finished answer only, and sends the one picked", async () => {
    const { dashboard, events } = await demoDashboard({ withChanges: true });
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(scriptedClient(), events) })} />);
    expect(screen.queryByRole("group", { name: /follow-up questions/i })).toBeNull();
    ask("What is due this week?");
    const group = await screen.findByRole("group", { name: /follow-up questions/i });
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["What should I start first among these?", "What is due next week?"]);
    fireEvent.click(within(group).getByRole("button", { name: "What is due next week?" }));
    const conversation = screen.getByRole("list", { name: /conversation/i });
    await within(conversation).findAllByText(/due next week \(Sep 14 to Sep 20\)/i);
    await waitFor(() => expect(screen.getAllByRole("group", { name: /follow-up questions/i })).toHaveLength(1));
    // The newest answer's own follow-ups replaced the earlier ones.
    expect(within(screen.getByRole("group", { name: /follow-up questions/i })).queryByRole("button", { name: "What is due next week?" })).toBeNull();
    expect(within(screen.getByRole("group", { name: /follow-up questions/i })).getByRole("button", { name: "What is due in the next 7 days?" })).toBeTruthy();
  });

  it("shows no follow-ups under an error or a stopped answer", async () => {
    const { dashboard, events } = await demoDashboard();
    render(<MissionControl {...baseProps({ dashboard, ask: askProps(eventsClient([{ type: "tool_call", id: "c1", name: "get_brief", input: {} }, { type: "tool_result", id: "c1", name: "get_brief", ok: true, summary: "x", rows: [] }, { type: "error", code: "upstream_error", message: "boom", retryable: true }]), events) })} />);
    ask("Hi");
    await screen.findByRole("alert");
    expect(screen.queryByRole("group", { name: /follow-up questions/i })).toBeNull();
  });

  it("draws a fourth opening question from the busiest day, or the course with the most open work", async () => {
    const { dashboard } = await demoDashboard();
    const questions = suggestedQuestions(dashboard);
    expect(questions.slice(0, 3)).toEqual(["What should I start first?", "What is overdue?", "Any new announcements?"]);
    const busiest = [...dashboard.week].filter((day) => !day.isToday).sort((a, b) => b.entries.length - a.entries.length)[0];
    if (busiest && busiest.entries.filter((entry) => entry.bucket !== "completed").length >= 2) {
      expect(questions[3]).toMatch(/^What is due on (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\?$/);
    } else {
      expect(questions[3]).toMatch(/^What is left in .+\?$/);
    }
    // With nothing standing out, there is no fourth chip.
    const one = buildDashboard({ snapshot: { ...dashboard.snapshot, items: dashboard.snapshot.items.slice(0, 1) }, events: [], now: NOW, courseFilter: null });
    expect(dataQuestion(one)).toBeNull();
    expect(suggestedQuestions(one)).toHaveLength(3);
  });
});
