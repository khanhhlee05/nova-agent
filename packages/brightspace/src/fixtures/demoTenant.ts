import { routes, VILLANOVA_BRIGHTSPACE_ORIGIN } from "../routes";
import { jsonResponse, type FixtureResolver, type RawResponse } from "../transport";

/**
 * Sanitized, fictional demo tenant shaped like real D2L responses. Dates are
 * generated relative to `now` so demo mode always looks alive. No real student
 * data appears here.
 */

export const DEMO_LP_VERSION = "1.47";
export const DEMO_LE_VERSION = "1.79";
export const DEMO_USER_ID = "2001";

const hours = (n: number, now: Date): string => new Date(now.getTime() + n * 3_600_000).toISOString();
const days = (n: number, now: Date, hour = 23, minute = 59): string => {
  const date = new Date(now);
  date.setDate(date.getDate() + n);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};

export type DemoScenario = "baseline" | "changed";

export type DemoCourse = { id: string; name: string; code: string };

export const DEMO_COURSES: DemoCourse[] = [
  { id: "31001", name: "Microcontrollers", code: "ECE-2042-001" },
  { id: "31002", name: "Computer Architecture", code: "CSC-2405-002" },
  { id: "31003", name: "Signals and Systems", code: "ECE-3040-001" },
  { id: "31004", name: "Engineering Ethics", code: "EGR-3300-003" },
];

const folder = (
  id: number,
  name: string,
  dueDate: string | null,
  extra: Partial<{ IsHidden: boolean; ScoreDenominator: number | null; StartDate: string | null; EndDate: string | null }> = {},
) => ({
  Id: id,
  CategoryId: null,
  Name: name,
  CustomInstructions: { Text: "", Html: "" },
  Attachments: [],
  TotalFiles: 0,
  UnreadFiles: 0,
  FlaggedFiles: 0,
  TotalUsers: 42,
  TotalUsersWithSubmissions: 0,
  TotalUsersWithFeedback: 0,
  Availability: extra.StartDate !== undefined || extra.EndDate !== undefined ? { StartDate: extra.StartDate ?? null, EndDate: extra.EndDate ?? null } : null,
  GroupTypeId: null,
  DueDate: dueDate,
  DisplayInCalendar: true,
  Assessment: { ScoreDenominator: extra.ScoreDenominator === undefined ? 100 : extra.ScoreDenominator, Rubrics: [] },
  NotificationEmail: null,
  IsHidden: extra.IsHidden ?? false,
  LinkAttachments: [],
  ActivityId: `https://demo.invalid/activities/${id}`,
  IsAnonymous: false,
  DropboxType: 0,
  SubmissionType: 0,
  CompletionType: 0,
  GradeItemId: null,
  AllowOnlyUsersWithSpecialAccess: false,
  IsUnread: false,
  LearnerIsSubmitted: false,
});

const quiz = (id: number, name: string, dueDate: string | null, extra: Partial<{ IsActive: boolean; StartDate: string | null; EndDate: string | null }> = {}) => ({
  QuizId: id,
  Name: name,
  IsActive: extra.IsActive ?? true,
  SortOrder: id,
  AutoExportToGrades: false,
  GradeItemId: null,
  IsAutoSetGraded: false,
  Instructions: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  Description: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  Header: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  Footer: { Text: { Text: "", Html: "" }, IsDisplayed: false },
  StartDate: extra.StartDate ?? null,
  EndDate: extra.EndDate ?? null,
  DueDate: dueDate,
  DisplayInCalendar: true,
  AttemptsAllowed: { IsUnlimited: false, NumberOfAttemptsAllowed: 1 },
  ActivityId: `https://demo.invalid/activities/quiz-${id}`,
  IsRetakeIncorrectOnly: false,
});

