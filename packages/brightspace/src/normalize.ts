import {
  buildStableKey,
  normalizeIso,
  normalizeOrigin,
  type AcademicItem,
  type Announcement,
  type Course,
  type ItemStatus,
  type Visibility,
} from "@nova-agent/core";
import { pageLinks } from "./routes";
import type { DropboxFolder, EntityDropbox, MyOrgUnitInfo, NewsItem, QuizReadData } from "./schemas";

/**
 * Course color slots. These are the light-theme swatches (each at least 3:1
 * against white as a dot); the side panel maps each slot to a dark-theme
 * swatch by index. Order matters: it is the slot identity.
 */
export const COURSE_COLORS = ["#1d5fd1", "#188a4f", "#c2591b", "#a3338a", "#0e7c86", "#6d4c9f", "#c02f5c", "#4b6a1f"] as const;

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  return hash;
};

export const courseColor = (courseId: string): string => COURSE_COLORS[hashString(courseId) % COURSE_COLORS.length] as string;

export const isCourseOffering = (info: MyOrgUnitInfo): boolean => {
  const type = info.OrgUnit.Type;
  if (!type) return true;
  if (type.Code) return type.Code.toLowerCase().replace(/\s+/g, "") === "courseoffering";
  if (type.Id !== undefined) return type.Id === 3;
  return true;
};

export const toCourse = (info: MyOrgUnitInfo, tenantOrigin: string): Course => {
  const origin = normalizeOrigin(tenantOrigin);
  const id = info.OrgUnit.Id;
  return {
    id,
    name: info.OrgUnit.Name.trim(),
    code: info.OrgUnit.Code?.trim() || null,
    homeUrl: pageLinks.courseHome(origin, id),
    startAt: normalizeIso(info.Access?.StartDate ?? null),
    endAt: normalizeIso(info.Access?.EndDate ?? null),
    active: info.Access?.IsActive ?? true,
    color: courseColor(id),
  };
};

const visibilityFromWindow = (hidden: boolean, startAt: string | null, endAt: string | null, now: Date): Visibility => {
  if (hidden) return "hidden";
  const start = startAt ? new Date(startAt).getTime() : null;
  const end = endAt ? new Date(endAt).getTime() : null;
  if (start !== null && !Number.isNaN(start) && start > now.getTime()) return "scheduled";
  if (end !== null && !Number.isNaN(end) && end < now.getTime()) return "expired";
  return "visible";
};

export type StatusSource =
  | { kind: "known"; submission: EntityDropbox | null }
  | { kind: "unavailable" };

/** D2L DROPBOX_STATUS: 0 Unsubmitted, 1 Submitted, 2 Draft, 3 Published. */
export const statusFromSubmission = (source: StatusSource): ItemStatus => {
  if (source.kind === "unavailable") return "unknown";
  const entry = source.submission;
  if (!entry) return "not-started";
  if (entry.CompletionDate) return "completed";
  switch (entry.Status) {
    case 1:
    case 3:
      return "submitted";
    case 2:
      return "in-progress";
    case 0:
      return entry.Submissions.length > 0 ? "submitted" : "not-started";
    default:
      return entry.Submissions.length > 0 ? "submitted" : "unknown";
  }
};

export type NormalizeContext = { tenantOrigin: string; userId: string; observedAt: string; now: Date };

export const toAssignment = (folder: DropboxFolder, courseId: string, status: StatusSource, ctx: NormalizeContext): AcademicItem => {
  const origin = normalizeOrigin(ctx.tenantOrigin);
  const startAt = normalizeIso(folder.Availability?.StartDate ?? null);
  const endAt = normalizeIso(folder.Availability?.EndDate ?? null);
  return {
    key: buildStableKey({ tenantOrigin: origin, userId: ctx.userId, kind: "assignment", courseId, sourceId: folder.Id }),
    sourceId: folder.Id,
    courseId,
    kind: "assignment",
    title: folder.Name.trim(),
    startAt,
    endAt,
    dueAt: normalizeIso(folder.DueDate),
    visibility: visibilityFromWindow(folder.IsHidden ?? false, startAt, endAt, ctx.now),
    status: statusFromSubmission(status),
    pointsPossible: folder.Assessment?.ScoreDenominator ?? null,
    estimatedMinutes: null,
    importance: "normal",
    url: pageLinks.assignment(origin, courseId, folder.Id),
    sourceUpdatedAt: null,
    observedAt: ctx.observedAt,
  };
};

export const toQuiz = (quiz: QuizReadData, courseId: string, ctx: NormalizeContext): AcademicItem => {
  const origin = normalizeOrigin(ctx.tenantOrigin);
  const startAt = normalizeIso(quiz.StartDate);
  const endAt = normalizeIso(quiz.EndDate);
  return {
    key: buildStableKey({ tenantOrigin: origin, userId: ctx.userId, kind: "quiz", courseId, sourceId: quiz.QuizId }),
    sourceId: quiz.QuizId,
    courseId,
    kind: "quiz",
    title: quiz.Name.trim(),
    startAt,
    endAt,
    dueAt: normalizeIso(quiz.DueDate),
    visibility: visibilityFromWindow(quiz.IsActive === false, startAt, endAt, ctx.now),
    // Learner quiz-attempt routes are not reliably available; never guess.
    status: "unknown",
    pointsPossible: null,
    estimatedMinutes: null,
    importance: "normal",
    url: pageLinks.quiz(origin, courseId, quiz.QuizId),
    sourceUpdatedAt: null,
    observedAt: ctx.observedAt,
  };
};

const stripHtml = (html: string): string =>
  html
    .replace(/<\s*(br|p|div|li|h[1-6])[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

export const toAnnouncement = (news: NewsItem, courseId: string, ctx: NormalizeContext): Announcement => {
  const origin = normalizeOrigin(ctx.tenantOrigin);
  const startAt = normalizeIso(news.StartDate);
  const endAt = normalizeIso(news.EndDate);
  const text = news.Body?.Text?.trim() || (news.Body?.Html ? stripHtml(news.Body.Html) : "");
  return {
    key: buildStableKey({ tenantOrigin: origin, userId: ctx.userId, kind: "announcement", courseId, sourceId: news.Id }),
    sourceId: news.Id,
    courseId,
    title: news.Title.trim(),
    bodyText: text,
    createdAt: normalizeIso(news.CreatedDate),
    updatedAt: normalizeIso(news.LastModifiedDate),
    startAt,
    endAt,
    visibility: visibilityFromWindow((news.IsHidden ?? false) || news.IsPublished === false, startAt, endAt, ctx.now),
    pinned: news.IsPinned ?? false,
    url: pageLinks.news(origin, courseId),
  };
};
