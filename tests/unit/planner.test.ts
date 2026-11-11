import { describe, expect, it } from "vitest";
import {
  BAND_LABELS,
  compareRanked,
  crunchScore,
  describePriority,
  effortScore,
  explainPriority,
  isEligible,
  isLateWindowOpen,
  momentumScore,
  pointsPercentile,
  priorityBand,
  rankItems,
  scoreItem,
  stakesScore,
  urgencyScore,
  weightScore,
} from "@nova-agent/planner";
import { makeItem } from "../helpers/factories";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const emptyContext = { now: NOW, courseKnownPoints: new Map<string, number[]>() };

describe("priority components", () => {
  it("urgency", () => {
    expect(urgencyScore(-1)).toBe(50);
    expect(urgencyScore(0)).toBe(50);
    expect(urgencyScore(84)).toBeCloseTo(20);
    expect(urgencyScore(168)).toBe(0);
    expect(urgencyScore(500)).toBe(0);
    expect(urgencyScore(null)).toBe(0);
  });

  it("stakes from what Brightspace says about the work", () => {
    expect(stakesScore({ kind: "assignment" })).toBe(6);
    expect(stakesScore({ kind: "quiz" })).toBe(8);
    expect(stakesScore({ kind: "quiz", timeLimitMinutes: 30 })).toBe(12);
    expect(stakesScore({ kind: "quiz", timeLimitMinutes: 90, proctored: true, attemptsAllowed: 1 })).toBe(20);
    expect(stakesScore({ kind: "quiz", attemptsAllowed: null })).toBe(4);
    expect(stakesScore({ kind: "quiz", attemptsAllowed: 3 })).toBe(8);
    expect(stakesScore({ kind: "assignment", group: true })).toBe(9);
    expect(stakesScore({ kind: "assignment", group: true, hasRubric: true })).toBe(11);
    // Quiz flags never apply to an assignment, and the result stays within 0..20.
    expect(stakesScore({ kind: "assignment", timeLimitMinutes: 60, proctored: true })).toBe(6);
  });

  it("weight from the course percentile, or absolute bands when the course is too thin", () => {
    expect(pointsPercentile(50, [50, 100])).toBeNull();
    expect(pointsPercentile(null, [10, 20, 30])).toBeNull();
    expect(pointsPercentile(30, [10, 20, 30])).toBe(1);
    expect(pointsPercentile(10, [10, 20, 30])).toBe(0);
    expect(pointsPercentile(20, [10, 20, 30])).toBe(0.5);
    expect(weightScore(20, 0.5)).toBe(7.5);
    expect(weightScore(null, null)).toBe(3);
    expect(weightScore(100, null)).toBe(10);
    expect(weightScore(50, null)).toBe(7);
    expect(weightScore(20, null)).toBe(4);
    expect(weightScore(5, null)).toBe(2);
  });

  it("momentum, crunch, and effort", () => {
    expect(momentumScore({ status: "not-started" }, false)).toBe(0);
    expect(momentumScore({ status: "in-progress" }, false)).toBe(5);
    expect(momentumScore({ status: "not-started" }, true)).toBe(10);
    expect(crunchScore(0)).toBe(0);
    expect(crunchScore(1)).toBe(4);
    expect(crunchScore(2)).toBe(8);
    expect(crunchScore(5)).toBe(10);
    expect(effortScore(null, 10)).toBe(0);
    expect(effortScore(120, null)).toBe(0);
    // 2h, 8h left -> 10 * 2 / max(2, 1) = 10 (cap)
    expect(effortScore(120, 8)).toBe(10);
    // 1h, 40h left -> 10 * 1 / 10 = 1
    expect(effortScore(60, 40)).toBeCloseTo(1);
    expect(effortScore(30, 0)).toBe(5);
  });

  it("late window: overdue but the availability end date is still ahead", () => {
    expect(isLateWindowOpen({ dueAt: inHours(-5), endAt: inHours(40) }, NOW)).toBe(true);
    expect(isLateWindowOpen({ dueAt: inHours(-5), endAt: inHours(-1) }, NOW)).toBe(false);
    expect(isLateWindowOpen({ dueAt: inHours(5), endAt: inHours(40) }, NOW)).toBe(false);
    expect(isLateWindowOpen({ dueAt: inHours(-5), endAt: null }, NOW)).toBe(false);
  });

  it("combines components into a rounded, clamped score", () => {
    const item = makeItem({ sourceId: "1", courseId: "c", kind: "quiz", dueAt: inHours(-2), endAt: inHours(20), timeLimitMinutes: 90, proctored: true, attemptsAllowed: 1, estimatedMinutes: 90, pointsPossible: 100 });
    const result = scoreItem(item, emptyContext);
    expect(result.components).toEqual({ urgency: 50, stakes: 20, weight: 10, momentum: 10, crunch: 0, effort: 10 });
    expect(result.score).toBe(100);
    expect(result.overdue).toBe(true);
    expect(result.lateWindowOpen).toBe(true);
  });

  it("handles missing due date, points, and estimate", () => {
    const result = scoreItem(makeItem({ sourceId: "1", courseId: "c" }), emptyContext);
    expect(result.components).toEqual({ urgency: 0, stakes: 6, weight: 3, momentum: 0, crunch: 0, effort: 0 });
    expect(result.hoursUntilDue).toBeNull();
    expect(result.score).toBe(9);
  });
});

