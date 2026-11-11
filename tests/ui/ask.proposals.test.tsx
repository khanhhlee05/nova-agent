// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { ScriptedModel, demoRouter, shortId } from "@nova-agent/agent";
import type { AskEvent, ProposalPayload } from "@nova-agent/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { ASK_SETTINGS_PREFERENCE, LocalAskClient, localInstant, resolveProposal, reviveMessages, type AskSettings, type ProposalContext } from "../../apps/extension/src/sidepanel/ask";
import { MissionControl } from "../../apps/extension/src/sidepanel/MissionControl";
import type { PersonalDeadline } from "../../apps/extension/src/sidepanel/model";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { getSyncStatus, listLocalMarks, listPersonalItems, setPreference } from "../../apps/extension/src/storage/repositories";
import type { TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { askProps, baseProps, eventsClient, trackedActions, type TrackedActions } from "../helpers/askHarness";
import { NOW, demoDashboard } from "../helpers/demoDashboard";

let db: NovaDb | null = null;

afterEach(async () => {
  cleanup();
  await db?.delete();
  db = null;
});

const LONG = { timeout: 10_000 };

const ask = (text: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /send question/i }));
};

const proposing = (payloads: ProposalPayload[]): AskEvent[] => [
  ...payloads.flatMap((payload, index): AskEvent[] => [
    { type: "tool_call", id: `c${index}`, name: "propose_mark_done", input: {} },
    { type: "tool_result", id: `c${index}`, name: "propose_mark_done", ok: true, summary: "Suggested an action", rows: [] },
    { type: "proposal", id: `proposal-1-c${index}`, label: `Server label ${index}`, payload },
  ]),
  { type: "text", delta: "I suggested that. It waits for you." },
  { type: "done", model: "fake", usage: null, rounds: 2, grounded: true, corrected: false },
];

const own = (overrides: Partial<PersonalDeadline> = {}): PersonalDeadline => ({ id: "personal-1", title: "Email lab partner", dueAt: new Date("2026-09-10T17:00:00-04:00").toISOString(), courseId: null, completedAt: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), ...overrides });

