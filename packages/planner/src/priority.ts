import { hoursUntil, isActive, type AcademicItem } from "@nova-agent/core";

/**
 * Deterministic priority engine. No I/O, no randomness, no LLM.
 *
 *   score = round(clamp(urgency + typeWeight + importance + effortPressure + pointImpact, 0, 100))
 */

export type PriorityComponents = {
  urgency: number;
  typeWeight: number;
  importance: number;
  effortPressure: number;
  pointImpact: number;
};

export type PriorityResult = {
  key: string;
  score: number;
  components: PriorityComponents;
  hoursUntilDue: number | null;
  overdue: boolean;
  /** Within-course points percentile (0..1) when enough data exists, else null. */
  pointsPercentile: number | null;
};

export type RankedItem = { item: AcademicItem; priority: PriorityResult };

export const URGENCY_WINDOW_HOURS = 168;
export const MIN_ITEMS_FOR_POINT_IMPACT = 3;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const urgencyScore = (hoursUntilDue: number | null): number => {
  if (hoursUntilDue === null) return 0;
  if (hoursUntilDue <= 0) return 50;
  if (hoursUntilDue >= URGENCY_WINDOW_HOURS) return 0;
  return 40 * (1 - hoursUntilDue / URGENCY_WINDOW_HOURS);
};

export const typeWeightScore = (kind: AcademicItem["kind"]): number => (kind === "quiz" ? 10 : 6);

export const importanceScore = (importance: AcademicItem["importance"]): number => {
  switch (importance) {
    case "high":
      return 10;
    case "low":
      return 0;
    default:
      return 5;
  }
};

export const effortPressureScore = (estimatedMinutes: number | null, hoursUntilDue: number | null): number => {
  if (estimatedMinutes === null || hoursUntilDue === null) return 0;
  const estimatedHours = estimatedMinutes / 60;
  const remaining = Math.max(hoursUntilDue, 0);
  return Math.min(15, (15 * estimatedHours) / Math.max(remaining / 4, 1));
};

/**
 * Percentile of `points` among `courseKnownPoints` (all active items in the same
 * course with known points). Returns null when fewer than three items have
 * known points.
 */
export const pointsPercentile = (points: number | null, courseKnownPoints: readonly number[]): number | null => {
  if (points === null || courseKnownPoints.length < MIN_ITEMS_FOR_POINT_IMPACT) return null;
  const others = courseKnownPoints.length - 1;
  if (others <= 0) return null;
  const below = courseKnownPoints.filter((value) => value < points).length;
  return clamp(below / others, 0, 1);
};

export const pointImpactScore = (percentile: number | null): number => (percentile === null ? 0 : percentile * 10);

export type ScoreContext = {
  now: Date;
  /** Known points of active items per course, used for the percentile. */
  courseKnownPoints: ReadonlyMap<string, readonly number[]>;
};

export const scoreItem = (item: AcademicItem, context: ScoreContext): PriorityResult => {
  const hoursUntilDue = hoursUntil(item.dueAt, context.now);
  const overdue = hoursUntilDue !== null && hoursUntilDue < 0;
  const percentile = pointsPercentile(item.pointsPossible, context.courseKnownPoints.get(item.courseId) ?? []);
  const components: PriorityComponents = {
    urgency: urgencyScore(hoursUntilDue),
    typeWeight: typeWeightScore(item.kind),
    importance: importanceScore(item.importance),
    effortPressure: effortPressureScore(item.estimatedMinutes, overdue ? 0 : hoursUntilDue),
    pointImpact: pointImpactScore(percentile),
  };
  const total = components.urgency + components.typeWeight + components.importance + components.effortPressure + components.pointImpact;
  return { key: item.key, score: Math.round(clamp(total, 0, 100)), components, hoursUntilDue, overdue, pointsPercentile: percentile };
};

/**
 * Eligibility: submitted, completed, and hidden items are excluded. Scheduled
 * (not-yet-available) items rank only when they carry a due date.
 */
export const isEligible = (item: AcademicItem): boolean => {
  if (!isActive(item)) return false;
  if (item.visibility === "scheduled" && !item.dueAt) return false;
  return true;
};

const dueTime = (item: AcademicItem): number => (item.dueAt ? new Date(item.dueAt).getTime() : Number.POSITIVE_INFINITY);

/** Stable ordering: score desc, due asc (missing last), quiz first, locale title, stable key. */
export const compareRanked = (a: RankedItem, b: RankedItem): number => {
  if (a.priority.score !== b.priority.score) return b.priority.score - a.priority.score;
  const dueDiff = dueTime(a.item) - dueTime(b.item);
  if (dueDiff !== 0 && !Number.isNaN(dueDiff)) return dueDiff;
  if (a.item.kind !== b.item.kind) return a.item.kind === "quiz" ? -1 : 1;
  const title = a.item.title.localeCompare(b.item.title, undefined, { sensitivity: "base", numeric: true });
  if (title !== 0) return title;
  return a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0;
};

export const buildCourseKnownPoints = (items: readonly AcademicItem[]): Map<string, number[]> => {
  const map = new Map<string, number[]>();
  for (const item of items) {
    if (!isEligible(item) || item.pointsPossible === null) continue;
    const list = map.get(item.courseId) ?? [];
    list.push(item.pointsPossible);
    map.set(item.courseId, list);
  }
  return map;
};

export const rankItems = (items: readonly AcademicItem[], options: { now: Date }): RankedItem[] => {
  const context: ScoreContext = { now: options.now, courseKnownPoints: buildCourseKnownPoints(items) };
  return items
    .filter(isEligible)
    .map((item) => ({ item, priority: scoreItem(item, context) }))
    .sort(compareRanked);
};
