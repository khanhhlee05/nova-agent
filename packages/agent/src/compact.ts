import {
  classifyDeadline,
  deadlineWindow,
  isActive,
  isDone,
  normalizeText,
  parseStableKey,
  sortEventsNewestFirst,
  type AcademicItem,
  type AcademicSnapshot,
  type Announcement,
  type ChangeEvent,
} from "@nova-agent/core";
import { explainPriority, rankItems } from "@nova-agent/planner";
import { COMPACT_LIMITS, type CompactChange, type CompactItem, type CompactSnapshot } from "@nova-agent/protocol";
import { addDays, addWeeks, differenceInCalendarDays, endOfWeek, format, startOfDay, startOfWeek } from "date-fns";

export type CompactOptions = {
  mode: "live" | "demo";
  /** IANA zone name recorded in the snapshot; the formatting itself uses the process zone. */
  timezone?: string;
  maxItems?: number;
  completedWithinDays?: number;
  changesWithinDays?: number;
  announcementsWithinDays?: number;
};

const LOCAL_FORMAT = "EEE, MMM d, h:mm a";

const localOf = (iso: string | null): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : format(date, LOCAL_FORMAT);
};

const DATE_FORMAT = "yyyy-MM-dd";

const dateOf = (iso: string | null): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : format(date, DATE_FORMAT);
};

/** Calendar strings in the student's zone. `thisWeek` matches `deadlineWindow`; weeks start on Monday. */
export const calendarOf = (now: Date): CompactSnapshot["calendar"] => {
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const nextStart = addWeeks(weekStart, 1);
  return {
    today: format(now, DATE_FORMAT),
    weekStart: format(weekStart, DATE_FORMAT),
    thisWeek: { from: format(now, DATE_FORMAT), to: format(addDays(startOfDay(now), 6), DATE_FORMAT) },
    nextWeek: { from: format(nextStart, DATE_FORMAT), to: format(endOfWeek(nextStart, { weekStartsOn: 1 }), DATE_FORMAT) },
  };
};

/** Strips control characters (newlines included) and collapses whitespace, so LMS text can never add a line to a prompt. */
export const cleanText = (text: string): string => normalizeText(text.replace(/\p{Cc}/gu, " "));

const clip = (text: string): string => {
  const clean = cleanText(text);
  return clean.length > COMPACT_LIMITS.title ? `${clean.slice(0, COMPACT_LIMITS.title - 1)}…` : clean;
};