const news = (id: number, title: string, text: string, createdDate: string, extra: Partial<{ LastModifiedDate: string; IsPinned: boolean }> = {}) => ({
  Id: id,
  IsHidden: false,
  Attachments: [],
  Title: title,
  Body: { Text: text, Html: `<p>${text}</p>` },
  StartDate: createdDate,
  EndDate: null,
  IsGlobal: false,
  IsPublished: true,
  ShowOnlyInCourseOfferings: true,
  IsAuthorInfoShown: false,
  CreatedBy: 9,
  CreatedDate: createdDate,
  LastModifiedBy: 9,
  LastModifiedDate: extra.LastModifiedDate ?? createdDate,
  IsPinned: extra.IsPinned ?? false,
});

const submission = (status: number, submitted: boolean, completedAt: string | null = null) => ({
  Entity: { DisplayName: "Demo Student", EntityId: Number(DEMO_USER_ID), EntityType: "User", Active: true },
  Status: status,
  Feedback: null,
  Submissions: submitted ? [{ Id: 1, Comment: { Text: "", Html: "" }, Files: [], SubmissionDate: completedAt }] : [],
  CompletionDate: completedAt,
});

export type DemoTenantData = {
  versions: unknown;
  whoami: unknown;
  enrollments: unknown;
  courseData: Record<string, { folders: unknown[]; quizzes: unknown[]; news: unknown[]; submissions: Record<string, unknown[]> }>;
};

export const buildDemoTenant = (now: Date, scenario: DemoScenario = "baseline"): DemoTenantData => {
  const changed = scenario === "changed";
  const versions = [
    { ProductCode: "lp", LatestVersion: DEMO_LP_VERSION, SupportedVersions: ["1.40", "1.45", DEMO_LP_VERSION] },
    { ProductCode: "le", LatestVersion: DEMO_LE_VERSION, SupportedVersions: ["1.70", "1.75", DEMO_LE_VERSION] },
    { ProductCode: "ep", LatestVersion: "2.3", SupportedVersions: ["2.3"] },
  ];
  const whoami = { Identifier: DEMO_USER_ID, FirstName: "Demo", LastName: "Student", UniqueName: "demo.student", ProfileIdentifier: "p1" };
  const enrollments = {
    PagingInfo: { Bookmark: "31004", HasMoreItems: false },
    Items: DEMO_COURSES.map((course) => ({
      OrgUnit: { Id: Number(course.id), Type: { Id: 3, Code: "Course Offering", Name: "Course Offering" }, Name: course.name, Code: course.code },
      Access: { IsActive: true, StartDate: days(-40, now, 0, 0), EndDate: days(80, now), CanAccess: true, ClasslistRoleName: "Student", LISRoles: [], LastAccessed: hours(-2, now) },
      PinDate: null,
    })),
  };

  const courseData: DemoTenantData["courseData"] = {
    "31001": {
      folders: [
        folder(4101, "Lab 3: Timer Interrupts", changed ? days(2, now) : days(1, now), { ScoreDenominator: 50 }),
        folder(4102, "Lab 2: GPIO and Debouncing", days(-1, now, 17, 0), { ScoreDenominator: 50 }),
        folder(4103, "Project Proposal", days(9, now), { ScoreDenominator: 25 }),
        folder(4104, "Lab 1: Toolchain Setup", days(-12, now), { ScoreDenominator: 20 }),
      ],
      quizzes: [quiz(5101, "Quiz 2: Interrupt Latency", days(3, now, 23, 30)), ...(changed ? [quiz(5102, "Quiz 3: Serial Protocols", days(6, now, 23, 30))] : [])],
      news: [
        news(6101, "Lab 3 kit pickup", "Lab 3 kits are available at the CEER stockroom from Monday.", hours(-30, now)),
        ...(changed ? [news(6102, "Lab 3 deadline extended", "Lab 3 now closes one day later. Use the extra time to document timing diagrams.", hours(-1, now))] : []),
      ],
      submissions: {
        "4101": [submission(0, false)],
        "4102": [submission(0, false)],
        "4103": [submission(0, false)],
        "4104": [submission(1, true, days(-13, now, 21, 4))],
      },
    },
    "31002": {
      folders: [
        // Due dates use fixed clock times so repeated demo refreshes never look like moved deadlines.
        folder(4201, "Homework 4: Pipelining Hazards", days(0, now, 20, 0), { ScoreDenominator: 40 }),
        folder(4202, "Homework 5: Cache Simulation", days(5, now), { ScoreDenominator: 40 }),
        folder(4203, "Reading Response: Hennessy Ch. 3", null, { ScoreDenominator: 10 }),
        folder(4204, "Homework 3: ISA Design", days(-7, now), { ScoreDenominator: 40 }),
      ],
      quizzes: [quiz(5201, "Midterm Practice Quiz", days(4, now, 12, 0)), quiz(5202, "Quiz 1: Number Systems", days(-20, now), { EndDate: days(-19, now) })],
      news: [news(6201, "Midterm logistics", "The midterm is in Tolentine 215. Bring one page of notes.", days(-2, now, 9, 0), { IsPinned: true })],
      submissions: {
        "4201": [submission(changed ? 1 : 2, changed, changed ? hours(-0.5, now) : null)],
        "4202": [submission(0, false)],
        "4203": [submission(0, false)],
        "4204": [submission(1, true, days(-7, now, 20, 0))],
      },
    },
    "31003": {
      folders: [
        folder(4301, "Problem Set 6: Fourier Series", days(0, now, 23, 59), { ScoreDenominator: 30 }),
        folder(4302, "Problem Set 7: Sampling", days(13, now), { ScoreDenominator: 30 }),
        folder(4303, "MATLAB Lab: Filters", days(2, now, 17, 0), { ScoreDenominator: 60 }),
      ],
      quizzes: [],
      news: [],
      submissions: { "4301": [submission(2, false)], "4302": [submission(0, false)], "4303": [submission(0, false)] },
    },
    "31004": {
      folders: [folder(4401, "Case Study Reflection", days(20, now), { ScoreDenominator: 15 })],
      quizzes: [quiz(5401, "Syllabus Quiz", days(-30, now), { EndDate: days(-29, now) })],
      news: [news(6401, "Guest lecture Thursday", "A practicing engineer will discuss the Citicorp Center case.", days(-1, now, 8, 0))],
      submissions: { "4401": [submission(0, false)] },
    },
  };

  return { versions, whoami, enrollments, courseData };
};

