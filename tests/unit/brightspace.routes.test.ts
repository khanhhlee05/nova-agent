import { describe, expect, it } from "vitest";
import { isSafeTenantLink, routes, validateApprovedPath } from "@nova-agent/brightspace";

const TENANT = "https://brightspace.villanova.edu";

describe("route allowlist", () => {
  it("builds every approved route", () => {
    expect(routes.versions()).toBe("/d2l/api/versions/");
    expect(routes.whoami("1.47")).toBe("/d2l/api/lp/1.47/users/whoami");
    expect(routes.myEnrollments("1.47", { isActive: true, canAccess: true })).toBe(
      "/d2l/api/lp/1.47/enrollments/myenrollments/?isActive=true&canAccess=true",
    );
    expect(routes.dropboxFolders("1.79", "31001")).toBe("/d2l/api/le/1.79/31001/dropbox/folders/");
    expect(routes.mySubmissions("1.79", "31001", "4101")).toBe("/d2l/api/le/1.79/31001/dropbox/folders/4101/submissions/mysubmissions/");
    expect(routes.quizzes("1.79", "31001", { bookmark: "abc" })).toBe("/d2l/api/le/1.79/31001/quizzes/?bookmark=abc");
    expect(routes.news("1.79", "31001", { since: "2026-09-01T00:00:00.000Z" })).toBe(
      "/d2l/api/le/1.79/31001/news/?since=2026-09-01T00%3A00%3A00.000Z",
    );
  });

  it("rejects off-list paths, foreign origins, and injected parameters", () => {
    expect(validateApprovedPath("/d2l/api/lp/1.47/users/1234")).toBeNull();
    expect(validateApprovedPath("/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=1&db=2")).toBeNull();
    expect(validateApprovedPath("/d2l/api/le/1.79/31001/dropbox/folders/../../users")).toBeNull();
    expect(validateApprovedPath("/d2l/api/le/1.79/31001/quizzes/?bookmark=a&evil=1")).toBeNull();
    expect(validateApprovedPath("/d2l/api/le/1.79/31001/quizzes/?bookmark=a&bookmark=b")).toBeNull();
    expect(validateApprovedPath("https://evil.example/d2l/api/versions/", TENANT)).toBeNull();
    expect(validateApprovedPath("http://brightspace.villanova.edu/d2l/api/versions/", TENANT)).toBeNull();
    expect(validateApprovedPath("javascript:alert(1)", TENANT)).toBeNull();
    expect(validateApprovedPath("", TENANT)).toBeNull();
  });

  it("accepts same-tenant absolute pagination URLs and normalizes them", () => {
    const next = validateApprovedPath(`${TENANT}/d2l/api/le/1.79/31001/quizzes/?bookmark=xyz`, TENANT);
    expect(next?.path).toBe("/d2l/api/le/1.79/31001/quizzes/?bookmark=xyz");
    expect(next?.operation).toBe("quizzes");
  });

  it("rejects route builder abuse", () => {
    expect(() => routes.dropboxFolders("1.79", "31001/../x")).toThrow();
    expect(() => routes.whoami("latest")).toThrow();
  });

  it("only treats https tenant pages as safe links", () => {
    expect(isSafeTenantLink(`${TENANT}/d2l/home/31001`, TENANT)).toBe(true);
    expect(isSafeTenantLink("https://phish.example/d2l/home/1", TENANT)).toBe(false);
    expect(isSafeTenantLink(`${TENANT}/other`, TENANT)).toBe(false);
    expect(isSafeTenantLink(null, TENANT)).toBe(false);
  });
});
