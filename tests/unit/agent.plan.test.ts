import { ESTIMATE_NOTE, ScriptedModel, compactSnapshot, executeTool, formatMinutes, runTurn, type ToolResult } from "@nova-agent/agent";
import type { AcademicItem } from "@nova-agent/core";
import { estimateStudyMinutes } from "@nova-agent/planner";
import { compactSnapshotSchema, toolRowSchema, type AskEvent, type CompactSnapshot, type ToolRow } from "@nova-agent/protocol";
import { describe, expect, it } from "vitest";
import { makeCourse, makeItem, makeSnapshot } from "../helpers/factories";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

// NOW is Tuesday 2026-09-08 at 2:00 PM in New York.
const at = (date: string, time = "23:59") => new Date(`${date}T${time}:00-04:00`).toISOString();

type Seed = Partial<AcademicItem> & { sourceId: string; title: string };
const build = (seeds: Seed[], options: Parameters<typeof compactSnapshot>[3] = { mode: "live" }): CompactSnapshot => {
  const items = seeds.map((seed) => makeItem({ courseId: "c1", ...seed }));
  const courses = [makeCourse("c1", { name: "Circuits" }), makeCourse("c2", { name: "Writing" })];
  return compactSnapshot(makeSnapshot(NOW.toISOString(), items, { courses }), [], NOW, { timezone: "America/New_York", ...options });
};

type PlanDay = Extract<ToolRow, { kind: "plan-day" }>;
type PlanData = { planId: string; start: string; end: string; note: string; minutesPerDay: number; leftOut: { title: string; minutesMissing: number; reason: string }[]; freeMinutes: number; plan: { date: string; minutes: number; slots: { title: string; minutes: number; reason: string }[] }[]; ownDeadlinesInTheseDays?: { title: string }[] };

const plan = (snapshot: CompactSnapshot, args: unknown = {}) => {
  const result = executeTool("build_study_plan", args, { snapshot });
  if (!result.ok) throw new Error(result.error);
  return { result, days: result.rows as PlanDay[], data: result.data as PlanData };
};
const layout = (days: PlanDay[]) => days.map((day) => `${day.date}: ${day.slots.map((slot) => `${slot.title} ${slot.minutes}`).join(", ") || "-"}`);

describe("estimateStudyMinutes", () => {
  const assignment = (pointsPossible: number | null, extra: Partial<AcademicItem> = {}) => estimateStudyMinutes({ kind: "assignment", pointsPossible, estimatedMinutes: null, ...extra });
  it("sizes an assignment by its points, with a default when Brightspace does not say", () => {
    expect([assignment(null), assignment(5), assignment(20), assignment(50), assignment(100), assignment(400)]).toEqual([90, 60, 90, 120, 180, 180]);
    expect(assignment(50, { group: true })).toBe(150);
  });

  it("sizes a quiz by its time limit plus review, within bounds", () => {
    const quiz = (timeLimitMinutes: number | null) => estimateStudyMinutes({ kind: "quiz", pointsPossible: null, estimatedMinutes: timeLimitMinutes, timeLimitMinutes });
    expect([quiz(null), quiz(20), quiz(60), quiz(90), quiz(600)]).toEqual([75, 60, 105, 135, 240]);
    // A quiz normalized before time limits were kept apart still carries the limit as its estimate.
    expect(estimateStudyMinutes({ kind: "quiz", pointsPossible: null, estimatedMinutes: 50 })).toBe(90);
  });

  it("is carried on open items only", async () => {
    const compact = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo" });
    expect(compactSnapshotSchema.safeParse(compact).success).toBe(true);
    for (const item of compact.items) {
      if (item.bucket === "completed") expect(item.estimateMinutes).toBeUndefined();
      else expect(item.estimateMinutes).toBeGreaterThanOrEqual(30);
    }
  });
});

