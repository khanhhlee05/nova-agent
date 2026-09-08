import type { AcademicItem, AcademicSnapshot, Announcement, ChangeEvent, ChangeEventKind } from "./models";
import { isDone } from "./models";

/**
 * Semantic fields that count as a meaningful change. Observation timestamps,
 * links, and unknown API properties are deliberately excluded.
 */
export type ItemSemantics = {
  title: string;
  dueAt: string | null;
  startAt: string | null;
  endAt: string | null;
  visibility: AcademicItem["visibility"];
  status: AcademicItem["status"];
  pointsPossible: number | null;
};

export const itemSemantics = (item: AcademicItem): ItemSemantics => ({
  title: normalizeText(item.title),
  dueAt: normalizeIso(item.dueAt),
  startAt: normalizeIso(item.startAt),
  endAt: normalizeIso(item.endAt),
  visibility: item.visibility,
  status: item.status,
  pointsPossible: item.pointsPossible,
});

export type AnnouncementSemantics = {
  title: string;
  bodyText: string;
  pinned: boolean;
  visibility: Announcement["visibility"];
};

export const announcementSemantics = (announcement: Announcement): AnnouncementSemantics => ({
  title: normalizeText(announcement.title),
  bodyText: normalizeText(announcement.bodyText),
  pinned: announcement.pinned,
  visibility: announcement.visibility,
});

/** Collapses whitespace so formatting-only edits do not surface as changes. */
export const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Normalizes any parseable timestamp to a canonical ISO string; leaves null and garbage alone. */
export const normalizeIso = (value: string | null): string | null => {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? value : new Date(time).toISOString();
};

/** FNV-1a 32-bit hash. Deterministic and dependency-free; good enough for dedupe fingerprints. */
export const fingerprintOf = (...parts: unknown[]): string => {
  const text = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0") + text.length.toString(16);
};

export type DiffInput = {
  /** The snapshot just captured. */
  current: AcademicSnapshot;
  /**
   * Prior snapshots for the same tenant + user, newest first. The most recent
   * one is the comparison baseline; older ones support the two-observation
   * removal grace rule.
   */
  history: readonly AcademicSnapshot[];
  /** Detection timestamp. Defaults to `current.capturedAt`. */
  detectedAt?: string;
};

const isOverdueAt = (item: Pick<AcademicItem, "dueAt" | "status">, at: string): boolean => {
  if (!item.dueAt || isDone(item)) return false;
  const due = new Date(item.dueAt).getTime();
  return !Number.isNaN(due) && due < new Date(at).getTime();
};

const makeEvent = (
  kind: ChangeEventKind,
  entityKey: string,
  courseId: string,
  detectedAt: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): ChangeEvent => {
  const fingerprint = fingerprintOf(kind, entityKey, before, after);
  return { id: `${fingerprint}|${detectedAt}`, fingerprint, kind, entityKey, courseId, detectedAt, before, after, readAt: null };
};

/**
 * Compares the current snapshot against history and returns semantic events.
 *
 * Guarantees:
 * - No history → baseline; no events at all.
 * - A course that failed in the current sync is skipped entirely.
 * - A course that was never observed before is baseline for that course.
 * - Each course is compared against the most recent snapshot in which that
 *   course was successfully observed, so a failed sync in between is skipped.
 * - Removal requires absence from two consecutive successful observations of
 *   the course, unless the source explicitly reports the item hidden.
 * - `became-overdue` fires only on the transition between observations.
 * - `status-changed` never fires into `unknown`.
 */
