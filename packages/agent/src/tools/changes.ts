import { compactChangeKindSchema } from "@nova-agent/protocol";
import { z } from "zod";
import { MAX_ROWS, changeData, changeRow, defineTool, plural, resolveCourse } from "./shared";

const sinceSchema = z.enum(["today", "yesterday", "week", "all"]);
const maxDaysAgo: Record<z.infer<typeof sinceSchema>, number> = { today: 0, yesterday: 1, week: 7, all: Number.POSITIVE_INFINITY };

export const getChanges = defineTool({
  name: "get_changes",
  description: "What changed since the student's last visit: new items, moved due dates, items that became overdue, submissions, hidden or removed items, and new announcements. Each change carries before and after values.",
  input: z.object({
    course: z.string().max(120).optional().describe("Course id, code, or part of the course name."),
    since: sinceSchema.optional().describe("How far back: 'today', 'yesterday' (includes today), 'week', or 'all'. Default 'all'."),
    kind: compactChangeKindSchema.optional().describe("Only one kind of change."),
    unreadOnly: z.boolean().optional().describe("Only changes the student has not marked as read."),
  }),
  run: (input, { snapshot }) => {
    const { course, error } = resolveCourse(snapshot, input.course);
    if (error) return { ok: false, error };
    const since = input.since ?? "all";
    const matches = snapshot.changes
      .filter((change) => (course ? change.courseId === course.id : true))
      .filter((change) => change.daysAgo <= maxDaysAgo[since])
      .filter((change) => (input.kind ? change.kind === input.kind : true))
      .filter((change) => (input.unreadOnly ? !change.read : true));
    const shown = matches.slice(0, MAX_ROWS);
    return {
      ok: true,
      summary: `${plural(matches.length, "change")}${course ? ` in ${course.name}` : ""}${since === "all" ? "" : ` (${since})`}.`,
      data: { since, course: course?.name ?? null, total: matches.length, changes: shown.map((change) => changeData(snapshot, change)) },
      rows: shown.map((change) => changeRow(snapshot, change)),
    };
  },
});
