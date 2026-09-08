import { describe, expect, it } from "vitest";
import {
  compareRanked,
  effortPressureScore,
  explainPriority,
  importanceScore,
  isEligible,
  pointImpactScore,
  pointsPercentile,
  rankItems,
  scoreItem,
  typeWeightScore,
  urgencyScore,
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

  it("type weight and importance", () => {
    expect(typeWeightScore("quiz")).toBe(10);
    expect(typeWeightScore("assignment")).toBe(6);
    expect(importanceScore("high")).toBe(10);
    expect(importanceScore("normal")).toBe(5);
    expect(importanceScore("low")).toBe(0);
  });

  it("effort pressure", () => {
    expect(effortPressureScore(null, 10)).toBe(0);
    expect(effortPressureScore(120, null)).toBe(0);
    // 2h estimate, 8h left -> 15 * 2 / max(2, 1) = 15
    expect(effortPressureScore(120, 8)).toBe(15);
    // 1h estimate, 40h left -> 15 * 1 / 10 = 1.5
    expect(effortPressureScore(60, 40)).toBeCloseTo(1.5);
    // capped at 15
    expect(effortPressureScore(600, 1)).toBe(15);
    // overdue uses hoursUntilDue = 0 -> divisor 1
    expect(effortPressureScore(30, 0)).toBe(7.5);
  });

  it("point impact only with enough known points in the course", () => {
    expect(pointsPercentile(50, [50, 100])).toBeNull();
    expect(pointsPercentile(null, [10, 20, 30])).toBeNull();
    expect(pointsPercentile(30, [10, 20, 30])).toBe(1);
    expect(pointsPercentile(10, [10, 20, 30])).toBe(0);
    expect(pointsPercentile(20, [10, 20, 30])).toBe(0.5);
    expect(pointImpactScore(0.5)).toBe(5);
    expect(pointImpactScore(null)).toBe(0);
  });

  it("combines components into a rounded, clamped score", () => {
    const item = makeItem({ sourceId: "1", courseId: "c", kind: "quiz", dueAt: inHours(-2), importance: "high", estimatedMinutes: 600 });
    const result = scoreItem(item, emptyContext);
    expect(result.components).toEqual({ urgency: 50, typeWeight: 10, importance: 10, effortPressure: 15, pointImpact: 0 });
    expect(result.score).toBe(85);
    expect(result.overdue).toBe(true);
  });

  it("handles missing due date and missing estimate", () => {
    const result = scoreItem(makeItem({ sourceId: "1", courseId: "c" }), emptyContext);
    expect(result.components).toEqual({ urgency: 0, typeWeight: 6, importance: 5, effortPressure: 0, pointImpact: 0 });
    expect(result.hoursUntilDue).toBeNull();
    expect(result.score).toBe(11);
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

  it("applies point impact within a course only when three or more items have points", () => {
    const items = [
      makeItem({ sourceId: "1", courseId: "c", pointsPossible: 100, dueAt: inHours(100) }),
      makeItem({ sourceId: "2", courseId: "c", pointsPossible: 10, dueAt: inHours(100) }),
      makeItem({ sourceId: "3", courseId: "c", pointsPossible: 50, dueAt: inHours(100) }),
      makeItem({ sourceId: "4", courseId: "d", pointsPossible: 100, dueAt: inHours(100) }),
      makeItem({ sourceId: "5", courseId: "d", pointsPossible: 10, dueAt: inHours(100) }),
    ];
    const ranked = rankItems(items, { now: NOW });
    const byId = Object.fromEntries(ranked.map((r) => [r.item.sourceId, r.priority]));
    expect(byId["1"]?.components.pointImpact).toBe(10);
    expect(byId["3"]?.components.pointImpact).toBe(5);
    expect(byId["2"]?.components.pointImpact).toBe(0);
    expect(byId["4"]?.components.pointImpact).toBe(0);
    expect(byId["5"]?.components.pointImpact).toBe(0);
  });

  it("breaks ties deterministically", () => {
    const base = { courseId: "c", dueAt: inHours(24) };
    const a = makeItem({ sourceId: "a", ...base, title: "Beta", kind: "assignment" });
    const b = makeItem({ sourceId: "b", ...base, title: "Alpha", kind: "assignment" });
    // quiz 10 + low 0 + effort 1 (24 min, 24 h left) == assignment 6 + normal 5.
    const q = makeItem({ sourceId: "q", ...base, title: "Zeta", kind: "quiz", importance: "low", estimatedMinutes: 24 });
    const later = makeItem({ sourceId: "l", courseId: "c", dueAt: inHours(30), title: "Aardvark", importance: "high" });
    const noDate = makeItem({ sourceId: "n", courseId: "c", title: "Aardvark" });
    const ranked = rankItems([later, noDate, a, b, q], { now: NOW });
    const scores = ranked.map((r) => r.priority.score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1] as number);
    // Among equal scores at the same due time: quiz first, then locale title.
    const equal = ranked.filter((r) => r.item.dueAt === base.dueAt).map((r) => r.item.sourceId);
    expect(equal).toEqual(["q", "b", "a"]);
    expect(ranked.at(-1)?.item.sourceId).toBe("n");
    // Sorting is a strict total order over stable keys.
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
  it("match the calculated components", () => {
    const item = makeItem({ sourceId: "1", courseId: "c", dueAt: inHours(14), estimatedMinutes: 120 });
    const priority = scoreItem(item, emptyContext);
    const reasons = explainPriority(item, priority);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toMatchObject({ component: "urgency", text: "Due in 14 hours." });
    expect(reasons[0]?.value).toBeCloseTo(priority.components.urgency);
    expect(reasons.map((r) => r.component)).toEqual(["urgency", "effortPressure"]);
    expect(reasons[1]?.text).toBe("Estimated to take 2 hours.");

    const quiz = makeItem({ sourceId: "2", courseId: "c", kind: "quiz", dueAt: inHours(14), estimatedMinutes: 120 });
    const quizReasons = explainPriority(quiz, scoreItem(quiz, emptyContext));
    expect(quizReasons.map((r) => r.component)).toEqual(["urgency", "typeWeight"]);
  });

  it("explains overdue and point impact", () => {
    const item = makeItem({ sourceId: "1", courseId: "c", dueAt: inHours(-3), pointsPossible: 100 });
    const priority = scoreItem(item, { now: NOW, courseKnownPoints: new Map([["c", [10, 50, 100]]]) });
    const reasons = explainPriority(item, priority);
    expect(reasons.map((r) => r.text)).toEqual(["Overdue and still unfinished.", "One of the higher-point items in this course."]);
  });

  it("falls back to baseline components when nothing stronger exists", () => {
    const item = makeItem({ sourceId: "1", courseId: "c" });
    const reasons = explainPriority(item, scoreItem(item, emptyContext));
    expect(reasons.map((r) => r.component)).toEqual(["typeWeight", "importance"]);
  });
});
