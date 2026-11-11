import { OFFLINE_MODEL_ID, ScriptedModel, TOOLS, compactSnapshot, intentRouter, matchIntent, runTurn, type Intent, type TurnResult } from "@nova-agent/agent";
import { askEventSchema, type AskEvent, type CompactSnapshot } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let snapshot: CompactSnapshot;
const MICRO = "31001";

beforeAll(async () => {
  snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" });
});

const intent = (question: string): Intent | null => matchIntent(question, snapshot);

describe("matchIntent", () => {
  it("recognises every question the panel itself suggests", () => {
    // The fixed chips, the two drawn from the data, and the follow-ups that stand on their own.
    expect(intent("What should I start first?")).toEqual({ name: "get_brief", args: {} });
    expect(intent("What is overdue?")).toEqual({ name: "list_deadlines", args: { range: "overdue" } });
    expect(intent("What is due in the next 7 days?")).toEqual({ name: "list_deadlines", args: { range: "week" } });
    expect(intent("What is due next week?")).toEqual({ name: "list_deadlines", args: { range: "next-week" } });
    expect(intent("What changed since my last visit?")).toEqual({ name: "get_changes", args: { since: "week" } });
    expect(intent("Any new announcements?")).toEqual({ name: "get_recent_announcements", args: {} });
    expect(intent("What is left in Microcontrollers?")).toEqual({ name: "list_deadlines", args: { range: "all", course: MICRO } });
    expect(intent("Plan the next 7 days")).toEqual({ name: "build_study_plan", args: { days: 7 } });
  });

  it("turns a weekday into that calendar day, today included", () => {
    // The demo clock is Tuesday 2026-09-08.
    expect(snapshot.calendar.today).toBe("2026-09-08");
    expect(intent("What is due on Thursday?")).toEqual({ name: "list_deadlines", args: { from: "2026-09-10", to: "2026-09-10" } });
    expect(intent("what's due tuesday")).toEqual({ name: "list_deadlines", args: { from: "2026-09-08", to: "2026-09-08" } });
    expect(intent("Anything due Monday?")).toEqual({ name: "list_deadlines", args: { from: "2026-09-14", to: "2026-09-14" } });
    expect(intent("What is due on Sunday in Microcontrollers?")).toEqual({ name: "list_deadlines", args: { from: "2026-09-13", to: "2026-09-13", course: MICRO } });
  });

  it("accepts close variants, whatever the case or punctuation", () => {
    expect(intent("whats due today")).toEqual({ name: "list_deadlines", args: { range: "today" } });
    expect(intent("What's due tonight?")).toEqual({ name: "list_deadlines", args: { range: "today" } });
    expect(intent("WHAT IS DUE TOMORROW?!")).toEqual({ name: "list_deadlines", args: { range: "tomorrow" } });
    expect(intent("what's due")).toEqual({ name: "list_deadlines", args: { range: "week" } });
    expect(intent("upcoming deadlines")).toEqual({ name: "list_deadlines", args: { range: "week" } });
    expect(intent("What do I have this week?")).toEqual({ name: "list_deadlines", args: { range: "week" } });
    expect(intent("Microcontrollers this week")).toEqual({ name: "list_deadlines", args: { range: "week", course: MICRO } });
    expect(intent("ECE-2042-001 next week")).toEqual({ name: "list_deadlines", args: { range: "next-week", course: MICRO } });
    expect(intent("What am I late on?")).toEqual({ name: "list_deadlines", args: { range: "overdue" } });
    expect(intent("anything past due in microcontrollers?")).toEqual({ name: "list_deadlines", args: { range: "overdue", course: MICRO } });
    expect(intent("what did I miss")).toEqual({ name: "get_changes", args: { since: "week" } });
    expect(intent("what's new")).toEqual({ name: "get_changes", args: { since: "week" } });
    expect(intent("news in Microcontrollers")).toEqual({ name: "get_recent_announcements", args: { course: MICRO } });
    expect(intent("What should I do next?")).toEqual({ name: "get_brief", args: {} });
    expect(intent("what is most urgent")).toEqual({ name: "get_brief", args: {} });
    expect(intent("Which course needs the most attention?")).toEqual({ name: "get_course_load", args: {} });
    expect(intent("Make me a study plan")).toEqual({ name: "build_study_plan", args: { days: 3 } });
    expect(intent("plan my week for Microcontrollers")).toEqual({ name: "build_study_plan", args: { days: 7, course: MICRO } });
    expect(intent("Plan today")).toEqual({ name: "build_study_plan", args: { days: 1 } });
  });

  it("stays silent on anything that needs reading, reasoning, an action, or the earlier conversation", () => {
    for (const question of [
      "Why is Lab 2 my next move?",
      "Why that one?",
      "Explain the late policy",
      "What does the syllabus say about late work?",
      "What does the Lab 3 handout ask for?",
      "Summarize lecture 5",
      "Mark what is overdue as done",
      "Remind me to email my TA tomorrow",
      "Hide the quiz",
      "What grade did I get on Lab 1?",
      "What should I start first among these?",
      "Which of these moved later?",
      "What else is due in that course?",
      "What do I have to hand in?",
      "How do interrupts work?",
      "Tell me a joke",
      "hello",
      "",
      "   ",
      `What is due ${"really ".repeat(40)}soon?`,
    ]) {
      expect(intent(question), question).toBeNull();
    }
  });

  it("does not guess a course when the question names two, or none clearly", () => {
    const twins: CompactSnapshot = { ...snapshot, courses: [...snapshot.courses, { ...(snapshot.courses[0] as CompactSnapshot["courses"][number]), id: "999", name: "Microcontrollers Lab", code: null }] };
    // "microcontrollers lab" contains both names, so neither is chosen and every course is listed.
    expect(matchIntent("What is due this week in Microcontrollers Lab?", twins)).toEqual({ name: "list_deadlines", args: { range: "week" } });
    expect(intent("What is left?")).toBeNull();
    expect(intent("What is due this week in Basket Weaving?")).toEqual({ name: "list_deadlines", args: { range: "week" } });
  });

  it("only ever chooses a lookup that reads the snapshot, with arguments the tool accepts", () => {
    const questions = ["What should I start first?", "What is overdue?", "What is due next week?", "What changed since my last visit?", "Any new announcements?", "What is left in Microcontrollers?", "Plan the next 7 days", "What is due on Thursday?", "Which course needs the most attention?", "news in Microcontrollers", "plan my week for Microcontrollers"];
    for (const question of questions) {
      const matched = intent(question) as Intent;
      const tool = TOOLS.find((candidate) => candidate.name === matched.name);
      expect(tool, question).toBeDefined();
      expect(tool?.client, question).not.toBe(true);
      expect(matched.name.startsWith("propose_"), question).toBe(false);
      expect(tool?.input.safeParse(matched.args).success, question).toBe(true);
    }
  });
});

