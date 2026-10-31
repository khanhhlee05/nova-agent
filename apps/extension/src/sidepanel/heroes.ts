import type { ChangeEvent } from "@nova-agent/core";
import { format } from "date-fns";
import { formatAge, formatDeadline, formatRelative } from "./format";
import { isUpcoming, type Dashboard, type NextMove } from "./model";

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const words = (n: number): string => WORDS[n] ?? String(n);
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, one: string, many = `${one}s`): string => `${words(n)} ${n === 1 ? one : many}`;

export type Hero = { title: string; meta: string; text: string };

/** The Focus headline is the item; the sentence explains due date and the non-urgency reasons in words. */
export const focusHero = (nextMove: NextMove | null, courseName: string | undefined, now: Date): Hero => {
  if (!nextMove) {
    return { title: "You're all caught up", meta: "Nothing left to start", text: "Nothing is waiting on you in the courses Nova can see. Refresh to check for new work." };
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
  const upcoming = (day: (typeof days)[number]) => day.entries.filter((entry) => isUpcoming(entry.bucket));
  if (selectedDay) {
    const day = days.find((candidate) => format(candidate.date, "yyyy-MM-dd") === selectedDay);
    if (day) {
      const active = upcoming(day);
      const late = day.entries.filter((entry) => entry.bucket === "overdue").length;
      const done = day.entries.filter((entry) => entry.bucket === "completed").length;
      const name = day.isToday ? "Today" : format(day.date, "EEEE");
      const quizzes = active.filter((entry) => entry.item.kind === "quiz").length;
      const also = [late > 0 ? `${plural(late, "item")} already overdue` : null, done > 0 ? `${plural(done, "item")} already submitted` : null].filter((part): part is string => part !== null);
      return {
        title: active.length === 0 ? `Nothing due ${day.isToday ? "today" : format(day.date, "EEEE")}` : `${name}: ${plural(active.length, "deadline")}`,
        meta: `${format(day.date, "EEEE, MMM d")} · Click ${day.isToday ? "Today" : format(day.date, "EEE")} again to see all 7 days`,
        text:
          active.length === 0
            ? also.length > 0
              ? `${cap(also.join(" and "))}.`
              : "A clear day. Use it to get ahead on the next one."
            : `${quizzes > 0 ? `${cap(plural(quizzes, "quiz", "quizzes"))} and ` : ""}${quizzes > 0 ? plural(active.length - quizzes, "assignment") : cap(plural(active.length, "assignment"))}${also.length > 0 ? `, plus ${also.join(" and ")}` : ""}.`,
      };
    }
  }
  // The same number as "Next 7 days" in the Focus counts strip: today, tomorrow, and later this week.
  const total = dashboard.counts.thisWeek;
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  const meta = first && last ? `Next 7 days · ${format(first, "MMM d")} to ${format(last, "MMM d")}` : "Next 7 days";
  if (total === 0) return { title: "Nothing due in the next 7 days", meta, text: "Deadlines further out are listed under Later on the Focus tab." };
  const busiest = [...days].sort((a, b) => upcoming(b).length - upcoming(a).length)[0];
  const busiestActive = busiest ? upcoming(busiest) : [];
  const dayName = busiest ? (busiest.isToday ? "today" : format(busiest.date, "EEEE")) : "";
  const title = busiestActive.length >= 2 ? `${cap(plural(total, "deadline"))}, ${cap(dayName)} is the crunch` : `${cap(plural(total, "deadline"))} in the next 7 days`;
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

/** The Ask headline states scope and freshness, computed like every other tab's. */
export const askHero = (dashboard: Dashboard, enabled: boolean, lastSuccessfulSyncAt: string | null, now: Date): Hero => {
  if (!enabled) {
    return { title: "Ask Nova is off", meta: "Read what gets sent, then turn it on below", text: "Ask about your deadlines and changes in plain words. Answers come from a Nova server, so your question and a summary of your courses leave this device." };
  }
  const courses = dashboard.courses.length;
  return {
    title: courses === 0 ? "Nothing to ask about yet" : `Ask across ${plural(courses, "course")}`,
    meta: lastSuccessfulSyncAt ? `Answers use data refreshed ${formatAge(lastSuccessfulSyncAt, now)}` : "Answers need a refresh first",
    text: "Deadlines, changes, what to start first. Nova reads every course, filtered or not, and cannot change anything in Brightspace.",
  };
};
