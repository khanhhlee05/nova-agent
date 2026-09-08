import { describe, expect, it } from "vitest";
import {
  BrightspaceClient,
  BrightspaceFailure,
  DEMO_LE_VERSION,
  DEMO_LP_VERSION,
  FixtureTransport,
  MemoryVersionCache,
  SessionTransport,
  buildDemoTenant,
  demoResolver,
  htmlResponse,
  jsonResponse,
  mapResolver,
  routes,
  runFeasibilityProbe,
  selectHighestVersion,
  type RawFetch,
} from "@nova-agent/brightspace";

const TENANT = "https://brightspace.villanova.edu";
const NOW = new Date("2026-09-08T12:00:00.000Z");

const demoClient = (overrides: Record<string, unknown> = {}, options: Partial<ConstructorParameters<typeof BrightspaceClient>[1]> = {}) => {
  const transport = new FixtureTransport(demoResolver(buildDemoTenant(NOW), overrides));
  return { transport, client: new BrightspaceClient(transport, { tenantOrigin: TENANT, now: () => NOW, ...options }) };
};

describe("version selection", () => {
  it("selects the highest supported version per product code", () => {
    const versions = [
      { ProductCode: "lp", LatestVersion: "1.9", SupportedVersions: ["1.9", "1.10", "1.2"] },
      { ProductCode: "le", LatestVersion: null, SupportedVersions: ["1.79", "1.8"] },
    ];
    expect(selectHighestVersion(versions, "lp")).toBe("1.10");
    expect(selectHighestVersion(versions, "le")).toBe("1.79");
    expect(selectHighestVersion(versions, "ep" as "lp")).toBeNull();
  });

  it("caches resolved versions for 24 hours and invalidates on a version-specific 404", async () => {
    const cache = new MemoryVersionCache();
    const { client, transport } = demoClient({}, { versionCache: cache });
    await client.resolveVersions();
    await client.resolveVersions();
    expect(transport.requests.filter((path) => path === routes.versions())).toHaveLength(1);

    const stale = { ...(await cache.get())!, resolvedAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() };
    await cache.set(stale);
    await client.resolveVersions();
    expect(transport.requests.filter((path) => path === routes.versions())).toHaveLength(2);

    const broken = demoClient({ [routes.whoami(DEMO_LP_VERSION)]: jsonResponse({ Errors: [{ Message: "Invalid API version" }] }, 404) }, { versionCache: cache });
    await expect(broken.client.whoami()).rejects.toMatchObject({ error: { kind: "unsupported-api", product: "lp" } });
    expect(await cache.get()).toBeNull();
  });
});

