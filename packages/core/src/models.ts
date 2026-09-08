/**
 * Canonical academic models shared by every Nova Agent layer.
 *
 * Every field that Brightspace may not expose to a learner is explicitly
 * nullable or carries an `unknown` state. Never collapse an unknown into a
 * confident boolean.
 */

export type ItemKind = "assignment" | "quiz";

export type Visibility = "visible" | "hidden" | "scheduled" | "expired" | "unknown";

export type ItemStatus = "not-started" | "in-progress" | "submitted" | "completed" | "unknown";

export type Importance = "low" | "normal" | "high";

export type Course = {
  id: string;
  name: string;
  code: string | null;
  homeUrl: string;
  startAt: string | null;
  endAt: string | null;
  active: boolean;
  color: string;
};

export type AcademicItem = {
  /** Stable key: `{tenantOrigin}|{userId}|{kind}|{courseId}|{sourceId}` */
  key: string;
  sourceId: string;
  courseId: string;
  kind: ItemKind;
  title: string;
  startAt: string | null;
  endAt: string | null;
  dueAt: string | null;
  visibility: Visibility;
  status: ItemStatus;
  pointsPossible: number | null;
  estimatedMinutes: number | null;
  importance: Importance;
  url: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string;
};

export type Announcement = {
  key: string;
  sourceId: string;
  courseId: string;
  title: string;
  bodyText: string;
  createdAt: string | null;
  updatedAt: string | null;
  startAt: string | null;
  endAt: string | null;
  visibility: Visibility;
  pinned: boolean;
  url: string | null;
};

export type AcademicSnapshot = {
  id: string;
  tenantOrigin: string;
  userId: string;
  capturedAt: string;
  isComplete: boolean;
  successfulCourseIds: string[];
  failedCourseIds: string[];
  courses: Course[];
  items: AcademicItem[];
  announcements: Announcement[];
};

export type ChangeEventKind =
  | "item-added"
  | "due-date-changed"
  | "visibility-changed"
  | "item-removed"
  | "status-changed"
  | "became-overdue"
  | "announcement-added"
  | "announcement-updated";

export type ChangeEvent = {
  id: string;
  fingerprint: string;
  kind: ChangeEventKind;
  entityKey: string;
  courseId: string;
  detectedAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  readAt: string | null;
};

export type DeadlineBucket =
  | "overdue"
  | "today"
  | "tomorrow"
  | "this-week"
  | "later"
  | "no-date"
  | "completed";

/** Statuses that take an item out of the active workload. */
export const DONE_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>(["submitted", "completed"]);

export const isDone = (item: Pick<AcademicItem, "status">): boolean => DONE_STATUSES.has(item.status);

export const isHidden = (item: Pick<AcademicItem, "visibility">): boolean => item.visibility === "hidden";

/** An item counts toward the active workload when it is neither done nor hidden. */
export const isActive = (item: Pick<AcademicItem, "status" | "visibility">): boolean =>
  !isDone(item) && !isHidden(item);
