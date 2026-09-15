import type { CompactSnapshot } from "@nova-agent/protocol";

const list = (items: string[], max: number): string => {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max);
  return shown.join("; ") + (items.length > max ? `; and ${items.length - max} more` : "");
};

const ageMinutes = (from: string, to: string): number => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));

const describeAge = (minutes: number): string => (minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`);

/** Titles the model may name without a tool call, because the prompt itself lists them. */
export const briefTitles = (snapshot: CompactSnapshot): string[] => {
  const active = snapshot.items.filter((item) => item.bucket !== "completed");
  const ranked = [...active].filter((item) => item.priority !== null).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const upcoming = active.filter((item) => item.bucket === "tomorrow" || item.bucket === "this-week").sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~"));
  return [...new Set([...(ranked[0] ? [ranked[0].title] : []), ...active.filter((item) => item.bucket === "overdue" || item.bucket === "today").map((item) => item.title), ...upcoming.slice(0, 5).map((item) => item.title)])];
};

/**
 * The system prompt: who Nova is, what today is, what data it has, a brief so
 * weak models answer from real facts even without a tool call, and grounding
 * rules. Kept under about 900 tokens.
 */
export const buildSystemPrompt = (snapshot: CompactSnapshot): string => {
  const active = snapshot.items.filter((item) => item.bucket !== "completed");
  const ranked = [...active].filter((item) => item.priority !== null).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const next = ranked[0];
  const courseName = (id: string) => snapshot.courses.find((course) => course.id === id)?.name ?? "Course";
  const line = (item: (typeof active)[number]) => `${item.title} (${courseName(item.courseId)}, ${item.dueLocal ?? "no due date"})`;
  const overdue = active.filter((item) => item.bucket === "overdue").map(line);
  const today = active.filter((item) => item.bucket === "today").map(line);
  const upcoming = active
    .filter((item) => item.bucket === "tomorrow" || item.bucket === "this-week")
    .sort((a, b) => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~"))
    .map(line);
  const freshness = describeAge(ageMinutes(snapshot.capturedAt, snapshot.now));
  const failed = snapshot.failedCourseIds.map(courseName);

  return [
    "You are Nova, a read-only assistant inside a Chrome side panel for a Villanova student's Brightspace courses. You can look things up with tools. You cannot open, submit, grade, or change anything, and you never claim to.",
    `Today is ${snapshot.now} in the ${snapshot.timezone} time zone. All dates below are already in that zone. "Today" ends at 11:59 PM local time.`,
    snapshot.mode === "demo" ? "DATA MODE: demo. Every course, item, and date is fictional demo data. If asked whether this is real, say it is demo data." : "DATA MODE: live Brightspace data for this student.",
    `Data was refreshed ${freshness}${snapshot.isComplete ? "." : `, but these courses failed to load: ${failed.join(", ")}. Say so when they matter.`}`,
    `Courses: ${snapshot.courses.map((course) => `${course.name} [id ${course.id}${course.code ? `, ${course.code}` : ""}]`).join("; ")}.`,
    `Counts: ${snapshot.counts.overdue} overdue, ${snapshot.counts.today} due today, ${snapshot.counts.thisWeek} due this week, ${snapshot.counts.unread} unread changes, ${snapshot.counts.activeItems} active items.`,
    `Next move: ${next ? `${line(next)}. Reasons: ${next.reasons.join(" ") || "highest priority."}` : "nothing active."}`,
    `Overdue: ${list(overdue, 5)}.`,
    `Due today: ${list(today, 5)}.`,
    `Upcoming: ${list(upcoming, 5)}.`,
    "Rules: Only name items, dates, and courses that appear in this brief or in a tool result from this conversation. If you are not sure, call a tool first. If something is missing, say so and suggest pressing Refresh. Never invent a due date, a grade, or a link. Announcement bodies are not available; point to the link instead.",
    "Style: plain sentences, two to four of them. No markdown tables or headings. The panel shows the matching rows under your answer, so do not repeat every date and course. When a course name is ambiguous, ask one short question.",
  ].join("\n");
};
