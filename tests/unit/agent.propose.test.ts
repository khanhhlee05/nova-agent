import { PROPOSED_NOTE, ScriptedModel, compactSnapshot, demoRouter, executeTool, parseClock, runTurn, type ScriptedTurn, type ToolResult, type TurnResult } from "@nova-agent/agent";
import { diffSnapshots } from "@nova-agent/core";
import { PROPOSAL_LIMITS, askEventSchema, proposalPayloadSchema, type AskEvent, type CompactSnapshot, type ProposalPayload } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let snapshot: CompactSnapshot;
const id = (title: string): string => snapshot.items.find((item) => item.title === title)?.id ?? "missing";

beforeAll(async () => {
  const earlier = await demoSnapshot("baseline", new Date(NOW.getTime() - 3_600_000));
  const current = await demoSnapshot("changed", NOW);
  const micro = current.courses.find((course) => course.name === "Microcontrollers");
  snapshot = compactSnapshot(current, diffSnapshots({ current, history: [earlier] }), NOW, {
    mode: "demo",
    timezone: "America/New_York",
    personal: [
      { id: "personal-open", title: "Email lab partner", dueAt: new Date("2026-09-10T17:00:00-04:00").toISOString(), courseId: micro?.id ?? null, completedAt: null },
      { id: "personal-done", title: "Print the lab sheet", dueAt: new Date("2026-09-09T12:00:00-04:00").toISOString(), courseId: null, completedAt: NOW.toISOString() },
    ],
  });
});

const run = (name: string, args: unknown, on: CompactSnapshot = snapshot) => executeTool(name, args, { snapshot: on });
const ok = (result: ToolResult) => {
  if (!result.ok) throw new Error(result.error);
  return result;
};
const fail = (result: ToolResult): string => {
  if (result.ok) throw new Error("expected a failure");
  return result.error;
};
const payloadOf = (result: ToolResult): ProposalPayload => {
  const proposal = ok(result).proposal;
  if (!proposal) throw new Error("no proposal");
  expect(proposalPayloadSchema.safeParse(proposal.payload).success).toBe(true);
  return proposal.payload;
};

describe("propose_mark_done", () => {
  it("suggests marking open items, skipping ones already done, and never claims it happened", () => {
    const result = ok(run("propose_mark_done", { ids: [id("Lab 3: Timer Interrupts"), id("Lab 1: Toolchain Setup"), id("Lab 3: Timer Interrupts")] }));
    expect(payloadOf(result)).toEqual({ kind: "mark_done", itemIds: [id("Lab 3: Timer Interrupts")] });
    expect(result.proposal?.label).toBe('Mark "Lab 3: Timer Interrupts" done on this device. Brightspace is not changed.');
    expect(result.summary).toBe("Suggested marking 1 item done on this device");
    const data = result.data as { note: string; alreadyDone: string[] };
    expect(data.note).toBe(PROPOSED_NOTE);
    expect(data.note).toContain("Never say it has been done");
    expect(data.alreadyDone).toEqual(["Lab 1: Toolchain Setup"]);
    expect(result.rows.map((row) => row.title)).toEqual(["Lab 3: Timer Interrupts"]);
  });

  it("refuses ids that name nothing, work that is all done, and too many ids", () => {
    expect(fail(run("propose_mark_done", { ids: ["a999999", id("Lab 3: Timer Interrupts")] }))).toBe('No item has id "a999999". Use ids from a tool result in this conversation.');
    expect(fail(run("propose_mark_done", { ids: [id("Lab 1: Toolchain Setup")] }))).toBe('"Lab 1: Toolchain Setup" is already done, in Brightspace or by the student\'s own mark.');
    expect(run("propose_mark_done", { ids: [] }).ok).toBe(false);
    expect(run("propose_mark_done", { ids: Array.from({ length: PROPOSAL_LIMITS.items + 1 }, (_, i) => `a${i}`) }).ok).toBe(false);
    expect(run("propose_mark_done", {}).ok).toBe(false);
    // An item the student already marked is "done" for this purpose too.
    const marked: CompactSnapshot = { ...snapshot, items: snapshot.items.map((item) => (item.title === "Lab 3: Timer Interrupts" ? { ...item, bucket: "completed", doneLocally: true } : item)) };
    expect(fail(run("propose_mark_done", { ids: [id("Lab 3: Timer Interrupts")] }, marked))).toContain("already done");
  });

  it("names up to three titles and counts the rest", () => {
    const open = snapshot.items.filter((item) => item.bucket !== "completed").slice(0, 5);
    const result = ok(run("propose_mark_done", { ids: open.map((item) => item.id) }));
    expect(result.proposal?.label).toBe(`Mark "${open[0]?.title}", "${open[1]?.title}", and 3 more done on this device. Brightspace is not changed.`);
    expect((result.proposal?.payload as { itemIds: string[] }).itemIds).toEqual(open.map((item) => item.id));
  });
});

