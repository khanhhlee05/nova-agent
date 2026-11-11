import { ScriptedModel, addEvidence, compactSnapshot, emptyEvidence, runTurn, unverifiedFacts, type RunTurnInput, type ScriptedTurn, type TurnResult } from "@nova-agent/agent";
import { askEventSchema, chatRequestSchema, type AskEvent, type CompactSnapshot } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let snapshot: CompactSnapshot;

beforeAll(async () => {
  snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" });
});

const shown = (...values: unknown[]) => {
  const evidence = emptyEvidence();
  for (const value of values) addEvidence(evidence, value);
  return evidence;
};

/** What a deadline lookup returns for one item, as the model sees it. */
const LAB3 = { title: "Lab 3: Timer Interrupts", dueDate: "2026-09-09", dueLocal: "Wed, Sep 9, 11:59 PM", pointsPossible: 50 };

describe("unverifiedFacts", () => {
  it("accepts a date written any of the ways the data could be read", () => {
    const evidence = shown(LAB3);
    for (const answer of ["It is due Sep 9.", "It is due on September 9th at 11:59 PM.", "Due 2026-09-09.", "Due Sept. 9, 11:59 PM.", "It is due on the 9th of September.", "Due 9 September.", "Due Wed, Sep 9.", "Due Wednesday, September 9.", "Due Wednesday 2026-09-09."]) {
      expect(unverifiedFacts(answer, evidence), answer).toEqual([]);
    }
  });

  it("flags a date nothing the model was shown contains", () => {
    const evidence = shown(LAB3);
    expect(unverifiedFacts("Lab 3 is due Sep 10.", evidence)).toEqual([{ kind: "date", value: "Sep 10" }]);
    expect(unverifiedFacts("Lab 3 is due on September 19th.", evidence)).toEqual([{ kind: "date", value: "September 19th" }]);
    expect(unverifiedFacts("It is due 2026-09-10, not 2026-09-09.", evidence)).toEqual([{ kind: "date", value: "2026-09-10" }]);
    expect(unverifiedFacts("Hand it in by the 12th of October.", evidence)).toEqual([{ kind: "date", value: "12th of October" }]);
    // The same wrong date twice is one finding.
    expect(unverifiedFacts("Due Oct 1. Again: due Oct 1.", evidence)).toHaveLength(1);
    // The right day in the wrong year is still a wrong date when written in full.
    expect(unverifiedFacts("Due 2025-09-09.", evidence)).toEqual([{ kind: "date", value: "2025-09-09" }]);
  });

  it("flags a weekday that does not match the date it is attached to, and only then", () => {
    const evidence = shown(LAB3);
    expect(unverifiedFacts("Lab 3 is due Thursday, Sep 9.", evidence)).toEqual([{ kind: "weekday", value: "Thursday, Sep 9" }]);
    expect(unverifiedFacts("Due Fri 2026-09-09.", evidence)).toEqual([{ kind: "weekday", value: "Fri 2026-09-09" }]);
    expect(unverifiedFacts("Due Tues, September 9th.", evidence)).toEqual([{ kind: "weekday", value: "Tues, September 9th" }]);
    // A weekday on its own is advice or a relative day, not a checkable claim.
    expect(unverifiedFacts("Start on Monday and finish by Friday.", evidence)).toEqual([]);
    // With only a month and a day in the data, the year is unknown, so the weekday cannot be judged.
    expect(unverifiedFacts("Due Thursday, Sep 9.", shown("Lab 3 is due Sep 9"))).toEqual([]);
    // A wrong date with a weekday is reported once, as a date.
    expect(unverifiedFacts("Due Friday, Sep 11.", evidence)).toEqual([{ kind: "date", value: "Sep 11" }]);
  });

  it("flags a point value that appears nowhere, and accepts one from a number or from text", () => {
    const evidence = shown(LAB3, "Worth 25 points, about average for this course.");
    expect(unverifiedFacts("Lab 3 is worth 50 points and the proposal 25 pts.", evidence)).toEqual([]);
    expect(unverifiedFacts("Lab 3 is worth 60 points.", evidence)).toEqual([{ kind: "points", value: "60 points" }]);
    expect(unverifiedFacts("It is 12.5 points.", evidence)).toEqual([{ kind: "points", value: "12.5 points" }]);
    expect(unverifiedFacts("It is 12.5 points.", shown({ earned: 12.5 }))).toEqual([]);
    expect(unverifiedFacts("That is 1 Point.", shown("nothing numeric"))).toEqual([{ kind: "points", value: "1 Point" }]);
    // Other numbers are not point values.
    expect(unverifiedFacts("You have 3 items, about 90 minutes of work, and 10 percent off per day.", evidence)).toEqual([]);
  });

  it("does not read ordinary words and numbers as dates", () => {
    const evidence = shown(LAB3);
    for (const answer of [
      "You may 5 times retry the quiz.",
      "She sat 3 exams in March 2026.",
      "Lab 3 is first. Then Quiz 2 and Homework 4.",
      "It opens at 11:59 PM and takes 30 minutes.",
      "Do it today, tomorrow, or next week.",
      "See section 3.2 of the manual, page 14.",
      "The sun sets early; wed the two ideas.",
      "",
    ]) {
      expect(unverifiedFacts(answer, evidence), answer).toEqual([]);
    }
  });

  it("counts what the student wrote and what the prompt lists as shown", () => {
    expect(unverifiedFacts("Nothing is due on October 3.", shown("Is anything due on october 3rd?"))).toEqual([]);
    expect(unverifiedFacts("Next week runs Sep 14 to Sep 20.", shown("next week runs Mon 2026-09-14 to Sun 2026-09-20"))).toEqual([]);
    expect(unverifiedFacts("Next week starts Tuesday, Sep 14.", shown("next week runs Mon 2026-09-14 to Sun 2026-09-20"))).toEqual([{ kind: "weekday", value: "Tuesday, Sep 14" }]);
  });
});

