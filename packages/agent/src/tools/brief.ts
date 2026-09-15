import { z } from "zod";
import { courseName, defineTool, dueOrder, itemData, itemRow, plural } from "./shared";

export const getBrief = defineTool({
  name: "get_brief",
  description: "Overview of the student's workload right now: counts, the single next move with its reasons, what is overdue, what is due today, and the next few upcoming deadlines. Call this for questions like 'what should I do first' or 'how bad is this week'.",
  input: z.object({}),
  run: (_input, { snapshot }) => {
    const active = snapshot.items.filter((item) => item.bucket !== "completed");
    const ranked = [...active].filter((item) => item.priority !== null).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || dueOrder(a, b));
    const nextMove = ranked[0] ?? null;
    const overdue = active.filter((item) => item.bucket === "overdue").sort(dueOrder);
    const today = active.filter((item) => item.bucket === "today").sort(dueOrder);
    const upcoming = active
      .filter((item) => item.bucket === "tomorrow" || item.bucket === "this-week" || item.bucket === "later")
      .sort(dueOrder)
      .slice(0, 5);
    const rows = [...(nextMove ? [nextMove] : []), ...overdue, ...today].filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index).slice(0, 8);
    const summary = nextMove
      ? `${plural(snapshot.counts.overdue, "overdue item")}, ${plural(snapshot.counts.today, "item")} due today. Start with ${nextMove.title}.`
      : "Nothing active right now.";
    return {
      ok: true,
      summary,
      data: {
        mode: snapshot.mode,
        dataRefreshedAt: snapshot.capturedAt,
        complete: snapshot.isComplete,
        failedCourses: snapshot.failedCourseIds.map((id) => courseName(snapshot, id)),
        counts: snapshot.counts,
        nextMove: nextMove ? { ...itemData(snapshot, nextMove), reasons: nextMove.reasons } : null,
        overdue: overdue.map((item) => itemData(snapshot, item)),
        dueToday: today.map((item) => itemData(snapshot, item)),
        upcoming: upcoming.map((item) => itemData(snapshot, item)),
      },
      rows: rows.map((item) => itemRow(snapshot, item)),
    };
  },
});