describe("build_study_plan", () => {
  const week: Seed[] = [
    { sourceId: "1", title: "Essay", dueAt: at("2026-09-10"), pointsPossible: 100 }, // 180 min, due Thu
    { sourceId: "2", title: "Worksheet", dueAt: at("2026-09-09"), pointsPossible: 10 }, // 60 min, due Wed
    { sourceId: "3", title: "Late lab", dueAt: at("2026-09-07", "17:00"), pointsPossible: 50 }, // 120 min, overdue
    { sourceId: "4", title: "Reading", dueAt: at("2026-09-20"), pointsPossible: 10 }, // 60 min, later
    { sourceId: "5", title: "Journal", dueAt: null, pointsPossible: null }, // 90 min, no date
  ];

  it("gives overdue work the earliest time on-time work does not need, then places by the day work has to be done, never past capacity or a deadline", () => {
    const { days, data, result } = plan(build(week), { days: 3, hoursPerDay: 2 });
    expect(layout(days)).toEqual(["2026-09-08: Late lab 120", "2026-09-09: Worksheet 60, Essay 60", "2026-09-10: Essay 120"]);
    for (const day of days) {
      expect(day.totalMinutes).toBeLessThanOrEqual(day.capacityMinutes);
      expect(day.totalMinutes).toBe(day.slots.reduce((sum, slot) => sum + slot.minutes, 0));
      expect(toolRowSchema.safeParse(day).success).toBe(true);
    }
    expect(data.leftOut).toEqual([]);
    expect(data.freeMinutes).toBe(0);
    expect(data.note).toBe(ESTIMATE_NOTE);
    expect(result.summary).toBe("Plan for 3 days from Tue, Sep 8 at 2 hours a day: 3 items in 4 slots.");
    expect(days[0]?.slots[0]?.reason).toBe("Overdue since Mon, Sep 7, 5:00 PM.");
    expect(days[1]?.slots[0]?.reason).toMatch(/^Due Wed, Sep 9, 11:59 PM\. /);
    expect(days.map((day) => day.title)).toEqual(["Tue, Sep 8", "Wed, Sep 9", "Thu, Sep 10"]);
  });

  it("uses spare time for later work by score, with undated work last, and never calls it left out", () => {
    const { days, data } = plan(build(week), { days: 3, hoursPerDay: 3 });
    expect(layout(days)).toEqual(["2026-09-08: Late lab 120, Worksheet 60", "2026-09-09: Essay 180", "2026-09-10: Reading 60, Journal 90"]);
    expect(days[2]?.slots.map((slot) => slot.reason)).toEqual(["Getting ahead. Due Sun, Sep 20, 11:59 PM.", "Getting ahead. No due date."]);
    expect(data.leftOut).toEqual([]);
    expect(data.freeMinutes).toBe(30);
  });

  it("reports what does not fit before its deadline instead of placing it late", () => {
    const { days, data, result } = plan(build(week), { days: 3, hoursPerDay: 1 });
    // One hour a day, six hours of work. What can still be on time comes first: the worksheet by Wednesday,
    // then as much of the essay as fits by Thursday. The lab is late either way and gets no time it would take from them.
    expect(layout(days)).toEqual(["2026-09-08: Worksheet 60", "2026-09-09: Essay 60", "2026-09-10: Essay 60"]);
    expect(data.leftOut.map((entry) => [entry.title, entry.minutesMissing])).toEqual([
      ["Late lab", 120],
      ["Essay", 60],
    ]);
    expect(data.leftOut[0]?.reason).toBe("Overdue, and 2 hours of it does not fit in 3 days at 1 hour a day once work that can still be on time has its time.");
    expect(data.leftOut[1]?.reason).toBe("Due Thu, Sep 10, 11:59 PM: 1 hour of it does not fit before then at 1 hour a day.");
    expect(result.summary).toBe("Plan for 3 days from Tue, Sep 8 at 1 hour a day: 2 items in 3 slots, 2 do not fully fit.");
    // Nothing sits after the day it is due.
    expect(days.find((day) => day.date === "2026-09-10")?.slots.some((slot) => slot.title === "Worksheet")).toBe(false);
  });

  it("does not let overdue work push out something due tonight", () => {
    const tonight = build([
      { sourceId: "1", title: "Late lab", dueAt: at("2026-09-07", "17:00"), pointsPossible: 50 }, // 120 min, overdue
      { sourceId: "2", title: "Problem set", dueAt: at("2026-09-08", "23:59"), pointsPossible: 20 }, // 90 min, due tonight
      { sourceId: "3", title: "Project", dueAt: at("2026-09-10", "23:59"), pointsPossible: 100 }, // 180 min, due Thursday
    ]);
    const { days, data } = plan(tonight, { days: 3, hoursPerDay: 2 });
    // Tonight's problem set keeps its 90 minutes; the lab gets the 30 left today and nothing the project needs later.
    expect(layout(days)).toEqual(["2026-09-08: Late lab 30, Problem set 90", "2026-09-09: Late lab 60, Project 60", "2026-09-10: Project 120"]);
    expect(data.leftOut.map((entry) => [entry.title, entry.minutesMissing])).toEqual([["Late lab", 30]]);
    // With room for everything, overdue work still goes first.
    expect(layout(plan(tonight, { days: 3, hoursPerDay: 4 }).days)).toEqual(["2026-09-08: Late lab 120, Problem set 90, Project 30", "2026-09-09: Project 150", "2026-09-10: -"]);
  });

  it("finishes work due before noon on the day before", () => {
    const morning = build([{ sourceId: "1", title: "Morning quiz prep", kind: "quiz", dueAt: at("2026-09-10", "09:00") }, { sourceId: "2", title: "Evening essay", dueAt: at("2026-09-10", "23:59"), pointsPossible: 10 }]);
    const { days } = plan(morning, { days: 3, hoursPerDay: 1 });
    // The quiz (75 min) must be done by Wednesday night; the essay may use Thursday itself.
    expect(layout(days)).toEqual(["2026-09-08: Morning quiz prep 60", "2026-09-09: Morning quiz prep 15, Evening essay 45", "2026-09-10: Evening essay 15"]);
  });

  it("leaves out work marked done, long overdue work, hidden work, and the student's own deadlines", () => {
    const seeds: Seed[] = [
      { sourceId: "1", title: "Open task", dueAt: at("2026-09-09"), pointsPossible: 10 },
      { sourceId: "2", title: "Marked task", dueAt: at("2026-09-09"), pointsPossible: 10 },
      { sourceId: "3", title: "Ancient task", dueAt: at("2026-08-01"), pointsPossible: 10 },
      { sourceId: "4", title: "Submitted task", dueAt: at("2026-09-09"), pointsPossible: 10, status: "submitted" },
      { sourceId: "5", title: "Hidden task", dueAt: at("2026-09-09"), pointsPossible: 10 },
    ];
    const items = seeds.map((seed) => makeItem({ courseId: "c1", ...seed }));
    const snapshot = compactSnapshot(makeSnapshot(NOW.toISOString(), items, { courses: [makeCourse("c1", { name: "Circuits" })] }), [], NOW, {
      mode: "live",
      timezone: "America/New_York",
      localDone: new Set([items[1]?.key ?? ""]),
      dismissedItemKeys: new Set([items[4]?.key ?? ""]),
      personal: [
        { id: "p1", title: "Office hours", dueAt: at("2026-09-09", "15:00"), courseId: "c1", completedAt: null },
        { id: "p2", title: "Work on: Open task", dueAt: at("2026-09-09"), courseId: "c1", completedAt: null, planId: "plan-old" },
        { id: "p3", title: "Far away", dueAt: at("2026-10-09"), courseId: null, completedAt: null },
      ],
    });
    const { days, data } = plan(snapshot, { days: 2 });
    expect(layout(days)).toEqual(["2026-09-08: Open task 60", "2026-09-09: -"]);
    // Own deadlines inside the days are mentioned, never scheduled, and an earlier plan's slots are not echoed back.
    expect(data.ownDeadlinesInTheseDays?.map((entry) => entry.title)).toEqual(["Office hours"]);
    expect(snapshot.personal?.find((deadline) => deadline.id === "p2")?.fromPlan).toBe(true);
  });

  it("is the same plan for the same request, under the same id, and a different id for a different request", () => {
    const snapshot = build(week);
    const first = plan(snapshot, { days: 3, hoursPerDay: 2 });
    const second = plan(snapshot, { hoursPerDay: 2, days: 3 });
    expect(second.days).toEqual(first.days);
    expect(first.data.planId).toBe("plan-2026-09-08-3d-120m-all");
    expect(first.days.every((day) => day.planId === first.data.planId && day.id === `${day.planId}:${day.date}`)).toBe(true);
    expect(plan(snapshot, { days: 3, hoursPerDay: 3 }).data.planId).toBe("plan-2026-09-08-3d-180m-all");
    expect(plan(snapshot, { days: 3, hoursPerDay: 2, course: "circ" }).data.planId).toBe("plan-2026-09-08-3d-120m-c1");
    // Defaults: three days, two hours.
    expect(plan(snapshot).data.planId).toBe("plan-2026-09-08-3d-120m-all");
  });

  it("plans one course, starts on a later day, and validates its arguments", () => {
    const mixed = compactSnapshot(
      makeSnapshot(NOW.toISOString(), [makeItem({ sourceId: "1", courseId: "c1", title: "Circuits lab", dueAt: at("2026-09-12"), pointsPossible: 10 }), makeItem({ sourceId: "2", courseId: "c2", title: "Writing draft", dueAt: at("2026-09-12"), pointsPossible: 10 })], { courses: [makeCourse("c1", { name: "Circuits" }), makeCourse("c2", { name: "Writing" })] }),
      [],
      NOW,
      { mode: "live", timezone: "America/New_York" },
    );
    const writing = plan(mixed, { course: "writ", days: 1 });
    expect(layout(writing.days)).toEqual(["2026-09-08: Writing draft 60"]);
    expect(writing.result.summary).toBe("Plan for 1 day from Tue, Sep 8 at 2 hours a day in Writing: 1 item in 1 slot.");
    const later = plan(mixed, { startDate: "2026-09-11", days: 2, hoursPerDay: 0.5 });
    expect(layout(later.days)).toEqual(["2026-09-11: Circuits lab 30", "2026-09-12: Circuits lab 30"]);
    expect(later.data.leftOut.map((entry) => entry.title)).toEqual(["Writing draft"]);
    expect(later.result.summary).toContain("from Fri, Sep 11 at 30 minutes a day");
    const bad = (args: unknown) => executeTool("build_study_plan", args, { snapshot: mixed }) as Extract<ToolResult, { ok: false }>;
    expect(bad({ startDate: "2026-09-07" }).error).toBe("startDate (2026-09-07) is in the past. Today is 2026-09-08.");
    expect(bad({ startDate: "next monday" }).error).toContain("must be a date like 2026-09-08");
    expect(bad({ startDate: "2026-02-30" }).error).toContain("must be a date like");
    expect(bad({ startDate: "2027-01-01" }).error).toContain("more than 60 days ahead");
    expect(bad({ days: 15 }).ok).toBe(false);
    expect(bad({ days: 0 }).ok).toBe(false);
    expect(bad({ hoursPerDay: 0.25 }).ok).toBe(false);
    expect(bad({ hoursPerDay: 13 }).ok).toBe(false);
    expect(bad({ course: "astronomy" }).error).toContain("No course matches");
  });

  it("is honest when there is nothing to plan", () => {
    const empty = plan(build([]), { days: 2 });
    expect(empty.result.summary).toBe("Nothing open to plan for 2 days from Tue, Sep 8 at 2 hours a day.");
    expect(empty.days).toHaveLength(2);
    expect(empty.days.every((day) => day.slots.length === 0 && day.totalMinutes === 0)).toBe(true);
  });

  it("caps the slots on a day and leaves no crumbs", () => {
    const many: Seed[] = Array.from({ length: 12 }, (_, i) => ({ sourceId: String(i + 1), title: `Task ${String(i + 1).padStart(2, "0")}`, dueAt: at("2026-09-08"), pointsPossible: 5 }));
    const capped = plan(build(many), { days: 1, hoursPerDay: 12 });
    expect(capped.days[0]?.slots).toHaveLength(8);
    expect(capped.data.leftOut).toHaveLength(4);
    // 100 minutes a day and a 90 minute task: the 10 minutes left are not worth a slot for the next task.
    const crumbs = plan(build([{ sourceId: "1", title: "First", dueAt: at("2026-09-09"), pointsPossible: null }, { sourceId: "2", title: "Second", dueAt: at("2026-09-09"), pointsPossible: null }]), { days: 2, hoursPerDay: 100 / 60 });
    expect(layout(crumbs.days)).toEqual(["2026-09-08: First 90", "2026-09-09: Second 90"]);
    expect(formatMinutes(100)).toBe("1.67 hours");
    expect(formatMinutes(45)).toBe("45 minutes");
  });

  it("lets an answer name the items in the plan without a second lookup", async () => {
    const snapshot = build(week);
    const events: AskEvent[] = [];
    const generator = runTurn({ snapshot, history: [], message: "Plan my next three days", model: new ScriptedModel([{ toolCalls: [{ name: "build_study_plan", args: { days: 3 } }] }, { text: ["Start with Late lab today, then Worksheet and Essay."] }]), maxTokens: 300, signal: new AbortController().signal });
    let result;
    for (;;) {
      const next = await generator.next();
      if (next.done) {
        result = next.value;
        break;
      }
      events.push(next.value);
    }
    expect(result).toMatchObject({ grounded: true, corrected: false, toolNames: ["build_study_plan"] });
    expect(result?.returnedTitles).toEqual(expect.arrayContaining(["Late lab", "Worksheet", "Essay"]));
    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult?.type === "tool_result" && toolResult.rows.every((row) => row.kind === "plan-day")).toBe(true);
  });
});

