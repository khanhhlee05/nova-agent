import {
  bucketItems,
  classifyDeadline,
  deadlineWindow,
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

export type Dashboard = {
  snapshot: AcademicSnapshot;
  courses: Course[];
  courseById: Map<string, Course>;
  itemByKey: Map<string, AcademicItem>;
  items: AcademicItem[];
  buckets: BucketedItems;
  counts: { overdue: number; today: number; thisWeek: number; unread: number };
  ranked: Map<string, RankedItem>;
  nextMove: NextMove | null;
  week: WeekDay[];
  changes: ChangeGroups;
  totalChanges: number;
};

export type BuildDashboardInput = {
  snapshot: AcademicSnapshot;
  events: readonly ChangeEvent[];
  now: Date;
  courseFilter: CourseFilter;
};

/** Pure derivation of everything the three tabs render. Counts, buckets, and ranking share one filtered set. */
export const buildDashboard = ({ snapshot, events, now, courseFilter }: BuildDashboardInput): Dashboard => {
  const courses = [...snapshot.courses].sort((a, b) => a.name.localeCompare(b.name));
  const courseById = new Map(courses.map((course) => [course.id, course]));
  const itemByKey = new Map(snapshot.items.map((item) => [item.key, item]));
  // Hidden and expired items are not actionable, so they never reach a bucket or the ranking.
  const items = snapshot.items.filter((item) => item.visibility !== "hidden" && item.visibility !== "expired" && (courseFilter === null || item.courseId === courseFilter));
  const buckets = bucketItems(items, { now });

  const rankedList = rankItems(items, { now });
  const ranked = new Map(rankedList.map((entry) => [entry.item.key, entry]));
  const top = rankedList[0];
  const nextMove = top ? { item: top.item, ranked: top, reasons: explainPriority(top.item, top.priority) } : null;

  const window = deadlineWindow(now);
  const start = startOfDay(now);
  const week: WeekDay[] = Array.from({ length: 7 }, (_, offset) => {
    const date = addDays(start, offset);
    const entries = items
      .filter((item) => item.dueAt && isSameDay(new Date(item.dueAt), date))
      .map((item) => ({ item, bucket: classifyDeadline(item, window) }))
      .sort((a, b) => new Date(a.item.dueAt as string).getTime() - new Date(b.item.dueAt as string).getTime() || a.item.title.localeCompare(b.item.title));
    return { date, isToday: offset === 0, entries };
  });

  const filteredEvents = events.filter((event) => courseFilter === null || event.courseId === courseFilter);
  const yesterdayStart = subDays(start, 1);
  const changes: ChangeGroups = { today: [], yesterday: [], earlier: [] };
  for (const event of filteredEvents) {
    const detected = new Date(event.detectedAt);
    if (detected >= start) changes.today.push(event);
    else if (detected >= yesterdayStart) changes.yesterday.push(event);
    else changes.earlier.push(event);
  }
  const unread = filteredEvents.filter((event) => event.readAt === null).length;

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
  };
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
  "this-week": "This week",
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
