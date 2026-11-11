import type { ToolRow } from "@nova-agent/protocol";
import { z } from "zod";
import { dateSchema, rangeSchema, resolvePeriod } from "./period";
import { defineTool, dueOrder, plural, resolveCourse } from "./shared";

/**
 * Workload per course, so "which course needs me most" is answered from
 * counts instead of a list of every item. Courses with the most late work
 * come first, then the most work due in the period, then the most points.
 */
export const getCourseLoad = defineTool({
  name: "get_course_load",
  description:
    "Workload per course: open items, overdue items, items due in a period with the points at stake, the next deadline, recent changes, and graded points so far. Use for 'which course needs the most attention', 'how is Microcontrollers going', or comparing courses. The period takes the same ranges as list_deadlines ('week' by default) or from and to as YYYY-MM-DD.",
  input: z.object({
    range: rangeSchema.optional().describe("Period for the 'due' counts. Same ranges as list_deadlines. Defaults to 'week', or to 'all' when from or to is given."),
    from: dateSchema.optional().describe("First due date to count, YYYY-MM-DD, inclusive."),
    to: dateSchema.optional().describe("Last due date to count, YYYY-MM-DD, inclusive."),
    course: z.string().max(120).optional().describe("Only this course: id, code, or part of the course name."),
  }),
  run: (input, { snapshot }) => {
    const resolved = resolvePeriod(input, snapshot, "week");
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { period } = resolved;
    const { course: only, error } = resolveCourse(snapshot, input.course);
    if (error) return { ok: false, error };
    const loads = snapshot.courses
      .filter((course) => (only ? course.id === only.id : true))
      .map((course) => {
        const items = snapshot.items.filter((item) => item.courseId === course.id);
        // Long overdue items are usually closed; they are counted on their own and never as open work.
        const open = items.filter((item) => item.bucket !== "completed" && !item.longOverdue);
        const overdue = open.filter((item) => item.bucket === "overdue");
        const due = open.filter((item) => (period.range === "long-overdue" ? false : period.matches(item.bucket, item.dueDate)));
        const upcoming = open.filter((item) => item.bucket !== "overdue" && item.dueAt !== null).sort(dueOrder)[0] ?? null;
        const graded = items.filter((item) => typeof item.earnedScore === "number" && item.pointsPossible !== null);
        return {
          course,
          open: open.length,
          overdue: overdue.length,
          longOverdue: items.filter((item) => item.bucket !== "completed" && item.longOverdue).length,
          dueInPeriod: due.length,
          pointsAtStake: due.reduce((sum, item) => sum + (item.pointsPossible ?? 0), 0),
          pointsUnknown: due.filter((item) => item.pointsPossible === null).length,
          next: upcoming,
          changes: snapshot.changes.filter((change) => change.courseId === course.id).length,
          graded: { count: graded.length, earned: graded.reduce((sum, item) => sum + (item.earnedScore ?? 0), 0), possible: graded.reduce((sum, item) => sum + (item.pointsPossible ?? 0), 0) },
          failed: snapshot.failedCourseIds.includes(course.id),
        };
      })
      .sort((a, b) => b.overdue - a.overdue || b.dueInPeriod - a.dueInPeriod || b.pointsAtStake - a.pointsAtStake || b.open - a.open || a.course.name.localeCompare(b.course.name));
    const rows: ToolRow[] = loads.map((load) => ({
      kind: "course",
      id: load.course.id,
      title: load.course.name,
      courseId: load.course.id,
      courseName: load.course.name,
      open: load.open,
      overdue: load.overdue,
      dueInPeriod: load.dueInPeriod,
      pointsAtStake: load.pointsAtStake,
      nextDueAt: load.next?.dueAt ?? null,
      nextDueLocal: load.next?.dueLocal ?? null,
      changes: load.changes,
      url: load.course.homeUrl,
    }));
    const busiest = loads.find((load) => load.overdue > 0 || load.dueInPeriod > 0);
    const totalDue = loads.reduce((sum, load) => sum + load.dueInPeriod, 0);
    const summary = only
      ? `${only.name}: ${plural(loads[0]?.open ?? 0, "open item")}, ${loads[0]?.overdue ?? 0} overdue, ${loads[0]?.dueInPeriod ?? 0} ${period.label}${period.suffix}.`
      : `${plural(loads.length, "course")}, ${plural(totalDue, "item")} ${period.label}${period.suffix}${busiest ? `. ${busiest.course.name} has the most to do` : ""}.`;
    return {
      ok: true,
      summary,
      data: {
        period: { range: period.range, from: period.from, to: period.to, window: period.next },
        courses: loads.map((load) => ({
          id: load.course.id,
          course: load.course.name,
          open: load.open,
          overdue: load.overdue,
          longOverdue: load.longOverdue,
          dueInPeriod: load.dueInPeriod,
          pointsAtStake: load.pointsAtStake,
          itemsWithUnknownPoints: load.pointsUnknown,
          nextDeadline: load.next ? { title: load.next.title, due: load.next.dueLocal } : null,
          changesInLastTwoWeeks: load.changes,
          gradedSoFar: load.graded.count > 0 ? load.graded : null,
          ...(load.failed ? { note: "This course failed to load on the last refresh; its numbers may be stale." } : {}),
        })),
      },
      rows,
    };
  },
});