describe("eligibility and ranking", () => {
  it("excludes submitted, completed, and hidden items; scheduled items need a due date", () => {
    expect(isEligible(makeItem({ sourceId: "1", courseId: "c", status: "submitted" }))).toBe(false);
    expect(isEligible(makeItem({ sourceId: "2", courseId: "c", status: "completed" }))).toBe(false);
    expect(isEligible(makeItem({ sourceId: "3", courseId: "c", visibility: "hidden" }))).toBe(false);
    expect(isEligible(makeItem({ sourceId: "3b", courseId: "c", visibility: "expired", dueAt: inHours(-400) }))).toBe(false);
    expect(isEligible(makeItem({ sourceId: "4", courseId: "c", visibility: "scheduled" }))).toBe(false);
    expect(isEligible(makeItem({ sourceId: "5", courseId: "c", visibility: "scheduled", dueAt: inHours(48) }))).toBe(true);
    expect(isEligible(makeItem({ sourceId: "6", courseId: "c", status: "unknown" }))).toBe(true);
  });

  it("applies the percentile within a course only when three or more items have points", () => {
    const items = [
      makeItem({ sourceId: "1", courseId: "c", pointsPossible: 100, dueAt: inHours(100) }),
      makeItem({ sourceId: "2", courseId: "c", pointsPossible: 10, dueAt: inHours(100) }),
      makeItem({ sourceId: "3", courseId: "c", pointsPossible: 50, dueAt: inHours(100) }),
      makeItem({ sourceId: "4", courseId: "d", pointsPossible: 100, dueAt: inHours(100) }),
      makeItem({ sourceId: "5", courseId: "d", pointsPossible: 10, dueAt: inHours(100) }),
    ];
    const ranked = rankItems(items, { now: NOW });
    const byId = Object.fromEntries(ranked.map((r) => [r.item.sourceId, r.priority]));
    expect(byId["1"]?.components.weight).toBe(15);
    expect(byId["3"]?.components.weight).toBe(7.5);
    expect(byId["2"]?.components.weight).toBe(0);
    // Course d has only two known: absolute bands.
    expect(byId["4"]?.components.weight).toBe(10);
    expect(byId["5"]?.components.weight).toBe(2);
  });

  it("counts crunch across every eligible item, within a day either side, excluding done ones", () => {
    const items = [
      makeItem({ sourceId: "a", courseId: "c", dueAt: inHours(48) }),
      makeItem({ sourceId: "b", courseId: "d", dueAt: inHours(60) }),
      makeItem({ sourceId: "c", courseId: "e", dueAt: inHours(75) }),
      makeItem({ sourceId: "done", courseId: "e", dueAt: inHours(50), status: "submitted" }),
      makeItem({ sourceId: "far", courseId: "e", dueAt: inHours(120) }),
    ];
    const byId = Object.fromEntries(rankItems(items, { now: NOW }).map((r) => [r.item.sourceId, r.priority]));
    expect(byId["a"]?.crunchCount).toBe(1);
    expect(byId["b"]?.crunchCount).toBe(2);
    expect(byId["c"]?.crunchCount).toBe(1);
    expect(byId["far"]?.crunchCount).toBe(0);
    expect(byId["b"]?.components.crunch).toBe(8);
  });

  it("ranks a timed single-attempt quiz above a same-week homework, and an unlimited practice quiz below it", () => {
    const quiz = makeItem({ sourceId: "q", courseId: "c", kind: "quiz", title: "Quiz 2", dueAt: inHours(72), timeLimitMinutes: 30, attemptsAllowed: 1 });
    const homework = makeItem({ sourceId: "h", courseId: "c", title: "Homework 5", dueAt: inHours(72), pointsPossible: 40 });
    const practice = makeItem({ sourceId: "p", courseId: "c", kind: "quiz", title: "Practice", dueAt: inHours(72), attemptsAllowed: null });
    const order = rankItems([practice, homework, quiz], { now: NOW }).map((r) => r.item.sourceId);
    expect(order).toEqual(["q", "h", "p"]);
  });

  it("breaks ties deterministically", () => {
    const base = { courseId: "c", dueAt: inHours(24) };
    const a = makeItem({ sourceId: "a", ...base, title: "Beta", kind: "assignment", pointsPossible: 20 });
    const b = makeItem({ sourceId: "b", ...base, title: "Alpha", kind: "assignment", pointsPossible: 20 });
    // quiz: 8 + unknown points 3 == assignment 6 + 20 points 4 + ... crunch equal for all three.
    const q = makeItem({ sourceId: "q", ...base, title: "Zeta", kind: "quiz", attemptsAllowed: 2 });
    const noDate = makeItem({ sourceId: "n", courseId: "c", title: "Aardvark" });
    const ranked = rankItems([noDate, a, b, q], { now: NOW });
    const equal = ranked.filter((r) => r.item.dueAt === base.dueAt).map((r) => r.item.sourceId);
    expect(equal).toEqual(["q", "b", "a"]);
    expect(ranked.at(-1)?.item.sourceId).toBe("n");
    const twin = { ...a, key: a.key + "z" };
    expect(compareRanked({ item: a, priority: scoreItem(a, emptyContext) }, { item: twin, priority: scoreItem(twin, emptyContext) })).toBeLessThan(0);
  });

  it("is deterministic across runs", () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      makeItem({ sourceId: String(i), courseId: i % 2 ? "c" : "d", dueAt: inHours((i * 7) % 90), kind: i % 3 ? "assignment" : "quiz", pointsPossible: (i * 13) % 50 }),
    );
    const first = rankItems(items, { now: NOW }).map((r) => `${r.item.key}:${r.priority.score}`);
    const second = rankItems([...items].reverse(), { now: NOW }).map((r) => `${r.item.key}:${r.priority.score}`);
    expect(second).toEqual(first);
  });
});