describe("get_course_load", () => {
  const seeds = [
    makeItem({ sourceId: "1", courseId: "c1", title: "Circuits lab", dueAt: at("2026-09-09"), pointsPossible: 50 }),
    makeItem({ sourceId: "2", courseId: "c1", title: "Circuits late", dueAt: at("2026-09-07", "17:00"), pointsPossible: 20 }),
    makeItem({ sourceId: "3", courseId: "c1", title: "Circuits ancient", dueAt: at("2026-08-01"), pointsPossible: 20 }),
    makeItem({ sourceId: "4", courseId: "c1", title: "Circuits graded", dueAt: at("2026-09-05"), pointsPossible: 20, status: "completed", score: { earned: 17, graded: true } }),
    makeItem({ sourceId: "5", courseId: "c2", title: "Writing essay", dueAt: at("2026-09-10"), pointsPossible: null }),
    makeItem({ sourceId: "6", courseId: "c2", title: "Writing later", dueAt: at("2026-09-25"), pointsPossible: 100 }),
    makeItem({ sourceId: "7", courseId: "c2", title: "Writing quiz", kind: "quiz", dueAt: at("2026-09-11"), pointsPossible: 30 }),
  ];
  const snapshot = compactSnapshot(makeSnapshot(NOW.toISOString(), seeds, { courses: [makeCourse("c1", { name: "Circuits" }), makeCourse("c2", { name: "Writing" }), makeCourse("c3", { name: "Yoga" })] }), [], NOW, { mode: "live", timezone: "America/New_York" });
  type Load = { course: string; open: number; overdue: number; longOverdue: number; dueInPeriod: number; pointsAtStake: number; itemsWithUnknownPoints: number; nextDeadline: { title: string } | null; gradedSoFar: { count: number; earned: number; possible: number } | null };
  const load = (args: unknown = {}) => {
    const result = executeTool("get_course_load", args, { snapshot });
    if (!result.ok) throw new Error(result.error);
    return { result, courses: (result.data as { courses: Load[] }).courses };
  };

  it("counts per course, with late work first, and agrees with list_deadlines on the period", () => {
    const { result, courses } = load();
    expect(courses.map((course) => course.course)).toEqual(["Circuits", "Writing", "Yoga"]);
    expect(courses[0]).toMatchObject({ open: 2, overdue: 1, longOverdue: 1, dueInPeriod: 1, pointsAtStake: 50, itemsWithUnknownPoints: 0, nextDeadline: { title: "Circuits lab" }, gradedSoFar: { count: 1, earned: 17, possible: 20 } });
    expect(courses[1]).toMatchObject({ open: 3, overdue: 0, dueInPeriod: 2, pointsAtStake: 30, itemsWithUnknownPoints: 1, nextDeadline: { title: "Writing essay" }, gradedSoFar: null });
    expect(courses[2]).toMatchObject({ open: 0, overdue: 0, dueInPeriod: 0, nextDeadline: null });
    expect(result.summary).toBe("3 courses, 3 items due in the next 7 days. Circuits has the most to do.");
    for (const course of ["Circuits", "Writing"]) {
      const listed = executeTool("list_deadlines", { course, includePersonal: false }, { snapshot });
      if (!listed.ok) throw new Error(listed.error);
      expect(courses.find((entry) => entry.course === course)?.dueInPeriod).toBe(listed.rows.length);
    }
    expect(result.rows.every((row) => row.kind === "course" && toolRowSchema.safeParse(row).success)).toBe(true);
    expect(result.rows[0]).toMatchObject({ kind: "course", id: "c1", title: "Circuits", open: 2, overdue: 1, dueInPeriod: 1, pointsAtStake: 50, url: "https://brightspace.villanova.edu/d2l/home/c1" });
  });

  it("takes the same periods as list_deadlines, and one course", () => {
    expect(load({ range: "all" }).courses.find((course) => course.course === "Writing")).toMatchObject({ dueInPeriod: 3, pointsAtStake: 130 });
    expect(load({ from: "2026-09-20", to: "2026-09-30" }).courses.map((course) => [course.course, course.dueInPeriod])).toEqual([
      ["Circuits", 0],
      ["Writing", 1],
      ["Yoga", 0],
    ]);
    const one = load({ course: "writ" });
    expect(one.courses).toHaveLength(1);
    expect(one.result.summary).toBe("Writing: 3 open items, 0 overdue, 2 due in the next 7 days.");
    expect(executeTool("get_course_load", { from: "soon" }, { snapshot })).toMatchObject({ ok: false });
    expect(executeTool("get_course_load", { course: "astronomy" }, { snapshot })).toMatchObject({ ok: false });
  });

  it("says when nothing is due anywhere", () => {
    const quiet = compactSnapshot(makeSnapshot(NOW.toISOString(), [], { courses: [makeCourse("c1", { name: "Circuits" })] }), [], NOW, { mode: "live" });
    const result = executeTool("get_course_load", {}, { snapshot: quiet });
    expect(result.ok && result.summary).toBe("1 course, 0 items due in the next 7 days.");
  });
});