describe("pagination", () => {
  it("follows PagingInfo bookmarks for enrollments", async () => {
    const base = buildDemoTenant(NOW);
    const enrollments = base.enrollments as { Items: unknown[] };
    const page1 = { PagingInfo: { Bookmark: "b1", HasMoreItems: true }, Items: enrollments.Items.slice(0, 2) };
    const page2 = { PagingInfo: { Bookmark: "b2", HasMoreItems: false }, Items: enrollments.Items.slice(2) };
    const { client } = demoClient({
      [routes.myEnrollments(DEMO_LP_VERSION, { isActive: true, canAccess: true })]: page1,
      [routes.myEnrollments(DEMO_LP_VERSION, { isActive: true, canAccess: true, bookmark: "b1" })]: page2,
    });
    expect(await client.listMyEnrollments()).toHaveLength(4);
  });

  it("follows Next URLs for quizzes only on the tenant origin", async () => {
    const q = (id: number) => ({ QuizId: id, Name: `Q${id}`, IsActive: true, StartDate: null, EndDate: null, DueDate: null });
    const first = routes.quizzes(DEMO_LE_VERSION, "31001");
    const { client } = demoClient({
      [first]: { Objects: [q(1)], Next: `${TENANT}/d2l/api/le/${DEMO_LE_VERSION}/31001/quizzes/?bookmark=p2` },
      [routes.quizzes(DEMO_LE_VERSION, "31001", { bookmark: "p2" })]: { Objects: [q(2)], Next: null },
    });
    expect((await client.listQuizzes("31001")).map((quiz) => quiz.QuizId)).toEqual(["1", "2"]);

    const foreign = demoClient({ [first]: { Objects: [q(1)], Next: "https://evil.example/d2l/api/le/1.79/31001/quizzes/?bookmark=x" } });
    await expect(foreign.client.listQuizzes("31001")).rejects.toMatchObject({ error: { kind: "pagination", reason: "unsafe-next" } });
  });

  it("stops on a repeated bookmark or Next URL", async () => {
    const loopEnrollments = { PagingInfo: { Bookmark: "same", HasMoreItems: true }, Items: [] };
    const { client } = demoClient({
      [routes.myEnrollments(DEMO_LP_VERSION, { isActive: true, canAccess: true })]: loopEnrollments,
      [routes.myEnrollments(DEMO_LP_VERSION, { isActive: true, canAccess: true, bookmark: "same" })]: loopEnrollments,
    });
    await expect(client.listMyEnrollments()).rejects.toMatchObject({ error: { kind: "pagination", reason: "loop" } });

    const first = routes.quizzes(DEMO_LE_VERSION, "31001");
    const loopQuizzes = demoClient({ [first]: { Objects: [], Next: `${TENANT}${first}` } });
    await expect(loopQuizzes.client.listQuizzes("31001")).rejects.toMatchObject({ error: { kind: "pagination", reason: "loop" } });
  });
});

describe("loadAcademicState", () => {
  it("normalizes the demo tenant into canonical models", async () => {
    const { client } = demoClient();
    const state = await client.loadAcademicState();
    expect(state.userId).toBe("2001");
    expect(state.courses.map((course) => course.name)).toContain("Microcontrollers");
    expect(state.failedCourseIds).toEqual([]);
    expect(state.successfulCourseIds).toHaveLength(4);
    const lab3 = state.items.find((item) => item.title.startsWith("Lab 3"));
    expect(lab3).toMatchObject({ kind: "assignment", status: "not-started", pointsPossible: 50, visibility: "visible" });
    expect(lab3?.key).toBe(`${TENANT}|2001|assignment|31001|4101`);
    expect(lab3?.url).toBe(`${TENANT}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=31001&db=4101`);
    const lab1 = state.items.find((item) => item.title.startsWith("Lab 1"));
    expect(lab1?.status).toBe("completed");
    const quiz = state.items.find((item) => item.kind === "quiz");
    expect(quiz?.status).toBe("unknown");
    expect(state.announcements.some((a) => a.title === "Midterm logistics" && a.pinned)).toBe(true);
  });

  it("tolerates unknown extra response fields", async () => {
    const { client } = demoClient({
      [routes.whoami(DEMO_LP_VERSION)]: { Identifier: 77, FirstName: "A", LastName: "B", UniqueName: "ab", Pronouns: "they/them", FutureField: { nested: true } },
    });
    const state = await client.loadAcademicState();
    expect(state.userId).toBe("77");
  });

  it("keeps successful courses when one course fails", async () => {
    const { client } = demoClient({ [routes.dropboxFolders(DEMO_LE_VERSION, "31002")]: jsonResponse(null, 500) });
    const state = await client.loadAcademicState();
    expect(state.failedCourseIds).toEqual(["31002"]);
    expect(state.successfulCourseIds).toEqual(["31001", "31003", "31004"]);
    expect(state.items.some((item) => item.courseId === "31002")).toBe(false);
    expect(state.items.some((item) => item.courseId === "31001")).toBe(true);
  });

  it("treats a 404 optional resource as a warning, not a failure", async () => {
    const { client } = demoClient({ [routes.quizzes(DEMO_LE_VERSION, "31003")]: jsonResponse(null, 404) });
    const state = await client.loadAcademicState();
    expect(state.failedCourseIds).toEqual([]);
    expect(state.warnings).toContainEqual(expect.objectContaining({ courseId: "31003", operation: "quizzes" }));
  });

  it("marks status unknown when submissions are forbidden", async () => {
    const { client } = demoClient({ [routes.mySubmissions(DEMO_LE_VERSION, "31001", "4101")]: jsonResponse(null, 403) });
    const state = await client.loadAcademicState();
    expect(state.items.find((item) => item.sourceId === "4101")?.status).toBe("unknown");
    expect(state.items.find((item) => item.sourceId === "4102")?.status).toBe("not-started");
    expect(state.warnings.filter((w) => w.courseId === "31001" && w.operation === "mySubmissions")).toHaveLength(1);
  });

  it("aborts the sync on session expiry", async () => {
    const { client } = demoClient({ [routes.whoami(DEMO_LP_VERSION)]: htmlResponse() });
    await expect(client.loadAcademicState()).rejects.toBeInstanceOf(BrightspaceFailure);
    await expect(client.loadAcademicState()).rejects.toMatchObject({ error: { kind: "session-expired" } });
  });

  it("limits course-detail concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const resolver = demoResolver(buildDemoTenant(NOW));
    const fetch: RawFetch = async (path) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      const value = resolver(path);
      return value && typeof value === "object" && "status" in (value as object) ? (value as never) : jsonResponse(value);
    };
    const transport = new SessionTransport(fetch, { tenantOrigin: TENANT, sleep: async () => {} });
    const client = new BrightspaceClient(transport, { tenantOrigin: TENANT, now: () => NOW, concurrency: 2 });
    await client.loadAcademicState();
    expect(peak).toBeLessThanOrEqual(2 * 3);
  });
});

