import { z } from "zod";
import { dateSchema, rangeSchema, resolvePeriod } from "./period";
import { MAX_ROWS, defineTool, dueOrder, itemData, itemRow, personalData, personalRow, plural, resolveCourse } from "./shared";

export { shortDate } from "./period";

/** The student's own deadlines shown per lookup. */
const PERSONAL_ROWS = 10;

export const listDeadlines = defineTool({
  name: "list_deadlines",
  description:
    "Lists assignments and quizzes due in one period, optionally for one course or one kind. Ranges: 'overdue' (the last two weeks), 'long-overdue' (older than that, usually closed or never updated by the instructor), 'today', 'tomorrow', 'week' (today plus the next six days, the default), 'next-week' (Monday to Sunday of the calendar week after this one), 'later' (after the next seven days), 'no-date', and 'all' (for totals only). For any other period, such as a month or before or after a date, pass from and/or to as YYYY-MM-DD. Completed items, and items the student marked done on this device, are excluded unless includeDone is true. The student's own deadlines (typed in on the Week tab, not in Brightspace) for the same period come back in a separate list.",
  input: z.object({
    range: rangeSchema
      .optional()
      .describe("Time range. 'week' is today plus the next six days, the same seven days as the Week tab. 'next-week' is Monday to Sunday of next calendar week. 'all' is for totals only; never fetch it to narrow down yourself. Defaults to 'week', or to 'all' when from or to is given."),
    from: dateSchema.optional().describe("First due date to include, YYYY-MM-DD, inclusive. Use for any period the ranges do not name."),
    to: dateSchema.optional().describe("Last due date to include, YYYY-MM-DD, inclusive."),
    course: z.string().max(120).optional().describe("Course id, code, or part of the course name."),
    kind: z.enum(["assignment", "quiz"]).optional().describe("Only this kind of item."),
    includeDone: z.boolean().optional().describe("Include submitted and completed items, and items the student marked done. Default false."),
    includePersonal: z.boolean().optional().describe("Include the student's own deadlines for the same period. Default true; they are never mixed into the Brightspace items."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum items to return. Default 20."),
  }),
  run: (input, { snapshot }) => {
    const resolved = resolvePeriod(input, snapshot, "week");
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { period } = resolved;
    const { range } = period;
    const { course, error } = resolveCourse(snapshot, input.course);
    if (error) return { ok: false, error };
    const limit = Math.min(input.limit ?? 20, MAX_ROWS);
    const matches = snapshot.items
      .filter((item) => (course ? item.courseId === course.id : true))
      .filter((item) => (input.kind ? item.kind === input.kind : true))
      .filter((item) => (input.includeDone ? true : item.bucket !== "completed"))
      // Both ranges share the overdue bucket; the flag, set in the browser, tells them apart.
      .filter((item) => (range === "overdue" ? !item.longOverdue : range === "long-overdue" ? item.longOverdue === true : true))
      .filter((item) => period.matches(item.bucket, item.dueDate))
      .sort(dueOrder);
    const shown = matches.slice(0, limit);
    // The student's own deadlines follow the same period and course, but never a kind filter or the long-overdue fold.
    const own =
      input.includePersonal === false || input.kind !== undefined || range === "long-overdue"
        ? []
        : (snapshot.personal ?? [])
            .filter((deadline) => (course ? deadline.courseId === course.id : true))
            .filter((deadline) => (input.includeDone ? true : !deadline.done))
            .filter((deadline) => period.matches(deadline.bucket, deadline.dueDate))
            .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title));
    const ownShown = own.slice(0, Math.min(limit, PERSONAL_ROWS));
    const where = course ? ` in ${course.name}` : "";
    const older = range === "overdue" ? snapshot.items.filter((item) => item.longOverdue && item.bucket !== "completed" && (course ? item.courseId === course.id : true) && (input.kind ? item.kind === input.kind : true)).length : 0;
    const summary = `${plural(matches.length, input.kind ?? "item")} ${period.label}${period.suffix}${where}${matches.length > shown.length ? ` (showing ${shown.length})` : ""}${older > 0 ? `, plus ${older} long overdue not listed` : ""}${own.length > 0 ? `, plus ${own.length} of your own ${own.length === 1 ? "deadline" : "deadlines"}` : ""}.`;
    return {
      ok: true,
      summary,
      data: { range, from: period.from, to: period.to, window: period.next, course: course?.name ?? null, total: matches.length, items: shown.map((item) => itemData(snapshot, item)), ...(own.length > 0 ? { ownDeadlines: ownShown.map((deadline) => personalData(snapshot, deadline)) } : {}) },
      rows: [...shown.map((item) => itemRow(snapshot, item)), ...ownShown.map((deadline) => personalRow(snapshot, deadline))],
    };
  },
});
