/**
 * Every Brightspace request must be built through this module. The transport
 * only accepts `ApprovedBrightspacePath` values, and the content-script bridge
 * re-validates with `validateApprovedPath` before fetching.
 */

declare const approvedBrand: unique symbol;

/** A tenant-relative path (`/d2l/api/...` plus optional query) that matched the allowlist. */
export type ApprovedBrightspacePath = string & { readonly [approvedBrand]: true };

export type BrightspaceOperation =
  | "versions"
  | "whoami"
  | "myenrollments"
  | "dropboxFolders"
  | "mySubmissions"
  | "quizzes"
  | "news";

type RouteRule = { operation: BrightspaceOperation; pattern: RegExp; params: readonly string[] };

const VERSION = String.raw`\d{1,3}\.\d{1,3}`;
const ID = String.raw`\d{1,12}`;

const ROUTE_RULES: readonly RouteRule[] = [
  { operation: "versions", pattern: new RegExp(String.raw`^/d2l/api/versions/$`), params: [] },
  { operation: "whoami", pattern: new RegExp(String.raw`^/d2l/api/lp/${VERSION}/users/whoami$`), params: [] },
  {
    operation: "myenrollments",
    pattern: new RegExp(String.raw`^/d2l/api/lp/${VERSION}/enrollments/myenrollments/$`),
    params: ["bookmark", "isActive", "canAccess", "orgUnitTypeId", "sortBy", "excludeEnded", "startDateTime", "endDateTime"],
  },
  { operation: "dropboxFolders", pattern: new RegExp(String.raw`^/d2l/api/le/${VERSION}/${ID}/dropbox/folders/$`), params: [] },
  {
    operation: "mySubmissions",
    pattern: new RegExp(String.raw`^/d2l/api/le/${VERSION}/${ID}/dropbox/folders/${ID}/submissions/mysubmissions/$`),
    params: [],
  },
  { operation: "quizzes", pattern: new RegExp(String.raw`^/d2l/api/le/${VERSION}/${ID}/quizzes/$`), params: ["bookmark"] },
  { operation: "news", pattern: new RegExp(String.raw`^/d2l/api/le/${VERSION}/${ID}/news/$`), params: ["since"] },
];

const SAFE_PARAM_VALUE = /^[A-Za-z0-9._~%+:-]*$/;

export type ApprovedRoute = { path: ApprovedBrightspacePath; operation: BrightspaceOperation };

/**
 * Validates a path or absolute URL against the allowlist.
 *
 * Accepts either a tenant-relative path beginning with `/d2l/api/` or an
 * absolute URL whose origin equals `tenantOrigin`. Returns the normalized
 * relative path (pathname + query) or `null` if anything is off-list.
 */
export const validateApprovedPath = (input: string, tenantOrigin?: string): ApprovedRoute | null => {
  if (typeof input !== "string" || input.length === 0 || input.length > 2048) return null;
  if (/[\s\\]/.test(input) || input.includes("..")) return null;

  let url: URL;
  try {
    url = new URL(input, tenantOrigin ?? "https://tenant.invalid");
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;

  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) {
    // Absolute URL: origin must match the tenant exactly.
    if (!tenantOrigin || url.origin !== new URL(tenantOrigin).origin) return null;
  } else if (!input.startsWith("/d2l/api/")) {
    return null;
  }
  if (url.protocol !== "https:" && tenantOrigin !== undefined) return null;
  if (!url.pathname.startsWith("/d2l/api/")) return null;

  const rule = ROUTE_RULES.find((candidate) => candidate.pattern.test(url.pathname));
  if (!rule) return null;

  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!rule.params.includes(key) || seen.has(key) || !SAFE_PARAM_VALUE.test(encodeURIComponent(value))) return null;
    seen.add(key);
  }
  const query = url.searchParams.toString();
  const path = `${url.pathname}${query ? `?${query}` : ""}` as ApprovedBrightspacePath;
  return { path, operation: rule.operation };
};

export const isApprovedBrightspacePath = (input: string, tenantOrigin?: string): input is ApprovedBrightspacePath =>
  validateApprovedPath(input, tenantOrigin)?.path === input;