const drive = async (script: ScriptedTurn[], overrides: Partial<RunTurnInput> = {}) => {
  const model = new ScriptedModel(script);
  const events: AskEvent[] = [];
  const generator = runTurn({ snapshot, history: [], message: "When is Lab 3 due?", model, maxTokens: 300, signal: new AbortController().signal, ...overrides });
  let result: TurnResult | undefined;
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }
  for (const event of events) expect(askEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
  return { events, result: result as TurnResult, model };
};

const LOOKUP: ScriptedTurn = { toolCalls: [{ name: "list_deadlines", args: { range: "week" } }] };
const RIGHT = "Lab 3: Timer Interrupts is due Wed, Sep 9 and is worth 50 points.";

describe("dates and points in the loop", () => {
  it("lets through an answer whose date and points are the ones the lookup returned", async () => {
    const { result, events } = await drive([LOOKUP, { text: [RIGHT] }]);
    expect(result).toMatchObject({ grounded: true, corrected: false, rounds: 2 });
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
  });

  it("holds back a wrong date, asks once for a correction, and sends the corrected answer", async () => {
    const { result, events, model } = await drive([LOOKUP, { text: ["Lab 3: Timer Interrupts is due Sep 19."] }, { text: [RIGHT] }]);
    expect(result).toMatchObject({ grounded: true, corrected: true, rounds: 3 });
    expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", delta: RIGHT }]);
    const nudge = model.calls[2]?.messages.at(-1);
    expect(nudge).toMatchObject({ role: "user" });
    expect(nudge?.content).toContain('"Sep 19"');
    expect(nudge?.content).toContain("that date is not in the course data or in any tool result");
    expect(nudge?.content).toContain("use only dates and numbers that a tool returned");
  });

  it("does the same for a wrong weekday and a wrong point value", async () => {
    const weekday = await drive([LOOKUP, { text: ["Lab 3: Timer Interrupts is due Friday, Sep 9."] }, { text: [RIGHT] }]);
    expect(weekday.result).toMatchObject({ grounded: true, corrected: true });
    expect(weekday.model.calls[2]?.messages.at(-1)?.content).toContain("that weekday does not match the date in the course data");
    const points = await drive([LOOKUP, { text: ["Lab 3: Timer Interrupts is worth 75 points."] }, { text: [RIGHT] }]);
    expect(points.result).toMatchObject({ grounded: true, corrected: true });
    expect(points.model.calls[2]?.messages.at(-1)?.content).toContain("that point value is not in the course data or in any tool result");
  });

  it("marks the answer as not grounded when the wrong date survives the correction, or no round is left for one", async () => {
    const wrong: ScriptedTurn = { text: ["Lab 3: Timer Interrupts is due Sep 19."] };
    expect((await drive([LOOKUP, wrong, wrong])).result).toMatchObject({ grounded: false, corrected: true, rounds: 3 });
    const last = await drive([LOOKUP, wrong], { maxRounds: 2 });
    expect(last.result).toMatchObject({ grounded: false, corrected: false, rounds: 2 });
    expect(last.model.calls).toHaveLength(2);
  });

  it("reports an unknown title before a quotation, and a quotation before a date", async () => {
    // "Project Proposal" is in the data but not in the brief, and no lookup returned it.
    expect(snapshot.items.some((item) => item.title === "Project Proposal")).toBe(true);
    const title = await drive([{ text: ['Project Proposal says "hand it in whenever you feel ready" by Sep 30.'] }, { text: [RIGHT] }]);
    expect(title.model.calls[1]?.messages.at(-1)?.content).toContain('Your draft names "Project Proposal"');
    const quoted = await drive([LOOKUP, { text: ['The page says "hand it in whenever you feel ready" by Sep 30.'] }, { text: [RIGHT] }]);
    expect(quoted.model.calls[2]?.messages.at(-1)?.content).toContain("those exact words are not in the course data or in any tool result");
    const dated = await drive([LOOKUP, { text: ["Hand it in by Sep 30."] }, { text: [RIGHT] }]);
    expect(dated.model.calls[2]?.messages.at(-1)?.content).toContain("that date is not in the course data");
  });
});