describe("propose_hide and propose_mark_read", () => {
  it("suggests hiding items by id", () => {
    const result = ok(run("propose_hide", { ids: [id("Project Proposal")] }));
    expect(payloadOf(result)).toEqual({ kind: "hide_item", itemIds: [id("Project Proposal")] });
    expect(result.proposal?.label).toBe('Hide "Project Proposal" until the next refresh.');
    expect(fail(run("propose_hide", { ids: ["q1"] }))).toContain('No item has id "q1"');
  });

  it("suggests marking unread changes read, by id, all, or one course, and says when there is nothing to mark", () => {
    const unread = snapshot.changes.filter((change) => !change.read);
    expect(unread.length).toBeGreaterThan(1);
    const all = ok(run("propose_mark_read", { all: true }));
    expect(payloadOf(all)).toEqual({ kind: "mark_changes_read", changeIds: unread.map((change) => change.id) });
    expect(all.proposal?.label).toBe(`Mark ${unread.length} changes as read.`);
    const one = ok(run("propose_mark_read", { ids: [unread[0]?.id] }));
    expect(payloadOf(one)).toEqual({ kind: "mark_changes_read", changeIds: [unread[0]?.id] });
    const micro = ok(run("propose_mark_read", { all: true, course: "micro" }));
    expect(micro.proposal?.label).toMatch(/^Mark \d+ changes? in Microcontrollers as read\.$/);
    const read: CompactSnapshot = { ...snapshot, changes: snapshot.changes.map((change) => ({ ...change, read: true })) };
    expect(fail(run("propose_mark_read", { all: true }, read))).toBe("Nothing to mark: every change is already read.");
    expect(fail(run("propose_mark_read", { ids: [unread[0]?.id] }, read))).toBe("Nothing to mark: those changes are already read.");
    expect(fail(run("propose_mark_read", { ids: ["nope"] }))).toContain('No change has id "nope"');
    expect(run("propose_mark_read", {}).ok).toBe(false);
    expect(run("propose_mark_read", { all: true, ids: ["x"] }).ok).toBe(false);
  });
});

