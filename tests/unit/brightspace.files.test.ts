import {
  ATTACHMENT_CAP_BYTES,
  BrightspaceClient,
  DEMO_LE_VERSION,
  FileFetchError,
  FixtureTransport,
  HARD_FILE_CAP_BYTES,
  attachmentsOf,
  base64ToBytes,
  buildDemoTenant,
  bytesToBase64,
  createSameOriginFileFetcher,
  demoFileFetch,
  demoResolver,
  dropboxFoldersSchema,
  fetchFile,
  isApprovedFilePath,
  minimalPdf,
  mySubmissionsSchema,
  routes,
  validateApprovedPath,
  type ApprovedBrightspacePath,
  type RawFileFetch,
  type RawFileResponse,
} from "@nova-agent/brightspace";
import { describe, expect, it } from "vitest";
import { parseMessage, BRIDGE_FILE_CAP_BYTES } from "../../apps/extension/src/messaging/protocol";
import { fileBridgeResultSchema } from "../../apps/extension/src/messaging/bridgeSchemas";
import { NOW, TENANT } from "../helpers/demoDashboard";

const LE = DEMO_LE_VERSION;
const ATTACHMENT = routes.dropboxAttachment(LE, "31001", "4101", "9101");
const SUBMISSION = routes.submissionFile(LE, "31001", "4104", "1", "9104");

describe("file routes", () => {
  it("allows exactly the two download shapes, by ids, with no query string", () => {
    expect(ATTACHMENT).toBe("/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/9101");
    expect(SUBMISSION).toBe("/d2l/api/le/1.79/31001/dropbox/folders/4104/submissions/1/files/9104");
    expect(validateApprovedPath(ATTACHMENT)?.operation).toBe("dropboxAttachment");
    expect(validateApprovedPath(SUBMISSION)?.operation).toBe("submissionFile");
    expect(isApprovedFilePath(ATTACHMENT)).toBe(true);
    expect(isApprovedFilePath(SUBMISSION, TENANT)).toBe(true);
    for (const bad of [
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/",
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/9101/",
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/9101?stream=true",
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/abc",
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/../9101",
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/submissions/1/files/",
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/submissions/",
      "/d2l/api/le/1.79/31001/dropbox/folders/4101/submissions/1/files/9104/extra",
      "/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=31001&db=4101",
      "https://evil.example/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/9101",
    ]) {
      expect(isApprovedFilePath(bad, TENANT)).toBe(false);
    }
    // A JSON route is approved, but it is not a file route.
    expect(isApprovedFilePath(routes.dropboxFolders(LE, "31001"))).toBe(false);
    expect(() => routes.dropboxAttachment(LE, "31001", "4101", "9101; rm")).toThrow();
    expect(() => routes.submissionFile(LE, "31001", "4104", "x", "9104")).toThrow();
  });
});

