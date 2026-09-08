import type { AcademicItem, AcademicSnapshot, Announcement, Course } from "./models";
import { normalizeOrigin } from "./stableKey";

/** Retention limits. Kept as constants so they are easy to audit and tune. */
export const MAX_SNAPSHOTS_PER_USER = 20;
export const MAX_CHANGE_EVENT_AGE_DAYS = 30;
export const MAX_CHANGE_EVENTS = 2000;

export type SnapshotInput = {
  tenantOrigin: string;
  userId: string;
  capturedAt: string;
  courses: Course[];
  items: AcademicItem[];
  announcements: Announcement[];
  successfulCourseIds: string[];
  failedCourseIds: string[];
  id?: string;
};

export const userScope = (tenantOrigin: string, userId: string): string => `${normalizeOrigin(tenantOrigin)}|${userId}`;

export const createSnapshot = (input: SnapshotInput): AcademicSnapshot => {
  const tenantOrigin = normalizeOrigin(input.tenantOrigin);
  const successful = [...new Set(input.successfulCourseIds)].sort();
  const failed = [...new Set(input.failedCourseIds)].filter((id) => !successful.includes(id)).sort();
  return {
    id: input.id ?? `${userScope(tenantOrigin, input.userId)}|${input.capturedAt}`,
    tenantOrigin,
    userId: input.userId,
    capturedAt: input.capturedAt,
    isComplete: failed.length === 0,
    successfulCourseIds: successful,
    failedCourseIds: failed,
    courses: [...input.courses].sort((a, b) => a.id.localeCompare(b.id)),
    items: [...input.items].sort((a, b) => a.key.localeCompare(b.key)),
    announcements: [...input.announcements].sort((a, b) => a.key.localeCompare(b.key)),
  };
};

/**
 * A permission-limited status request must not erase a status that was known
 * before. Carries the previous known status forward when the new observation
 * is `unknown`.
 */
export const carryForwardKnownStatuses = (
  items: readonly AcademicItem[],
  previous: AcademicSnapshot | null,
): AcademicItem[] => {
  if (!previous) return [...items];
  const known = new Map(previous.items.filter((item) => item.status !== "unknown").map((item) => [item.key, item.status]));
  return items.map((item) => {
    if (item.status !== "unknown") return item;
    const prior = known.get(item.key);
    return prior ? { ...item, status: prior } : item;
  });
};

/** Sorted newest first. */
export const sortSnapshotsNewestFirst = (snapshots: readonly AcademicSnapshot[]): AcademicSnapshot[] =>
  [...snapshots].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));

/** Selects the snapshots that exceed the retention limit and should be deleted. */
export const snapshotsToPrune = (snapshots: readonly AcademicSnapshot[], keep = MAX_SNAPSHOTS_PER_USER): AcademicSnapshot[] =>
  sortSnapshotsNewestFirst(snapshots).slice(keep);