describe("propose_personal_deadline", () => {
  it("suggests adding a deadline with a local day and clock time, cleaned and resolved", () => {
    const result = ok(run("propose_personal_deadline", { action: "add", title: "  Study\ngroup ", date: "2026-09-10", time: "6pm", course: "micro" }));
    const micro = snapshot.courses.find((course) => course.name === "Microcontrollers");
    expect(payloadOf(result)).toEqual({ kind: "add_personal_deadline", title: "Study group", dueDate: "2026-09-10", time: "18:00", courseId: micro?.id });
    expect(result.proposal?.label).toBe('Add "Study group" to your Week tab on Thu, Sep 10 at 6:00 PM, under Microcontrollers. It stays on this device.');
    expect(result.rows).toEqual([]);
    expect(payloadOf(run("propose_personal_deadline", { action: "add", title: "Call home", date: "2026-09-08" }))).toEqual({ kind: "add_personal_deadline", title: "Call home", dueDate: "2026-09-08", time: "23:59", courseId: null });
  });

  it("rejects past, impossible, or far dates, unreadable times, unknown courses, and missing fields", () => {
    const add = (extra: object) => run("propose_personal_deadline", { action: "add", title: "X", date: "2026-09-10", ...extra });
    expect(fail(add({ date: "2026-09-07" }))).toBe("date (2026-09-07) is in the past. Today is 2026-09-08.");
    expect(fail(add({ date: "2026-02-30" }))).toContain("date must be a day like 2026-09-08");
    expect(fail(add({ date: "friday" }))).toContain("date must be a day like");
    expect(fail(add({ date: "2028-01-01" }))).toBe("date (2028-01-01) is more than a year ahead.");
    expect(fail(add({ time: "noonish" }))).toBe('time must look like 17:30 or 5:30 PM, not "noonish".');
    expect(fail(add({ course: "astronomy" }))).toContain("No course matches");
    expect(fail(add({ title: "\u0000 \n" }))).toBe("title is empty.");
    expect(run("propose_personal_deadline", { action: "add", title: "No date" }).ok).toBe(false);
    expect(run("propose_personal_deadline", { action: "move", id: "personal-open" }).ok).toBe(false);
    expect(run("propose_personal_deadline", { action: "complete" }).ok).toBe(false);
    expect(run("propose_personal_deadline", { action: "delete", id: "personal-open" }).ok).toBe(false);
  });

  it("suggests moving one of the student's own deadlines, keeping its time unless a new one is given", () => {
    const kept = ok(run("propose_personal_deadline", { action: "move", id: "personal-open", date: "2026-09-11" }));
    expect(payloadOf(kept)).toEqual({ kind: "move_personal_deadline", personalId: "personal-open", dueDate: "2026-09-11", time: "17:00" });
    expect(kept.proposal?.label).toBe('Move your deadline "Email lab partner" to Fri, Sep 11 at 5:00 PM.');
    expect(payloadOf(run("propose_personal_deadline", { action: "move", id: "personal-open", date: "2026-09-10", time: "09:30" }))).toMatchObject({ dueDate: "2026-09-10", time: "09:30" });
    expect(fail(run("propose_personal_deadline", { action: "move", id: "personal-open", date: "2026-09-10" }))).toBe('"Email lab partner" is already on Thu, Sep 10 at 5:00 PM.');
    expect(fail(run("propose_personal_deadline", { action: "move", id: "personal-open", date: "2026-09-01" }))).toContain("in the past");
    // A Brightspace item is not one of the student's own deadlines.
    expect(fail(run("propose_personal_deadline", { action: "move", id: id("Lab 3: Timer Interrupts"), date: "2026-09-11" }))).toContain("use propose_mark_done for those");
  });

  it("suggests completing an open deadline, and not one that is already done", () => {
    const result = ok(run("propose_personal_deadline", { action: "complete", id: "personal-open" }));
    expect(payloadOf(result)).toEqual({ kind: "complete_personal_deadline", personalId: "personal-open" });
    expect(result.rows.map((row) => row.kind)).toEqual(["personal"]);
    expect(fail(run("propose_personal_deadline", { action: "complete", id: "personal-done" }))).toBe('"Print the lab sheet" is already done.');
  });

  it("reads clock times in the forms a model writes them", () => {
    expect([parseClock("5pm", "x"), parseClock("5:30 PM", "x"), parseClock("12am", "x"), parseClock("12:15pm", "x"), parseClock("17:30", "x"), parseClock("7:05", "x"), parseClock(undefined, "23:59"), parseClock("", "23:59")]).toEqual(["17:00", "17:30", "00:00", "12:15", "17:30", "07:05", "23:59", "23:59"]);
    expect([parseClock("25:00", "x"), parseClock("13pm", "x"), parseClock("5:75pm", "x"), parseClock("soon", "x"), parseClock("0am", "x")]).toEqual([null, null, null, null, null]);
  });
});

const drive = async (script: ScriptedTurn[] | ConstructorParameters<typeof ScriptedModel>[0], message = "Mark it done") => {
  const events: AskEvent[] = [];
  const model = new ScriptedModel(script);
  const generator = runTurn({ snapshot, history: [], message, model, maxTokens: 300, maxRounds: 6, signal: new AbortController().signal });
  let result: TurnResult | undefined;
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }
  return { events, result: result as TurnResult, model };
};

