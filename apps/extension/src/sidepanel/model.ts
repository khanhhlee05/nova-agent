import {
  BUCKET_ORDER,
  bucketItems,
  classifyDeadline,
  deadlineWindow,
  isDone,
  type AcademicItem,
  type AcademicSnapshot,
  type BucketedItems,
  type ChangeEvent,
  type Course,
  type DeadlineBucket,
} from "@nova-agent/core";
import { explainPriority, rankItems, type PriorityReason, type RankedItem } from "@nova-agent/planner";
import { addDays, isSameDay, startOfDay, subDays } from "date-fns";

export type CourseFilter = string | null;

export type NextMove = { item: AcademicItem; ranked: RankedItem; reasons: PriorityReason[] };

export type WeekEntry = { item: AcademicItem; bucket: DeadlineBucket };

export type WeekDay = { date: Date; isToday: boolean; entries: WeekEntry[] };

export type ChangeGroups = { today: ChangeEvent[]; yesterday: ChangeEvent[]; earlier: ChangeEvent[] };

/** The three views of the Focus tab. One is shown at a time. */
export type FocusCategory = "overdue" | "upcoming" | "completed";

export const FOCUS_CATEGORIES: readonly FocusCategory[] = ["overdue", "upcoming", "completed"];

export const FOCUS_CATEGORY_LABELS: Record<FocusCategory, string> = { overdue: "Overdue", upcoming: "Upcoming", completed: "Completed" };

/** Buckets shown inside Upcoming, in order, when the list is sorted by due date. */
export const UPCOMING_BUCKETS: readonly DeadlineBucket[] = BUCKET_ORDER.filter((bucket) => bucket !== "overdue" && bucket !== "completed");

export const focusCategoryOf = (bucket: DeadlineBucket): FocusCategory => (bucket === "overdue" ? "overdue" : bucket === "completed" ? "completed" : "upcoming");

export type SortKey = "due" | "course" | "updated";

export const SORT_KEYS: readonly SortKey[] = ["due", "course", "updated"];

export const SORT_LABELS: Record<SortKey, string> = { due: "Due date", course: "Course", updated: "Recently updated" };

export type Dashboard = {
  snapshot: AcademicSnapshot;
  courses: Course[];
  courseById: Map<string, Course>;
  itemByKey: Map<string, AcademicItem>;
  items: AcademicItem[];
  buckets: BucketedItems;
  /** `thisWeek` is today plus the next six days, the same seven days the Week tab shows. */
  counts: { overdue: number; today: number; thisWeek: number; unread: number };
  ranked: Map<string, RankedItem>;
  nextMove: NextMove | null;
  week: WeekDay[];
  changes: ChangeGroups;
  totalChanges: number;
  /** Count of tasks hidden by session dismissals, for the "hidden until next refresh" bar. */
  hidden: { items: number };
  /** Items the student marked done on this device, with when. Brightspace still lists them as open. */
  localDone: ReadonlyMap<string, string>;
  /** When each item last appeared in the current change feed. Drives the "Changed" mark and the recently-updated sort. */
  changedAt: ReadonlyMap<string, string>;
};

export type BuildDashboardInput = {
  snapshot: AcademicSnapshot;
  events: readonly ChangeEvent[];
  now: Date;
  courseFilter: CourseFilter;
  /** Session-only task dismissals. Hidden everywhere: counts, sections, next move, and week. */
  dismissedItemKeys?: ReadonlySet<string>;
  /** Persisted local done marks, item key to markedAt. Marked items count as completed until Brightspace says so itself. */
  localMarks?: ReadonlyMap<string, string>;
};

/** Still to do and not yet late. The Week tab counts only these, so its numbers match the counts strip. */
export const isUpcoming = (bucket: DeadlineBucket): boolean => bucket === "today" || bucket === "tomorrow" || bucket === "this-week";

/**
 * A change stays in the feed for the session in which it was read, then
 * leaves on the next refresh: anything read before the current snapshot was
 * captured has already been seen "since your last visit".
 */
export const isReadBefore = (event: Pick<ChangeEvent, "readAt">, capturedAt: string): boolean =>
  event.readAt !== null && new Date(event.readAt).getTime() < new Date(capturedAt).getTime();

