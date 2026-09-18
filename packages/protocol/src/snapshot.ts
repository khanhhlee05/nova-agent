import { z } from "zod";

/**
 * The compact snapshot is the only academic data that leaves the device, and
 * only when Ask Nova is on. It carries titles, dates, statuses, and links.
 * It never carries cookies, raw Brightspace responses, the tenant, the user
 * id, announcement bodies, or hidden and expired items.
 *
 * Time-zone facts (buckets, local date strings, days ago) are computed in the
 * browser so a server in any zone reads the same "today" the student sees.
 */
export const COMPACT_LIMITS = { courses: 12, items: 200, announcements: 30, changes: 60, title: 200, reasons: 3 } as const;

const title = z.string().min(1).max(COMPACT_LIMITS.title);
const iso = z.string().min(1);
const localDate = z.string().min(1);
const safeUrl = z.url({ protocol: /^https?$/ });

export const compactBucketSchema = z.enum(["overdue", "today", "tomorrow", "this-week", "later", "no-date", "completed"]);
export type CompactBucket = z.infer<typeof compactBucketSchema>;

export const compactItemStatusSchema = z.enum(["not-started", "in-progress", "submitted", "completed", "unknown"]);
export const compactItemKindSchema = z.enum(["assignment", "quiz"]);

export const compactCourseSchema = z.object({
  id: z.string().min(1),
  name: title,
  code: z.string().max(64).nullable(),
  homeUrl: safeUrl,
  active: z.boolean(),
});
export type CompactCourse = z.infer<typeof compactCourseSchema>;

export const compactItemSchema = z.object({
  /** Short id: kind initial plus the Brightspace source id, for example "a4101" or "q5101". */
  id: z.string().min(2).max(40),
  courseId: z.string().min(1),
  kind: compactItemKindSchema,
  title,
  dueAt: iso.nullable(),
  /** The due date formatted in the student's own time zone. */
  dueLocal: localDate.nullable(),
  bucket: compactBucketSchema,
  status: compactItemStatusSchema,
  visibility: z.enum(["visible", "scheduled", "unknown"]),
  pointsPossible: z.number().nullable(),
  url: safeUrl.nullable(),
  /** Priority score 0..100 from the planner, null when the item is not rankable. */
  priority: z.number().int().min(0).max(100).nullable(),
  reasons: z.array(z.string().max(160)).max(COMPACT_LIMITS.reasons),
});
export type CompactItem = z.infer<typeof compactItemSchema>;

export const compactAnnouncementSchema = z.object({
  id: z.string().min(2).max(40),
  courseId: z.string().min(1),
  title,
  createdAt: iso.nullable(),
  createdLocal: localDate.nullable(),
  pinned: z.boolean(),
  url: safeUrl.nullable(),
});
export type CompactAnnouncement = z.infer<typeof compactAnnouncementSchema>;

export const compactChangeKindSchema = z.enum([
  "item-added",
  "due-date-changed",
  "visibility-changed",
  "item-removed",
  "status-changed",
  "became-overdue",
  "announcement-added",
  "announcement-updated",
]);
export type CompactChangeKind = z.infer<typeof compactChangeKindSchema>;

export const compactChangeFieldsSchema = z.object({
  dueAt: iso.nullable().optional(),
  dueLocal: localDate.nullable().optional(),
  status: compactItemStatusSchema.optional(),
  visibility: z.string().max(16).optional(),
});

export const compactChangeSchema = z.object({
  id: z.string().min(1).max(80),
  kind: compactChangeKindSchema,
  courseId: z.string().min(1),
  title,
  /** Short item id when the change is about an item still in the snapshot. */
  itemId: z.string().max(40).nullable(),
  detectedAt: iso,
  detectedLocal: localDate,
  daysAgo: z.number().int().min(0),
  before: compactChangeFieldsSchema.nullable(),
  after: compactChangeFieldsSchema.nullable(),
  read: z.boolean(),
});
export type CompactChange = z.infer<typeof compactChangeSchema>;

export const compactCountsSchema = z.object({
  overdue: z.number().int().min(0),
  today: z.number().int().min(0),
  thisWeek: z.number().int().min(0),
  unread: z.number().int().min(0),
  activeItems: z.number().int().min(0),
});

export const compactSnapshotSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["live", "demo"]),
  now: iso,
  timezone: z.string().min(1).max(64),
  capturedAt: iso,
  isComplete: z.boolean(),
  failedCourseIds: z.array(z.string()).max(COMPACT_LIMITS.courses),
  courses: z.array(compactCourseSchema).max(COMPACT_LIMITS.courses),
  items: z.array(compactItemSchema).max(COMPACT_LIMITS.items),
  announcements: z.array(compactAnnouncementSchema).max(COMPACT_LIMITS.announcements),
  changes: z.array(compactChangeSchema).max(COMPACT_LIMITS.changes),
  counts: compactCountsSchema,
});
export type CompactSnapshot = z.infer<typeof compactSnapshotSchema>;