describe("file lists in Brightspace payloads", () => {
  it("keeps attachments and submitted files, and drops a malformed list without losing the assignment", () => {
    const folder = { Id: 1, Name: "Lab", DueDate: null, Attachments: [{ FileId: 7, FileName: "handout.pdf", Size: 2048 }, { FileId: "8", FileName: "notes.txt" }] };
    const parsed = dropboxFoldersSchema.parse([folder, { ...folder, Id: 2, Attachments: "nope" }, { ...folder, Id: 3, Attachments: [{ FileName: "no id" }] }, { Id: 4, Name: "Bare", DueDate: null }]);
    expect(parsed[0]?.Attachments).toEqual([{ FileId: "7", FileName: "handout.pdf", Size: 2048 }, { FileId: "8", FileName: "notes.txt" }]);
    expect(parsed[1]).toMatchObject({ Id: "2", Name: "Lab" });
    expect(parsed[1]?.Attachments).toBeUndefined();
    expect(parsed[2]?.Attachments).toBeUndefined();
    expect(parsed[3]?.Attachments).toBeUndefined();
    const submissions = mySubmissionsSchema.parse([{ Status: 1, CompletionDate: null, Submissions: [{ Id: 5, SubmissionDate: null, Files: [{ FileId: 9, FileName: "report.docx", Size: 10 }] }, { Id: 6, SubmissionDate: null, Files: 3 }] }]);
    expect(submissions[0]?.Submissions[0]?.Files).toEqual([{ FileId: "9", FileName: "report.docx", Size: 10 }]);
    expect(submissions[0]?.Submissions[1]?.Files).toBeUndefined();
  });

  it("normalizes instructor files first, then the student's, and drops unusable entries", () => {
    const folder = dropboxFoldersSchema.parse([{ Id: 1, Name: "Lab", DueDate: null, Attachments: [{ FileId: 7, FileName: "  handout.pdf  ", Size: 2048 }, { FileId: "x7", FileName: "bad id" }, { FileId: 8, FileName: "   " }, { FileId: 9, FileName: "n".repeat(300), Size: -5 }] }])[0]!;
    const submission = mySubmissionsSchema.parse([{ Status: 1, CompletionDate: null, Submissions: [{ Id: 5, SubmissionDate: null, Files: [{ FileId: 11, FileName: "report.docx", Size: 10 }] }, { SubmissionDate: null, Files: [{ FileId: 12, FileName: "orphan.txt" }] }] }])[0]!;
    const files = attachmentsOf(folder, { kind: "known", submission });
    expect(files).toEqual([
      { id: "7", name: "handout.pdf", size: 2048, source: "instructor" },
      { id: "9", name: "n".repeat(200), size: null, source: "instructor" },
      { id: "11", name: "report.docx", size: 10, source: "submission", submissionId: "5" },
    ]);
    expect(attachmentsOf(folder, { kind: "unavailable" }).every((file) => file.source === "instructor")).toBe(true);
    const many = dropboxFoldersSchema.parse([{ Id: 1, Name: "Lab", DueDate: null, Attachments: Array.from({ length: 40 }, (_, i) => ({ FileId: i + 1, FileName: `f${i}.txt` })) }])[0]!;
    expect(attachmentsOf(many, { kind: "unavailable" })).toHaveLength(20);
  });

  it("puts the demo tenant's files on its items through a normal refresh, and no file on a quiz", async () => {
    const client = new BrightspaceClient(new FixtureTransport(demoResolver(buildDemoTenant(NOW))), { tenantOrigin: TENANT, now: () => NOW });
    const state = await client.loadAcademicState();
    const byTitle = (title: string) => state.items.find((item) => item.title === title);
    expect(byTitle("Lab 3: Timer Interrupts")?.attachments).toEqual([{ id: "9101", name: "Lab 3 handout.pdf", size: expect.any(Number), source: "instructor" }]);
    expect(byTitle("Project Proposal")?.attachments?.[0]).toMatchObject({ name: "Proposal rubric.txt", source: "instructor" });
    expect(byTitle("Lab 1: Toolchain Setup")?.attachments).toEqual([{ id: "9104", name: "lab1-report.txt", size: expect.any(Number), source: "submission", submissionId: "1" }]);
    expect(byTitle("Lab 2: GPIO and Debouncing")?.attachments).toBeUndefined();
    expect(state.items.filter((item) => item.kind === "quiz").every((item) => item.attachments === undefined)).toBe(true);
  });
});

const fileResponse = (overrides: Partial<RawFileResponse> = {}): RawFileResponse => ({ status: 200, contentType: "text/plain", redirected: false, finalPath: null, size: 5, base64: bytesToBase64(new TextEncoder().encode("hello")), tooLarge: false, headers: { retryAfter: null, rateLimitRemaining: null, rateLimitReset: null }, ...overrides });

