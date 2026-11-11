import {
  buildStableKey,
  normalizeIso,
  normalizeOrigin,
  type AcademicItem,
  type Announcement,
  type Course,
  type CourseMaterial,
  type ItemAttachment,
  type ItemScore,
  type ItemStatus,
  type SubmissionType,
  type Visibility,
} from "@nova-agent/core";
import { pageLinks } from "./routes";
import type { ContentToc, DropboxFolder, EntityDropbox, MyOrgUnitInfo, NewsItem, QuizReadData, TocModule } from "./schemas";

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

/** The earned score, when the submission carries graded feedback. Never invents a number from feedback text alone. */
export const scoreFromSubmission = (source: StatusSource): ItemScore | null => {
  if (source.kind === "unavailable" || !source.submission?.Feedback) return null;
  const feedback = source.submission.Feedback;
  const earned = typeof feedback.Score === "number" ? feedback.Score : null;
  const graded = feedback.IsGraded === true || earned !== null;
  return graded ? { earned, graded } : null;
};

const submissionTypeOf = (code: number | null | undefined): SubmissionType => {
  switch (code) {
    case 0:
    case 1:
      return "online";
    case 2:
      return "on-paper";
    case 3:
      return "observed";
    default:
      return "unknown";
  }
};

/** At most this many files are kept per assignment: enough for any real handout set, bounded against a hostile response. */
export const MAX_ATTACHMENTS_PER_ITEM = 20;

/**
 * The files on an assignment: the instructor's first, then the files of the
 * student's own submissions. Names are trimmed and clipped; a file without a
 * usable id or name is dropped.
 */
export const attachmentsOf = (folder: DropboxFolder, status: StatusSource): ItemAttachment[] => {
  const usable = (file: { FileId: string; FileName: string }): boolean => /^\d{1,12}$/.test(file.FileId) && file.FileName.trim() !== "";
  const size = (value: number | null | undefined): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
  const instructor: ItemAttachment[] = (folder.Attachments ?? []).filter(usable).map((file) => ({ id: file.FileId, name: file.FileName.trim().slice(0, 200), size: size(file.Size), source: "instructor" }));
  const submitted: ItemAttachment[] =
    status.kind === "known" && status.submission
      ? status.submission.Submissions.flatMap((submission) =>
          submission.Id && /^\d{1,12}$/.test(submission.Id) ? (submission.Files ?? []).filter(usable).map((file): ItemAttachment => ({ id: file.FileId, name: file.FileName.trim().slice(0, 200), size: size(file.Size), source: "submission", submissionId: submission.Id })) : [],
        )
      : [];
  return [...instructor, ...submitted].slice(0, MAX_ATTACHMENTS_PER_ITEM);
};

export type NormalizeContext = { tenantOrigin: string; userId: string; observedAt: string; now: Date };

export const toAssignment = (folder: DropboxFolder, courseId: string, status: StatusSource, ctx: NormalizeContext): AcademicItem => {
  const origin = normalizeOrigin(ctx.tenantOrigin);
  const startAt = normalizeIso(folder.Availability?.StartDate ?? null);
  const endAt = normalizeIso(folder.Availability?.EndDate ?? null);
  const attachments = attachmentsOf(folder, status);
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
    // D2L DROPBOXTYPE_T: 1 individual, 2 group.
    group: folder.DropboxType === 2,
    hasRubric: (folder.Assessment?.Rubrics?.length ?? 0) > 0,
    submissionType: submissionTypeOf(folder.SubmissionType),
    score: scoreFromSubmission(status),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
};

export const toQuiz = (quiz: QuizReadData, courseId: string, ctx: NormalizeContext): AcademicItem => {
  const origin = normalizeOrigin(ctx.tenantOrigin);
  const startAt = normalizeIso(quiz.StartDate);
  const endAt = normalizeIso(quiz.EndDate);
  const timeLimit = quiz.SubmissionTimeLimit?.IsEnforced && typeof quiz.SubmissionTimeLimit.TimeLimitValue === "number" && quiz.SubmissionTimeLimit.TimeLimitValue > 0 ? quiz.SubmissionTimeLimit.TimeLimitValue : null;
  const attempts = quiz.AttemptsAllowed ? (quiz.AttemptsAllowed.IsUnlimited ? null : (quiz.AttemptsAllowed.NumberOfAttemptsAllowed ?? undefined)) : undefined;
  const late = quiz.LateSubmissionInfo ? (typeof quiz.LateSubmissionInfo.LateSubmissionOption === "number" ? quiz.LateSubmissionInfo.LateSubmissionOption !== 2 : null) : null;
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
    // A timed quiz is the one case where Brightspace states how long the work takes.
    estimatedMinutes: timeLimit,
    importance: "normal",
    url: pageLinks.quiz(origin, courseId, quiz.QuizId),
    sourceUpdatedAt: null,
    observedAt: ctx.observedAt,
    ...(attempts !== undefined ? { attemptsAllowed: attempts } : {}),
    timeLimitMinutes: timeLimit,
    proctored: Boolean(quiz.Password) || (quiz.RestrictIPAddressRange?.length ?? 0) > 0,
    lateAllowed: late,
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

/** Bounds on one course's table of contents: deep enough for any real course, small enough to store and to show. */
export const MATERIAL_LIMITS = { topics: 400, depth: 8, title: 200 } as const;

const fileNameOf = (url: string | null | undefined): string | null => {
  if (!url) return null;
  const path = url.split(/[?#]/)[0] ?? "";
  const last = path.split("/").filter(Boolean).pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  return /\.[a-z0-9]{1,8}$/i.test(name) ? name.slice(0, MATERIAL_LIMITS.title) : null;
};

/**
 * Flattens a course's table of contents into its topics, in the order a
 * student sees them. Hidden modules and topics are left out, as is anything
 * past the depth or count limit. Nothing is fetched here.
 */
export const toMaterials = (toc: ContentToc, courseId: string, tenantOrigin: string): CourseMaterial[] => {
  const origin = normalizeOrigin(tenantOrigin);
  const out: CourseMaterial[] = [];
  const walk = (modules: readonly TocModule[], path: string[], depth: number): void => {
    for (const module of modules) {
      if (module.IsHidden || depth > MATERIAL_LIMITS.depth) continue;
      const here = [...path, module.Title.trim().slice(0, MATERIAL_LIMITS.title) || "Untitled module"];
      for (const topic of module.Topics) {
        if (out.length >= MATERIAL_LIMITS.topics) return;
        if (topic.IsHidden || !/^\d{1,12}$/.test(topic.TopicId) || topic.Title.trim() === "") continue;
        const fileName = fileNameOf(topic.Url);
        const kind = (topic.TypeIdentifier ?? "").toLowerCase();
        const type: CourseMaterial["type"] = kind === "link" ? "link" : kind === "file" ? (fileName && /\.html?$/i.test(fileName) ? "page" : "file") : "other";
        out.push({
          id: topic.TopicId,
          courseId,
          title: topic.Title.trim().slice(0, MATERIAL_LIMITS.title),
          modulePath: here,
          type,
          fileName: type === "file" || type === "page" ? fileName : null,
          url: pageLinks.contentTopic(origin, courseId, topic.TopicId),
          updatedAt: normalizeIso(topic.LastModifiedDate),
        });
      }
      walk(module.Modules, here, depth + 1);
    }
  };
  walk(toc.Modules, [], 1);
  return out;
};