describe("streamed text", () => {
  const stream = { streamText: true } as const;

  it("is off unless the request asks for it: one checked text event", async () => {
    const { events } = await drive([LOOKUP, { text: ["Lab 3: Timer Interrupts ", "is due Wed, Sep 9."] }]);
    expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", delta: "Lab 3: Timer Interrupts is due Wed, Sep 9." }]);
    expect(events.some((event) => event.type === "text_reset")).toBe(false);
  });

  it("sends the answer's words as the model writes them, and nothing twice", async () => {
    const { events, result } = await drive([LOOKUP, { text: ["Lab 3: Timer Interrupts ", "is due ", "Wed, Sep 9."] }], stream);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "text", "text", "text", "done"]);
    expect(events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("")).toBe("Lab 3: Timer Interrupts is due Wed, Sep 9.");
    expect(result).toMatchObject({ text: "Lab 3: Timer Interrupts is due Wed, Sep 9.", grounded: true, corrected: false });
  });

  it("takes back words the model wrote before asking for a lookup", async () => {
    const { events } = await drive([{ text: ["Let me check ", "your deadlines."], toolCalls: [{ name: "list_deadlines", args: { range: "week" } }] }, { text: [RIGHT] }], stream);
    expect(events.map((event) => (event.type === "text_reset" ? `reset:${event.reason}` : event.type))).toEqual(["text", "text", "reset:lookup", "tool_call", "tool_result", "text", "done"]);
    expect(events.at(-2)).toEqual({ type: "text", delta: RIGHT });
  });

  it("takes back a draft that fails the check, then streams the corrected answer", async () => {
    const { events, result } = await drive([LOOKUP, { text: ["Lab 3: Timer Interrupts ", "is due Sep 19."] }, { text: ["Lab 3: Timer Interrupts ", "is due Wed, Sep 9."] }], stream);
    expect(events.map((event) => (event.type === "text_reset" ? `reset:${event.reason}` : event.type))).toEqual(["tool_call", "tool_result", "text", "text", "reset:correction", "text", "text", "done"]);
    const afterReset = events.slice(events.findIndex((event) => event.type === "text_reset") + 1);
    expect(afterReset.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("")).toBe("Lab 3: Timer Interrupts is due Wed, Sep 9.");
    expect(result).toMatchObject({ grounded: true, corrected: true });
    expect(events.at(-1)).toMatchObject({ type: "done", grounded: true, corrected: true });
  });

  it("leaves a draft that cannot be corrected on screen and says it is not grounded", async () => {
    const { events, result } = await drive([LOOKUP, { text: ["Lab 3: Timer Interrupts is due Sep 19."] }], { ...stream, maxRounds: 2 });
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(result.grounded).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", grounded: false });
  });

  it("replaces whitespace or nothing with the fallback sentence", async () => {
    const blank = await drive([{ text: ["  ", "\n"] }], stream);
    expect(blank.events.map((event) => (event.type === "text_reset" ? `reset:${event.reason}` : event.type))).toEqual(["text", "text", "reset:lookup", "text", "done"]);
    expect(blank.result.text).toBe("I do not have enough to answer that. Try asking about deadlines, changes, or what to start first.");
    const empty = await drive([{ text: [] }], stream);
    expect(empty.events.map((event) => event.type)).toEqual(["text", "done"]);
  });

  it("stops in the middle with what was written and an aborted error", async () => {
    const controller = new AbortController();
    const model = new ScriptedModel([{ text: ["First part. ", "Second part. ", "Third part."] }]);
    const events: AskEvent[] = [];
    for await (const event of runTurn({ snapshot, history: [], message: "Go", model, maxTokens: 300, signal: controller.signal, streamText: true })) {
      events.push(event);
      if (event.type === "text" && event.delta.startsWith("First")) controller.abort();
    }
    expect(events[0]).toEqual({ type: "text", delta: "First part. " });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "aborted" });
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("is a request flag older servers ignore and older clients never send", () => {
    const base = { message: "hi", history: [], snapshot, client: { name: "nova-extension", version: "0.1.0" } };
    expect(chatRequestSchema.parse(base).streamText).toBeUndefined();
    expect(chatRequestSchema.parse({ ...base, streamText: true }).streamText).toBe(true);
    expect(chatRequestSchema.safeParse({ ...base, streamText: "yes" }).success).toBe(false);
    expect(askEventSchema.safeParse({ type: "text_reset", reason: "correction" }).success).toBe(true);
    expect(askEventSchema.safeParse({ type: "text_reset", reason: "because" }).success).toBe(false);
  });
});