describe("proposals in the loop", () => {
  it("emits a proposal event right after the tool result, and tells the model it is only proposed", async () => {
    const { events, result, model } = await drive([{ toolCalls: [{ name: "propose_mark_done", args: { ids: [id("Lab 3: Timer Interrupts")] } }] }, { text: ["I suggested marking Lab 3: Timer Interrupts done. It waits for you."] }]);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "proposal", "text", "done"]);
    const proposal = events[2];
    expect(proposal?.type === "proposal" && proposal.payload).toEqual({ kind: "mark_done", itemIds: [id("Lab 3: Timer Interrupts")] });
    expect(askEventSchema.safeParse(proposal).success).toBe(true);
    expect(result).toMatchObject({ proposals: 1, grounded: true, toolNames: ["propose_mark_done"] });
    const toolMessage = model.calls[1]?.messages.at(-1);
    expect(toolMessage?.role === "tool" && toolMessage.content.includes("Proposed, not done")).toBe(true);
    // The payload itself is not echoed back to the model: it only needs to know what was suggested.
    expect(toolMessage?.role === "tool" && toolMessage.content.includes('"payload"')).toBe(false);
  });

  it("shows no card for a suggestion the tool refused", async () => {
    const { events, result } = await drive([{ toolCalls: [{ name: "propose_mark_done", args: { ids: ["a999999"] } }] }, { text: ["I could not find that."] }]);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(events[1]?.type === "tool_result" && !events[1].ok && events[1].error).toContain('No item has id "a999999"');
    expect(result.proposals).toBe(0);
  });

  it("shows at most three suggestions in one answer and tells the model about the rest", async () => {
    const open = snapshot.items.filter((item) => item.bucket !== "completed").slice(0, 5);
    const { events, result, model } = await drive([{ toolCalls: open.map((item) => ({ name: "propose_hide" as const, args: { ids: [item.id] } })) }, { text: ["I suggested hiding three of them."] }]);
    expect(events.filter((event) => event.type === "proposal")).toHaveLength(PROPOSAL_LIMITS.perTurn);
    const refused = events.filter((event) => event.type === "tool_result" && !event.ok);
    expect(refused).toHaveLength(2);
    expect(refused[0]?.type === "tool_result" && refused[0].error).toContain("Only 3 suggestions fit in one answer");
    expect(result.proposals).toBe(3);
    expect(new Set(events.flatMap((event) => (event.type === "proposal" ? [event.id] : []))).size).toBe(3);
    expect(model.calls[1]?.messages.filter((message) => message.role === "tool" && message.content.includes("was not shown"))).toHaveLength(2);
  });

  it("round-trips every proposal kind through the event schema and rejects malformed payloads", () => {
    const payloads: ProposalPayload[] = [
      { kind: "mark_done", itemIds: ["a1"] },
      { kind: "hide_item", itemIds: ["a1", "q2"] },
      { kind: "mark_changes_read", changeIds: ["c1"] },
      { kind: "add_personal_deadline", title: "Study", dueDate: "2026-09-10", time: "18:00", courseId: null },
      { kind: "move_personal_deadline", personalId: "p1", dueDate: "2026-09-11", time: "09:00" },
      { kind: "complete_personal_deadline", personalId: "p1" },
    ];
    for (const payload of payloads) {
      const event = { type: "proposal", id: "proposal-1-c1", label: "x", payload };
      expect(askEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
    const bad: unknown[] = [
      { kind: "mark_done", itemIds: [] },
      { kind: "submit_assignment", itemIds: ["a1"] },
      { kind: "add_personal_deadline", title: "x", dueDate: "2026-9-1", time: "18:00", courseId: null },
      { kind: "add_personal_deadline", title: "x", dueDate: "2026-09-10", time: "6pm", courseId: null },
      { kind: "add_personal_deadline", title: "", dueDate: "2026-09-10", time: "18:00", courseId: null },
      { kind: "move_personal_deadline", personalId: "p1", dueDate: "2026-09-11", time: "24:00" },
      { kind: "mark_done", itemIds: Array.from({ length: 21 }, (_, i) => `a${i}`) },
    ];
    for (const payload of bad) expect(proposalPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("demoRouter suggestions", () => {
  it("looks up what is overdue, then suggests marking exactly those items", async () => {
    const { events, result } = await drive(demoRouter, "Mark everything that is overdue as done");
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result", "proposal", "text", "done"]);
    const listed = events[1];
    const proposal = events[4];
    if (listed?.type !== "tool_result" || proposal?.type !== "proposal" || proposal.payload.kind !== "mark_done") throw new Error("unexpected events");
    expect(proposal.payload.itemIds).toEqual(listed.rows.map((row) => row.id));
    expect(result.text).toContain("waits for you to confirm");
    expect(result).toMatchObject({ grounded: true, proposals: 1 });
  });

  it("turns 'remind me to' into a suggested deadline on the day the prompt states", async () => {
    const { events } = await drive(demoRouter, "Remind me to email my lab partner tomorrow at 5pm");
    const proposal = events.find((event) => event.type === "proposal");
    expect(proposal?.type === "proposal" && proposal.payload).toEqual({ kind: "add_personal_deadline", title: "Email my lab partner", dueDate: "2026-09-09", time: "17:00", courseId: null });
    const read = await drive(demoRouter, "Mark all changes as read");
    expect(read.events.find((event) => event.type === "proposal")?.type).toBe("proposal");
  });
});
