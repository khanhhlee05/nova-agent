import { normalizeOrigin, type AcademicItem, type Announcement, type Course } from "@nova-agent/core";
import { BrightspaceFailure, fail, isFatalForSync, toBrightspaceError, type BrightspaceError } from "./errors";
import { isCourseOffering, toAnnouncement, toAssignment, toCourse, toQuiz, type StatusSource } from "./normalize";
import { collectBookmarkPages, collectNextPages } from "./paging";
import { routes } from "./routes";
import {
  dropboxFoldersSchema,
  enrollmentsPageSchema,
  mySubmissionsSchema,
  newsListSchema,
  quizzesPageSchema,
  versionsSchema,
  whoAmISchema,
  type DropboxFolder,
  type EntityDropbox,
  type MyOrgUnitInfo,
  type NewsItem,
  type ProductVersion,
  type QuizReadData,
  type WhoAmI,
} from "./schemas";
import type { BrightspaceTransport } from "./transport";
import { MemoryVersionCache, isVersionCacheFresh, resolveVersions, type ResolvedVersions, type VersionCacheStore } from "./versions";

export type SyncWarning = { courseId: string | null; operation: string; message: string };

export type CourseFailure = { courseId: string; error: BrightspaceError };

export type AcademicStateResult = {
  tenantOrigin: string;
  userId: string;
  displayName: string;
  capturedAt: string;
  versions: ResolvedVersions;
  courses: Course[];
  items: AcademicItem[];
  announcements: Announcement[];
  successfulCourseIds: string[];
  failedCourseIds: string[];
  failures: CourseFailure[];
  warnings: SyncWarning[];
};

export type LoadPhase = "checking-session" | "discovering-versions" | "loading-courses" | "loading-course-data" | "normalizing";

export type BrightspaceClientOptions = {
  tenantOrigin: string;
  versionCache?: VersionCacheStore;
  now?: () => Date;
  /** Maximum simultaneous course-detail requests. */
  concurrency?: number;
  /** How far back to load announcements. */
  announcementWindowDays?: number;
  /** Fetch per-folder submission status. Bounded by `concurrency`. */
  loadSubmissionStatus?: boolean;
  onPhase?: (phase: LoadPhase, detail?: { completed: number; total: number }) => void;
};

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_ANNOUNCEMENT_WINDOW_DAYS = 45;
/** Only fetch submission status for folders due within this many days in the past (or any time in the future). */
export const SUBMISSION_LOOKBACK_DAYS = 21;

const mapWithConcurrency = async <T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
};

export class BrightspaceClient {
  readonly tenantOrigin: string;
  private readonly versionCache: VersionCacheStore;
  private readonly now: () => Date;
  private readonly concurrency: number;
  private readonly announcementWindowDays: number;
  private readonly loadSubmissionStatus: boolean;
  private readonly onPhase: BrightspaceClientOptions["onPhase"];

  constructor(
    private readonly transport: BrightspaceTransport,
    options: BrightspaceClientOptions,
  ) {
    this.tenantOrigin = normalizeOrigin(options.tenantOrigin);
    this.versionCache = options.versionCache ?? new MemoryVersionCache();
    this.now = options.now ?? (() => new Date());
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.announcementWindowDays = options.announcementWindowDays ?? DEFAULT_ANNOUNCEMENT_WINDOW_DAYS;
    this.loadSubmissionStatus = options.loadSubmissionStatus ?? true;
    this.onPhase = options.onPhase;
  }

  getVersions(): Promise<ProductVersion[]> {
    return this.transport.getJson(routes.versions(), versionsSchema);
  }

  /** Resolves LP/LE versions from `/d2l/api/versions/`, cached for 24 hours. */
  async resolveVersions(force = false): Promise<ResolvedVersions> {
    const cached = force ? null : await this.versionCache.get();
    if (isVersionCacheFresh(cached, this.now())) return cached;
    const resolved = resolveVersions(await this.getVersions(), this.now());
    await this.versionCache.set(resolved);
    return resolved;
  }