describe("fetchFile", () => {
  const through = (response: RawFileResponse | Error): RawFileFetch => async () => {
    if (response instanceof Error) throw response;
    return response;
  };
  const reason = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof FileFetchError) return error.reason;
      throw error;
    }
    throw new Error("expected a failure");
  };

  it("returns the bytes of an approved file", async () => {
    const file = await fetchFile(through(fileResponse()), ATTACHMENT, { tenantOrigin: TENANT });
    expect(new TextDecoder().decode(file.bytes)).toBe("hello");
    expect(file).toMatchObject({ contentType: "text/plain", size: 5 });
  });

  it("maps every failure to a reason, and never asks for a path that is not a file route", async () => {
    expect(await reason(fetchFile(through(fileResponse({ status: 401, base64: null })), ATTACHMENT))).toBe("session-expired");
    expect(await reason(fetchFile(through(fileResponse({ status: 200, finalPath: "/d2l/login", redirected: true })), ATTACHMENT))).toBe("session-expired");
    expect(await reason(fetchFile(through(fileResponse({ status: 403, base64: null })), ATTACHMENT))).toBe("permission-denied");
    expect(await reason(fetchFile(through(fileResponse({ status: 404, base64: null })), ATTACHMENT))).toBe("not-found");
    expect(await reason(fetchFile(through(fileResponse({ status: 429, base64: null })), ATTACHMENT))).toBe("rate-limited");
    expect(await reason(fetchFile(through(fileResponse({ tooLarge: true, base64: null })), ATTACHMENT))).toBe("too-large");
    expect(await reason(fetchFile(through(fileResponse({ status: 500, base64: null })), ATTACHMENT))).toBe("network");
    expect(await reason(fetchFile(through(fileResponse({ base64: null })), ATTACHMENT))).toBe("network");
    expect(await reason(fetchFile(through(fileResponse({ base64: "%%% not base64 %%%" })), ATTACHMENT))).toBe("network");
    expect(await reason(fetchFile(through(new Error("offline")), ATTACHMENT))).toBe("network");
    let asked = false;
    const spy: RawFileFetch = async () => {
      asked = true;
      return fileResponse();
    };
    expect(await reason(fetchFile(spy, routes.dropboxFolders(LE, "31001")))).toBe("unsafe-path");
    expect(await reason(fetchFile(spy, "/d2l/home/31001" as ApprovedBrightspacePath))).toBe("unsafe-path");
    expect(asked).toBe(false);
    // An HTML file is a file, not a login page, unless the request ended on the login path.
    const html = await fetchFile(through(fileResponse({ contentType: "text/html" })), ATTACHMENT);
    expect(html.contentType).toBe("text/html");
  });

  it("asks for the attachment cap by default and never more than the hard cap", async () => {
    const seen: number[] = [];
    const spy: RawFileFetch = async (_path, options) => {
      seen.push(options.maxBytes);
      return fileResponse();
    };
    await fetchFile(spy, ATTACHMENT);
    await fetchFile(spy, ATTACHMENT, { maxBytes: 999_999_999 });
    await fetchFile(spy, ATTACHMENT, { maxBytes: 1024 });
    expect(seen).toEqual([ATTACHMENT_CAP_BYTES, HARD_FILE_CAP_BYTES, 1024]);
  });
});

