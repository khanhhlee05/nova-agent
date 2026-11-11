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

/** How an assignment is handed in. D2L SUBMISSIONTYPE_T: 0 file, 1 text, 2 on paper, 3 observed in person. */
export type SubmissionType = "online" | "on-paper" | "observed" | "unknown";

/**
 * A file attached to an assignment: one the instructor attached to the
 * folder, or one the student handed in. Only the name and size are kept from
 * a refresh; the bytes are fetched when the student asks for them.
 */
export type ItemAttachment = {
  /** Brightspace file id, unique within its folder or submission. */
  id: string;
  name: string;
  /** Size in bytes, when Brightspace says. */
  size: number | null;
  source: "instructor" | "submission";
  /** The submission the file belongs to; present for `submission` files. */
  submissionId?: string;
};

/**
 * One topic from a course's Content area: a file the instructor uploaded, a
 * page written in Brightspace, or a link. Only its place and name are kept
 * from the table of contents; a file's bytes are fetched when the student
 * has Nova read the course's materials.
 */
export type CourseMaterial = {
  /** Brightspace topic id. */
  id: string;
  courseId: string;
  title: string;
  /** The modules the topic sits under, outermost first. */
  modulePath: string[];
  /** `file`: an uploaded file. `page`: an HTML page. `link`: an address elsewhere. `other`: anything else (a quiz, a discussion). */
  type: "file" | "page" | "link" | "other";
  /** The file's own name, when the topic is a file or a page. */
  fileName: string | null;
  /** The topic's page in Brightspace. */
  url: string | null;
  /** When Brightspace says the topic last changed. */
  updatedAt: string | null;
};

/** A score Brightspace reported for the student on this item. `earned` is null when feedback exists without a number. */
export type ItemScore = { earned: number | null; graded: boolean };

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
  /**
   * Signals read from the same Brightspace responses, all optional so older
   * stored snapshots and fixtures stay valid. Absent means "not reported".
   */
  /** Group assignment (D2L DropboxType 2). */
  group?: boolean;
  /** The assignment is graded against a rubric. */
  hasRubric?: boolean;
  submissionType?: SubmissionType;
  /** Quiz attempts allowed; null means unlimited. */
  attemptsAllowed?: number | null;
  /** Enforced quiz time limit in minutes; null when untimed. */
  timeLimitMinutes?: number | null;
  /** The quiz needs a password or is restricted to certain addresses: an exam signal. */
  proctored?: boolean;
  /** Whether a late attempt or submission is accepted at all; null when Brightspace did not say. */
  lateAllowed?: boolean | null;
  /** The score Brightspace reported; null when nothing has been graded. */
  score?: ItemScore | null;
  /** Files on the assignment. Absent on quizzes and on snapshots stored before attachments were read. */
  attachments?: ItemAttachment[];
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
  | "announcement-updated"
  | "graded";

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

/** Availability window closed: the item can no longer be acted on in Brightspace. */
export const isExpired = (item: Pick<AcademicItem, "visibility">): boolean => item.visibility === "expired";

/** An item counts toward the active workload when it is not done, hidden, or expired. */
export const isActive = (item: Pick<AcademicItem, "status" | "visibility">): boolean =>
  !isDone(item) && !isHidden(item) && !isExpired(item);