  /** Runs a versioned call; a 404 on a required route invalidates the version cache. */
  private async withVersions<T>(product: "lp" | "le", run: (versions: ResolvedVersions) => Promise<T>): Promise<T> {
    const versions = await this.resolveVersions();
    try {
      return await run(versions);
    } catch (error) {
      if (error instanceof BrightspaceFailure && (error.error.kind === "not-found" || error.error.kind === "unsupported-api")) {
        // A version-specific failure: drop the cached versions so the next sync re-discovers them.
        await this.versionCache.clear();
      }
      throw error;
    }
  }

  whoami(): Promise<WhoAmI> {
    return this.withVersions("lp", async ({ lp }) => {
      try {
        return await this.transport.getJson(routes.whoami(lp), whoAmISchema);
      } catch (error) {
        if (error instanceof BrightspaceFailure && error.error.kind === "not-found") fail({ kind: "unsupported-api", product: "lp" });
        throw error;
      }
    });
  }

  listMyEnrollments(): Promise<MyOrgUnitInfo[]> {
    return this.withVersions("lp", ({ lp }) =>
      collectBookmarkPages("myenrollments", (bookmark) =>
        this.transport.getJson(routes.myEnrollments(lp, { isActive: true, canAccess: true, bookmark }), enrollmentsPageSchema),
      ),
    );
  }

  listDropboxFolders(orgUnitId: string): Promise<DropboxFolder[]> {
    return this.withVersions("le", ({ le }) => this.transport.getJson(routes.dropboxFolders(le, orgUnitId), dropboxFoldersSchema));
  }

  listMySubmissions(orgUnitId: string, folderId: string): Promise<EntityDropbox[]> {
    return this.withVersions("le", ({ le }) => this.transport.getJson(routes.mySubmissions(le, orgUnitId, folderId), mySubmissionsSchema));
  }

  listQuizzes(orgUnitId: string): Promise<QuizReadData[]> {
    return this.withVersions("le", ({ le }) =>
      collectNextPages("quizzes", this.tenantOrigin, routes.quizzes(le, orgUnitId), (path) => this.transport.getJson(path, quizzesPageSchema)),
    );
  }

  listNews(orgUnitId: string, since?: string): Promise<NewsItem[]> {
    return this.withVersions("le", ({ le }) => this.transport.getJson(routes.news(le, orgUnitId, { since }), newsListSchema));
  }

  /**
   * Loads everything Mission Control needs. A failed course never invalidates a
   * successful one; session expiry and unsupported API versions abort the sync.
   */
  async loadAcademicState(): Promise<AcademicStateResult> {
    const now = this.now();
    const capturedAt = now.toISOString();
    const warnings: SyncWarning[] = [];

    this.onPhase?.("discovering-versions");
    const versions = await this.resolveVersions();

    this.onPhase?.("checking-session");
    const me = await this.whoami();
    const userId = me.Identifier;
    const displayName = [me.FirstName, me.LastName].filter(Boolean).join(" ").trim() || me.UniqueName || "Student";

    this.onPhase?.("loading-courses");
    const enrollments = (await this.listMyEnrollments()).filter(isCourseOffering);
    const courses = enrollments.map((info) => toCourse(info, this.tenantOrigin));

    const ctx = { tenantOrigin: this.tenantOrigin, userId, observedAt: capturedAt, now };
    const since = new Date(now.getTime() - this.announcementWindowDays * 86_400_000).toISOString();
    const submissionCutoff = now.getTime() - SUBMISSION_LOOKBACK_DAYS * 86_400_000;

    this.onPhase?.("loading-course-data", { completed: 0, total: courses.length });
    let completed = 0;

    const perCourse = await mapWithConcurrency(courses, this.concurrency, async (course) => {
      const result = await this.loadCourse(course.id, ctx, since, submissionCutoff, warnings);
      completed++;
      this.onPhase?.("loading-course-data", { completed, total: courses.length });
      return result;
    });

    this.onPhase?.("normalizing");
    const items: AcademicItem[] = [];
    const announcements: Announcement[] = [];
    const successfulCourseIds: string[] = [];
    const failures: CourseFailure[] = [];
    for (const [index, result] of perCourse.entries()) {
      const course = courses[index] as Course;
      if (result.ok) {
        successfulCourseIds.push(course.id);
        items.push(...result.items);
        announcements.push(...result.announcements);
      } else {
        failures.push({ courseId: course.id, error: result.error });
      }
    }
    const fatal = failures.find((failure) => isFatalForSync(failure.error));
    if (fatal) throw new BrightspaceFailure(fatal.error);

    return {
      tenantOrigin: this.tenantOrigin,
      userId,
      displayName,
      capturedAt,
      versions,
      courses,
      items,
      announcements,
      successfulCourseIds,
      failedCourseIds: failures.map((failure) => failure.courseId),
      failures,
      warnings,
    };
  }

