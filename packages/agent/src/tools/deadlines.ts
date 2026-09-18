import type { CompactBucket } from "@nova-agent/protocol";
import { z } from "zod";
import { MAX_ROWS, defineTool, dueOrder, itemData, itemRow, plural, resolveCourse } from "./shared";

const rangeSchema = z.enum(["overdue", "today", "tomorrow", "week", "later", "no-date", "all"]);

const bucketsFor = (range: z.infer<typeof rangeSchema>): CompactBucket[] | null => {
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
    case "all":
      return null;
  }
};

const RANGE_LABEL: Record<z.infer<typeof rangeSchema>, string> = {
  overdue: "overdue",
  today: "due today",
  tomorrow: "due tomorrow",
  week: "due in the next 7 days",
  later: "due later",
  "no-date": "without a due date",
  all: "in total",
};

export const listDeadlines = defineTool({
  name: "list_deadlines",
  description: "Lists assignments and quizzes by time range, optionally for one course or one kind. Default range is 'week' (today plus the next six days). Completed items are excluded unless includeDone is true.",
  input: z.object({
    range: rangeSchema.optional().describe("Time range. 'week' means today plus the next six days, the same seven days as the Week tab. 'all' means every known item."),
    course: z.string().max(120).optional().describe("Course id, code, or part of the course name."),
    kind: z.enum(["assignment", "quiz"]).optional().describe("Only this kind of item."),
    includeDone: z.boolean().optional().describe("Include submitted and completed items. Default false."),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum items to return. Default 20."),
  }),
  run: (input, { snapshot }) => {
    const range = input.range ?? "week";
    const { course, error } = resolveCourse(snapshot, input.course);
    if (error) return { ok: false, error };
    const buckets = bucketsFor(range);
    const limit = Math.min(input.limit ?? 20, MAX_ROWS);
    const matches = snapshot.items
      .filter((item) => (course ? item.courseId === course.id : true))
      .filter((item) => (input.kind ? item.kind === input.kind : true))
      .filter((item) => (input.includeDone ? true : item.bucket !== "completed"))
      .filter((item) => (buckets ? buckets.includes(item.bucket) : true))
      .sort(dueOrder);
    const shown = matches.slice(0, limit);
    const where = course ? ` in ${course.name}` : "";
    const summary = `${plural(matches.length, input.kind ?? "item")} ${RANGE_LABEL[range]}${where}${matches.length > shown.length ? ` (showing ${shown.length})` : ""}.`;
    return {
      ok: true,
      summary,
      data: { range, course: course?.name ?? null, total: matches.length, items: shown.map((item) => itemData(snapshot, item)) },
      rows: shown.map((item) => itemRow(snapshot, item)),
    };
  },
});