describe("resolveProposal", () => {
  it("reads a suggestion against the data on this device and keeps only what is still true", async () => {
    const { dashboard, events, snapshot } = await demoDashboard({ withChanges: true });
    const lab3 = snapshot.items.find((item) => item.title === "Lab 3: Timer Interrupts");
    const pset = snapshot.items.find((item) => item.title === "Problem Set 6: Fourier Series");
    const done = snapshot.items.find((item) => item.status === "completed" || item.status === "submitted");
    if (!lab3 || !pset || !done) throw new Error("fixture changed");
    const id = (item: typeof lab3) => shortId(item.key, item.kind);
    const base: ProposalContext = { items: snapshot.items, courseById: dashboard.courseById, localMarks: new Map(), dismissed: new Set(), events, personal: [own(), own({ id: "personal-2", title: "Old task", completedAt: NOW.toISOString() })] };
    const both = resolveProposal({ kind: "mark_done", itemIds: [id(lab3), id(pset), id(done), "a999999"] }, base);
    expect(both).toMatchObject({ kind: "mark_done", text: 'Mark 2 items done on this device: "Lab 3: Timer Interrupts", "Problem Set 6: Fourier Series". Brightspace is not changed.' });
    expect(both.kind === "mark_done" && both.items.map((item) => item.key)).toEqual([lab3.key, pset.key]);
    const oneLeft = resolveProposal({ kind: "mark_done", itemIds: [id(lab3), id(pset)] }, { ...base, localMarks: new Map([[pset.key, NOW.toISOString()]]) });
    expect(oneLeft.text).toBe('Mark "Lab 3: Timer Interrupts" done on this device. Brightspace is not changed.');
    expect(resolveProposal({ kind: "mark_done", itemIds: [id(done)] }, base)).toEqual({ kind: "unavailable", text: "Nothing left to mark: that work is already done." });
    expect(resolveProposal({ kind: "mark_done", itemIds: ["a999999"] }, base)).toEqual({ kind: "unavailable", text: "Nothing to mark: that work is no longer in your data." });
    expect(resolveProposal({ kind: "hide_item", itemIds: [id(lab3)] }, base).text).toBe('Hide "Lab 3: Timer Interrupts" until the next refresh.');
    expect(resolveProposal({ kind: "hide_item", itemIds: [id(lab3)] }, { ...base, dismissed: new Set([lab3.key]) }).kind).toBe("unavailable");
    const read = resolveProposal({ kind: "mark_changes_read", changeIds: events.map((event) => event.id.slice(0, 80)) }, base);
    expect(read).toMatchObject({ kind: "mark_changes_read", text: `Mark ${events.length} changes as read.` });
    expect(resolveProposal({ kind: "mark_changes_read", changeIds: ["gone"] }, base).kind).toBe("unavailable");
    const micro = dashboard.courses.find((course) => course.name === "Microcontrollers");
    const add = resolveProposal({ kind: "add_personal_deadline", title: "Study group", dueDate: "2026-09-10", time: "18:00", courseId: micro?.id ?? null }, base);
    expect(add).toEqual({ kind: "add_personal_deadline", text: 'Add "Study group" to your Week tab: Thu, Sep 10 at 6:00 PM, under Microcontrollers. It stays on this device.', draft: { title: "Study group", dueAt: new Date("2026-09-10T18:00:00-04:00").toISOString(), courseId: micro?.id } });
    expect(resolveProposal({ kind: "add_personal_deadline", title: "X", dueDate: "2026-09-10", time: "18:00", courseId: "nope" }, base).kind).toBe("unavailable");
    expect(resolveProposal({ kind: "add_personal_deadline", title: "X", dueDate: "2026-02-30", time: "18:00", courseId: null }, base).kind).toBe("unavailable");
    expect(resolveProposal({ kind: "move_personal_deadline", personalId: "personal-1", dueDate: "2026-09-11", time: "09:00" }, base).text).toBe('Move your deadline "Email lab partner" from Thu, Sep 10 at 5:00 PM to Fri, Sep 11 at 9:00 AM.');
    expect(resolveProposal({ kind: "move_personal_deadline", personalId: "personal-1", dueDate: "2026-09-10", time: "17:00" }, base).kind).toBe("unavailable");
    expect(resolveProposal({ kind: "move_personal_deadline", personalId: "gone", dueDate: "2026-09-11", time: "09:00" }, base).kind).toBe("unavailable");
    expect(resolveProposal({ kind: "complete_personal_deadline", personalId: "personal-1" }, base).text).toBe('Mark your deadline "Email lab partner" done.');
    expect(resolveProposal({ kind: "complete_personal_deadline", personalId: "personal-2" }, base)).toEqual({ kind: "unavailable", text: '"Old task" is already done.' });
    expect(localInstant("2026-09-10", "18:00")?.toISOString()).toBe("2026-09-10T22:00:00.000Z");
    expect([localInstant("2026-02-30", "18:00"), localInstant("2026-13-01", "18:00"), localInstant("2026-09-10", "6pm")]).toEqual([null, null, null]);
  });
});

