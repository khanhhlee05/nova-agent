import type { AcademicItem } from "@nova-agent/core";
import type { PriorityComponents, PriorityResult } from "./priority";

export type PriorityReason = {
  component: keyof PriorityComponents;
  value: number;
  text: string;
};

const formatDuration = (hours: number): string => {
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (hours < 48) {
    const rounded = Math.round(hours);
    return `${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const daysCount = Math.round(hours / 24);
  return `${daysCount} day${daysCount === 1 ? "" : "s"}`;
};

const stakesText = (item: AcademicItem): string => {
  if (item.kind === "quiz") {
    const parts: string[] = [];
    if (item.proctored) parts.push("password or location restricted");
    if (item.timeLimitMinutes) parts.push("timed");
    if (item.attemptsAllowed === 1) parts.push("one attempt");
    if (parts.length > 0) {
      const lead = parts.join(", ");
      return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}: treat it like an exam.`;
    }
    if (item.attemptsAllowed === null) return "A quiz, but attempts are unlimited.";
    return "Quizzes rank above assignments.";
  }
  const parts: string[] = [];
  if (item.group) parts.push("group work, so coordinate early");
  if (item.hasRubric) parts.push("graded against a rubric");
  if (parts.length > 0) {
    const lead = parts.join(" and ");
    return `${lead.charAt(0).toUpperCase()}${lead.slice(1)}.`;
  }
  return "Assignment work counts toward the weekly load.";
};

const weightText = (item: AcademicItem, priority: PriorityResult): string => {
  if (item.pointsPossible === null) return "Brightspace did not share the points for this one.";
  const points = `Worth ${item.pointsPossible} point${item.pointsPossible === 1 ? "" : "s"}`;
  if (priority.pointsPercentile === null) return `${points}.`;
  if (priority.pointsPercentile >= 0.99) return `${points}, the biggest item in this course.`;
  if (priority.pointsPercentile >= 0.66) return `${points}, one of the bigger items in this course.`;
  if (priority.pointsPercentile <= 0.01) return `${points}, the smallest item in this course.`;
  return `${points}, about average for this course.`;
};

const reasonText = (component: keyof PriorityComponents, item: AcademicItem, priority: PriorityResult): string => {
  switch (component) {
    case "urgency":
      return priority.overdue ? `Overdue by ${formatDuration(-(priority.hoursUntilDue ?? 0))} and still unfinished.` : `Due in ${formatDuration(priority.hoursUntilDue ?? 0)}.`;
    case "stakes":
      return stakesText(item);
    case "weight":
      return weightText(item, priority);
    case "momentum":
      return priority.lateWindowOpen ? "Overdue, but still open for a late submission." : "You saved a draft and have not submitted it.";
    case "crunch":
      return priority.crunchCount === 1 ? "Another deadline lands within a day of this one." : `${priority.crunchCount} other deadlines land within a day of this one.`;
    case "effort":
      return item.kind === "quiz" && item.timeLimitMinutes ? `Timed at ${formatDuration(item.timeLimitMinutes / 60)}.` : `Estimated to take ${formatDuration((item.estimatedMinutes ?? 0) / 60)}.`;
  }
};

/** Components that say nothing specific about this item: the bare kind base, and "points unknown". */
const isBaseline = (component: keyof PriorityComponents, item: AcademicItem, priority: PriorityResult): boolean => {
  if (component === "stakes") return priority.components.stakes === (item.kind === "quiz" ? 8 : 6);
  if (component === "weight") return item.pointsPossible === null;
  return false;
};

/**
 * Picks the most useful explanations from the highest non-zero components.
 * Baseline components (a plain assignment or quiz, points not shared) only
 * appear when nothing stronger exists.
 */
export const explainPriority = (item: AcademicItem, priority: PriorityResult, limit = 2): PriorityReason[] => {
  const entries = (Object.keys(priority.components) as (keyof PriorityComponents)[])
    .map((component) => ({ component, value: priority.components[component] }))
    .filter((entry) => entry.value > 0);
  const strong = entries.filter((entry) => !isBaseline(entry.component, item, priority));
  const pool = strong.length > 0 ? strong : entries;
  return pool
    .sort((a, b) => b.value - a.value || a.component.localeCompare(b.component))
    .slice(0, limit)
    .map((entry) => ({ component: entry.component, value: entry.value, text: reasonText(entry.component, item, priority) }));
};

export const COMPONENT_LABELS: Record<keyof PriorityComponents, string> = {
  urgency: "Urgency",
  stakes: "Stakes",
  weight: "Weight",
  momentum: "Momentum",
  crunch: "Crunch",
  effort: "Effort",
};

export const COMPONENT_MAX: Record<keyof PriorityComponents, number> = { urgency: 50, stakes: 20, weight: 15, momentum: 10, crunch: 10, effort: 10 };

export type PriorityBand = "now" | "soon" | "steady" | "later";

/** The score in words, for students who do not want a number. */
export const priorityBand = (score: number): PriorityBand => (score >= 70 ? "now" : score >= 45 ? "soon" : score >= 20 ? "steady" : "later");

export const BAND_LABELS: Record<PriorityBand, string> = { now: "Do this first", soon: "Start soon", steady: "On the radar", later: "Can wait" };

/**
 * One sentence that reads the score for the student: the band, the number, and
 * which parts carry it. The reasons themselves are listed separately, so this
 * names components, not causes.
 */
export const describePriority = (item: AcademicItem, priority: PriorityResult): string => {
  const band = priorityBand(priority.score);
  const lead = band === "now" ? "Top of the list" : band === "soon" ? "Coming up fast" : band === "steady" ? "Worth keeping in view" : "Nothing to rush";
  const parts = (Object.keys(priority.components) as (keyof PriorityComponents)[])
    .map((component) => ({ component, value: priority.components[component], share: priority.components[component] / COMPONENT_MAX[component] }))
    .filter((entry) => entry.value > 0 && !isBaseline(entry.component, item, priority))
    .sort((a, b) => b.value - a.value || a.component.localeCompare(b.component));
  const total = parts.reduce((sum, entry) => sum + entry.value, 0);
  const top = parts.slice(0, 2);
  const names = top.map((entry) => COMPONENT_LABELS[entry.component].toLowerCase());
  const carried = top.reduce((sum, entry) => sum + entry.value, 0);
  const room = (Object.keys(COMPONENT_MAX) as (keyof PriorityComponents)[]).filter((component) => priority.components[component] === 0).map((component) => COMPONENT_LABELS[component].toLowerCase());
  const tail =
    names.length === 0
      ? "Nothing specific lifts it: no due date pressure, no known weight, nothing in motion."
      : `${names.length === 1 ? `${names[0]} carries` : `${names[0]} and ${names[1]} carry`} ${total > 0 && carried / total >= 0.85 ? "nearly all of it" : "most of it"}${room.length > 0 ? `; ${room.join(", ")} ${room.length === 1 ? "adds" : "add"} nothing yet` : ""}.`;
  return `${lead} at ${priority.score} out of 100. ${tail.charAt(0).toUpperCase()}${tail.slice(1)}`;
};


