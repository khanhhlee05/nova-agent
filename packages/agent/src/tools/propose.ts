import { PROPOSAL_LIMITS, type CompactItem, type CompactPersonal } from "@nova-agent/protocol";
import { z } from "zod";
import { addCalendarDays, dateSchema, dayLabel, isCalendarDate } from "./period";
import { cleanText } from "../compact";
import { changeData, changeRow, defineTool, itemData, itemRow, personalData, personalRow, plural, resolveCourse, type ToolResult } from "./shared";

/** What the model reads back after proposing. It never learns the student's decision inside the same turn. */
export const PROPOSED_NOTE = "Proposed, not done. The student sees a card and decides. Tell them what you suggested and that it waits for their confirmation. Never say it has been done.";

const MAX_DEADLINE_AHEAD_DAYS = 366;

const ids = z.array(z.string().min(2).max(40)).min(1).max(PROPOSAL_LIMITS.items);

const quoted = (titles: string[]): string => (titles.length <= 3 ? titles.map((title) => `"${title}"`).join(", ") : `"${titles[0]}", "${titles[1]}", and ${titles.length - 2} more`);

/** Splits ids into the items they name and the ids that name nothing, keeping the order asked for and dropping repeats. */
const lookUp = <T extends { id: string }>(wanted: readonly string[], pool: readonly T[]): { found: T[]; unknown: string[] } => {
  const found: T[] = [];
  const unknown: string[] = [];
  for (const id of new Set(wanted)) {
    const match = pool.find((entry) => entry.id === id);
    if (match) found.push(match);
    else unknown.push(id);
  }
  return { found, unknown };
};

const unknownError = (kind: string, unknown: string[]): ToolResult => ({ ok: false, error: `No ${kind} has id ${unknown.map((id) => `"${id}"`).join(", ")}. Use ids from a tool result in this conversation.` });