describe("explanations", () => {
  it("match the calculated components and name the strongest ones", () => {
    const item = makeItem({ sourceId: "1", courseId: "c", dueAt: inHours(14), estimatedMinutes: 120, pointsPossible: 40 });
    const priority = scoreItem(item, emptyContext);
    const reasons = explainPriority(item, priority);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toMatchObject({ component: "urgency", text: "Due in 14 hours." });
    expect(reasons[0]?.value).toBeCloseTo(priority.components.urgency);
    expect(reasons.map((r) => r.component)).toEqual(["urgency", "effort"]);
    expect(reasons[1]?.text).toBe("Estimated to take 2 hours.");

    const quiz = makeItem({ sourceId: "2", courseId: "c", kind: "quiz", dueAt: inHours(14), timeLimitMinutes: 45, attemptsAllowed: 1 });
    const quizReasons = explainPriority(quiz, scoreItem(quiz, emptyContext));
    expect(quizReasons.map((r) => r.component)).toEqual(["urgency", "stakes"]);
    expect(quizReasons[1]?.text).toBe("Timed, one attempt: treat it like an exam.");
  });

  it("explains overdue with a late window, weight, crunch, and a draft", () => {
    const item = makeItem({ sourceId: "1", courseId: "c", dueAt: inHours(-50), endAt: inHours(40), pointsPossible: 100 });
    const priority = scoreItem(item, { now: NOW, courseKnownPoints: new Map([["c", [10, 50, 100]]]) });
    expect(explainPriority(item, priority, 3).map((r) => r.text)).toEqual([
      "Overdue by 2 days and still unfinished.",
      "Worth 100 points, the biggest item in this course.",
      "Overdue, but still open for a late submission.",
    ]);
    const draft = makeItem({ sourceId: "2", courseId: "c", dueAt: inHours(100), status: "in-progress", group: true });
    const draftPriority = scoreItem(draft, { ...emptyContext, dueTimes: new Map([[draft.key, NOW.getTime() + 100 * 3_600_000], ["other", NOW.getTime() + 110 * 3_600_000]]) });
    expect(explainPriority(draft, draftPriority, 4).map((r) => r.text)).toEqual([
      "Due in 4 days.",
      "Group work, so coordinate early.",
      "You saved a draft and have not submitted it.",
      "Another deadline lands within a day of this one.",
    ]);
  });

  it("falls back to baseline components when nothing stronger exists", () => {
    const item = makeItem({ sourceId: "1", courseId: "c" });
    const reasons = explainPriority(item, scoreItem(item, emptyContext));
    expect(reasons.map((r) => r.component)).toEqual(["stakes", "weight"]);
    expect(reasons[1]?.text).toBe("Brightspace did not share the points for this one.");
  });

  it("reads the score as a band and a sentence", () => {
    expect(priorityBand(85)).toBe("now");
    expect(priorityBand(70)).toBe("now");
    expect(priorityBand(50)).toBe("soon");
    expect(priorityBand(25)).toBe("steady");
    expect(priorityBand(9)).toBe("later");
    expect(BAND_LABELS.now).toBe("Do this first");
    const item = makeItem({ sourceId: "1", courseId: "c", kind: "quiz", dueAt: inHours(-2), endAt: inHours(20), timeLimitMinutes: 90, attemptsAllowed: 1 });
    const text = describePriority(item, scoreItem(item, emptyContext));
    expect(text).toBe("Top of the list at 79 out of 100. Urgency and stakes carry nearly all of it; crunch, effort add nothing yet.");
    const quiet = makeItem({ sourceId: "2", courseId: "c" });
    expect(describePriority(quiet, scoreItem(quiet, emptyContext))).toBe("Nothing to rush at 9 out of 100. Nothing specific lifts it: no due date pressure, no known weight, nothing in motion.");
  });
});
