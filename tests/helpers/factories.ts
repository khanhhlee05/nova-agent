import {
  buildStableKey,
  createSnapshot,
  type AcademicItem,
  type AcademicSnapshot,
  type Announcement,
  type Course,
} from "@nova-agent/core";

export const TENANT = "https://brightspace.villanova.edu";
export const USER = "2001";

export const makeCourse = (id: string, overrides: Partial<Course> = {}): Course => ({
  id,
  name: `Course ${id}`,
  code: `CRS-${id}`,
  homeUrl: `${TENANT}/d2l/home/${id}`,
  startAt: null,
  endAt: null,
  active: true,
  color: "#5aa9ff",
  ...overrides,
});

export const makeItem = (overrides: Partial<AcademicItem> & { sourceId: string; courseId: string }): AcademicItem => {
  const kind = overrides.kind ?? "assignment";
  return {
    key: buildStableKey({ tenantOrigin: TENANT, userId: USER, kind, courseId: overrides.courseId, sourceId: overrides.sourceId }),
    kind,
    title: `Item ${overrides.sourceId}`,
    startAt: null,
    endAt: null,
    dueAt: null,
    visibility: "visible",
    status: "not-started",
    pointsPossible: null,
    estimatedMinutes: null,
    importance: "normal",
    url: null,
    sourceUpdatedAt: null,
    observedAt: "2026-09-08T12:00:00.000Z",
    ...overrides,
  };
};

export const makeAnnouncement = (overrides: Partial<Announcement> & { sourceId: string; courseId: string }): Announcement => ({
  key: buildStableKey({ tenantOrigin: TENANT, userId: USER, kind: "announcement", courseId: overrides.courseId, sourceId: overrides.sourceId }),
  title: `Announcement ${overrides.sourceId}`,
  bodyText: "Body",
  createdAt: "2026-09-08T10:00:00.000Z",
  updatedAt: null,
  startAt: null,
  endAt: null,
  visibility: "visible",
  pinned: false,
  url: null,
  ...overrides,
});

export const makeSnapshot = (
  capturedAt: string,
  items: AcademicItem[],
  options: { announcements?: Announcement[]; courses?: Course[]; failedCourseIds?: string[]; successfulCourseIds?: string[] } = {},
): AcademicSnapshot => {
  const courseIds = [...new Set([...items.map((i) => i.courseId), ...(options.announcements ?? []).map((a) => a.courseId), ...(options.courses ?? []).map((c) => c.id)])];
  const failed = options.failedCourseIds ?? [];
  return createSnapshot({
    tenantOrigin: TENANT,
    userId: USER,
    capturedAt,
    courses: options.courses ?? courseIds.map((id) => makeCourse(id)),
    items,
    announcements: options.announcements ?? [],
    successfulCourseIds: options.successfulCourseIds ?? courseIds.filter((id) => !failed.includes(id)),
    failedCourseIds: failed,
  });
};