const approve = (path: string): ApprovedBrightspacePath => {
  const approved = validateApprovedPath(path);
  if (!approved) throw new Error(`Route builder produced an off-list path: ${path}`);
  return approved.path;
};

const withQuery = (path: string, params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};

const assertId = (value: string, label: string): string => {
  if (!/^\d{1,12}$/.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
};

const assertVersion = (value: string): string => {
  if (!/^\d{1,3}\.\d{1,3}$/.test(value)) throw new Error(`Invalid API version: ${value}`);
  return value;
};

/** Typed route builders. These are the only way to obtain an `ApprovedBrightspacePath`. */
export const routes = {
  versions: (): ApprovedBrightspacePath => approve("/d2l/api/versions/"),
  whoami: (lp: string): ApprovedBrightspacePath => approve(`/d2l/api/lp/${assertVersion(lp)}/users/whoami`),
  myEnrollments: (lp: string, options: { bookmark?: string; isActive?: boolean; canAccess?: boolean } = {}): ApprovedBrightspacePath =>
    approve(
      withQuery(`/d2l/api/lp/${assertVersion(lp)}/enrollments/myenrollments/`, {
        isActive: options.isActive === undefined ? undefined : String(options.isActive),
        canAccess: options.canAccess === undefined ? undefined : String(options.canAccess),
        bookmark: options.bookmark,
      }),
    ),
  dropboxFolders: (le: string, orgUnitId: string): ApprovedBrightspacePath =>
    approve(`/d2l/api/le/${assertVersion(le)}/${assertId(orgUnitId, "orgUnitId")}/dropbox/folders/`),
  mySubmissions: (le: string, orgUnitId: string, folderId: string): ApprovedBrightspacePath =>
    approve(
      `/d2l/api/le/${assertVersion(le)}/${assertId(orgUnitId, "orgUnitId")}/dropbox/folders/${assertId(folderId, "folderId")}/submissions/mysubmissions/`,
    ),
  quizzes: (le: string, orgUnitId: string, options: { bookmark?: string } = {}): ApprovedBrightspacePath =>
    approve(withQuery(`/d2l/api/le/${assertVersion(le)}/${assertId(orgUnitId, "orgUnitId")}/quizzes/`, { bookmark: options.bookmark })),
  news: (le: string, orgUnitId: string, options: { since?: string } = {}): ApprovedBrightspacePath =>
    approve(withQuery(`/d2l/api/le/${assertVersion(le)}/${assertId(orgUnitId, "orgUnitId")}/news/`, { since: options.since })),
};

/** Well-known learner-facing Brightspace page paths (not API routes). */
export const pageLinks = {
  courseHome: (tenantOrigin: string, orgUnitId: string): string => `${tenantOrigin}/d2l/home/${assertId(orgUnitId, "orgUnitId")}`,
  assignment: (tenantOrigin: string, orgUnitId: string, folderId: string): string =>
    `${tenantOrigin}/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=${assertId(orgUnitId, "orgUnitId")}&db=${assertId(folderId, "folderId")}`,
  quiz: (tenantOrigin: string, orgUnitId: string, quizId: string): string =>
    `${tenantOrigin}/d2l/lms/quizzing/user/quiz_summary.d2l?ou=${assertId(orgUnitId, "orgUnitId")}&qi=${assertId(quizId, "quizId")}`,
  news: (tenantOrigin: string, orgUnitId: string): string => `${tenantOrigin}/d2l/lms/news/main.d2l?ou=${assertId(orgUnitId, "orgUnitId")}`,
};

/** Villanova's confirmed Brightspace host. Configurable per build; never the retired learn.villanova.edu. */
export const VILLANOVA_BRIGHTSPACE_ORIGIN = "https://brightspace.villanova.edu";

/** Returns true when `url` points at a page on the tenant, so the UI never opens a foreign link. */
export const isSafeTenantLink = (url: string | null, tenantOrigin: string): url is string => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.origin === new URL(tenantOrigin).origin && parsed.pathname.startsWith("/d2l/");
  } catch {
    return false;
  }
};