/** Pure derivation of everything the three tabs render. Counts, buckets, and ranking share one filtered set. */
export const buildDashboard = ({ snapshot, events, now, courseFilter, dismissedItemKeys, localMarks }: BuildDashboardInput): Dashboard => {
  const courses = [...snapshot.courses].sort((a, b) => a.name.localeCompare(b.name));
  const courseById = new Map(courses.map((course) => [course.id, course]));
  const itemByKey = new Map(snapshot.items.map((item) => [item.key, item]));
  // Hidden and expired items are not actionable, so they never reach a bucket or the ranking.
  const items = snapshot.items.filter(
    (item) => item.visibility !== "hidden" && item.visibility !== "expired" && !dismissedItemKeys?.has(item.key) && (courseFilter === null || item.courseId === courseFilter),
  );
  // A local mark only matters while Brightspace still lists the item as open; once the LMS agrees, the Brightspace status is the story.
  const localDone = new Map<string, string>();
  for (const item of items) {
    const markedAt = localMarks?.get(item.key);
    if (markedAt && !isDone(item)) localDone.set(item.key, markedAt);
  }
  const active = localDone.size > 0 ? items.filter((item) => !localDone.has(item.key)) : items;
  const buckets = bucketItems(active, { now });
  if (localDone.size > 0) {
    buckets.completed = [...buckets.completed, ...items.filter((item) => localDone.has(item.key))].sort(byDueThenTitle);
  }

  const rankedList = rankItems(active, { now });
  const ranked = new Map(rankedList.map((entry) => [entry.item.key, entry]));
  const top = rankedList[0];
  const nextMove = top ? { item: top.item, ranked: top, reasons: explainPriority(top.item, top.priority) } : null;

  const window = deadlineWindow(now);
  const start = startOfDay(now);
  const week: WeekDay[] = Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(start, offset);
    const entries = items
      .filter((item) => item.dueAt && isSameDay(new Date(item.dueAt), date))
      .map((item) => ({ item, bucket: localDone.has(item.key) ? ("completed" as const) : classifyDeadline(item, window) }))
      .sort((a, b) => new Date(a.item.dueAt as string).getTime() - new Date(b.item.dueAt as string).getTime() || a.item.title.localeCompare(b.item.title));
    return { date, isToday: offset === 0, entries };
  });

  const filteredEvents = events.filter((event) => !isReadBefore(event, snapshot.capturedAt) && (courseFilter === null || event.courseId === courseFilter));
  const yesterdayStart = subDays(start, 1);
  const changes: ChangeGroups = { today: [], yesterday: [], earlier: [] };
  for (const event of filteredEvents) {
    const detected = new Date(event.detectedAt);
    if (detected >= start) changes.today.push(event);
    else if (detected >= yesterdayStart) changes.yesterday.push(event);
    else changes.earlier.push(event);
  }
  const unread = filteredEvents.filter((event) => event.readAt === null).length;
  const changedAt = new Map<string, string>();
  for (const event of filteredEvents) {
    if (!itemByKey.has(event.entityKey)) continue;
    const previous = changedAt.get(event.entityKey);
    if (!previous || previous < event.detectedAt) changedAt.set(event.entityKey, event.detectedAt);
  }

  return {
    snapshot,
    courses,
    courseById,
    itemByKey,
    items,
    buckets,
    counts: { overdue: buckets.overdue.length, today: buckets.today.length, thisWeek: buckets.today.length + buckets.tomorrow.length + buckets["this-week"].length, unread },
    ranked,
    nextMove,
    week,
    changes,
    totalChanges: filteredEvents.length,
    hidden: { items: dismissedItemKeys ? snapshot.items.filter((item) => dismissedItemKeys.has(item.key)).length : 0 },
    localDone,
    changedAt,
  };
};

const dueTime = (item: AcademicItem): number => (item.dueAt ? new Date(item.dueAt).getTime() : Number.POSITIVE_INFINITY);

const byDueThenTitle = (a: AcademicItem, b: AcademicItem): number => dueTime(a) - dueTime(b) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key);

/** When the item last changed from the student's point of view: the feed first, then what Brightspace reports. */
export const updatedTime = (item: AcademicItem, dashboard: Pick<Dashboard, "changedAt">): number => new Date(dashboard.changedAt.get(item.key) ?? item.sourceUpdatedAt ?? item.observedAt).getTime();

/**
 * Orders one category's rows. Due date runs earliest first except under Completed, where the
 * most recent deadline is the most relevant; items without a date always come last.
 */
export const sortItems = (items: readonly AcademicItem[], sort: SortKey, dashboard: Pick<Dashboard, "changedAt" | "courseById">, category: FocusCategory): AcademicItem[] => {
  const list = [...items];
  if (sort === "course") {
    const name = (item: AcademicItem) => dashboard.courseById.get(item.courseId)?.name ?? "";
    return list.sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: "base" }) || byDueThenTitle(a, b));
  }
  if (sort === "updated") return list.sort((a, b) => updatedTime(b, dashboard) - updatedTime(a, dashboard) || byDueThenTitle(a, b));
  if (category !== "completed") return list.sort(byDueThenTitle);
  return list.sort((a, b) => {
    const ad = dueTime(a);
    const bd = dueTime(b);
    if (ad === bd) return byDueThenTitle(a, b);
    if (ad === Number.POSITIVE_INFINITY) return 1;
    if (bd === Number.POSITIVE_INFINITY) return -1;
    return bd - ad;
  });
};

export type ChangeVerb = "Added" | "Moved" | "Became overdue" | "Submitted" | "Hidden" | "Updated" | "Removed" | "Visible" | "Posted";

export const changeVerb = (event: ChangeEvent): ChangeVerb => {
  switch (event.kind) {
    case "item-added":
      return "Added";
    case "due-date-changed":
      return "Moved";
    case "became-overdue":
      return "Became overdue";
    case "status-changed":
      return event.after?.status === "submitted" || event.after?.status === "completed" ? "Submitted" : "Updated";
    case "visibility-changed":
      return event.after?.visibility === "hidden" ? "Hidden" : event.after?.visibility === "visible" ? "Visible" : "Updated";
    case "item-removed":
      return "Removed";
    case "announcement-added":
      return "Posted";
    case "announcement-updated":
      return "Updated";
  }
};

export const changeTitle = (event: ChangeEvent): string => {
  const title = (event.after?.title ?? event.before?.title) as string | undefined;
  return title ?? "Item";
};

export const SECTION_LABELS: Record<DeadlineBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  "this-week": "Later this week",
  later: "Later",
  "no-date": "No date",
  completed: "Completed",
};

export const STATUS_LABELS: Record<AcademicItem["status"], string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  submitted: "Submitted",
  completed: "Completed",
  unknown: "Status unknown",
};

export const KIND_LABELS: Record<AcademicItem["kind"], string> = { assignment: "Assignment", quiz: "Quiz" };