describe("feasibility probe", () => {
  const rawFrom =
    (overrides: Record<string, unknown> = {}): RawFetch =>
    async (path) => {
      const resolver = demoResolver(buildDemoTenant(NOW), overrides);
      const value = resolver(path);
      if (value && typeof value === "object" && "status" in (value as object)) return value as never;
      return jsonResponse(value);
    };

  it("reports live-ok with sanitized evidence only", async () => {
    const report = await runFeasibilityProbe(rawFrom(), { tenantOrigin: TENANT, now: () => NOW });
    expect(report.verdict).toBe("live-ok");
    expect(report.selectedVersions).toEqual({ lp: DEMO_LP_VERSION, le: DEMO_LE_VERSION });
    expect(report.activeEnrollmentCount).toBe(4);
    expect(report.steps.map((step) => step.operation)).toEqual(["versions", "whoami", "myenrollments"]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("Demo Student");
    expect(serialized).not.toContain("Microcontrollers");
    expect(report.steps[1]?.fieldShape).toMatchObject({ Identifier: "string", FirstName: "string" });
  });

  it("reports authorization-required when whoami redirects to login", async () => {
    const report = await runFeasibilityProbe(rawFrom({ [routes.whoami(DEMO_LP_VERSION)]: htmlResponse() }), { tenantOrigin: TENANT, now: () => NOW });
    expect(report.verdict).toBe("authorization-required");
    expect(report.steps).toHaveLength(2);
    expect(report.steps[1]).toMatchObject({ status: 200, isJson: false, outcome: "session-expired" });
  });

  it("reports unreachable when versions cannot be fetched", async () => {
    const report = await runFeasibilityProbe(async () => { throw new Error("offline"); }, { tenantOrigin: TENANT, now: () => NOW });
    expect(report.verdict).toBe("unreachable");
    expect(report.steps[0]?.status).toBeNull();
  });
});

describe("FixtureTransport", () => {
  it("returns typed not-found for missing fixtures", async () => {
    const transport = new FixtureTransport(mapResolver({}));
    const client = new BrightspaceClient(transport, { tenantOrigin: TENANT, now: () => NOW });
    await expect(client.getVersions()).rejects.toMatchObject({ error: { kind: "not-found" } });
  });
});
