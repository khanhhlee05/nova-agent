import {
  classifyDeadline,
  deadlineWindow,
  isActive,
  isDone,
  isLongOverdue,
  normalizeText,
  parseStableKey,
  sortEventsNewestFirst,
  type AcademicItem,
  type AcademicSnapshot,
  type Announcement,
  type ChangeEvent,
} from "@nova-agent/core";
import { estimateStudyMinutes, explainPriority, rankItems } from "@nova-agent/planner";
import { COMPACT_LIMITS, type CompactChange, type CompactItem, type CompactPersonal, type CompactSnapshot } from "@nova-agent/protocol";
import { addDays, addWeeks, differenceInCalendarDays, endOfWeek, format, startOfDay, startOfWeek } from "date-fns";

export type CompactOptions = {
  mode: "live" | "demo";
  /** IANA zone name recorded in the snapshot; the formatting itself uses the process zone. */
  timezone?: string;
  maxItems?: number;
  completedWithinDays?: number;
  changesWithinDays?: number;
  announcementsWithinDays?: number;
  /** Item keys the student marked done on this device. Such items count as completed, the same as on the Focus tab. */
  localDone?: { has(key: string): boolean };
  /** Item keys hidden for this session. They are left out; only their count is sent. */
  dismissedItemKeys?: { has(key: string): boolean };
  /** Deadlines the student added by hand on the Week tab. */
  personal?: readonly PersonalInput[];
  /** Send the names of each item's files. Only while the student lets Ask Nova read attachments. */
  includeAttachments?: boolean;
  /**
   * Content topics per course, for the courses whose materials the student lets Ask Nova read. A course in this
   * map is sent with its topic names (possibly none); a course outside it is sent without the field.
   */
  materials?: ReadonlyMap<string, readonly MaterialInput[]>;
};

/** The fields of a Content topic the compact snapshot needs. */
export type MaterialInput = { id: string; title: string; modulePath: readonly string[]; type: "file" | "page" | "link" | "other"; read: boolean };