describe("suggestion cards", () => {
  const setup = async (payloads: ProposalPayload[], personal: PersonalDeadline[] = []) => {
    const { dashboard, events, snapshot } = await demoDashboard({ withChanges: true });
    const actions = trackedActions();
    const state = askProps(eventsClient(proposing(payloads)), events, { localMarks: new Map(), personal });
    const view = render(<MissionControl {...baseProps({ dashboard, actions, ask: state })} />);
    return { dashboard, events, snapshot, actions, state, view };
  };

  it("does nothing until confirmed, then marks through the Focus handler, records it, and undoes exactly that", async () => {
    const { dashboard } = await demoDashboard({ withChanges: true });
    const lab3 = dashboard.snapshot.items.find((item) => item.title === "Lab 3: Timer Interrupts");
    if (!lab3) throw new Error("fixture changed");
    cleanup();
    const { actions } = await setup([{ kind: "mark_done", itemIds: [shortId(lab3.key, lab3.kind)] }]);
    ask("I finished lab 3");
    const cards = await screen.findByRole("list", { name: /suggested actions/i });
    const card = within(cards).getByRole("listitem");
    expect(within(card).getByText("Nova suggests")).toBeTruthy();
    // The sentence is written here from the item on this device, not taken from the server's label.
    expect(within(card).getByText('Mark "Lab 3: Timer Interrupts" done on this device. Brightspace is not changed.')).toBeTruthy();
    expect(within(card).queryByText(/server label/i)).toBeNull();
    expect(actions.calls.setLocalDone).toBeUndefined();
    fireEvent.click(within(card).getByRole("button", { name: /confirm/i }));
    expect(actions.calls.setLocalDone).toEqual([[lab3.key, "Lab 3: Timer Interrupts", true]]);
    expect(card.getAttribute("data-state")).toBe("confirmed");
    expect(within(card).getByText("Done.")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /confirm/i })).toBeNull();
    expect(within(card).queryByRole("button", { name: /dismiss/i })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: /undo/i }));
    expect(actions.calls.setLocalDone?.at(-1)).toEqual([lab3.key, "Lab 3: Timer Interrupts", false]);
    expect(within(card).getByText("Undone.")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /undo/i })).toBeNull();
  });

  it("dismisses without touching anything, and the card stays as a record", async () => {
    const { snapshot, actions } = await setup([{ kind: "hide_item", itemIds: ["a4101"] }]);
    expect(snapshot.items.length).toBeGreaterThan(0);
    ask("Hide lab 3");
    const card = within(await screen.findByRole("list", { name: /suggested actions/i })).getByRole("listitem");
    fireEvent.click(within(card).getByRole("button", { name: /dismiss/i }));
    expect(card.getAttribute("data-state")).toBe("dismissed");
    expect(within(card).getByText("Dismissed. Nothing changed.")).toBeTruthy();
    expect(within(card).queryByRole("button")).toBeNull();
    expect(actions.calls.dismissItem).toBeUndefined();
    expect(actions.calls.setLocalDone).toBeUndefined();
  });

  it("offers no Confirm for a suggestion that no longer applies", async () => {
    await setup([{ kind: "mark_done", itemIds: ["a999999"] }, { kind: "complete_personal_deadline", personalId: "gone" }]);
    ask("Mark it");
    const cards = within(await screen.findByRole("list", { name: /suggested actions/i })).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText("Nothing to mark: that work is no longer in your data.")).toBeTruthy();
    expect(within(cards[1] as HTMLElement).getByText("That deadline is no longer on your Week tab.")).toBeTruthy();
    for (const card of cards) {
      expect(within(card).queryByRole("button", { name: /confirm/i })).toBeNull();
      expect(within(card).getByRole("button", { name: /dismiss/i })).toBeTruthy();
    }
  });

  it("hides, marks changes read, and completes or moves the student's own deadline through the tabs' own handlers", async () => {
    const { events, actions } = await setup(
      [
        { kind: "hide_item", itemIds: ["a4101"] },
        { kind: "complete_personal_deadline", personalId: "personal-1" },
        { kind: "move_personal_deadline", personalId: "personal-1", dueDate: "2026-09-11", time: "09:00" },
      ],
      [own()],
    );
    ask("Do the things");
    const cards = within(await screen.findByRole("list", { name: /suggested actions/i })).getAllByRole("listitem");
    fireEvent.click(within(cards[0] as HTMLElement).getByRole("button", { name: /confirm/i }));
    expect(actions.calls.dismissItem?.[0]?.[1]).toBe("Lab 3: Timer Interrupts");
    expect(within(cards[0] as HTMLElement).getByText("Hidden. Show all in the panel brings it back.")).toBeTruthy();
    expect(within(cards[0] as HTMLElement).queryByRole("button", { name: /undo/i })).toBeNull();
    fireEvent.click(within(cards[1] as HTMLElement).getByRole("button", { name: /confirm/i }));
    expect(actions.calls.setPersonalDone).toEqual([["personal-1", "Email lab partner", true]]);
    fireEvent.click(within(cards[1] as HTMLElement).getByRole("button", { name: /undo/i }));
    expect(actions.calls.setPersonalDone?.at(-1)).toEqual(["personal-1", "Email lab partner", false]);
    fireEvent.click(within(cards[2] as HTMLElement).getByRole("button", { name: /confirm/i }));
    expect(actions.calls.updatePersonal).toEqual([["personal-1", { title: "Email lab partner", dueAt: new Date("2026-09-11T09:00:00-04:00").toISOString(), courseId: null }]]);
    fireEvent.click(within(cards[2] as HTMLElement).getByRole("button", { name: /undo/i }));
    expect(actions.calls.updatePersonal?.at(-1)).toEqual(["personal-1", { title: "Email lab partner", dueAt: new Date("2026-09-10T17:00:00-04:00").toISOString(), courseId: null }]);
    cleanup();

    const read = await setup([{ kind: "mark_changes_read", changeIds: events.slice(0, 2).map((event) => event.id.slice(0, 80)) }]);
    ask("Mark them read");
    const card = within(await screen.findByRole("list", { name: /suggested actions/i })).getByRole("listitem");
    expect(within(card).getByText("Mark 2 changes as read.")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: /confirm/i }));
    expect(read.actions.calls.setEventRead).toEqual(events.slice(0, 2).map((event) => [event.id, true]));
    fireEvent.click(within(card).getByRole("button", { name: /undo/i }));
    expect(read.actions.calls.setEventRead?.slice(2)).toEqual(events.slice(0, 2).map((event) => [event.id, false]));
  });

  it("adds a deadline under an id it can find again, and shows it on the Week tab", async () => {
    const { dashboard, actions, state, view } = await setup([{ kind: "add_personal_deadline", title: "Study group", dueDate: "2026-09-10", time: "18:00", courseId: null }]);
    ask("Remind me");
    const card = within(await screen.findByRole("list", { name: /suggested actions/i })).getByRole("listitem");
    expect(within(card).getByText('Add "Study group" to your Week tab: Thu, Sep 10 at 6:00 PM. It stays on this device.')).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: /confirm/i }));
    const draft = actions.calls.addPersonal?.[0]?.[0] as { id: string; title: string; dueAt: string; courseId: string | null };
    expect(draft).toMatchObject({ title: "Study group", dueAt: new Date("2026-09-10T18:00:00-04:00").toISOString(), courseId: null });
    expect(draft.id).toMatch(/^personal-/);
    expect(within(card).getByText("Added to your Week tab.")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: /undo/i })).toBeNull();
    // Once the deadline exists, the card can take the student to it.
    view.rerender(<MissionControl {...baseProps({ dashboard, actions, ask: { ...state, personal: [own({ id: draft.id, title: "Study group", dueAt: draft.dueAt })] } })} />);
    fireEvent.click(within(card).getByRole("button", { name: /show on week/i }));
    expect((actions as TrackedActions).calls.setPreferences?.at(-1)).toEqual([{ activeTab: "week" }]);
  });

  it("restores a pending suggestion as expired and a decided one as a record without Undo", () => {
    const stored = [
      {
        id: "a1",
        role: "assistant",
        text: "Suggested.",
        tools: [],
        rows: [],
        error: null,
        usage: null,
        grounded: true,
        stopped: false,
        proposals: [
          { id: "p1", label: "Mark it", payload: { kind: "mark_done", itemIds: ["a4101"] }, state: "pending" },
          { id: "p2", label: "Marked it", payload: { kind: "mark_done", itemIds: ["a4101"] }, state: "confirmed", applied: { itemKeys: ["k"] } },
          { id: "p3", label: "Bad", payload: { kind: "launch", itemIds: ["a4101"] }, state: "pending" },
        ],
      },
    ];
    const revived = reviveMessages(stored);
    expect(revived[0]?.proposals).toEqual([
      { id: "p1", label: "Mark it", payload: { kind: "mark_done", itemIds: ["a4101"] }, state: "expired" },
      { id: "p2", label: "Marked it", payload: { kind: "mark_done", itemIds: ["a4101"] }, state: "confirmed" },
    ]);
    expect(reviveMessages([{ ...stored[0], proposals: "junk" }])[0]?.proposals).toBeUndefined();
  });
});

