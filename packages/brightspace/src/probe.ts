import { toBrightspaceError, type BrightspaceError } from "./errors";
import { routes, type ApprovedBrightspacePath } from "./routes";
import { enrollmentsPageSchema, versionsSchema, whoAmISchema } from "./schemas";
import { DEFAULT_TIMEOUT_MS, classifyResponse, type RawFetch, type RawResponse } from "./transport";
import { resolveVersions, type ResolvedVersions } from "./versions";

/**
 * Phase 0 feasibility probe.
 *
 * Tests whether the logged-in browser session is accepted by the documented
 * read-only routes on this tenant. Records only sanitized evidence: status,
 * content type, whether the body was JSON, the field *shape*, and the selected
 * versions. Never values, cookies, or raw bodies.
 */

export type ShapeDescription = string | { [key: string]: ShapeDescription } | ShapeDescription[];

export const describeShape = (value: unknown, depth = 2): ShapeDescription => {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (depth <= 0 || value.length === 0) return `array(${value.length})`;
    return [describeShape(value[0], depth - 1)];
  }
  if (typeof value === "object") {
    if (depth <= 0) return "object";
    const out: { [key: string]: ShapeDescription } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort().slice(0, 40)) {
      out[key] = describeShape((value as Record<string, unknown>)[key], depth - 1);
    }
    return out;
  }
  return typeof value;
};

export type ProbeStepOutcome = "ok" | BrightspaceError["kind"];

export type ProbeStep = {
  operation: "versions" | "whoami" | "myenrollments";
  path: string;
  status: number | null;
  contentType: string | null;
  isJson: boolean;
  redirected: boolean;
  fieldShape: ShapeDescription | null;
  schemaValid: boolean;
  outcome: ProbeStepOutcome;
};

export type FeasibilityVerdict = "live-ok" | "authorization-required" | "permission-denied" | "unreachable" | "unsupported";

export type FeasibilityReport = {
  probedAt: string;
  tenantOrigin: string;
  verdict: FeasibilityVerdict;
  steps: ProbeStep[];
  selectedVersions: Pick<ResolvedVersions, "lp" | "le"> | null;
  /** Course count only; never names or IDs. */
  activeEnrollmentCount: number | null;
};

export const runFeasibilityProbe = async (
  rawFetch: RawFetch,
  options: { tenantOrigin: string; now?: () => Date },
): Promise<FeasibilityReport> => {
  const now = options.now ?? (() => new Date());
  const steps: ProbeStep[] = [];

  const fetchOnce = async (path: ApprovedBrightspacePath): Promise<RawResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      return await rawFetch(path, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const step = async <T>(
    operation: ProbeStep["operation"],
    path: ApprovedBrightspacePath,
    schema: { safeParse(input: unknown): { success: boolean; data?: T } },
  ): Promise<{ data: T | null; error: BrightspaceError | null }> => {
    let response: RawResponse | null = null;
    let error: BrightspaceError | null = null;
    try {
      response = await fetchOnce(path);
      const outcome = classifyResponse(response, operation, now());
      if (outcome.type === "fail") error = outcome.error;
      if (outcome.type === "retry") error = outcome.exhausted;
    } catch (caught) {
      error = toBrightspaceError(caught, operation);
    }
    const parsed = response?.isJson && !error ? schema.safeParse(response.body) : null;
    const schemaValid = !!parsed?.success;
    if (response && !error && !schemaValid) error = { kind: "invalid-response", operation, detail: "schema" };
    steps.push({
      operation,
      path,
      status: response?.status ?? null,
      contentType: response?.contentType ?? null,
      isJson: response?.isJson ?? false,
      redirected: response?.redirected ?? false,
      fieldShape: response?.isJson ? describeShape(response.body) : null,
      schemaValid,
      outcome: error ? error.kind : "ok",
    });
    return { data: schemaValid ? ((parsed as { data: T }).data ?? null) : null, error };
  };

  const verdictFor = (error: BrightspaceError): FeasibilityVerdict => {
    switch (error.kind) {
      case "session-expired":
        return "authorization-required";
      case "permission-denied":
        return "permission-denied";
      case "unsupported-api":
      case "invalid-response":
      case "not-found":
        return "unsupported";
      default:
        return "unreachable";
    }
  };

  const report = (verdict: FeasibilityVerdict, selected: Pick<ResolvedVersions, "lp" | "le"> | null, count: number | null): FeasibilityReport => ({
    probedAt: now().toISOString(),
    tenantOrigin: options.tenantOrigin,
    verdict,
    steps,
    selectedVersions: selected,
    activeEnrollmentCount: count,
  });

  const versions = await step("versions", routes.versions(), versionsSchema);
  if (versions.error || !versions.data) return report(verdictFor(versions.error ?? { kind: "invalid-response", operation: "versions" }), null, null);

  let selected: ResolvedVersions;
  try {
    selected = resolveVersions(versions.data, now());
  } catch (caught) {
    return report(verdictFor(toBrightspaceError(caught, "versions")), null, null);
  }
  const chosen = { lp: selected.lp, le: selected.le };

  const me = await step("whoami", routes.whoami(selected.lp), whoAmISchema);
  if (me.error) return report(verdictFor(me.error), chosen, null);

  const enrollments = await step("myenrollments", routes.myEnrollments(selected.lp, { isActive: true, canAccess: true }), enrollmentsPageSchema);
  if (enrollments.error || !enrollments.data) return report(verdictFor(enrollments.error ?? { kind: "invalid-response", operation: "myenrollments" }), chosen, null);

  return report("live-ok", chosen, enrollments.data.Items.length);
};

/** Minimum read-only routes the OAuth registration must allow. */
export const REQUIRED_READ_ONLY_ROUTES = [
  "GET /d2l/api/versions/",
  "GET /d2l/api/lp/{version}/users/whoami",
  "GET /d2l/api/lp/{version}/enrollments/myenrollments/",
  "GET /d2l/api/le/{version}/{orgUnitId}/dropbox/folders/",
  "GET /d2l/api/le/{version}/{orgUnitId}/dropbox/folders/{folderId}/submissions/mysubmissions/",
  "GET /d2l/api/le/{version}/{orgUnitId}/quizzes/",
  "GET /d2l/api/le/{version}/{orgUnitId}/news/",
] as const;

/** D2L OAuth 2 scopes that cover the routes above. */
export const REQUIRED_OAUTH_SCOPES = ["core:*:*", "enrollment:orgunit:read", "dropbox:folders:read", "quizzing:quizzes:read", "news:access:read"] as const;