/** 24-hour "HH:mm". Accepts "5pm", "5:30 PM", "17:30"; anything else is rejected with the expected shape. */
export const parseClock = (value: string | undefined, fallback: string): string | null => {
  if (value === undefined || value.trim() === "") return fallback;
  const text = value.trim().toLowerCase();
  const twelve = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(text);
  if (twelve) {
    const hour = Number(twelve[1]);
    const minute = Number(twelve[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const hour24 = (hour % 12) + (twelve[3] === "pm" ? 12 : 0);
    return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  const twentyFour = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (twentyFour) {
    const hour = Number(twentyFour[1]);
    const minute = Number(twentyFour[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  return null;
};

const clockLabel = (time: string): string => {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
};

export const proposeMarkDone = defineTool({
  name: "propose_mark_done",
  description:
    "Suggests marking assignments or quizzes done on the student's device, for work they say they finished or handed in. It only shows a card the student confirms; nothing changes until they do, and Brightspace is never changed. Pass item ids from a tool result. Use it when the student asks to mark, tick off, or check off work.",
  input: z.object({ ids: ids.describe("Item ids such as 'a4101', from a tool result in this conversation.") }),
  run: (input, { snapshot }) => {
    const { found, unknown } = lookUp<CompactItem>(input.ids, snapshot.items);
    if (unknown.length > 0) return unknownError("item", unknown);
    const open = found.filter((item) => item.bucket !== "completed");
    if (open.length === 0) return { ok: false, error: `${found.length === 1 ? `"${found[0]?.title}" is` : "Those items are"} already done, in Brightspace or by the student's own mark.` };
    const label = `Mark ${quoted(open.map((item) => item.title))} done on this device. Brightspace is not changed.`;
    return {
      ok: true,
      summary: `Suggested marking ${plural(open.length, "item")} done on this device`,
      data: { proposed: label, note: PROPOSED_NOTE, items: open.map((item) => itemData(snapshot, item)), alreadyDone: found.filter((item) => item.bucket === "completed").map((item) => item.title) },
      rows: open.map((item) => itemRow(snapshot, item)),
      proposal: { label, payload: { kind: "mark_done", itemIds: open.map((item) => item.id) } },
    };
  },
});

export const proposeHide = defineTool({
  name: "propose_hide",
  description:
    "Suggests hiding assignments or quizzes from the panel until the next refresh, for work the student does not want to see right now. It only shows a card the student confirms. Hidden items come back on the next refresh or with Show all. Pass item ids from a tool result.",
  input: z.object({ ids: ids.describe("Item ids such as 'a4101', from a tool result in this conversation.") }),
  run: (input, { snapshot }) => {
    const { found, unknown } = lookUp<CompactItem>(input.ids, snapshot.items);
    if (unknown.length > 0) return unknownError("item", unknown);
    const label = `Hide ${quoted(found.map((item) => item.title))} until the next refresh.`;
    return {
      ok: true,
      summary: `Suggested hiding ${plural(found.length, "item")} until the next refresh`,
      data: { proposed: label, note: PROPOSED_NOTE, items: found.map((item) => itemData(snapshot, item)) },
      rows: found.map((item) => itemRow(snapshot, item)),
      proposal: { label, payload: { kind: "hide_item", itemIds: found.map((item) => item.id) } },
    };
  },
});

export const proposeMarkRead = defineTool({
  name: "propose_mark_read",
  description:
    "Suggests marking changes in the Changes tab as read. It only shows a card the student confirms. Pass change ids from get_changes, or all: true for every unread change, optionally for one course.",
  input: z
    .object({
      ids: z.array(z.string().min(1).max(80)).min(1).max(PROPOSAL_LIMITS.changes).optional().describe("Change ids from get_changes."),
      all: z.boolean().optional().describe("Every unread change. Use instead of ids."),
      course: z.string().max(120).optional().describe("With all: only this course. Id, code, or part of the name."),
    })
    .refine((value) => Boolean(value.ids) !== Boolean(value.all), { message: "Provide ids, or all: true, not both." }),
  run: (input, { snapshot }) => {
    const { course, error } = resolveCourse(snapshot, input.all ? input.course : undefined);
    if (error) return { ok: false, error };
    let changes = snapshot.changes;
    if (input.ids) {
      const { found, unknown } = lookUp(input.ids, snapshot.changes);
      if (unknown.length > 0) return unknownError("change", unknown);
      changes = found;
    } else if (course) {
      changes = changes.filter((change) => change.courseId === course.id);
    }
    const unread = changes.filter((change) => !change.read).slice(0, PROPOSAL_LIMITS.changes);
    if (unread.length === 0) return { ok: false, error: `Nothing to mark: ${input.ids ? "those changes are" : `every change${course ? ` in ${course.name}` : ""} is`} already read.` };
    const label = `Mark ${plural(unread.length, "change")}${course ? ` in ${course.name}` : ""} as read.`;
    return {
      ok: true,
      summary: `Suggested marking ${plural(unread.length, "change")} as read`,
      data: { proposed: label, note: PROPOSED_NOTE, changes: unread.slice(0, 10).map((change) => changeData(snapshot, change)) },
      rows: unread.slice(0, 10).map((change) => changeRow(snapshot, change)),
      proposal: { label, payload: { kind: "mark_changes_read", changeIds: unread.map((change) => change.id) } },
    };
  },
});

export const proposePersonalDeadline = defineTool({
  name: "propose_personal_deadline",
  description:
    "Suggests a change to the student's own deadlines on the Week tab (these are theirs, never in Brightspace): 'add' a new one, 'move' one to another day or time, or 'complete' one. It only shows a card the student confirms. Use it for 'remind me to', 'add a deadline', 'put that on my week', 'move it to Friday', or 'I did that'. For add: title and date are required. For move: id and date. For complete: id. Dates are YYYY-MM-DD in the student's zone; work them out from today's date in the course data.",
  input: z
    .object({
      action: z.enum(["add", "move", "complete"]),
      id: z.string().min(1).max(80).optional().describe("For move and complete: the id of one of the student's own deadlines, from a tool result."),
      title: z.string().max(200).optional().describe("For add: a short name for the deadline, in the student's words."),
      date: dateSchema.optional().describe("For add and move: the day, YYYY-MM-DD."),
      time: z.string().max(12).optional().describe("For add and move: the time, like 17:30 or 5:30 PM. Default 11:59 PM for add, the current time of the deadline for move."),
      course: z.string().max(120).optional().describe("For add: one of the student's courses, by id, code, or part of the name. Leave out for no course."),
    })
    .refine((value) => (value.action === "add" ? Boolean(value.title) && Boolean(value.date) : value.action === "move" ? Boolean(value.id) && Boolean(value.date) : Boolean(value.id)), {
      message: "add needs title and date; move needs id and date; complete needs id.",
    }),
  run: (input, { snapshot }) => {
    const today = snapshot.calendar.today;
    const own = snapshot.personal ?? [];
    const checkDate = (date: string): string | null => {
      if (!isCalendarDate(date)) return `date must be a day like ${today}, not "${date}".`;
      if (date < today) return `date (${date}) is in the past. Today is ${today}.`;
      if (date > addCalendarDays(today, MAX_DEADLINE_AHEAD_DAYS)) return `date (${date}) is more than a year ahead.`;
      return null;
    };
    if (input.action === "add") {
      const title = cleanText(input.title ?? "").slice(0, PROPOSAL_LIMITS.title).trim();
      if (title === "") return { ok: false, error: "title is empty." };
      const date = input.date as string;
      const dateError = checkDate(date);
      if (dateError) return { ok: false, error: dateError };
      const time = parseClock(input.time, "23:59");
      if (!time) return { ok: false, error: `time must look like 17:30 or 5:30 PM, not "${input.time}".` };
      const { course, error } = resolveCourse(snapshot, input.course);
      if (error) return { ok: false, error };
      const label = `Add "${title}" to your Week tab on ${dayLabel(date)} at ${clockLabel(time)}${course ? `, under ${course.name}` : ""}. It stays on this device.`;
      return {
        ok: true,
        summary: `Suggested adding "${title}" on ${dayLabel(date)} at ${clockLabel(time)}`,
        data: { proposed: label, note: PROPOSED_NOTE },
        rows: [],
        proposal: { label, payload: { kind: "add_personal_deadline", title, dueDate: date, time, courseId: course?.id ?? null } },
      };
    }
    const { found, unknown } = lookUp<CompactPersonal>([input.id as string], own);
    if (unknown.length > 0) return { ok: false, error: `None of the student's own deadlines has id "${input.id}". Ids come from list_deadlines or get_brief; Brightspace items cannot be moved or completed here, use propose_mark_done for those.` };
    const deadline = found[0] as CompactPersonal;
    if (input.action === "complete") {
      if (deadline.done) return { ok: false, error: `"${deadline.title}" is already done.` };
      const label = `Mark your deadline "${deadline.title}" done.`;
      return { ok: true, summary: `Suggested marking "${deadline.title}" done`, data: { proposed: label, note: PROPOSED_NOTE, deadline: personalData(snapshot, deadline) }, rows: [personalRow(snapshot, deadline)], proposal: { label, payload: { kind: "complete_personal_deadline", personalId: deadline.id } } };
    }
    const date = input.date as string;
    const dateError = checkDate(date);
    if (dateError) return { ok: false, error: dateError };
    // Without a new time the deadline keeps its own; the local text the browser wrote carries it.
    const current = /(\d{1,2}:\d{2} (?:AM|PM))$/.exec(deadline.dueLocal)?.[1];
    const time = parseClock(input.time ?? current, "23:59");
    if (!time) return { ok: false, error: `time must look like 17:30 or 5:30 PM, not "${input.time}".` };
    if (date === deadline.dueDate && current && parseClock(current, "") === time) return { ok: false, error: `"${deadline.title}" is already on ${dayLabel(date)} at ${clockLabel(time)}.` };
    const label = `Move your deadline "${deadline.title}" to ${dayLabel(date)} at ${clockLabel(time)}.`;
    return {
      ok: true,
      summary: `Suggested moving "${deadline.title}" to ${dayLabel(date)} at ${clockLabel(time)}`,
      data: { proposed: label, note: PROPOSED_NOTE, deadline: personalData(snapshot, deadline) },
      rows: [personalRow(snapshot, deadline)],
      proposal: { label, payload: { kind: "move_personal_deadline", personalId: deadline.id, dueDate: date, time } },
    };
  },
});
