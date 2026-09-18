import type { CompactBucket } from "@nova-agent/protocol";
import { z } from "zod";
import { MAX_ROWS, defineTool, dueOrder, itemData, itemRow, plural, resolveCourse } from "./shared";

const rangeSchema = z.enum(["overdue", "today", "tomorrow", "week", "next-week", "later", "no-date", "all"]);
type Range = z.infer<typeof rangeSchema>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Checked in `run` rather than by zod, so a phrase like "next monday" gets an error that shows the expected format.
const dateSchema = z.string().max(40);

/** Bucket filter per range. `next-week` is a date window instead (see `windowFor`), so it has none. */
const bucketsFor = (range: Range): CompactBucket[] | null => {
  switch (range) {
    case "overdue":
      return ["overdue"];
    case "today":
      return ["today"];
    case "tomorrow":
      return ["tomorrow"];
    case "week":
      return ["today", "tomorrow", "this-week"];
    case "later":
      return ["later"];
    case "no-date":
      return ["no-date"];
    case "next-week":
    case "all":
      return null;
  }
};

const RANGE_LABEL: Record<Range, string> = {
  overdue: "overdue",
  today: "due today",
  tomorrow: "due tomorrow",
  week: "due in the next 7 days",
  "next-week": "due next week",
  later: "due later",
  "no-date": "without a due date",
  all: "in total",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 14" from "2026-09-14". Month names of a calendar string do not depend on any time zone. */
export const shortDate = (date: string): string => {
  const [, month, day] = date.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}`;
};

export const listDeadlines = defineTool({
  name: "list_deadlines",
  description:
    "Lists assignments and quizzes due in one period, optionally for one course or one kind. Ranges: 'overdue', 'today', 'tomorrow', 'week' (today plus the next six days, the default), 'next-week' (Monday to Sunday of the calendar week after this one), 'later' (after the next seven days), 'no-date', and 'all' (for totals only). For any other period, such as a month or before or after a date, pass from and/or to as YYYY-MM-DD. Completed items are excluded unless includeDone is true.",
  input: z.object({
    range: rangeSchema
      .optional()
      .describe("Time range. 'week' is today plus the next six days, the same seven days as the Week tab. 'next-week' is Monday to Sunday of next calendar week. 'all' is for totals only; never fetch it to narrow down yourself. Defaults to 'week', or to 'all' when from or to is given."),
    from: dateSchema.optional().describe("First due date to include, YYYY-MM-DD, inclusive. Use for any period the ranges do not name."),
    to: dateSchema.optional().describe("Last due date to include, YYYY-MM-DD, inclusive."),
    course: z.string().max(120).optional().describe("Course id, code, or part of the course name."),
    kind: z.enum(["assignment", "quiz"]).optional().describe("Only this kind of item."),
    includeDone: z.boolean().optional().describe("Include submitted and completed items. Default false."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum items to return. Default 20."),
  }),
  run: (input, { snapshot }) => {
    for (const field of ["from", "to"] as const) {
      const value = input[field];
      if (value !== undefined && !DATE.test(value)) return { ok: false, error: `${field} must be a date like 2026-09-21, not "${value}".` };
    }
    if (input.from && input.to && input.from > input.to) return { ok: false, error: `from (${input.from}) is after to (${input.to}).` };
    const windowed = input.from !== undefined || input.to !== undefined;
    const range: Range = input.range ?? (windowed ? "all" : "week");
    const { course, error } = resolveCourse(snapshot, input.course);
    if (error) return { ok: false, error };
    const buckets = bucketsFor(range);
    // Calendar strings compare correctly as plain strings, so the server filters without any date math.
    const next = range === "next-week" ? snapshot.calendar.nextWeek : null;
    const inWindow = (date: string | null): boolean => {
      if (!next && !windowed) return true;
      if (!date) return false;
      if (next && (date < next.from || date > next.to)) return false;
      if (input.from && date < input.from) return false;
      if (input.to && date > input.to) return false;
      return true;
    };
    const limit = Math.min(input.limit ?? 20, MAX_ROWS);
    const matches = snapshot.items
      .filter((item) => (course ? item.courseId === course.id : true))
      .filter((item) => (input.kind ? item.kind === input.kind : true))
      .filter((item) => (input.includeDone ? true : item.bucket !== "completed"))
      .filter((item) => (buckets ? buckets.includes(item.bucket) : true))
      .filter((item) => inWindow(item.dueDate))
      .sort(dueOrder);
    const shown = matches.slice(0, limit);
    const where = course ? ` in ${course.name}` : "";
    const period = next ? ` (${shortDate(next.from)} to ${shortDate(next.to)})` : "";
    const between = !windowed ? "" : input.from && input.to ? ` between ${input.from} and ${input.to}` : input.from ? ` on or after ${input.from}` : ` on or before ${input.to}`;
    const label = windowed && range === "all" ? "due" : RANGE_LABEL[range];
    const summary = `${plural(matches.length, input.kind ?? "item")} ${label}${period}${between}${where}${matches.length > shown.length ? ` (showing ${shown.length})` : ""}.`;
    return {
      ok: true,
      summary,
      data: { range, from: input.from ?? null, to: input.to ?? null, window: next, course: course?.name ?? null, total: matches.length, items: shown.map((item) => itemData(snapshot, item)) },
      rows: shown.map((item) => itemRow(snapshot, item)),
    };
  },
});
