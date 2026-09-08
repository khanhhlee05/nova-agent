import { BrightspaceFailure, fail, type BrightspaceError } from "./errors";
import { isApprovedBrightspacePath, validateApprovedPath, type ApprovedBrightspacePath } from "./routes";
import type { Schema } from "./schemas";

/**
 * Sanitized view of an HTTP response. This is the only response shape that
 * crosses the content-script bridge: no cookies, no raw HTML, no headers other
 * than the rate-limit family.
 */
export type RawResponse = {
  status: number;
  contentType: string | null;
  isJson: boolean;
  /** Parsed JSON body when `isJson`, otherwise `null`. */
  body: unknown;
  redirected: boolean;
  /** Pathname of the final URL after redirects; never includes the query string. */
  finalPath: string | null;
  headers: { retryAfter: string | null; rateLimitRemaining: string | null; rateLimitReset: string | null };
};

export type RawFetchOptions = { signal: AbortSignal };

/** The lowest-level request primitive. Implementations must only accept approved paths. */
export type RawFetch = (path: ApprovedBrightspacePath, options: RawFetchOptions) => Promise<RawResponse>;

export interface BrightspaceTransport {
  getJson<T>(path: ApprovedBrightspacePath, schema: Schema<T>): Promise<T>;
}

export type RetryPolicy = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

export type SessionTransportOptions = {
  tenantOrigin?: string;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  onRateLimit?: (info: RawResponse["headers"]) => void;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const LOGIN_PATH = /\/d2l\/(login|lp\/auth|lp\/login|sso)/i;

const parseRetryAfter = (value: string | null, now: Date): number | null => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - now.getTime());
  return null;
};

export type ResponseOutcome =
  | { type: "ok" }
  | { type: "retry"; delayMs: number | null; exhausted: BrightspaceError }
  | { type: "fail"; error: BrightspaceError };

/** Pure mapping from a sanitized response to the typed error union. */
export const classifyResponse = (response: RawResponse, operation: string, now: Date): ResponseOutcome => {
  if (looksLikeSessionExpiry(response)) return { type: "fail", error: { kind: "session-expired" } };
  if (response.status === 403) return { type: "fail", error: { kind: "permission-denied", operation } };
  if (response.status === 404) return { type: "fail", error: { kind: "not-found", operation } };
  if (response.status === 429) {
    const delayMs = parseRetryAfter(response.headers.retryAfter, now);
    const retryAt = new Date(now.getTime() + (delayMs ?? 30_000)).toISOString();
    if (delayMs === null) return { type: "fail", error: { kind: "rate-limited", retryAt } };
    return { type: "retry", delayMs, exhausted: { kind: "rate-limited", retryAt } };
  }
  if (response.status >= 500) return { type: "retry", delayMs: null, exhausted: { kind: "network", retryable: true, operation } };
  if (response.status >= 400) return { type: "fail", error: { kind: "invalid-response", operation, detail: `http-${response.status}` } };
  if (!response.isJson) return { type: "fail", error: { kind: "invalid-response", operation, detail: "not-json" } };
  return { type: "ok" };
};

export const looksLikeSessionExpiry = (response: RawResponse): boolean => {
  if (response.status === 401) return true;
  if (response.isJson) return false;
  if (response.finalPath && LOGIN_PATH.test(response.finalPath)) return true;
  const html = (response.contentType ?? "").toLowerCase().includes("text/html");
  return html && (response.redirected || response.status === 200 || response.status === 302 || response.status === 303);
};

/**
 * Wraps a `RawFetch` with the behaviour every live Brightspace call needs:
 * 10-second timeout, bounded retries with jittered backoff for network and
 * 5xx failures, exact `Retry-After` handling, session/permission mapping, and
 * schema validation. 401, 403, 404 and validation failures are never retried.
 */
export class SessionTransport implements BrightspaceTransport {
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly onRateLimit: SessionTransportOptions["onRateLimit"];
  readonly tenantOrigin: string | undefined;
  lastRateLimit: RawResponse["headers"] | null = null;

  constructor(
    private readonly rawFetch: RawFetch,
    options: SessionTransportOptions = {},
  ) {
    this.tenantOrigin = options.tenantOrigin;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.onRateLimit = options.onRateLimit;
  }

  async getJson<T>(path: ApprovedBrightspacePath, schema: Schema<T>): Promise<T> {
    if (!isApprovedBrightspacePath(path, this.tenantOrigin)) fail({ kind: "unsafe-path", path: String(path) });
    const operation = validateApprovedPath(path, this.tenantOrigin)?.operation ?? "unknown";
    const response = await this.fetchWithRetry(path, operation);
    const parsed = schema.safeParse(response.body);
    if (!parsed.success) fail({ kind: "invalid-response", operation, detail: "schema" });
    return (parsed as { success: true; data: T }).data;
  }

