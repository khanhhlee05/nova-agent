import type { CompactBucket, CompactSnapshot } from "@nova-agent/protocol";
import { z } from "zod";

export const rangeSchema = z.enum(["overdue", "long-overdue", "today", "tomorrow", "week", "next-week", "later", "no-date", "all"]);
export type Range = z.infer<typeof rangeSchema>;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checked in `resolvePeriod` rather than by zod, so a phrase like "next monday" gets an error that shows the expected format. */
export const dateSchema = z.string().max(40);

/** Bucket filter per range. `next-week` is a date window instead, so it has none. */
const bucketsFor = (range: Range): CompactBucket[] | null => {
  switch (range) {
    case "overdue":
    case "long-overdue":
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
  "long-overdue": "long overdue (more than two weeks)",
  today: "due today",
  tomorrow: "due tomorrow",
  week: "due in the next 7 days",
  "next-week": "due next week",
  later: "due later",
  "no-date": "without a due date",
  all: "in total",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sep 14" from "2026-09-14". Month names of a calendar string do not depend on any time zone. */
export const shortDate = (date: string): string => {
  const [, month, day] = date.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${day}`;
};

/** "Mon, Sep 14" from "2026-09-14". The weekday of a calendar string is the same in every zone. */
export const dayLabel = (date: string): string => `${WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]}, ${shortDate(date)}`;

/** Calendar arithmetic on a "YYYY-MM-DD" string, done in UTC so no time zone can shift the day. */
export const addCalendarDays = (date: string, days: number): string => new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export const isCalendarDate = (value: string): boolean => DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) && addCalendarDays(value, 0) === value;

export type PeriodInput = { range?: Range; from?: string; to?: string };

export type Period = {
  range: Range;
  /** True when `from` or `to` was given. */
  windowed: boolean;
  /** The calendar week used by `next-week`, otherwise null. */
  next: { from: string; to: string } | null;
  from: string | null;
  to: string | null;
  /** Whether something in `bucket`, due on local calendar day `dueDate`, falls in the period. The long-overdue split is the caller's. */
  matches(bucket: CompactBucket, dueDate: string | null): boolean;
  /** "due in the next 7 days", "due next week", or plain "due" for a date window. */
  label: string;
  /** " (Sep 14 to Sep 20)" for next-week, " between a and b" for a window; empty otherwise. */
  suffix: string;
};

/**
 * One reading of "which period" for every tool that takes a range or a date
 * window. Calendar strings compare correctly as plain strings, so nothing
 * here does date math in a time zone.
 */
export const resolvePeriod = (input: PeriodInput, snapshot: CompactSnapshot, fallback: Range): { ok: true; period: Period } | { ok: false; error: string } => {
  for (const field of ["from", "to"] as const) {
    const value = input[field];
    if (value !== undefined && !DATE.test(value)) return { ok: false, error: `${field} must be a date like 2026-09-21, not "${value}".` };
  }
  if (input.from && input.to && input.from > input.to) return { ok: false, error: `from (${input.from}) is after to (${input.to}).` };
  const windowed = input.from !== undefined || input.to !== undefined;
  const range: Range = input.range ?? (windowed ? "all" : fallback);
  const buckets = bucketsFor(range);
  const next = range === "next-week" ? snapshot.calendar.nextWeek : null;
  const inWindow = (date: string | null): boolean => {
    if (!next && !windowed) return true;
    if (!date) return false;
    if (next && (date < next.from || date > next.to)) return false;
    if (input.from && date < input.from) return false;
    if (input.to && date > input.to) return false;
    return true;
  };
  const period = next ? ` (${shortDate(next.from)} to ${shortDate(next.to)})` : "";
  const between = !windowed ? "" : input.from && input.to ? ` between ${input.from} and ${input.to}` : input.from ? ` on or after ${input.from}` : ` on or before ${input.to}`;
  return {
    ok: true,
    period: {
      range,
      windowed,
      next,
      from: input.from ?? null,
      to: input.to ?? null,
      matches: (bucket, dueDate) => (buckets ? buckets.includes(bucket) : true) && inWindow(dueDate),
      label: windowed && range === "all" ? "due" : RANGE_LABEL[range],
      suffix: `${period}${between}`,
    },
  };
};