export type DemoOverrides = Record<string, RawResponse | unknown>;

/** Resolves approved paths against a demo tenant. `overrides` take precedence by exact path. */
export const demoResolver = (data: DemoTenantData, overrides: DemoOverrides = {}): FixtureResolver => {
  const lp = DEMO_LP_VERSION;
  return (path) => {
    if (path in overrides) return overrides[path];
    if (path === routes.versions()) return data.versions;
    if (path === routes.whoami(lp)) return data.whoami;
    if (path.startsWith(`/d2l/api/lp/${lp}/enrollments/myenrollments/`)) return data.enrollments;
    const course = /^\/d2l\/api\/le\/[\d.]+\/(\d+)\/(dropbox\/folders\/|quizzes\/|news\/)/.exec(path);
    if (!course) return undefined;
    const entry = data.courseData[course[1] as string];
    if (!entry) return jsonResponse({ Errors: [{ Message: "Not found" }] }, 404);
    const submissions = /dropbox\/folders\/(\d+)\/submissions\/mysubmissions\/$/.exec(path);
    if (submissions) return entry.submissions[submissions[1] as string] ?? jsonResponse(null, 404);
    if (path.endsWith("/dropbox/folders/")) return entry.folders;
    if (path.includes("/quizzes/")) return { Objects: entry.quizzes, Next: null };
    if (path.includes("/news/")) return entry.news;
    return undefined;
  };
};

export const DEMO_TENANT_ORIGIN = VILLANOVA_BRIGHTSPACE_ORIGIN;
