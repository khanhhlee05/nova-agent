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

const reasonText = (component: keyof PriorityComponents, item: AcademicItem, priority: PriorityResult): string => {
  switch (component) {
    case "urgency":
      return priority.overdue ? "Overdue and still unfinished." : `Due in ${formatDuration(priority.hoursUntilDue ?? 0)}.`;
    case "typeWeight":
      return item.kind === "quiz" ? "Quizzes are timed, so they rank above assignments." : "Assignment work counts toward the weekly load.";
    case "importance":
      return "Marked as high importance.";
    case "effortPressure":
      return `Estimated to take ${formatDuration((item.estimatedMinutes ?? 0) / 60)}.`;
    case "pointImpact":
      return "One of the higher-point items in this course.";
  }
};

/**
 * Picks the most useful explanations from the highest non-zero components.
 * The baseline importance (`normal` = 5) and assignment type weight are
 * low-signal, so they only appear when nothing stronger exists.
 */
export const explainPriority = (item: AcademicItem, priority: PriorityResult, limit = 2): PriorityReason[] => {
  const entries = (Object.keys(priority.components) as (keyof PriorityComponents)[])
    .map((component) => ({ component, value: priority.components[component] }))
    .filter((entry) => entry.value > 0);
  const strong = entries.filter(
    (entry) => !(entry.component === "importance" && item.importance !== "high") && !(entry.component === "typeWeight" && item.kind !== "quiz"),
  );
  const pool = strong.length > 0 ? strong : entries;
  return pool
    .sort((a, b) => b.value - a.value || a.component.localeCompare(b.component))
    .slice(0, limit)
    .map((entry) => ({ component: entry.component, value: entry.value, text: reasonText(entry.component, item, priority) }));
};

export const COMPONENT_LABELS: Record<keyof PriorityComponents, string> = {
  urgency: "Urgency",
  typeWeight: "Type weight",
  importance: "Importance",
  effortPressure: "Effort pressure",
  pointImpact: "Point impact",
};
