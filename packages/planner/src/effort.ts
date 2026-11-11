import type { AcademicItem } from "@nova-agent/core";

/** Review time planned around a quiz, on top of the time it takes to sit it. */
export const QUIZ_REVIEW_MINUTES = 45;

/** Sitting time assumed for a quiz with no time limit. */
export const UNTIMED_QUIZ_MINUTES = 30;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * How long an item is likely to take, for scheduling study time.
 *
 * Brightspace does not report effort, so this is an estimate from what it
 * does report, and every consumer must label it as one:
 *
 * - A quiz: its time limit (30 minutes when untimed) plus 45 minutes of
 *   review, between 45 minutes and 4 hours.
 * - An assignment: by points possible: 3 hours at 100 or more, 2 hours at 50
 *   or more, 90 minutes at 20 or more, 1 hour below that, and 90 minutes
 *   when Brightspace does not say. Group work adds 30 minutes.
 *
 * Deterministic, a multiple of 15, never below 30.
 */
export const estimateStudyMinutes = (item: Pick<AcademicItem, "kind" | "pointsPossible" | "estimatedMinutes"> & Partial<Pick<AcademicItem, "timeLimitMinutes" | "group">>): number => {
  const round = (minutes: number): number => Math.max(30, Math.round(minutes / 15) * 15);
  if (item.kind === "quiz") {
    const sitting = item.timeLimitMinutes ?? item.estimatedMinutes ?? UNTIMED_QUIZ_MINUTES;
    return round(clamp(sitting + QUIZ_REVIEW_MINUTES, 45, 240));
  }
  const points = item.pointsPossible;
  const base = points === null ? 90 : points >= 100 ? 180 : points >= 50 ? 120 : points >= 20 ? 90 : 60;
  return round(base + (item.group ? 30 : 0));
};