/** The fields of a student-added deadline the compact snapshot needs. */
export type PersonalInput = { id: string; title: string; dueAt: string; courseId: string | null; completedAt: string | null; planId?: string | null };

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
  if ("score" in record) out.score = typeof record.score === "number" ? record.score : null;
  if ("pointsPossible" in record) out.pointsPossible = typeof record.pointsPossible === "number" ? record.pointsPossible : null;
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
    .map((course) => {
      const topics = options.materials?.get(course.id);
      return {
        id: course.id,
        name: clip(course.name),
        code: course.code ? cleanText(course.code).slice(0, 64) : null,
        homeUrl: course.homeUrl,
        active: course.active,
        ...(topics
          ? {
              materials: topics
                .filter((topic) => /^\d{1,12}$/.test(topic.id) && cleanText(topic.title) !== "")
                .slice(0, COMPACT_LIMITS.materials)
                .map((topic) => ({ id: topic.id, title: cleanText(topic.title).slice(0, COMPACT_LIMITS.fileName), module: cleanText(topic.modulePath.join(" › ")).slice(0, COMPACT_LIMITS.title), type: topic.type, read: topic.read })),
            }
          : {}),
      };
    });
  const courseIds = new Set(courses.map((course) => course.id));

  const window = deadlineWindow(now);
  const dismissed = options.dismissedItemKeys;
  const visible = snapshot.items.filter((item) => courseIds.has(item.courseId) && item.visibility !== "hidden" && item.visibility !== "expired" && !dismissed?.has(item.key));
  // A local mark only matters while Brightspace still lists the item as open, the same rule as the dashboard.
  const marked = (item: AcademicItem): boolean => !isDone(item) && options.localDone?.has(item.key) === true;
  const recentlyDue = (item: AcademicItem): boolean => !item.dueAt || withinDays(item.dueAt, now, completedWithinDays);
  const eligible = visible.filter((item) => (marked(item) ? recentlyDue(item) : isActive(item) || (isDone(item) && withinDays(item.dueAt, now, completedWithinDays))));
  // Long overdue items are not ranked, the same as on the Focus tab: the planner would put any of them first.
  const ranked = new Map(rankItems(visible.filter((item) => isActive(item) && !marked(item) && !isLongOverdue(item, now)), { now }).map((entry) => [entry.item.key, entry]));

  const dueTime = (item: AcademicItem): number => (item.dueAt ? new Date(item.dueAt).getTime() : Number.POSITIVE_INFINITY);
  const items: CompactItem[] = [...eligible]
    .sort((a, b) => dueTime(a) - dueTime(b) || a.title.localeCompare(b.title))
    .slice(0, maxItems)
    .map((item) => {
      const entry = ranked.get(item.key);
      const doneLocally = marked(item);
      return {
        id: shortId(item.key, item.kind),
        courseId: item.courseId,
        kind: item.kind,
        title: clip(item.title),
        dueAt: item.dueAt,
        dueLocal: localOf(item.dueAt),
        dueDate: dateOf(item.dueAt),
        bucket: doneLocally ? "completed" : classifyDeadline(item, window),
        longOverdue: !doneLocally && isLongOverdue(item, now),
        status: item.status,
        ...(doneLocally ? { doneLocally: true } : {}),
        ...(isActive(item) && !doneLocally ? { estimateMinutes: estimateStudyMinutes(item) } : {}),
        ...(options.includeAttachments && item.attachments && item.attachments.length > 0
          ? {
              attachments: item.attachments
                .filter((file) => /^\d{1,12}$/.test(file.id) && cleanText(file.name) !== "")
                .slice(0, COMPACT_LIMITS.attachments)
                .map((file) => ({ id: file.id, name: cleanText(file.name).slice(0, COMPACT_LIMITS.fileName), size: typeof file.size === "number" && file.size >= 0 ? Math.round(file.size) : null, source: file.source })),
            }
          : {}),
        visibility: compactVisibility(item),
        pointsPossible: item.pointsPossible,
        earnedScore: item.score?.graded ? item.score.earned : null,
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

  const personal: CompactPersonal[] = [...(options.personal ?? [])]
    .filter((deadline) => !Number.isNaN(new Date(deadline.dueAt).getTime()) && cleanText(deadline.title) !== "")
    .filter((deadline) => deadline.completedAt === null || withinDays(deadline.dueAt, now, completedWithinDays))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .slice(0, COMPACT_LIMITS.personal)
    .map((deadline) => {
      const done = deadline.completedAt !== null;
      return {
        id: deadline.id.slice(0, 80),
        title: clip(deadline.title),
        // A deadline tied to a course that is no longer active is kept, without the course.
        courseId: deadline.courseId && courseIds.has(deadline.courseId) ? deadline.courseId : null,
        dueAt: deadline.dueAt,
        dueLocal: localOf(deadline.dueAt) ?? deadline.dueAt,
        dueDate: dateOf(deadline.dueAt) ?? format(now, DATE_FORMAT),
        bucket: classifyDeadline({ dueAt: deadline.dueAt, status: done ? "completed" : "not-started" }, window),
        done,
        ...(deadline.planId ? { fromPlan: true } : {}),
      };
    });

  const activeItems = items.filter((item) => item.bucket !== "completed");
  const count = (bucket: CompactItem["bucket"]) => activeItems.filter((item) => item.bucket === bucket && !item.longOverdue).length;
  const today = count("today");
  return {
    version: 3,
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
      longOverdue: activeItems.filter((item) => item.longOverdue).length,
      today,
      thisWeek: today + count("tomorrow") + count("this-week"),
      unread: changes.filter((change) => !change.read).length,
      activeItems: activeItems.length,
    },
    calendar: calendarOf(now),
    personal,
    hiddenCount: dismissed ? snapshot.items.filter((item) => dismissed.has(item.key)).length : 0,
  };
};

/** JSON byte length, for tests and the size note in the setup card. */
export const estimateSize = (snapshot: CompactSnapshot): number => new TextEncoder().encode(JSON.stringify(snapshot)).length;
