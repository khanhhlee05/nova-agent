import { addDays, endOfDay, endOfWeek, startOfDay } from "date-fns";
import { isDone, type AcademicItem, type DeadlineBucket } from "./models";

export type BucketOptions = {
  /** Reference instant. Defaults to the current time. */
  now?: Date;
};

export type DeadlineWindow = {
  now: Date;
  endOfToday: Date;
  endOfTomorrow: Date;
  /** Sunday 23:59:59.999 in the local timezone. */
  endOfWeekSunday: Date;
};

/**
 * Computes the local-timezone boundaries used by every bucket decision.
 * The window is derived once per render so all sections agree.
 */
export const deadlineWindow = (now: Date = new Date()): DeadlineWindow => ({
  now,
  endOfToday: endOfDay(now),
  endOfTomorrow: endOfDay(addDays(startOfDay(now), 1)),
  endOfWeekSunday: endOfWeek(now, { weekStartsOn: 1 }),
});

const toDate = (iso: string | null): Date | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Classifies a single item into exactly one deadline bucket.
 *
 * - `completed`: submitted or completed, regardless of date.
 * - `overdue`: due strictly before now.
 * - `today`: due from now through the end of the local day.
 * - `tomorrow`: due on the next local calendar day.
 * - `this-week`: due after tomorrow through Sunday 23:59:59 local time.
 * - `later`: due after this week.
 * - `no-date`: no due date.
 */
export const classifyDeadline = (
  item: Pick<AcademicItem, "dueAt" | "status">,
  options: BucketOptions | DeadlineWindow = {},
): DeadlineBucket => {
  if (isDone(item)) return "completed";
  const window = "endOfToday" in options ? options : deadlineWindow(options.now);
  const due = toDate(item.dueAt);
  if (!due) return "no-date";
  if (due.getTime() < window.now.getTime()) return "overdue";
  if (due.getTime() <= window.endOfToday.getTime()) return "today";
  if (due.getTime() <= window.endOfTomorrow.getTime()) return "tomorrow";
  if (due.getTime() <= window.endOfWeekSunday.getTime()) return "this-week";
  return "later";
};

export const BUCKET_ORDER: readonly DeadlineBucket[] = [
  "overdue",
  "today",
  "tomorrow",
  "this-week",
  "later",
  "no-date",
  "completed",
];

export type BucketedItems = Record<DeadlineBucket, AcademicItem[]>;

const emptyBuckets = (): BucketedItems => ({
  overdue: [],
  today: [],
  tomorrow: [],
  "this-week": [],
  later: [],
  "no-date": [],
  completed: [],
});

const byDueThenTitle = (a: AcademicItem, b: AcademicItem): number => {
  const ad = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const bd = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  const title = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  return title !== 0 ? title : a.key.localeCompare(b.key);
};

/** Groups items into buckets with a deterministic order inside each bucket. */
export const bucketItems = (items: readonly AcademicItem[], options: BucketOptions = {}): BucketedItems => {
  const window = deadlineWindow(options.now);
  const buckets = emptyBuckets();
  for (const item of items) buckets[classifyDeadline(item, window)].push(item);
  for (const bucket of BUCKET_ORDER) buckets[bucket].sort(byDueThenTitle);
  return buckets;
};

export type WorkloadCounts = {
  overdue: number;
  today: number;
  thisWeek: number;
};

/** Summary chip counts. "This week" includes today and tomorrow so the number reads as "due by Sunday". */
export const workloadCounts = (items: readonly AcademicItem[], options: BucketOptions = {}): WorkloadCounts => {
  const buckets = bucketItems(items, options);
  return {
    overdue: buckets.overdue.length,
    today: buckets.today.length,
    thisWeek: buckets.today.length + buckets.tomorrow.length + buckets["this-week"].length,
  };
};

export const hoursUntil = (dueAt: string | null, now: Date): number | null => {
  const due = toDate(dueAt);
  if (!due) return null;
  return (due.getTime() - now.getTime()) / 3_600_000;
};