const answer = async (question: string) => {
  const matched = intent(question) as Intent;
  const events: AskEvent[] = [];
  const model = new ScriptedModel(intentRouter(matched));
  const generator = runTurn({ snapshot, history: [], message: question, model, tools: TOOLS, maxRounds: 2, maxTokens: 200, signal: new AbortController().signal });
  let result: TurnResult | undefined;
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
  }
  for (const event of events) expect(askEventSchema.safeParse(event).success).toBe(true);
  return { events, result: result as TurnResult, model };
};

describe("an answer without a model", () => {
  it("makes the one lookup and says what the lookup said, which is true of the rows by construction", async () => {
    for (const question of ["What should I start first?", "What is overdue?", "What is due next week?", "What is due on Thursday?", "What changed since my last visit?", "Any new announcements?", "What is left in Microcontrollers?", "Which course needs the most attention?", "Plan the next 7 days"]) {
      const { events, result, model } = await answer(question);
      expect(events.map((event) => event.type), question).toEqual(["tool_call", "tool_result", "text", "done"]);
      const tool = events[1] as Extract<AskEvent, { type: "tool_result" }>;
      expect(tool.ok, question).toBe(true);
      expect(result, question).toMatchObject({ grounded: true, corrected: false, rounds: 2, model: OFFLINE_MODEL_ID, outcome: "ok" });
      expect(result.text, question).toBe(`${tool.summary.replace(/[.!?]+$/, "")}. The rows below come straight from the data on this device.`);
      expect(result.usage, question).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
      expect(model.calls, question).toHaveLength(2);
    }
  });

  it("answers the weekday question with that day's items", async () => {
    const { events } = await answer("What is due on Thursday?");
    const tool = events[1] as Extract<AskEvent, { type: "tool_result" }>;
    expect(tool.rows.length).toBeGreaterThan(0);
    expect(tool.rows.every((row) => row.kind === "item" && row.dueLocal?.startsWith("Thu, Sep 10"))).toBe(true);
    const expected = snapshot.items.filter((item) => item.dueDate === "2026-09-10" && item.bucket !== "completed").map((item) => item.title);
    expect(tool.rows.map((row) => (row.kind === "item" ? row.title : "")).sort()).toEqual(expected.sort());
  });

  it("says so plainly when the lookup gives nothing to say", async () => {
    const broken = new ScriptedModel(intentRouter({ name: "list_deadlines", args: { from: "not a date" } }));
    const events: AskEvent[] = [];
    for await (const event of runTurn({ snapshot, history: [], message: "x", model: broken, tools: TOOLS, maxRounds: 2, maxTokens: 200, signal: new AbortController().signal })) events.push(event);
    expect(events.find((event) => event.type === "tool_result")).toMatchObject({ ok: false });
    expect(events.find((event) => event.type === "text")).toEqual({ type: "text", delta: "I could not look that up on this device." });
  });
});