const httpOnly = (url: string | null): string | null => (url && /^https?:\/\//i.test(url) ? url : null);

/** "a4101" for assignment 4101, "q5101" for quiz 5101, "n7001" for announcement 7001. */
export const shortId = (key: string, fallbackKind: string): string => {
  const parts = parseStableKey(key);
  const kind = parts?.kind ?? fallbackKind;
  const sourceId = parts?.sourceId ?? key.split("|").pop() ?? key;
  const initial = kind === "announcement" ? "n" : kind.charAt(0);
  return `${initial}${sourceId}`.slice(0, 40);
};

const withinDays = (iso: string | null, now: Date, days: number): boolean => {
  if (!iso) return false;
  const time = new Date(iso).getTime();
  return !Number.isNaN(time) && now.getTime() - time <= days * 86_400_000;
};

const compactVisibility = (item: AcademicItem): CompactItem["visibility"] => (item.visibility === "scheduled" ? "scheduled" : item.visibility === "visible" ? "visible" : "unknown");

const changeFields = (record: Record<string, unknown> | null): CompactChange["before"] => {
  if (!record) return null;
  const out: NonNullable<CompactChange["before"]> = {};
  if ("dueAt" in record) {
    const dueAt = typeof record.dueAt === "string" ? record.dueAt : null;
    out.dueAt = dueAt;
    out.dueLocal = localOf(dueAt);
  }
  if (typeof record.status === "string") out.status = record.status as NonNullable<CompactChange["before"]>["status"];
  if (typeof record.visibility === "string") out.visibility = record.visibility.slice(0, 16);
  return out;
};

const changeTitle = (event: ChangeEvent): string => {
  const title = (event.after?.title ?? event.before?.title) as string | undefined;
  return clip(title ?? "Item");
};

/**
 * Builds the compact snapshot the Ask tab sends with each question.
 *
 * Runs in the browser on purpose: buckets, local date strings, and "days ago"
 * depend on the student's time zone, and the server must never do that math.
 * Hidden and expired items, the tenant, the user id, announcement bodies, and
 * observation metadata never leave the device.
 */
export const compactSnapshot = (snapshot: AcademicSnapshot, events: readonly ChangeEvent[], now: Date, options: CompactOptions): CompactSnapshot => {
  const maxItems = Math.min(options.maxItems ?? COMPACT_LIMITS.items, COMPACT_LIMITS.items);
  const completedWithinDays = options.completedWithinDays ?? 14;
  const changesWithinDays = options.changesWithinDays ?? 14;
  const announcementsWithinDays = options.announcementsWithinDays ?? 30;

  const courses = [...snapshot.courses]
    .filter((course) => course.active)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, COMPACT_LIMITS.courses)
    .map((course) => ({ id: course.id, name: clip(course.name), code: course.code ? cleanText(course.code).slice(0, 64) : null, homeUrl: course.homeUrl, active: course.active }));
  const courseIds = new Set(courses.map((course) => course.id));

  const window = deadlineWindow(now);
  const visible = snapshot.items.filter((item) => courseIds.has(item.courseId) && item.visibility !== "hidden" && item.visibility !== "expired");
  const eligible = visible.filter((item) => isActive(item) || (isDone(item) && withinDays(item.dueAt, now, completedWithinDays)));
  const ranked = new Map(rankItems(visible.filter(isActive), { now }).map((entry) => [entry.item.key, entry]));

  const dueTime = (item: AcademicItem): number => (item.dueAt ? new Date(item.dueAt).getTime() : Number.POSITIVE_INFINITY);
  const items: CompactItem[] = [...eligible]
    .sort((a, b) => dueTime(a) - dueTime(b) || a.title.localeCompare(b.title))
    .slice(0, maxItems)
    .map((item) => {
      const entry = ranked.get(item.key);
      return {
        id: shortId(item.key, item.kind),
        courseId: item.courseId,
        kind: item.kind,
        title: clip(item.title),
        dueAt: item.dueAt,
        dueLocal: localOf(item.dueAt),
        dueDate: dateOf(item.dueAt),
        bucket: classifyDeadline(item, window),
        status: item.status,
        visibility: compactVisibility(item),
        pointsPossible: item.pointsPossible,
        url: httpOnly(item.url),
        priority: entry ? Math.round(entry.priority.score) : null,
        reasons: entry ? explainPriority(item, entry.priority, COMPACT_LIMITS.reasons).map((reason) => reason.text) : [],
      };
    });
  const itemIdByKey = new Map(items.map((item) => [item.id, item]));

  const announcements = [...snapshot.announcements]
    .filter((announcement: Announcement) => courseIds.has(announcement.courseId) && announcement.visibility !== "hidden" && announcement.visibility !== "expired")
    .filter((announcement) => announcement.pinned || withinDays(announcement.createdAt ?? announcement.updatedAt, now, announcementsWithinDays))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || a.title.localeCompare(b.title))
    .slice(0, COMPACT_LIMITS.announcements)
    .map((announcement) => ({
      id: shortId(announcement.key, "announcement"),
      courseId: announcement.courseId,
      title: clip(announcement.title),
      createdAt: announcement.createdAt,
      createdLocal: localOf(announcement.createdAt),
      pinned: announcement.pinned,
      url: httpOnly(announcement.url),
    }));

  const changes: CompactChange[] = sortEventsNewestFirst(events)
    .filter((event) => courseIds.has(event.courseId) && withinDays(event.detectedAt, now, changesWithinDays))
    .slice(0, COMPACT_LIMITS.changes)
    .map((event) => {
      const parts = parseStableKey(event.entityKey);
      const itemId = parts && parts.kind !== "announcement" ? shortId(event.entityKey, parts.kind) : null;
      return {
        id: event.id.slice(0, 80),
        kind: event.kind,
        courseId: event.courseId,
        title: changeTitle(event),
        itemId: itemId && itemIdByKey.has(itemId) ? itemId : null,
        detectedAt: event.detectedAt,
        detectedLocal: localOf(event.detectedAt) ?? event.detectedAt,
        daysAgo: Math.max(0, differenceInCalendarDays(now, new Date(event.detectedAt))),
        before: changeFields(event.before),
        after: changeFields(event.after),
        read: event.readAt !== null,
      };
    });

  const activeItems = items.filter((item) => item.bucket !== "completed");
  const count = (bucket: CompactItem["bucket"]) => activeItems.filter((item) => item.bucket === bucket).length;
  const today = count("today");
  return {
    version: 2,
    mode: options.mode,
    now: now.toISOString(),
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    capturedAt: snapshot.capturedAt,
    isComplete: snapshot.isComplete,
    failedCourseIds: snapshot.failedCourseIds.slice(0, COMPACT_LIMITS.courses),
    courses,
    items,
    announcements,
    changes,
    counts: {
      overdue: count("overdue"),
      today,
      thisWeek: today + count("tomorrow") + count("this-week"),
      unread: changes.filter((change) => !change.read).length,
      activeItems: activeItems.length,
    },
    calendar: calendarOf(now),
  };
};

/** JSON byte length, for tests and the size note in the setup card. */
export const estimateSize = (snapshot: CompactSnapshot): number => new TextEncoder().encode(JSON.stringify(snapshot)).length;
