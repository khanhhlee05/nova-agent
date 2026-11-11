import { hoursUntil, isActive, type AcademicItem } from "@nova-agent/core";

/**
 * Deterministic priority engine. No I/O, no randomness, no LLM.
 *
 *   score = round(clamp(urgency + stakes + weight + momentum + crunch + effort, 0, 100))
 *
 * Every input is a field Brightspace already returns to Nova, or a local
 * derivation from them. Nothing here depends on an unverified route.
 */

export type PriorityComponents = {
  /** 0..50 from the due date: overdue is 50, otherwise 40 shrinking to 0 over the next 7 days. */
  urgency: number;
  /** 0..20 from what kind of work it is: quiz or assignment, timed, proctored, single attempt, group, rubric. */
  stakes: number;
  /** 0..15 from points possible, relative to the rest of the course when enough is known. */
  weight: number;
  /** 0..10 for work already in motion: a saved draft, or an overdue item whose late window is still open. */
  momentum: number;
  /** 0..10 when other deadlines land within a day of this one. */
  crunch: number;
  /** 0..10 when the time the work takes is known (a timed quiz, or a student estimate) and it crowds the time left. */
  effort: number;
};

export type PriorityResult = {
  key: string;
  score: number;
  components: PriorityComponents;
  hoursUntilDue: number | null;
  overdue: boolean;
  /** Within-course points percentile (0..1) when enough data exists, else null. */
  pointsPercentile: number | null;
  /** Overdue, but the availability end date is still ahead, so a late submission is possible. */
  lateWindowOpen: boolean;
  /** Other open items due within 24 hours of this one. */
  crunchCount: number;
};

export type RankedItem = { item: AcademicItem; priority: PriorityResult };

export const URGENCY_WINDOW_HOURS = 168;
export const MIN_ITEMS_FOR_POINT_IMPACT = 3;
export const CRUNCH_WINDOW_HOURS = 24;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const urgencyScore = (hoursUntilDue: number | null): number => {
  if (hoursUntilDue === null) return 0;
  if (hoursUntilDue <= 0) return 50;
  if (hoursUntilDue >= URGENCY_WINDOW_HOURS) return 0;
  return 40 * (1 - hoursUntilDue / URGENCY_WINDOW_HOURS);
};

/**
 * Base 6 for an assignment, 8 for a quiz. A quiz gains 4 each for being timed,
 * password or location restricted, and single attempt, and loses 4 when
 * attempts are unlimited. An assignment gains 3 for group work and 2 for a
 * rubric. Clamped to 0..20.
 */
export const stakesScore = (item: Pick<AcademicItem, "kind" | "timeLimitMinutes" | "proctored" | "attemptsAllowed" | "group" | "hasRubric">): number => {
  let score = item.kind === "quiz" ? 8 : 6;
  if (item.kind === "quiz") {
    if (item.timeLimitMinutes) score += 4;
    if (item.proctored) score += 4;
    if (item.attemptsAllowed === 1) score += 4;
    else if (item.attemptsAllowed === null) score -= 4;
  } else {
    if (item.group) score += 3;
    if (item.hasRubric) score += 2;
  }
  return clamp(score, 0, 20);
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

/** Percentile times 15 when known; otherwise absolute points bands, with 3 for "Brightspace did not say". */
export const weightScore = (points: number | null, percentile: number | null): number => {
  if (percentile !== null) return percentile * 15;
  if (points === null) return 3;
  if (points >= 100) return 10;
  if (points >= 50) return 7;
  if (points >= 20) return 4;
  return 2;
};

/** 10 when overdue with the late window still open, 5 for a saved draft, else 0. */
export const momentumScore = (item: Pick<AcademicItem, "status">, lateWindowOpen: boolean): number => {
  if (lateWindowOpen) return 10;
  if (item.status === "in-progress") return 5;
  return 0;
};

/** 4 per other deadline within 24 hours, capped at 10. */
export const crunchScore = (crunchCount: number): number => clamp(crunchCount * 4, 0, 10);

/** Known duration against the time left: 10 x hours / max(hours left / 4, 1), capped at 10. */
export const effortScore = (estimatedMinutes: number | null, hoursUntilDue: number | null): number => {
  if (estimatedMinutes === null || hoursUntilDue === null) return 0;
  const estimatedHours = estimatedMinutes / 60;
  const remaining = Math.max(hoursUntilDue, 0);
  return Math.min(10, (10 * estimatedHours) / Math.max(remaining / 4, 1));
};

export type ScoreContext = {
  now: Date;
  /** Known points of active items per course, used for the percentile. */
  courseKnownPoints: ReadonlyMap<string, readonly number[]>;
  /** Due instants (ms) of every eligible item, keyed by item key, for the crunch count. */
  dueTimes?: ReadonlyMap<string, number>;
};

const dueMs = (item: Pick<AcademicItem, "dueAt">): number | null => {
  if (!item.dueAt) return null;
  const value = new Date(item.dueAt).getTime();
  return Number.isNaN(value) ? null : value;
};

export const crunchCountFor = (item: Pick<AcademicItem, "key" | "dueAt">, dueTimes: ReadonlyMap<string, number> | undefined): number => {
  const due = dueMs(item);
  if (due === null || !dueTimes) return 0;
  let count = 0;
  for (const [key, other] of dueTimes) {
    if (key !== item.key && Math.abs(other - due) <= CRUNCH_WINDOW_HOURS * 3_600_000) count++;
  }
  return count;
};

export const isLateWindowOpen = (item: Pick<AcademicItem, "dueAt" | "endAt">, now: Date): boolean => {
  const due = dueMs(item);
  if (due === null || due >= now.getTime() || !item.endAt) return false;
  const end = new Date(item.endAt).getTime();
  return !Number.isNaN(end) && end > now.getTime();
};

export const scoreItem = (item: AcademicItem, context: ScoreContext): PriorityResult => {
  const hoursUntilDue = hoursUntil(item.dueAt, context.now);
  const overdue = hoursUntilDue !== null && hoursUntilDue < 0;
  const percentile = pointsPercentile(item.pointsPossible, context.courseKnownPoints.get(item.courseId) ?? []);
  const lateWindowOpen = isLateWindowOpen(item, context.now);
  const crunchCount = crunchCountFor(item, context.dueTimes);
  const components: PriorityComponents = {
    urgency: urgencyScore(hoursUntilDue),
    stakes: stakesScore(item),
    weight: weightScore(item.pointsPossible, percentile),
    momentum: momentumScore(item, lateWindowOpen),
    crunch: crunchScore(crunchCount),
    effort: effortScore(item.estimatedMinutes, overdue ? 0 : hoursUntilDue),
  };
  const total = components.urgency + components.stakes + components.weight + components.momentum + components.crunch + components.effort;
  return { key: item.key, score: Math.round(clamp(total, 0, 100)), components, hoursUntilDue, overdue, pointsPercentile: percentile, lateWindowOpen, crunchCount };
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

export const buildDueTimes = (items: readonly AcademicItem[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const item of items) {
    const due = isEligible(item) ? dueMs(item) : null;
    if (due !== null) map.set(item.key, due);
  }
  return map;
};

export const rankItems = (items: readonly AcademicItem[], options: { now: Date }): RankedItem[] => {
  const context: ScoreContext = { now: options.now, courseKnownPoints: buildCourseKnownPoints(items), dueTimes: buildDueTimes(items) };
  return items
    .filter(isEligible)
    .map((item) => ({ item, priority: scoreItem(item, context) }))
    .sort(compareRanked);
};