describe("createSameOriginFileFetcher", () => {
  const signal = new AbortController().signal;
  const serving = (body: Uint8Array | null, init: ResponseInit & { url?: string } = {}) => {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, requestInit: RequestInit) => {
      requests.push({ url, init: requestInit });
      const response = new Response(body as BodyInit | null, init);
      Object.defineProperty(response, "url", { value: init.url ?? url });
      return response;
    }) as unknown as typeof fetch;
    return { fetcher: createSameOriginFileFetcher(TENANT, fetchImpl), requests };
  };

  it("fetches with the session, as a GET, and returns the bytes as base64", async () => {
    const bytes = minimalPdf([["hello"]]);
    const { fetcher, requests } = serving(bytes, { status: 200, headers: { "content-type": "application/pdf", "content-length": String(bytes.length) } });
    const response = await fetcher(ATTACHMENT, { signal, maxBytes: ATTACHMENT_CAP_BYTES });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${TENANT}${ATTACHMENT}`);
    expect(requests[0]?.init).toMatchObject({ method: "GET", credentials: "include" });
    expect(response).toMatchObject({ status: 200, contentType: "application/pdf", size: bytes.length, tooLarge: false });
    expect(base64ToBytes(response.base64 as string)).toEqual(bytes);
  });

  it("refuses a path that is not a file route before making any request", async () => {
    const { fetcher, requests } = serving(new Uint8Array(1));
    await expect(fetcher(routes.dropboxFolders(LE, "31001"), { signal, maxBytes: 10 })).rejects.toThrow(/allowlist/);
    await expect(fetcher("/d2l/api/le/1.79/31001/dropbox/folders/4101/attachments/9101?x=1" as ApprovedBrightspacePath, { signal, maxBytes: 10 })).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("does not read a body over the cap, whether the size is declared or only found while streaming", async () => {
    const big = new Uint8Array(5000).fill(65);
    const declared = await serving(big, { status: 200, headers: { "content-length": "5000" } }).fetcher(ATTACHMENT, { signal, maxBytes: 1000 });
    expect(declared).toMatchObject({ tooLarge: true, base64: null, size: 5000 });
    const undeclared = await serving(big, { status: 200 }).fetcher(ATTACHMENT, { signal, maxBytes: 1000 });
    expect(undeclared).toMatchObject({ tooLarge: true, base64: null });
    const exact = await serving(big, { status: 200 }).fetcher(ATTACHMENT, { signal, maxBytes: 5000 });
    expect(exact).toMatchObject({ tooLarge: false, size: 5000 });
  });

  it("returns only the status and size when asked for the headers, and no body for an error status", async () => {
    const head = await serving(new Uint8Array(300), { status: 200, headers: { "content-type": "application/pdf", "content-length": "300" } }).fetcher(ATTACHMENT, { signal, maxBytes: 1000, headOnly: true });
    expect(head).toMatchObject({ status: 200, contentType: "application/pdf", size: 300, base64: null, tooLarge: false });
    const denied = await serving(new TextEncoder().encode("<html>denied</html>"), { status: 403, headers: { "content-type": "text/html" } }).fetcher(ATTACHMENT, { signal, maxBytes: 1000 });
    expect(denied).toMatchObject({ status: 403, base64: null });
    const login = await serving(new TextEncoder().encode("<html>sign in</html>"), { status: 200, url: `${TENANT}/d2l/login?target=x` }).fetcher(ATTACHMENT, { signal, maxBytes: 1000 });
    expect(login.finalPath).toBe("/d2l/login");
  });

  it("round-trips bytes through base64, including a large buffer", () => {
    const bytes = new Uint8Array(200_000).map((_, index) => index % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(new Uint8Array(0))).toBe("");
  });
});

describe("demo files", () => {
  it("serves the demo tenant's files through the same shape as the bridge, capped, and nothing else", async () => {
    const fetch = demoFileFetch(buildDemoTenant(NOW));
    const signal = new AbortController().signal;
    const handout = await fetch(ATTACHMENT, { signal, maxBytes: ATTACHMENT_CAP_BYTES });
    expect(handout).toMatchObject({ status: 200, contentType: "application/pdf", tooLarge: false });
    expect(new TextDecoder().decode(base64ToBytes(handout.base64 as string)).startsWith("%PDF-1.4")).toBe(true);
    expect(await fetch(SUBMISSION, { signal, maxBytes: ATTACHMENT_CAP_BYTES })).toMatchObject({ status: 200, contentType: "text/plain; charset=utf-8" });
    expect(await fetch(ATTACHMENT, { signal, maxBytes: 10 })).toMatchObject({ tooLarge: true, base64: null });
    expect(await fetch(ATTACHMENT, { signal, maxBytes: ATTACHMENT_CAP_BYTES, headOnly: true })).toMatchObject({ status: 200, base64: null });
    expect(await fetch(routes.dropboxAttachment(LE, "31001", "4101", "1"), { signal, maxBytes: 10 })).toMatchObject({ status: 404 });
    expect(await fetch(routes.dropboxFolders(LE, "31001"), { signal, maxBytes: 10 })).toMatchObject({ status: 404, base64: null });
  });
});

describe("the file bridge message", () => {
  it("accepts a path with a positive whole cap up to the bridge limit, and nothing else", () => {
    expect(parseMessage({ type: "BRIGHTSPACE_FETCH_FILE", path: ATTACHMENT, maxBytes: 1000 })).toEqual({ type: "BRIGHTSPACE_FETCH_FILE", path: ATTACHMENT, maxBytes: 1000, headOnly: false });
    expect(parseMessage({ type: "BRIGHTSPACE_FETCH_FILE", path: ATTACHMENT, maxBytes: BRIDGE_FILE_CAP_BYTES, headOnly: true })).toMatchObject({ headOnly: true });
    for (const bad of [{ maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1.5 }, { maxBytes: BRIDGE_FILE_CAP_BYTES + 1 }, { maxBytes: "1000" }, { path: "" }, { path: 5 }, { path: "x".repeat(3000) }]) {
      expect(parseMessage({ type: "BRIGHTSPACE_FETCH_FILE", path: ATTACHMENT, maxBytes: 1000, ...bad })).toBeNull();
    }
    expect(BRIDGE_FILE_CAP_BYTES).toBe(HARD_FILE_CAP_BYTES);
  });

  it("validates what the bridge sends back", () => {
    expect(fileBridgeResultSchema.safeParse({ ok: true, response: fileResponse() }).success).toBe(true);
    expect(fileBridgeResultSchema.safeParse({ ok: false, reason: "timeout" }).success).toBe(true);
    expect(fileBridgeResultSchema.safeParse({ ok: true, response: { ...fileResponse(), base64: 5 } }).success).toBe(false);
    expect(fileBridgeResultSchema.safeParse({ ok: true, response: { ...fileResponse(), size: -1 } }).success).toBe(false);
    expect(fileBridgeResultSchema.safeParse({ ok: false, reason: "because" }).success).toBe(false);
  });
});

describe("probeFileRoute", () => {
  const signalFree = (response: Partial<RawFileResponse> | Error): RawFileFetch & { options: { maxBytes: number; headOnly?: boolean }[] } => {
    const options: { maxBytes: number; headOnly?: boolean }[] = [];
    const fetch: RawFileFetch = async (_path, given) => {
      options.push({ maxBytes: given.maxBytes, headOnly: given.headOnly });
      if (response instanceof Error) throw response;
      return fileResponse({ base64: null, ...response });
    };
    return Object.assign(fetch, { options });
  };

  it("asks for headers only and records the outcome, never a name, an id, or a body", async () => {
    const { probeFileRoute } = await import("@nova-agent/brightspace");
    const served = signalFree({ status: 200, contentType: "application/pdf", size: 4096 });
    expect(await probeFileRoute(served, "dropboxAttachment", ATTACHMENT)).toEqual({ operation: "dropboxAttachment", outcome: "ok", status: 200, contentType: "application/pdf", size: 4096 });
    expect(served.options).toEqual([{ maxBytes: 1, headOnly: true }]);
    expect(await probeFileRoute(signalFree({ status: 403 }), "submissionFile", SUBMISSION)).toMatchObject({ outcome: "permission-denied", status: 403 });
    expect(await probeFileRoute(signalFree({ status: 404 }), "dropboxAttachment", ATTACHMENT)).toMatchObject({ outcome: "not-found" });
    expect(await probeFileRoute(signalFree({ status: 401 }), "dropboxAttachment", ATTACHMENT)).toMatchObject({ outcome: "session-expired" });
    expect(await probeFileRoute(signalFree({ status: 200, finalPath: "/d2l/login" }), "dropboxAttachment", ATTACHMENT)).toMatchObject({ outcome: "session-expired" });
    expect(await probeFileRoute(signalFree({ status: 429 }), "dropboxAttachment", ATTACHMENT)).toMatchObject({ outcome: "rate-limited" });
    expect(await probeFileRoute(signalFree({ status: 500 }), "dropboxAttachment", ATTACHMENT)).toMatchObject({ outcome: "network" });
    expect(await probeFileRoute(signalFree(new Error("offline")), "dropboxAttachment", ATTACHMENT)).toEqual({ operation: "dropboxAttachment", outcome: "network", status: null, contentType: null, size: null });
    // Nothing to try is not a failure, and no way to ask is not "served".
    expect(await probeFileRoute(served, "submissionFile", null)).toMatchObject({ outcome: "not-tested", status: null });
    expect(await probeFileRoute(null, "dropboxAttachment", ATTACHMENT)).toMatchObject({ outcome: "network" });
  });

  it("checks the demo tenant's kinds of file and finds them served", async () => {
    const { probeFileRoute } = await import("@nova-agent/brightspace");
    const fetch = demoFileFetch(buildDemoTenant(NOW));
    expect(await probeFileRoute(fetch, "dropboxAttachment", ATTACHMENT)).toMatchObject({ outcome: "ok", contentType: "application/pdf" });
    expect(await probeFileRoute(fetch, "submissionFile", SUBMISSION)).toMatchObject({ outcome: "ok" });
    expect(await probeFileRoute(fetch, "contentTopicFile", routes.contentTopicFile(LE, "31001", "8104"))).toMatchObject({ outcome: "ok", contentType: "application/pdf" });
    // A link topic has no file: the route answers 404 and the check says so.
    expect(await probeFileRoute(fetch, "contentTopicFile", routes.contentTopicFile(LE, "31001", "8103"))).toMatchObject({ outcome: "not-found", status: 404 });
  });
});
