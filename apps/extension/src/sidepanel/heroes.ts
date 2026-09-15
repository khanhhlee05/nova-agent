import type { ChangeEvent } from "@nova-agent/core";
import { format } from "date-fns";
import { formatDeadline, formatRelative } from "./format";
import type { Dashboard, NextMove } from "./model";

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const words = (n: number): string => WORDS[n] ?? String(n);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`): string => `${words(n)} ${n === 1 ? one : many}`;

export type Hero = { title: string; meta: string; text: string };

/** The Focus headline is the item; the sentence explains due date and the non-urgency reasons in words. */
export const focusHero = (nextMove: NextMove | null, courseName: string | undefined, now: Date): Hero => {
  if (!nextMove) {
    return { title: "Nothing active right now", meta: "Do this first", text: "Every visible item is submitted, hidden, or not yet rankable. Refresh to check for new work." };
  }
  const { item, ranked, reasons } = nextMove;
  const due = item.dueAt
    ? ranked.priority.overdue
      ? `Overdue since ${formatDeadline(item.dueAt, now)}, ${formatRelative(item.dueAt, now)}.`
      : `Due ${formatDeadline(item.dueAt, now)}, ${formatRelative(item.dueAt, now)}.`
    : "No due date.";
  const rest = reasons.filter((reason) => reason.component !== "urgency").map((reason) => reason.text);
  return {
    title: item.title,
    meta: ["Do this first", courseName ?? "Unknown course", item.kind === "quiz" ? "Quiz" : "Assignment"].join(" · "),
    text: [due, ...rest].join(" "),
  };
};

export const weekHero = (dashboard: Dashboard, selectedDay: string | null = null): Hero => {
  const days = dashboard.week;
  if (selectedDay) {
    const day = days.find((candidate) => format(candidate.date, "yyyy-MM-dd") === selectedDay);
    if (day) {
      const active = day.entries.filter((entry) => entry.bucket !== "completed");
      const done = day.entries.length - active.length;
      const name = day.isToday ? "Today" : format(day.date, "EEEE");
      const quizzes = active.filter((entry) => entry.item.kind === "quiz").length;
      return {
        title: active.length === 0 ? `Nothing due ${day.isToday ? "today" : format(day.date, "EEEE")}` : `${name}: ${plural(active.length, "deadline")}`,
        meta: `${format(day.date, "EEEE, MMM d")} · tap the day again for the whole week`,
        text:
          active.length === 0
            ? done > 0
              ? `${cap(plural(done, "item"))} already submitted. A clear day.`
              : "A clear day. Use it to get ahead on the next one."
            : `${quizzes > 0 ? `${cap(plural(quizzes, "quiz", "quizzes"))} and ` : ""}${quizzes > 0 ? plural(active.length - quizzes, "assignment") : cap(plural(active.length, "assignment"))}${done > 0 ? `, plus ${plural(done, "item")} already submitted` : ""}.`,
      };
    }
  }
  const total = days.reduce((sum, day) => sum + day.entries.filter((entry) => entry.bucket !== "completed").length, 0);
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  const meta = first && last ? `This week · ${format(first, "MMM d")} to ${format(last, "MMM d")}` : "This week";
  if (total === 0) return { title: "Nothing due in the next seven days", meta, text: "Deadlines further out are listed under Later on the Focus tab." };
  const activeCount = (day: (typeof days)[number]) => day.entries.filter((entry) => entry.bucket !== "completed").length;
  const busiest = [...days].sort((a, b) => activeCount(b) - activeCount(a))[0];
  const busiestActive = busiest ? busiest.entries.filter((entry) => entry.bucket !== "completed") : [];
  const dayName = busiest ? (busiest.isToday ? "today" : format(busiest.date, "EEEE")) : "";
  const title = busiestActive.length >= 2 ? `${cap(plural(total, "deadline"))}, ${cap(dayName)} is the crunch` : `${cap(plural(total, "deadline"))} this week`;
  const quizzes = busiestActive.filter((entry) => entry.item.kind === "quiz").length;
  const text =
    busiestActive.length >= 2
      ? `${cap(words(busiestActive.length))} land ${dayName}${quizzes > 0 ? `, including ${plural(quizzes, "quiz", "quizzes")}` : ""}. Start the earliest one first.`
      : "Spread evenly. Take them in order.";
  return { title, meta, text };
};

export const changesHero = (dashboard: Dashboard, lastVisitAt: string | null, now: Date): Hero => {
  const events: ChangeEvent[] = [...dashboard.changes.today, ...dashboard.changes.yesterday, ...dashboard.changes.earlier];
  const meta = `Since your last visit${lastVisitAt ? ` · ${formatRelative(lastVisitAt, now)}` : ""}`.replace("· in ", "· ");
  if (events.length === 0) return { title: "No changes since your last visit", meta, text: "Nova compares every refresh with the last one and only lists meaningful changes." };
  const count = (kind: ChangeEvent["kind"]) => events.filter((event) => event.kind === kind).length;
  const moved = count("due-date-changed");
  const overdue = count("became-overdue");
  const added = count("item-added");
  const posted = count("announcement-added") + count("announcement-updated");
  const submitted = count("status-changed");
  const removed = count("item-removed") + count("visibility-changed");
  const lead = moved > 0 ? plural(moved, "deadline") + " moved" : overdue > 0 ? `${words(overdue)} became overdue` : added > 0 ? plural(added, "new item") : posted > 0 ? plural(posted, "announcement") : submitted > 0 ? `${words(submitted)} submitted` : plural(removed, "item") + " changed";
  const rest = [
    moved > 0 && lead.includes("moved") ? null : moved > 0 ? `${words(moved)} moved` : null,
    overdue > 0 && !lead.includes("overdue") ? `${words(overdue)} overdue` : null,
    added > 0 && !lead.includes("new") ? `${words(added)} added` : null,
    submitted > 0 && !lead.includes("submitted") ? `${words(submitted)} submitted` : null,
    posted > 0 && !lead.includes("announcement") ? `${words(posted)} posted` : null,
    removed > 0 && !lead.includes("changed") ? `${words(removed)} hidden or removed` : null,
  ].filter((part): part is string => part !== null);
  const text = rest.length > 0 ? `Also ${rest.join(", ")}.` : "That is the only change.";
  return { title: `${cap(plural(events.length, "change"))}, ${lead}`, meta, text };
};