export const diffSnapshots = ({ current, history, detectedAt = current.capturedAt }: DiffInput): ChangeEvent[] => {
  if (history.length === 0) return [];

  const events: ChangeEvent[] = [];
  const successful = new Set(current.successfulCourseIds);

  /** The most recent prior snapshot in which a course was successfully observed. */
  const baselineCache = new Map<string, AcademicSnapshot | null>();
  const baselineFor = (courseId: string): AcademicSnapshot | null => {
    if (!baselineCache.has(courseId)) {
      baselineCache.set(courseId, history.find((snapshot) => snapshot.successfulCourseIds.includes(courseId)) ?? null);
    }
    return baselineCache.get(courseId) ?? null;
  };
  const itemMaps = new Map<AcademicSnapshot, Map<string, AcademicItem>>();
  const itemsOf = (snapshot: AcademicSnapshot): Map<string, AcademicItem> => {
    let map = itemMaps.get(snapshot);
    if (!map) {
      map = new Map(snapshot.items.map((item) => [item.key, item]));
      itemMaps.set(snapshot, map);
    }
    return map;
  };

  for (const item of current.items) {
    if (!successful.has(item.courseId)) continue;
    const baseline = baselineFor(item.courseId);
    if (!baseline) continue;
    const before = itemsOf(baseline).get(item.key);
    if (!before) {
      events.push(makeEvent("item-added", item.key, item.courseId, detectedAt, null, publicItemFields(item)));
      continue;
    }
    const prev = itemSemantics(before);
    const next = itemSemantics(item);

    if (prev.dueAt !== next.dueAt) {
      events.push(
        makeEvent("due-date-changed", item.key, item.courseId, detectedAt, { dueAt: prev.dueAt, title: prev.title }, { dueAt: next.dueAt, title: next.title }),
      );
    }
    if (prev.visibility !== next.visibility && prev.visibility !== "unknown" && next.visibility !== "unknown") {
      events.push(
        makeEvent("visibility-changed", item.key, item.courseId, detectedAt, { visibility: prev.visibility, title: prev.title }, { visibility: next.visibility, title: next.title }),
      );
    }
    if (prev.status !== next.status && next.status !== "unknown") {
      events.push(
        makeEvent("status-changed", item.key, item.courseId, detectedAt, { status: prev.status, title: prev.title }, { status: next.status, title: next.title }),
      );
    }
    if (prev.dueAt === next.dueAt && !isOverdueAt(before, baseline.capturedAt) && isOverdueAt(item, current.capturedAt)) {
      events.push(
        makeEvent("became-overdue", item.key, item.courseId, detectedAt, { dueAt: prev.dueAt, title: prev.title }, { dueAt: next.dueAt, title: next.title }),
      );
    }
  }

  // Removal grace rule: absent from this and the previous successful observation, present in the one before.
  const currentKeys = new Set(current.items.map((item) => item.key));
  for (const courseId of successful) {
    const observations = history.filter((snapshot) => snapshot.successfulCourseIds.includes(courseId));
    const [prior, earlier] = observations;
    if (!prior || !earlier) continue;
    const priorKeys = itemsOf(prior);
    for (const item of earlier.items) {
      if (item.courseId !== courseId) continue;
      if (currentKeys.has(item.key) || priorKeys.has(item.key)) continue;
      events.push(makeEvent("item-removed", item.key, courseId, detectedAt, publicItemFields(item), null));
    }
  }

  const announcementMaps = new Map<AcademicSnapshot, Map<string, Announcement>>();
  for (const announcement of current.announcements) {
    if (!successful.has(announcement.courseId)) continue;
    const baseline = baselineFor(announcement.courseId);
    if (!baseline) continue;
    let map = announcementMaps.get(baseline);
    if (!map) {
      map = new Map(baseline.announcements.map((a) => [a.key, a]));
      announcementMaps.set(baseline, map);
    }
    const before = map.get(announcement.key);
    if (!before) {
      events.push(
        makeEvent("announcement-added", announcement.key, announcement.courseId, detectedAt, null, publicAnnouncementFields(announcement)),
      );
      continue;
    }
    const prev = announcementSemantics(before);
    const next = announcementSemantics(announcement);
    if (prev.title !== next.title || prev.bodyText !== next.bodyText) {
      events.push(
        makeEvent("announcement-updated", announcement.key, announcement.courseId, detectedAt, { title: prev.title }, { title: next.title }),
      );
    }
  }

  return events;
};

const publicItemFields = (item: AcademicItem): Record<string, unknown> => ({
  title: normalizeText(item.title),
  kind: item.kind,
  dueAt: normalizeIso(item.dueAt),
  visibility: item.visibility,
});

const publicAnnouncementFields = (announcement: Announcement): Record<string, unknown> => ({
  title: normalizeText(announcement.title),
  createdAt: normalizeIso(announcement.createdAt),
});

/** Drops events whose fingerprint has already been recorded. */
export const dedupeEvents = (events: readonly ChangeEvent[], knownFingerprints: ReadonlySet<string>): ChangeEvent[] => {
  const seen = new Set(knownFingerprints);
  const result: ChangeEvent[] = [];
  for (const event of events) {
    if (seen.has(event.fingerprint)) continue;
    seen.add(event.fingerprint);
    result.push(event);
  }
  return result;
};

/** Sorts newest first, then by kind and entity for determinism. */
export const sortEventsNewestFirst = (events: readonly ChangeEvent[]): ChangeEvent[] =>
  [...events].sort(
    (a, b) => b.detectedAt.localeCompare(a.detectedAt) || a.kind.localeCompare(b.kind) || a.entityKey.localeCompare(b.entityKey),
  );