  /** Performs one request cycle including retries, but no schema validation. */
  async fetchWithRetry(path: ApprovedBrightspacePath, operation: string): Promise<RawResponse> {
    let attempt = 0;
    for (;;) {
      let response: RawResponse;
      try {
        response = await this.fetchOnce(path);
      } catch (error) {
        if (error instanceof BrightspaceFailure) throw error;
        if (attempt < this.retry.maxRetries) {
          await this.sleep(this.backoff(attempt));
          attempt++;
          continue;
        }
        fail({ kind: "network", retryable: true, operation });
      }
      const outcome = classifyResponse(response!, operation, this.now());
      if (outcome.type === "ok") return response!;
      if (outcome.type === "retry") {
        if (attempt >= this.retry.maxRetries) throw new BrightspaceFailure(outcome.exhausted);
        await this.sleep(outcome.delayMs ?? this.backoff(attempt));
        attempt++;
        continue;
      }
      throw new BrightspaceFailure(outcome.error);
    }
  }

  private async fetchOnce(path: ApprovedBrightspacePath): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.rawFetch(path, { signal: controller.signal });
      this.lastRateLimit = response.headers;
      if (response.headers.rateLimitRemaining !== null) this.onRateLimit?.(response.headers);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  private backoff(attempt: number): number {
    const exponential = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** attempt);
    const jitter = exponential * 0.25 * this.random();
    return Math.round(exponential + jitter);
  }
}

/** Builds a sanitized `RawResponse` from a Fetch API response. Never reads cookies or auth headers. */
export const toRawResponse = async (response: Response): Promise<RawResponse> => {
  const contentType = response.headers.get("content-type");
  const isJsonType = (contentType ?? "").toLowerCase().includes("json");
  let body: unknown = null;
  let isJson = false;
  if (isJsonType) {
    try {
      body = await response.json();
      isJson = true;
    } catch {
      body = null;
    }
  } else {
    // Drain the body without retaining HTML.
    await response.text().catch(() => "");
  }
  let finalPath: string | null = null;
  try {
    finalPath = response.url ? new URL(response.url).pathname : null;
  } catch {
    finalPath = null;
  }
  return {
    status: response.status,
    contentType,
    isJson,
    body,
    redirected: response.redirected,
    finalPath,
    headers: {
      retryAfter: response.headers.get("retry-after"),
      rateLimitRemaining: response.headers.get("x-rate-limit-remaining"),
      rateLimitReset: response.headers.get("x-rate-limit-reset"),
    },
  };
};

/**
 * Same-origin credentialed fetch for use inside a page on the tenant origin
 * (the content script). Cookies stay in the browser; this code never touches
 * them.
 */
export const createSameOriginFetcher = (tenantOrigin: string, fetchImpl: typeof fetch = fetch): RawFetch => {
  const origin = new URL(tenantOrigin).origin;
  return async (path, { signal }) => {
    if (!isApprovedBrightspacePath(path, origin)) fail({ kind: "unsafe-path", path: String(path) });
    const response = await fetchImpl(`${origin}${path}`, {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "application/json" },
      signal,
    });
    return toRawResponse(response);
  };
};

/** Used only after the feasibility probe succeeds. */
export class SameOriginSessionTransport extends SessionTransport {
  constructor(tenantOrigin: string, options: Omit<SessionTransportOptions, "tenantOrigin"> & { fetch?: typeof fetch } = {}) {
    super(createSameOriginFetcher(tenantOrigin, options.fetch), { ...options, tenantOrigin });
  }
}

export type FixtureResolver = (path: ApprovedBrightspacePath) => RawResponse | unknown | undefined;

export const jsonResponse = (body: unknown, status = 200): RawResponse => ({
  status,
  contentType: "application/json; charset=utf-8",
  isJson: status < 400 || body !== null,
  body,
  redirected: false,
  finalPath: null,
  headers: { retryAfter: null, rateLimitRemaining: null, rateLimitReset: null },
});

export const htmlResponse = (status = 200, finalPath: string | null = "/d2l/login", redirected = true): RawResponse => ({
  status,
  contentType: "text/html; charset=utf-8",
  isJson: false,
  body: null,
  redirected,
  finalPath,
  headers: { retryAfter: null, rateLimitRemaining: null, rateLimitReset: null },
});

const isRawResponse = (value: unknown): value is RawResponse =>
  typeof value === "object" && value !== null && "status" in value && "isJson" in value && "headers" in value;

/**
 * Always available for development, demo mode, and automated tests. Applies the
 * same error mapping as the live transport so fixture-driven error states are
 * faithful.
 */
export class FixtureTransport implements BrightspaceTransport {
  readonly requests: ApprovedBrightspacePath[] = [];
  private readonly inner: SessionTransport;

  constructor(
    private readonly resolver: FixtureResolver,
    options: SessionTransportOptions = {},
  ) {
    this.inner = new SessionTransport(
      async (path) => {
        this.requests.push(path);
        const resolved = this.resolver(path);
        if (resolved === undefined) return jsonResponse({ Errors: [{ Message: "fixture missing" }] }, 404);
        return isRawResponse(resolved) ? resolved : jsonResponse(resolved);
      },
      { sleep: async () => {}, retry: { baseDelayMs: 0, maxDelayMs: 0 }, ...options },
    );
  }

  getJson<T>(path: ApprovedBrightspacePath, schema: Schema<T>): Promise<T> {
    return this.inner.getJson(path, schema);
  }
}

/** Convenience: a resolver backed by an exact-path map. */
export const mapResolver = (map: Record<string, RawResponse | unknown>): FixtureResolver => (path) => map[path];
