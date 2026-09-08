import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BrightspaceFailure,
  SessionTransport,
  htmlResponse,
  jsonResponse,
  routes,
  type RawFetch,
  type RawResponse,
} from "@nova-agent/brightspace";

const TENANT = "https://brightspace.villanova.edu";
const schema = z.object({ ok: z.boolean() });

const sequence = (responses: (RawResponse | Error)[]): { fetch: RawFetch; calls: number } => {
  const state = { calls: 0 };
  const fetch: RawFetch = async () => {
    const next = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    if (next instanceof Error) throw next;
    return next as RawResponse;
  };
  return { fetch, get calls() { return state.calls; } } as { fetch: RawFetch; calls: number };
};

const transportFor = (fetch: RawFetch, sleep = vi.fn(async () => {})) =>
  new SessionTransport(fetch, { tenantOrigin: TENANT, sleep, random: () => 0, now: () => new Date("2026-09-08T12:00:00Z") });

const failureKind = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "none";
  } catch (error) {
    return error instanceof BrightspaceFailure ? error.error.kind : "other";
  }
};

describe("SessionTransport", () => {
  it("returns validated JSON", async () => {
    const source = sequence([jsonResponse({ ok: true, Extra: "ignored" })]);
    const result = await transportFor(source.fetch).getJson(routes.versions(), schema);
    expect(result).toEqual({ ok: true });
  });

  it("refuses paths that are not on the allowlist", async () => {
    const source = sequence([jsonResponse({ ok: true })]);
    const kind = await failureKind(transportFor(source.fetch).getJson("/d2l/api/lp/1.0/users/1" as never, schema));
    expect(kind).toBe("unsafe-path");
    expect(source.calls).toBe(0);
  });

  it("honors Retry-After exactly on 429 and then succeeds", async () => {
    const limited = { ...jsonResponse(null, 429), headers: { retryAfter: "7", rateLimitRemaining: "0", rateLimitReset: null } };
    const source = sequence([limited, jsonResponse({ ok: true })]);
    const sleep = vi.fn(async () => {});
    const result = await transportFor(source.fetch, sleep).getJson(routes.versions(), schema);
    expect(result).toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledWith(7000);
  });

  it("parses HTTP-date Retry-After relative to now", async () => {
    const limited = { ...jsonResponse(null, 429), headers: { retryAfter: "Tue, 08 Sep 2026 12:00:30 GMT", rateLimitRemaining: null, rateLimitReset: null } };
    const source = sequence([limited, jsonResponse({ ok: true })]);
    const sleep = vi.fn(async () => {});
    await transportFor(source.fetch, sleep).getJson(routes.versions(), schema);
    expect(sleep).toHaveBeenCalledWith(30000);
  });

  it("surfaces rate-limited when 429 has no Retry-After", async () => {
    const source = sequence([jsonResponse(null, 429)]);
    expect(await failureKind(transportFor(source.fetch).getJson(routes.versions(), schema))).toBe("rate-limited");
  });

  it("retries network failures and 5xx at most three times with backoff", async () => {
    const source = sequence([new Error("ECONNRESET"), jsonResponse(null, 503), jsonResponse(null, 502), jsonResponse(null, 500)]);
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });
    expect(await failureKind(transportFor(source.fetch, sleep).getJson(routes.versions(), schema))).toBe("network");
    expect(source.calls).toBe(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("recovers when a retry succeeds", async () => {
    const source = sequence([jsonResponse(null, 503), jsonResponse({ ok: true })]);
    expect(await transportFor(source.fetch).getJson(routes.versions(), schema)).toEqual({ ok: true });
    expect(source.calls).toBe(2);
  });

  it("never retries 401 or 403", async () => {
    const unauthorized = sequence([jsonResponse(null, 401), jsonResponse({ ok: true })]);
    expect(await failureKind(transportFor(unauthorized.fetch).getJson(routes.versions(), schema))).toBe("session-expired");
    expect(unauthorized.calls).toBe(1);

    const forbidden = sequence([jsonResponse(null, 403), jsonResponse({ ok: true })]);
    expect(await failureKind(transportFor(forbidden.fetch).getJson(routes.versions(), schema))).toBe("permission-denied");
    expect(forbidden.calls).toBe(1);
  });

  it("treats a login HTML page as session expiration, not a parse error", async () => {
    const source = sequence([htmlResponse(200, "/d2l/login", true)]);
    expect(await failureKind(transportFor(source.fetch).getJson(routes.versions(), schema))).toBe("session-expired");
  });

  it("treats unredirected HTML at 200 as session expiration too", async () => {
    const source = sequence([htmlResponse(200, "/d2l/api/versions/", false)]);
    expect(await failureKind(transportFor(source.fetch).getJson(routes.versions(), schema))).toBe("session-expired");
  });

  it("does not retry validation failures", async () => {
    const source = sequence([jsonResponse({ ok: "nope" }), jsonResponse({ ok: true })]);
    expect(await failureKind(transportFor(source.fetch).getJson(routes.versions(), schema))).toBe("invalid-response");
    expect(source.calls).toBe(1);
  });

  it("maps 404 to not-found without retrying", async () => {
    const source = sequence([jsonResponse(null, 404), jsonResponse({ ok: true })]);
    expect(await failureKind(transportFor(source.fetch).getJson(routes.versions(), schema))).toBe("not-found");
    expect(source.calls).toBe(1);
  });

  it("aborts a hanging request after the timeout and retries", async () => {
    let aborted = 0;
    const fetch: RawFetch = (_path, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted++;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
        if (aborted >= 1) resolve(jsonResponse({ ok: true }));
      });
    const transport = new SessionTransport(fetch, { tenantOrigin: TENANT, timeoutMs: 5, sleep: async () => {}, random: () => 0 });
    expect(await transport.getJson(routes.versions(), schema)).toEqual({ ok: true });
    expect(aborted).toBe(1);
  });
});