  private async loadCourse(
    courseId: string,
    ctx: { tenantOrigin: string; userId: string; observedAt: string; now: Date },
    since: string,
    submissionCutoff: number,
    warnings: SyncWarning[],
  ): Promise<{ ok: true; items: AcademicItem[]; announcements: Announcement[] } | { ok: false; error: BrightspaceError }> {
    const optional = async <T>(operation: string, run: () => Promise<T>, fallback: T): Promise<T | { failed: BrightspaceError }> => {
      try {
        return await run();
      } catch (error) {
        const mapped = toBrightspaceError(error, operation);
        if (mapped.kind === "not-found" || mapped.kind === "permission-denied") {
          warnings.push({ courseId, operation, message: `${operation} is unavailable for this course.` });
          return fallback;
        }
        return { failed: mapped };
      }
    };
    const isFailed = <T>(value: T | { failed: BrightspaceError }): value is { failed: BrightspaceError } =>
      typeof value === "object" && value !== null && "failed" in value;

    const [folders, quizzes, news] = await Promise.all([
      optional("dropboxFolders", () => this.listDropboxFolders(courseId), [] as DropboxFolder[]),
      optional("quizzes", () => this.listQuizzes(courseId), [] as QuizReadData[]),
      optional("news", () => this.listNews(courseId, since), [] as NewsItem[]),
    ]);
    for (const result of [folders, quizzes, news]) if (isFailed(result)) return { ok: false, error: result.failed };
    const folderList = folders as DropboxFolder[];
    const quizList = quizzes as QuizReadData[];
    const newsList = news as NewsItem[];

    // Submission status: only for folders that still matter, bounded concurrency, never fatal.
    const statuses = new Map<string, StatusSource>();
    if (this.loadSubmissionStatus) {
      const candidates = folderList.filter((folder) => {
        if (folder.IsHidden) return false;
        if (!folder.DueDate) return true;
        const due = new Date(folder.DueDate).getTime();
        return Number.isNaN(due) || due >= submissionCutoff;
      });
      let permissionWarned = false;
      await mapWithConcurrency(candidates, this.concurrency, async (folder) => {
        try {
          const entries = await this.listMySubmissions(courseId, folder.Id);
          statuses.set(folder.Id, { kind: "known", submission: entries[0] ?? null });
        } catch (error) {
          const mapped = toBrightspaceError(error, "mySubmissions");
          if (isFatalForSync(mapped)) throw error;
          statuses.set(folder.Id, { kind: "unavailable" });
          if (!permissionWarned) {
            permissionWarned = true;
            warnings.push({ courseId, operation: "mySubmissions", message: "Submission status is unavailable for this course." });
          }
        }
      }).catch((error: unknown) => {
        throw error;
      });
    }

    const items = [
      ...folderList.map((folder) => toAssignment(folder, courseId, statuses.get(folder.Id) ?? { kind: "unavailable" }, ctx)),
      ...quizList.map((quiz) => toQuiz(quiz, courseId, ctx)),
    ];
    const announcements = newsList.filter((item) => item.IsPublished !== false).map((item) => toAnnouncement(item, courseId, ctx));
    return { ok: true, items, announcements };
  }
}
