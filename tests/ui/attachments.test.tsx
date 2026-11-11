// @vitest-environment jsdom
import "./setup";
import "fake-indexeddb/auto";
import { DEMO_LE_VERSION, FixtureTransport, buildDemoTenant, demoFileFetch, demoResolver, routes, type RawFileFetch } from "@nova-agent/brightspace";
import { ScriptedModel, demoRouter, shortId } from "@nova-agent/agent";
import type { AcademicItem, AcademicSnapshot, ItemAttachment } from "@nova-agent/core";
import { CLIENT_TOOL_LIMITS, clientToolResultSchema, encodeSseFrame, streamFromChunks, type AskEvent, type ChatRequest } from "@nova-agent/protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTACHMENT_FAILURE_COPY, attachmentBody, attachmentPath, formatBytes, readAttachment, type AttachmentDeps } from "../../apps/extension/src/files/attachments";
import type { PdfReader } from "../../apps/extension/src/files/extract";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { App } from "../../apps/extension/src/sidepanel/App";
import { ASK_SETTINGS_PREFERENCE, HttpAskClient, LocalAskClient, answerClientTool, availableClientTools, mergeRows, runReadAttachment, type AskSettings, type ReadAttachmentDeps } from "../../apps/extension/src/sidepanel/ask";
import { ItemFiles, type AttachmentControls } from "../../apps/extension/src/sidepanel/components/ItemFiles";
import { MissionControl } from "../../apps/extension/src/sidepanel/MissionControl";
import { createNovaDb, type AttachmentTextRecord, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { MAX_ATTACHMENT_TEXTS, attachmentTextId, clearAllData, getAttachmentText, getSyncStatus, listAttachmentTexts, putAttachmentText, setPreference } from "../../apps/extension/src/storage/repositories";
import { DATA_MODE_PREFERENCE, SyncCoordinator, type TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { askProps, baseProps, eventsClient } from "../helpers/askHarness";
import { NOW, TENANT, demoDashboard, demoSnapshot } from "../helpers/demoDashboard";

let db: NovaDb;
let snapshot: AcademicSnapshot;
const SCOPE = `${TENANT}|2001`;
const LONG = { timeout: 10_000 };

beforeEach(async () => {
  db = createNovaDb(`attachments-${Date.now()}-${Math.random()}`);
  snapshot = await demoSnapshot("baseline", NOW);
});

afterEach(async () => {
  cleanup();
  await db.delete();
});

const itemNamed = (title: string): AcademicItem => {
  const item = snapshot.items.find((candidate) => candidate.title === title);
  if (!item) throw new Error(`fixture changed: ${title}`);
  return item;
};
const fileOf = (item: AcademicItem): ItemAttachment => {
  const file = item.attachments?.[0];
  if (!file) throw new Error(`fixture changed: no file on ${item.title}`);
  return file;
};

/** A reader that returns fixed pages, so nothing here loads pdf.js. The real reader has its own test. */
const pages = (...text: string[]): PdfReader => async () => ({ ok: true, pages: text });

const deps = (overrides: Partial<AttachmentDeps> = {}): AttachmentDeps => ({
  db,
  scope: SCOPE,
  tenantOrigin: TENANT,
  fetchFile: demoFileFetch(buildDemoTenant(NOW)),
  leVersion: async () => DEMO_LE_VERSION,
  readPdf: pages("Lab 3: Timer Interrupts. Configure Timer1 in CTC mode.", "Deliverables: main.c and a timing diagram."),
  now: () => NOW,
  ...overrides,
});

const counting = (inner: RawFileFetch): RawFileFetch & { paths: string[] } => {
  const paths: string[] = [];
  const fetch: RawFileFetch = async (path, options) => {
    paths.push(path);
    return inner(path, options);
  };
  return Object.assign(fetch, { paths });
};

describe("readAttachment", () => {
  it("downloads once through the approved route, keeps the text and not the bytes, and answers from storage after that", async () => {
    const lab3 = itemNamed("Lab 3: Timer Interrupts");
    const fetchFile = counting(demoFileFetch(buildDemoTenant(NOW)));
    const first = await readAttachment(deps({ fetchFile }), lab3, fileOf(lab3));
    if (!first.ok) throw new Error(first.message);
    expect(fetchFile.paths).toEqual([routes.dropboxAttachment(DEMO_LE_VERSION, lab3.courseId, lab3.sourceId, "9101")]);
    expect(first).toMatchObject({ cached: false, record: { name: "Lab 3 handout.pdf", kind: "pdf", failure: null, truncated: false, scope: SCOPE, extractedAt: NOW.toISOString() } });
    expect(first.record.parts.map((part) => part.number)).toEqual([1, 2]);
    expect(first.record.bytes).toBe(fileOf(lab3).size);
    const stored = await getAttachmentText(db, lab3.key, "9101");
    expect(stored).toEqual(first.record);
    expect(JSON.stringify(stored)).not.toContain("%PDF");
    const second = await readAttachment(deps({ fetchFile }), lab3, fileOf(lab3));
    expect(second).toMatchObject({ ok: true, cached: true });
    expect(fetchFile.paths).toHaveLength(1);
    expect(attachmentBody(first.record)).toBe("[Page 1]\nLab 3: Timer Interrupts. Configure Timer1 in CTC mode.\n\n[Page 2]\nDeliverables: main.c and a timing diagram.");
  });

  it("reads a plain text rubric and the student's own submitted file through their own routes", async () => {
    const proposal = itemNamed("Project Proposal");
    const rubric = await readAttachment(deps(), proposal, fileOf(proposal));
    if (!rubric.ok) throw new Error(rubric.message);
    expect(rubric.record.kind).toBe("text");
    expect(attachmentBody(rubric.record)).toContain("Problem statement: 8 points.");
    const lab1 = itemNamed("Lab 1: Toolchain Setup");
    const fetchFile = counting(demoFileFetch(buildDemoTenant(NOW)));
    const report = await readAttachment(deps({ fetchFile }), lab1, fileOf(lab1));
    expect(report.ok && attachmentBody(report.record)).toContain("Installed avr-gcc 12.1");
    expect(fetchFile.paths).toEqual([routes.submissionFile(DEMO_LE_VERSION, lab1.courseId, lab1.sourceId, "1", "9104")]);
  });

  it("downloads again when the file is no longer the one it read", async () => {
    const lab3 = itemNamed("Lab 3: Timer Interrupts");
    const fetchFile = counting(demoFileFetch(buildDemoTenant(NOW)));
    await readAttachment(deps({ fetchFile }), lab3, fileOf(lab3));
    await readAttachment(deps({ fetchFile }), lab3, { ...fileOf(lab3), name: "Lab 3 handout v2.pdf" });
    expect(fetchFile.paths).toHaveLength(2);
    await readAttachment(deps({ fetchFile }), lab3, { ...fileOf(lab3), name: "Lab 3 handout v2.pdf", size: 1 });
    expect(fetchFile.paths).toHaveLength(3);
    // A size Brightspace does not state is not a reason to download again.
    await readAttachment(deps({ fetchFile }), lab3, { ...fileOf(lab3), name: "Lab 3 handout v2.pdf", size: null });
    expect(fetchFile.paths).toHaveLength(3);
  });

  it("remembers a file that gave no text, so it is not downloaded again for the same answer", async () => {
    const lab3 = itemNamed("Lab 3: Timer Interrupts");
    const fetchFile = counting(demoFileFetch(buildDemoTenant(NOW)));
    const scan = deps({ fetchFile, readPdf: pages("", "   ") });
    const first = await readAttachment(scan, lab3, fileOf(lab3));
    expect(first).toMatchObject({ ok: true, cached: false, record: { failure: "empty", kind: null, parts: [] } });
    expect(await readAttachment(scan, lab3, fileOf(lab3))).toMatchObject({ ok: true, cached: true, record: { failure: "empty" } });
    expect(fetchFile.paths).toHaveLength(1);
    expect(await readAttachment(deps({ fetchFile }), lab3, fileOf(lab3), { force: true })).toMatchObject({ ok: true, cached: false, record: { failure: null } });
  });

  it("says why a file could not be had, and stores nothing then", async () => {
    const lab3 = itemNamed("Lab 3: Timer Interrupts");
    const path = routes.dropboxAttachment(DEMO_LE_VERSION, lab3.courseId, lab3.sourceId, "9101");
    const failing = (override: object) => deps({ fetchFile: demoFileFetch(buildDemoTenant(NOW), { [path]: override }) });
    expect(await readAttachment(failing({ status: 403, base64: null }), lab3, fileOf(lab3))).toEqual({ ok: false, reason: "permission-denied", message: ATTACHMENT_FAILURE_COPY["permission-denied"] });
    expect(await readAttachment(failing({ status: 401, base64: null }), lab3, fileOf(lab3))).toMatchObject({ reason: "session-expired" });
    expect(await readAttachment(failing({ status: 404, base64: null }), lab3, fileOf(lab3))).toMatchObject({ reason: "not-found" });
    expect(await readAttachment(failing({ tooLarge: true, base64: null }), lab3, fileOf(lab3))).toMatchObject({ reason: "too-large" });
    expect(await readAttachment(deps({ fetchFile: null }), lab3, fileOf(lab3))).toMatchObject({ reason: "no-bridge" });
    expect(await readAttachment(deps({ leVersion: async () => null }), lab3, fileOf(lab3))).toMatchObject({ reason: "no-version" });
    expect(await readAttachment(deps(), lab3, { id: "9101", name: "x.pdf", size: null, source: "submission" })).toMatchObject({ reason: "bad-ids" });
    expect(await readAttachment(deps(), { ...lab3, sourceId: "not-a-number" }, fileOf(lab3))).toMatchObject({ reason: "bad-ids" });
    expect(await db.attachmentText.count()).toBe(0);
    expect(attachmentPath("1.79", lab3, { id: "../etc", name: "x", size: null, source: "instructor" })).toBeNull();
    expect([formatBytes(null), formatBytes(512), formatBytes(48_000), formatBytes(3_500_000)]).toEqual(["size unknown", "512 B", "47 KB", "3.3 MB"]);
  });
});

describe("attachment text storage", () => {
  const record = (n: number, scope = SCOPE): AttachmentTextRecord => ({ id: attachmentTextId(`key-${n}`, "1"), itemKey: `key-${n}`, fileId: "1", scope, name: `f${n}.txt`, kind: "text", parts: [{ number: null, text: `text ${n}` }], truncated: false, failure: null, bytes: 10, extractedAt: new Date(NOW.getTime() + n * 1000).toISOString() });

  it("keeps the newest fifty per account, replaces in place, and is wiped by Clear local Nova data", async () => {
    // Item keys carry the account, so two accounts never share a key.
    await putAttachmentText(db, { ...record(0, "other|scope"), id: attachmentTextId("other-key", "1"), itemKey: "other-key" });
    for (let n = 0; n < MAX_ATTACHMENT_TEXTS + 4; n++) await putAttachmentText(db, record(n));
    const mine = await listAttachmentTexts(db, SCOPE);
    expect(mine).toHaveLength(MAX_ATTACHMENT_TEXTS);
    expect(mine.some((entry) => entry.itemKey === "key-0" || entry.itemKey === "key-3")).toBe(false);
    expect(await listAttachmentTexts(db, "other|scope")).toHaveLength(1);
    await putAttachmentText(db, { ...record(10), name: "renamed.txt" });
    expect((await getAttachmentText(db, "key-10", "1"))?.name).toBe("renamed.txt");
    expect(await listAttachmentTexts(db, SCOPE)).toHaveLength(MAX_ATTACHMENT_TEXTS);
    expect(await getAttachmentText(db, "key-999", "1")).toBeNull();
    await clearAllData(db);
    expect(await db.attachmentText.count()).toBe(0);
  });
});

describe("runReadAttachment", () => {
  const handler = (overrides: Partial<ReadAttachmentDeps> = {}) => {
    const asked: unknown[] = [];
    const reads: string[] = [];
    const base: ReadAttachmentDeps = {
      items: snapshot.items,
      courseById: new Map(snapshot.courses.map((course) => [course.id, course])),
      texts: new Map(),
      allowed: () => true,
      askPermission: (request) => asked.push(request),
      read: async (item, attachment) => {
        reads.push(attachment.name);
        return readAttachment(deps(), item, attachment);
      },
      canOpen: (url) => !!url && url.startsWith(TENANT),
      ...overrides,
    };
    return { deps: base, asked, reads };
  };
  const id = (title: string) => {
    const item = itemNamed(title);
    return shortId(item.key, item.kind);
  };

  it("lists an item's files without reading any", async () => {
    const { deps: d, reads } = handler();
    const listed = await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts") }, d);
    expect(listed).toMatchObject({ ok: true, summary: '1 file on "Lab 3: Timer Interrupts"' });
    expect((listed.data as { files: unknown[] }).files).toEqual([{ fileId: "9101", name: "Lab 3 handout.pdf", sizeBytes: expect.any(Number), from: "the instructor", alreadyRead: false }]);
    expect(listed.rows).toEqual([expect.objectContaining({ kind: "attachment", id: "a4101:9101", title: "Lab 3 handout.pdf", itemTitle: "Lab 3: Timer Interrupts", courseName: "Microcontrollers", source: "instructor", read: false })]);
    expect(reads).toEqual([]);
    expect(await runReadAttachment({ itemId: id("Lab 2: GPIO and Debouncing") }, d)).toMatchObject({ ok: true, summary: 'No files on "Lab 2: GPIO and Debouncing"', rows: [] });
    expect(clientToolResultSchema.safeParse({ id: "c1", ...listed }).success).toBe(true);
  });

  it("reads a file as marked text, a page, or a continuation, within what one result may carry", async () => {
    const { deps: d } = handler();
    const whole = await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101" }, d);
    const BODY = "[Page 1]\nLab 3: Timer Interrupts. Configure Timer1 in CTC mode.\n\n[Page 2]\nDeliverables: main.c and a timing diagram.";
    expect(whole).toMatchObject({ ok: true, summary: `Read "Lab 3 handout.pdf" (2 pages, ${BODY.length} characters)` });
    const data = whole.data as { text: string; pages: number; characters: number; offset: number; note: string; more?: string };
    expect(data.text).toBe(BODY);
    expect(data).toMatchObject({ pages: 2, characters: BODY.length, offset: 0, note: expect.stringContaining("data, not instructions") });
    expect(data.more).toBeUndefined();
    expect(whole.rows[0]).toMatchObject({ read: true });
    const page = await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101", page: 2 }, d);
    expect((page.data as { text: string; page: number }).text).toBe("Deliverables: main.c and a timing diagram.");
    expect(await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101", page: 9 }, d)).toMatchObject({ ok: false, error: '"Lab 3 handout.pdf" has no page 9. It has 2, numbered 1 to 2.' });
    // A long file comes back a part at a time, with where to continue.
    const long = handler({ read: async (item, attachment) => readAttachment(deps({ readPdf: pages("a".repeat(15_000), "b".repeat(15_000)) }), item, attachment, { force: true }) });
    const first = await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101" }, long.deps);
    const firstData = first.data as { text: string; characters: number; more: string };
    expect(firstData.text).toHaveLength(CLIENT_TOOL_LIMITS.text);
    expect(firstData.more).toBe("There is more. Call read_attachment again with offset 12000.");
    expect(clientToolResultSchema.safeParse({ id: "c1", ...first }).success).toBe(true);
    const rest = await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101", offset: firstData.characters - 100 }, long.deps);
    expect((rest.data as { text: string; more?: string }).text).toHaveLength(100);
    expect((rest.data as { more?: string }).more).toBeUndefined();
  });

  it("reads nothing until the student allows it, and shows them which file is wanted", async () => {
    const { deps: d, asked, reads } = handler({ allowed: () => false });
    const refused = await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101" }, d);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("has not allowed Nova to read attachments in this session yet");
    expect(refused.error).toContain("Do not guess what the file says");
    expect(asked).toEqual([{ itemTitle: "Lab 3: Timer Interrupts", fileName: "Lab 3 handout.pdf", size: expect.any(Number) }]);
    expect(reads).toEqual([]);
    // Listing names is not reading, and needs no permission.
    expect(await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts") }, d)).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it("refuses ids it does not know and passes on why a read failed", async () => {
    const { deps: d } = handler();
    expect(await runReadAttachment({ itemId: "a999999", fileId: "1" }, d)).toMatchObject({ ok: false, error: expect.stringContaining('No item has id "a999999"') });
    expect(await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "1" }, d)).toMatchObject({ ok: false, error: expect.stringContaining("Its files: Lab 3 handout.pdf (9101)") });
    expect(await runReadAttachment({}, d)).toMatchObject({ ok: false, error: "itemId is missing." });
    expect(await runReadAttachment("junk", d)).toMatchObject({ ok: false });
    const denied = handler({ read: async () => ({ ok: false, reason: "permission-denied", message: ATTACHMENT_FAILURE_COPY["permission-denied"] }) });
    expect(await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101" }, denied.deps)).toMatchObject({ ok: false, error: 'Could not read "Lab 3 handout.pdf": Brightspace would not let Nova download this file.' });
    const scan = handler({ read: async (item, attachment) => readAttachment(deps({ readPdf: pages("") }), item, attachment, { force: true }) });
    expect(await runReadAttachment({ itemId: id("Lab 3: Timer Interrupts"), fileId: "9101" }, scan.deps)).toMatchObject({ ok: false, error: expect.stringContaining("has no text to read") });
  });

  it("is offered only when reading is on and files can be fetched", () => {
    expect(availableClientTools({ readAttachments: true, canFetchFiles: true })).toEqual(["read_attachment"]);
    expect(availableClientTools({ readAttachments: false, canFetchFiles: true })).toEqual([]);
    expect(availableClientTools({ readAttachments: true, canFetchFiles: false })).toEqual([]);
  });
});

describe("the panel's answer to a lookup", () => {
  it("always produces a result the server accepts, whatever the handler does", async () => {
    const signal = new AbortController().signal;
    expect(await answerClientTool(undefined, "c1", "read_attachment", {}, signal)).toMatchObject({ id: "c1", ok: false, error: "This panel cannot make that lookup." });
    expect(await answerClientTool({ clientTool: async () => Promise.reject(new Error("boom")) }, "c1", "read_attachment", {}, signal)).toMatchObject({ ok: false, error: "The panel hit a problem making that lookup." });
    const huge = await answerClientTool({ clientTool: async () => ({ ok: true, summary: "s".repeat(500), data: { text: "x".repeat(40_000) }, rows: [] }) }, "c1", "read_attachment", {}, signal);
    expect(huge).toMatchObject({ ok: false, data: null, error: "The result was too large to send." });
    expect(huge.summary).toHaveLength(CLIENT_TOOL_LIMITS.summary);
    expect(clientToolResultSchema.safeParse(huge).success).toBe(true);
  });

  it("posts the result to the turn's own address with the access code, and keeps the lookup out of the thread", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const sse = (events: AskEvent[]) => events.map((event) => encodeSseFrame({ event: event.type, data: JSON.stringify(event), id: null }));
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/chat")) {
        return new Response(
          streamFromChunks(
            sse([
              { type: "tool_call", id: "c1", name: "read_attachment", input: { itemId: "a4101" } },
              { type: "client_tool", turnId: "0123abcd-0000-4000-8000-000000000000", id: "c1", name: "read_attachment", input: { itemId: "a4101" } },
              { type: "tool_result", id: "c1", name: "read_attachment", ok: true, summary: "1 file", rows: [] },
              { type: "text", delta: "One file." },
              { type: "done", model: "m", usage: null, rounds: 2, grounded: true, corrected: false },
            ]),
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new HttpAskClient({ baseUrl: "https://nova.example/", token: "s3cret", fetch: fetchImpl });
    const seen: AskEvent[] = [];
    const inputs: unknown[] = [];
    for await (const event of client.ask({} as ChatRequest, new AbortController().signal, {
      clientTool: async (name, input) => {
        inputs.push([name, input]);
        return { ok: true, summary: "1 file", data: { files: [] }, rows: [] };
      },
    })) {
      seen.push(event);
    }
    expect(seen.map((event) => event.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(inputs).toEqual([["read_attachment", { itemId: "a4101" }]]);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.url).toBe("https://nova.example/v1/chat/0123abcd-0000-4000-8000-000000000000/tool-result");
    expect(calls[1]?.init.method).toBe("POST");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ id: "c1", ok: true, summary: "1 file", data: { files: [] }, rows: [] });
  });

  it("keeps one row per file, and the newer state of it", () => {
    const row = (read: boolean) => ({ kind: "attachment" as const, id: "a1:9", title: "f.pdf", itemId: "a1", itemTitle: "Item", courseId: "1", courseName: "C", fileId: "9", size: 1, source: "instructor" as const, read, url: null });
    const other = { ...row(false), id: "a1:10", fileId: "10" };
    expect(mergeRows([row(false), other], [row(true)])).toEqual([row(true), other]);
    expect(mergeRows([], [row(false), row(true), other])).toEqual([row(true), other]);
  });
});

describe("files in an item's details", () => {
  const controls = (overrides: Partial<AttachmentControls> = {}): AttachmentControls & { reads: string[] } => {
    const reads: string[] = [];
    return { texts: new Map(), busy: new Set(), errors: new Map(), onRead: (_item, attachment) => reads.push(attachment.name), reads, ...overrides };
  };

  it("lists the files by name, with Read only while Nova may read them", () => {
    const lab3 = itemNamed("Lab 3: Timer Interrupts");
    const view = render(<ItemFiles item={lab3} now={NOW} />);
    const section = screen.getByRole("region", { name: "Files" });
    expect(within(section).getByText("Lab 3 handout.pdf")).toBeTruthy();
    expect(within(section).getByText(/^From your instructor · \d+ (B|KB)$/)).toBeTruthy();
    expect(within(section).queryByRole("button")).toBeNull();
    const c = controls();
    view.rerender(<ItemFiles item={lab3} now={NOW} controls={c} />);
    fireEvent.click(screen.getByRole("button", { name: "Read Lab 3 handout.pdf" }));
    expect(c.reads).toEqual(["Lab 3 handout.pdf"]);
    expect(screen.getByText(/keeps its text on this device/i)).toBeTruthy();
    view.rerender(<ItemFiles item={itemNamed("Lab 1: Toolchain Setup")} now={NOW} controls={c} />);
    expect(screen.getByText(/^You handed this in · /)).toBeTruthy();
    view.rerender(<ItemFiles item={itemNamed("Lab 2: GPIO and Debouncing")} now={NOW} controls={c} />);
    expect(screen.queryByRole("region", { name: "Files" })).toBeNull();
  });

  it("shows reading, read, unreadable, and failed, each in words", async () => {
    const lab3 = itemNamed("Lab 3: Timer Interrupts");
    const key = `${lab3.key}#9101`;
    const view = render(<ItemFiles item={lab3} now={NOW} controls={controls({ busy: new Set([key]) })} />);
    const reading = screen.getByRole("button", { name: "Reading Lab 3 handout.pdf" }) as HTMLButtonElement;
    expect(reading.disabled).toBe(true);
    const outcome = await readAttachment(deps({ now: () => new Date(NOW.getTime() - 5 * 60_000) }), lab3, fileOf(lab3));
    if (!outcome.ok) throw new Error(outcome.message);
    view.rerender(<ItemFiles item={lab3} now={NOW} controls={controls({ texts: new Map([[key, outcome.record]]) })} />);
    expect(screen.getByText(`Read 5 minutes ago. ${attachmentBody(outcome.record).length} characters of text kept on this device.`)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<ItemFiles item={lab3} now={NOW} controls={controls({ texts: new Map([[key, { ...outcome.record, failure: "empty", parts: [], kind: null }]]) })} />);
    expect(screen.getByText(/no text nova can read\. it may be a scan/i)).toBeTruthy();
    view.rerender(<ItemFiles item={lab3} now={NOW} controls={controls({ errors: new Map([[key, ATTACHMENT_FAILURE_COPY["session-expired"]]]) })} />);
    expect(within(screen.getByRole("alert")).getByText(/sign in to brightspace, then try again/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Read Lab 3 handout.pdf" }).textContent).toBe("Try again");
  });

  it("appear in the expanded row on the Focus tab and call the same reader", async () => {
    const { dashboard, events } = await demoDashboard();
    const c = controls();
    render(<MissionControl {...baseProps({ dashboard, preferences: { ...baseProps().preferences, activeTab: "focus", focusCategory: "upcoming" }, ask: askProps(eventsClient([]), events), attachments: c })} />);
    fireEvent.click(screen.getByRole("button", { name: "Show details for Lab 3: Timer Interrupts" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Files" })).getByRole("button", { name: "Read Lab 3 handout.pdf" }));
    expect(c.reads).toEqual(["Lab 3 handout.pdf"]);
  });
});

describe("a file question from permission to answer: end to end", () => {
  const ask = (text: string) => {
    fireEvent.change(screen.getByRole("textbox", { name: /ask nova a question/i }), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: /send question/i }));
  };

  it("asks permission once, reads the file on the device, answers from it, and reads from storage the second time", { timeout: 30_000 }, async () => {
    await setPreference(db, ASK_SETTINGS_PREFERENCE, { enabled: true, apiBaseUrl: "http://localhost:8787", token: null } satisfies AskSettings);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    const fetchFile = counting(demoFileFetch(buildDemoTenant(NOW)));
    const seen: ChatRequest[] = [];
    const inner = new LocalAskClient(new ScriptedModel(demoRouter), { maxRounds: 4 });
    const spying = {
      ask: (request: ChatRequest, signal: AbortSignal, handlers?: Parameters<LocalAskClient["ask"]>[2]) => {
        seen.push(request);
        return inner.ask(request, signal, handlers);
      },
      health: () => inner.health(),
    };
    render(<App db={db} host={createStubHost()} now={() => NOW} transportFactory={factory} autoSync={false} askClientFactory={() => spying} fileFetchFactory={() => fetchFile} readPdf={pages("unused")} />);
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await waitFor(async () => expect((await getSyncStatus(db)).lastSuccessfulSyncAt).toBe(NOW.toISOString()), LONG);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Ask" }, LONG));
    await screen.findByRole("textbox", { name: /ask nova a question/i }, LONG);

    ask("What does the proposal rubric say?");
    // The panel offered the tool and sent file names, and nothing was read before the student agreed.
    const card = await screen.findByRole("region", { name: /permission to read a file/i }, LONG);
    expect(within(card).getByText("Proposal rubric.txt")).toBeTruthy();
    expect(card.textContent).toContain('from "Project Proposal"');
    expect(seen[0]?.clientTools).toEqual(["read_attachment"]);
    expect(seen[0]?.snapshot.items.find((item) => item.title === "Project Proposal")?.attachments?.[0]?.name).toBe("Proposal rubric.txt");
    expect(JSON.stringify(seen[0])).not.toContain("Problem statement: 8 points");
    expect(fetchFile.paths).toEqual([]);
    expect(await db.attachmentText.count()).toBe(0);
    // The lookup line speaks to the student; what the model was told stays out of the thread.
    await screen.findByText('Could not read the file: waiting for your permission to read "Proposal rubric.txt"', {}, LONG);
    await screen.findAllByText("I need your permission before I can read that file. Press Allow below and I will answer.", {}, LONG);
    expect(screen.queryByText(/do not guess what the file says/i)).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: /allow for this session/i }));
    // The same question is asked again, the file is read once, and the answer quotes it.
    await screen.findByText(/^Read "Proposal rubric\.txt" \(\d+ characters\)$/, {}, LONG);
    await screen.findAllByText(/Proposal rubric\.txt says: Project Proposal rubric \(25 points\) Problem statement: 8 points\./, {}, LONG);
    expect(screen.queryByRole("region", { name: /permission to read a file/i })).toBeNull();
    expect(fetchFile.paths).toHaveLength(1);
    expect(screen.getAllByText("What does the proposal rubric say?", { selector: ".ask-bubble" })).toHaveLength(1);
    const scope = (await getSyncStatus(db)).scope as string;
    expect((await listAttachmentTexts(db, scope)).map((record) => record.name)).toEqual(["Proposal rubric.txt"]);
    fireEvent.click(screen.getByRole("button", { name: "Show 1 matching item" }));
    expect(within(screen.getByRole("list", { name: /matching items/i })).getByText("Read on this device")).toBeTruthy();

    // A second question about the same file: no card, no download.
    ask("Remind me what the rubric says about the schedule");
    await waitFor(() => expect(screen.getAllByText(/^Read "Proposal rubric\.txt"/)).toHaveLength(2), LONG);
    expect(fetchFile.paths).toHaveLength(1);
    expect(screen.queryByRole("region", { name: /permission to read a file/i })).toBeNull();

    // The item's details show the file as read, with no Read button left.
    await user.click(screen.getByRole("tab", { name: "Focus" }));
    await user.click(await screen.findByRole("radio", { name: /^Upcoming/ }, LONG));
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Project Proposal" }, LONG));
    const files = await screen.findByRole("region", { name: "Files" }, LONG);
    expect(within(files).getByText(/characters of text kept on this device/)).toBeTruthy();
    expect(within(files).queryByRole("button")).toBeNull();
  });

  it("sends no file names and offers no tool once reading is turned off", { timeout: 30_000 }, async () => {
    await setPreference(db, ASK_SETTINGS_PREFERENCE, { enabled: true, apiBaseUrl: "http://localhost:8787", token: null, readAttachments: false } satisfies AskSettings);
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    const seen: ChatRequest[] = [];
    const inner = new LocalAskClient(new ScriptedModel(demoRouter));
    render(
      <App
        db={db}
        host={createStubHost()}
        now={() => NOW}
        transportFactory={factory}
        autoSync={false}
        fileFetchFactory={() => demoFileFetch(buildDemoTenant(NOW))}
        readPdf={pages("unused")}
        askClientFactory={() => ({
          ask: (request, signal, handlers) => {
            seen.push(request);
            return inner.ask(request, signal, handlers);
          },
          health: () => inner.health(),
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /explore with demo data/i }));
    await waitFor(async () => expect((await getSyncStatus(db)).lastSuccessfulSyncAt).toBe(NOW.toISOString()), LONG);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("tab", { name: "Ask" }, LONG));
    await screen.findByRole("textbox", { name: /ask nova a question/i }, LONG);
    ask("What does the proposal rubric say?");
    await screen.findByRole("group", { name: /follow-up questions/i }, LONG);
    expect(seen[0]?.clientTools).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toContain("rubric.txt");
    expect(screen.queryByRole("region", { name: /permission to read a file/i })).toBeNull();
    // The item still lists its file by name, with nothing to press.
    await user.click(screen.getByRole("tab", { name: "Focus" }));
    await user.click(await screen.findByRole("radio", { name: /^Upcoming/ }, LONG));
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Project Proposal" }, LONG));
    const files = await screen.findByRole("region", { name: "Files" }, LONG);
    expect(within(files).getByText("Proposal rubric.txt")).toBeTruthy();
    expect(within(files).queryByRole("button")).toBeNull();
  });

  it("checks whether Brightspace serves files and shows the outcome in the connection report", { timeout: 30_000 }, async () => {
    const factory: TransportFactory = (_mode, { now, demoScenario }) => new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)));
    const lab3Path = routes.dropboxAttachment(DEMO_LE_VERSION, "31001", "4101", "9101");
    // The instructor's file is denied; the student's own submitted file is served.
    const fetchFile = counting(demoFileFetch(buildDemoTenant(NOW), { [lab3Path]: { status: 403, base64: null } }));
    // A connected student: live mode, one refresh done, a connection report on file.
    const host = createStubHost();
    await setPreference(db, DATA_MODE_PREFERENCE, "live");
    await new SyncCoordinator({ db, host, now: () => NOW, transportFactory: factory }).sync("manual");
    await db.feasibility.put({ tenantOrigin: host.tenantOrigin, report: { probedAt: NOW.toISOString(), tenantOrigin: host.tenantOrigin, verdict: "live-ok", steps: [], selectedVersions: { lp: "1.47", le: DEMO_LE_VERSION }, activeEnrollmentCount: 4 } });
    render(<App db={db} host={host} now={() => NOW} transportFactory={factory} autoSync={false} askClientFactory={() => new LocalAskClient(new ScriptedModel(demoRouter))} fileFetchFactory={() => fetchFile} readPdf={pages("unused")} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /more options/i }, LONG));
    await user.click(await screen.findByRole("button", { name: /connection report/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/not checked yet/i)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /check file access/i }));
    const section = within(dialog).getByRole("region", { name: "File access" });
    await within(section).findByText("denied (403)", {}, LONG);
    expect(within(section).getByText("served")).toBeTruthy();
    expect(section.textContent).toContain("Instructor attachments");
    expect(section.textContent).toContain("Your submitted files");
    // Two header-only requests, one per kind of file, and nothing stored but the outcome.
    expect(fetchFile.paths).toHaveLength(2);
    expect(await db.attachmentText.count()).toBe(0);
    const stored = JSON.stringify(await db.preferences.get("files.access"));
    expect(stored).toContain("permission-denied");
    expect(stored).not.toContain("handout");
    expect(stored).not.toContain("9101");
    expect(screen.getByText("File access checked: Brightspace served 1 of 2 kinds of file.")).toBeTruthy();
  });
});
