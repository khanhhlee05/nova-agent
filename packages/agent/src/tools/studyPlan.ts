import { PLAN_LIMITS, type CompactItem, type PlanSlot, type ToolRow } from "@nova-agent/protocol";
import { z } from "zod";
import { addCalendarDays, dateSchema, dayLabel, isCalendarDate } from "./period";
import { courseName, defineTool, dueOrder, personalData, plural, resolveCourse } from "./shared";

export const PLAN_DEFAULTS = { days: 3, hoursPerDay: 2, estimateMinutes: 90, minSlotMinutes: 15, maxStartAheadDays: 60 } as const;

export const ESTIMATE_NOTE = "Minutes are Nova's estimates from each item's kind, points, and time limit. Brightspace does not say how long work takes.";

/** "2 hours", "1 hour", "1.5 hours", "45 minutes". */
export const formatMinutes = (minutes: number): string => {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round((minutes / 60) * 100) / 100;
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
};

/** A deadline before noon leaves no time on its own day: the work has to be finished the day before. */
const dueBeforeNoon = (item: CompactItem): boolean => /\b\d{1,2}:\d{2} AM$/.test(item.dueLocal ?? "");

const byPriority = (a: CompactItem, b: CompactItem): number => (b.priority ?? -1) - (a.priority ?? -1) || dueOrder(a, b);

type Day = { date: string; used: number; slots: PlanSlot[] };

export type PlanLeftOut = { id: string; title: string; course: string; minutesMissing: number; reason: string };

/**
 * A day-by-day study plan, computed here and never by the model.
 *
 * Work that can still be on time is protected first: counting back from
 * each deadline inside the plan's days, the time that work needs is held.
 * Overdue work then takes the earliest time that is not held, because it is
 * late either way and must not make something else late. On-time work is
 * placed next, by the day it has to be done (earliest first, the planner's
 * score breaking ties), in the earliest free time. Then, only while time is
 * left, later work by score, and work without a due date last. An item may
 * span days. Nothing is ever placed after its own deadline: what does not
 * fit is reported as left out, with how much is missing. The same snapshot
 * and the same arguments always give the same plan.
 */