describe("a suggestion from question to device: end to end", () => {
  it("looks up what is overdue, suggests marking it, and only changes the device after Confirm", { timeout: 30_000 }, async () => {
    db = createNovaDb(`ask-proposal-${Date.now()}`);
    await setPreference(db, ASK_SETTINGS_PREFERENCE, { enabled: true, apiBaseUrl: "http://localhost:8787", token: null } satisfies AskSettings);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    render(<App db={db} host={createStubHost()} now={() => NOW} transportFactory={factory} autoSync={false} askClientFactory={() => new LocalAskClient(new ScriptedModel(demoRouter), { maxRounds: 4 })} />);
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await waitFor(async () => expect((await getSyncStatus(db as NovaDb)).lastSuccessfulSyncAt).toBe(NOW.toISOString()), LONG);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Ask" }, LONG));
    await screen.findByRole("textbox", { name: /ask nova a question/i }, LONG);
    ask("Mark everything that is overdue as done");
    const card = within(await screen.findByRole("list", { name: /suggested actions/i }, LONG)).getByRole("listitem");
    expect(within(card).getByText('Mark "Lab 2: GPIO and Debouncing" done on this device. Brightspace is not changed.')).toBeTruthy();
    // The answer and its screen-reader announcement both carry the sentence.
    await screen.findAllByText(/waits for you to confirm below; nothing has changed yet/i, {}, LONG);
    const scope = (await getSyncStatus(db)).scope as string;
    // Nothing is stored until the student confirms.
    expect(await listLocalMarks(db, scope)).toEqual([]);
    fireEvent.click(within(card).getByRole("button", { name: /confirm/i }));
    await waitFor(async () => expect(await listLocalMarks(db as NovaDb, scope)).toHaveLength(1), LONG);
    expect(within(card).getByText("Done.")).toBeTruthy();
    // The Focus tab agrees: nothing is overdue any more.
    await user.click(screen.getByRole("tab", { name: "Focus" }));
    await screen.findByRole("radio", { name: "Overdue, 0 items" }, LONG);
    await user.click(screen.getByRole("tab", { name: "Ask" }));
    fireEvent.click(within(await screen.findByRole("list", { name: /suggested actions/i }, LONG)).getByRole("button", { name: /undo/i }));
    await waitFor(async () => expect(await listLocalMarks(db as NovaDb, scope)).toEqual([]), LONG);

    // A deadline suggested from a sentence lands on the Week tab only after Confirm.
    ask("Remind me to email my lab partner tomorrow at 5pm");
    const second = (await screen.findAllByText(/^Add "Email my lab partner" to your Week tab: Wed, Sep 9 at 5:00 PM\./, {}, LONG))[0]?.closest("li") as HTMLElement;
    expect(await listPersonalItems(db, scope)).toEqual([]);
    fireEvent.click(within(second).getByRole("button", { name: /confirm/i }));
    await waitFor(async () => expect(await listPersonalItems(db as NovaDb, scope)).toHaveLength(1), LONG);
    expect((await listPersonalItems(db, scope))[0]).toMatchObject({ title: "Email my lab partner", dueAt: new Date("2026-09-09T17:00:00-04:00").toISOString(), courseId: null, completedAt: null });
  });
});