export const buildStudyPlan = defineTool({
  name: "build_study_plan",
  description:
    "Builds a day-by-day study plan for the next days from the open assignments and quizzes: work due inside those days is kept on time first, overdue work takes the earliest time left over, then later work if time remains. The schedule is computed for you; introduce it in two sentences and say what was left out. Minutes per item are estimates. Use for 'plan my week', 'what should I do each day', or 'how do I fit this in'. Items the student marked done, long overdue items, and the student's own deadlines are not scheduled.",
  input: z.object({
    days: z.number().int().min(1).max(PLAN_LIMITS.days).optional().describe(`How many days to plan, 1 to ${PLAN_LIMITS.days}, starting at startDate. Default ${PLAN_DEFAULTS.days}.`),
    hoursPerDay: z.number().min(0.5).max(12).optional().describe(`Study hours available per day, 0.5 to 12. Default ${PLAN_DEFAULTS.hoursPerDay}.`),
    course: z.string().max(120).optional().describe("Plan only this course: id, code, or part of the course name."),
    startDate: dateSchema.optional().describe("First day of the plan, YYYY-MM-DD. Default today. Not in the past."),
  }),
  run: (input, { snapshot }) => {
    const today = snapshot.calendar.today;
    const start = input.startDate ?? today;
    if (!isCalendarDate(start)) return { ok: false, error: `startDate must be a date like ${today}, not "${start}".` };
    if (start < today) return { ok: false, error: `startDate (${start}) is in the past. Today is ${today}.` };
    if (start > addCalendarDays(today, PLAN_DEFAULTS.maxStartAheadDays)) return { ok: false, error: `startDate (${start}) is more than ${PLAN_DEFAULTS.maxStartAheadDays} days ahead.` };
    const { course, error } = resolveCourse(snapshot, input.course);
    if (error) return { ok: false, error };
    const dayCount = input.days ?? PLAN_DEFAULTS.days;
    const capacity = Math.round((input.hoursPerDay ?? PLAN_DEFAULTS.hoursPerDay) * 60);
    const days: Day[] = Array.from({ length: dayCount }, (_, index) => ({ date: addCalendarDays(start, index), used: 0, slots: [] }));
    const end = (days[days.length - 1] as Day).date;
    const perDay = formatMinutes(capacity);

    const open = snapshot.items.filter((item) => item.bucket !== "completed" && !item.longOverdue && (course ? item.courseId === course.id : true));
    /** The last day work on the item still counts, clamped to the first day of the plan. */
    const lastDayOf = (item: CompactItem): string | null => {
      if (!item.dueDate) return null;
      const last = dueBeforeNoon(item) ? addCalendarDays(item.dueDate, -1) : item.dueDate;
      return last < start ? start : last;
    };
    const overdue = open.filter((item) => item.bucket === "overdue").sort(byPriority);
    const dated = open.filter((item) => item.bucket !== "overdue" && item.dueDate !== null);
    const must = dated.filter((item) => (lastDayOf(item) as string) <= end).sort((a, b) => (lastDayOf(a) as string).localeCompare(lastDayOf(b) as string) || byPriority(a, b));
    const ahead = dated.filter((item) => (lastDayOf(item) as string) > end).sort(byPriority);
    const undated = open.filter((item) => item.bucket !== "overdue" && item.dueDate === null).sort(byPriority);

    const dueText = (item: CompactItem): string => (item.dueLocal ? `Due ${item.dueLocal}` : "No due date");
    const estimate = (item: CompactItem): number => item.estimateMinutes ?? PLAN_DEFAULTS.estimateMinutes;
    const lastIndexOf = (item: CompactItem): number => days.findIndex((day) => day.date === lastDayOf(item));

    // Held time: each on-time item's minutes, counted back from the last day it can be worked on, latest deadline first.
    const held = days.map(() => 0);
    for (const item of [...must].reverse()) {
      let remaining = estimate(item);
      for (let index = lastIndexOf(item); index >= 0 && remaining > 0; index--) {
        const minutes = Math.min(capacity - (held[index] ?? 0), remaining);
        held[index] = (held[index] ?? 0) + minutes;
        remaining -= minutes;
      }
    }

    /**
     * Fills the earliest free time up to and including day `lastIndex`. With `aroundHeld`, time held for
     * on-time work is left alone. Returns the minutes that did not fit.
     */
    const place = (item: CompactItem, lastIndex: number, reason: string, aroundHeld = false): number => {
      let remaining = estimate(item);
      for (let index = 0; index <= lastIndex && remaining > 0; index++) {
        const day = days[index] as Day;
        const free = capacity - day.used - (aroundHeld ? (held[index] ?? 0) : 0);
        // No crumbs: a few minutes left on a day are not worth a slot unless they finish the item.
        if (day.slots.length >= PLAN_LIMITS.slotsPerDay || free <= 0 || (free < PLAN_DEFAULTS.minSlotMinutes && free < remaining)) continue;
        const minutes = Math.min(free, remaining);
        day.slots.push({ itemId: item.id, title: item.title, courseId: item.courseId, courseName: courseName(snapshot, item.courseId), minutes, reason: reason.slice(0, 240), dueAt: item.dueAt, url: item.url });
        day.used += minutes;
        remaining -= minutes;
      }
      return remaining;
    };

    const leftOut: PlanLeftOut[] = [];
    const leave = (item: CompactItem, minutesMissing: number, reason: string) => leftOut.push({ id: item.id, title: item.title, course: courseName(snapshot, item.courseId), minutesMissing, reason });
    for (const item of overdue) {
      const missing = place(item, days.length - 1, `Overdue since ${item.dueLocal ?? "its due date"}.`, true);
      if (missing > 0) leave(item, missing, `Overdue, and ${formatMinutes(missing)} of it does not fit in ${plural(dayCount, "day")} at ${perDay} a day once work that can still be on time has its time.`);
    }
    for (const item of must) {
      const missing = place(item, lastIndexOf(item), item.reasons[0] ? `${dueText(item)}. ${item.reasons[0]}` : `${dueText(item)}.`);
      if (missing > 0) leave(item, missing, `${dueText(item)}: ${formatMinutes(missing)} of it does not fit before then at ${perDay} a day.`);
    }
    // Later work only takes time nothing else needed, and is never reported as left out: it is not due in these days.
    for (const item of [...ahead, ...undated]) place(item, days.length - 1, `Getting ahead. ${dueText(item)}.`);

    const planId = `plan-${start}-${dayCount}d-${capacity}m-${course?.id ?? "all"}`.slice(0, 120);
    const rows: ToolRow[] = days.map((day) => ({ kind: "plan-day", id: `${planId}:${day.date}`, planId, title: dayLabel(day.date), date: day.date, totalMinutes: day.used, capacityMinutes: capacity, slots: day.slots }));
    const slotCount = days.reduce((sum, day) => sum + day.slots.length, 0);
    const planned = new Set(days.flatMap((day) => day.slots.map((slot) => slot.itemId))).size;
    const own = (snapshot.personal ?? []).filter((deadline) => !deadline.done && !deadline.fromPlan && deadline.dueDate >= start && deadline.dueDate <= end && (course ? deadline.courseId === course.id : true));
    const where = course ? ` in ${course.name}` : "";
    const span = `${plural(dayCount, "day")} from ${dayLabel(start)} at ${perDay} a day${where}`;
    const summary =
      slotCount === 0 && leftOut.length === 0
        ? `Nothing open to plan for ${span}.`
        : `Plan for ${span}: ${plural(planned, "item")} in ${plural(slotCount, "slot")}${leftOut.length > 0 ? `, ${leftOut.length} ${leftOut.length === 1 ? "does" : "do"} not fully fit` : ""}.`;
    return {
      ok: true,
      summary,
      data: {
        planId,
        start,
        end,
        days: dayCount,
        minutesPerDay: capacity,
        course: course?.name ?? null,
        note: ESTIMATE_NOTE,
        plan: days.map((day) => ({ date: day.date, day: dayLabel(day.date), minutes: day.used, slots: day.slots.map((slot) => ({ id: slot.itemId, title: slot.title, course: slot.courseName, minutes: slot.minutes, reason: slot.reason })) })),
        leftOut,
        freeMinutes: days.reduce((sum, day) => sum + (capacity - day.used), 0),
        ...(own.length > 0 ? { ownDeadlinesInTheseDays: own.slice(0, 10).map((deadline) => personalData(snapshot, deadline)) } : {}),
      },
      rows,
    };
  },
});
