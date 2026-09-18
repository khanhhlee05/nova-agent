import { chatRequestSchema, compactSnapshotSchema, encodeSseFrame, parseSseStream, streamFromChunks, type CompactSnapshot, type SseFrame } from "@nova-agent/protocol";
import { describe, expect, it } from "vitest";

const collect = async (chunks: readonly string[], signal?: AbortSignal): Promise<SseFrame[]> => {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(streamFromChunks(chunks), signal)) frames.push(frame);
  return frames;
};

describe("parseSseStream", () => {
  it("parses frames split across chunk boundaries, including mid-line and mid-delimiter", async () => {
    const text = "event: text\ndata: {\"a\":1}\n\nevent: done\ndata: {}\n\n";
    const whole = await collect([text]);
    expect(whole).toEqual([
      { event: "text", data: '{"a":1}', id: null },
      { event: "done", data: "{}", id: null },
    ]);
    const pieces = [...text].map((char) => char);
    expect(await collect(pieces)).toEqual(whole);
    expect(await collect([text.slice(0, 14), text.slice(14, 27), text.slice(27)])).toEqual(whole);
  });

  it("handles CRLF, comments, ids, and multi-line data", async () => {
    const frames = await collect([": OPENROUTER PROCESSING\r\n\r\nid: 7\r\nevent: text\r\ndata: first\r\ndata: second\r\n\r\n"]);
    expect(frames).toEqual([{ event: "text", data: "first\nsecond", id: "7" }]);
  });

  it("flushes a trailing frame without a blank line and drops comment-only blocks", async () => {
    const frames = await collect(["data: [DONE]"]);
    expect(frames).toEqual([{ event: null, data: "[DONE]", id: null }]);
    expect(await collect([": keep-alive\n\n"])).toEqual([]);
  });

  it("stops when aborted", async () => {
    const controller = new AbortController();
    const frames: SseFrame[] = [];
    const chunks = ["data: one\n\n", "data: two\n\n", "data: three\n\n"];
    for await (const frame of parseSseStream(streamFromChunks(chunks), controller.signal)) {
      frames.push(frame);
      controller.abort();
    }
    expect(frames.map((frame) => frame.data)).toEqual(["one"]);
  });

  it("round-trips encodeSseFrame", async () => {
    const encoded = encodeSseFrame({ event: "tool_result", data: '{"x":"y"}', id: "3" });
    expect(await collect([encoded])).toEqual([{ event: "tool_result", data: '{"x":"y"}', id: "3" }]);
  });
});

const minimalSnapshot = (): CompactSnapshot => ({
  version: 2,
  mode: "demo",
  now: "2026-09-08T18:00:00.000Z",
  timezone: "America/New_York",
  capturedAt: "2026-09-08T17:55:00.000Z",
  isComplete: true,
  failedCourseIds: [],
  courses: [{ id: "31001", name: "Microcontrollers", code: "ECE 3010", homeUrl: "https://brightspace.villanova.edu/d2l/home/31001", active: true }],
  items: [
    {
      id: "a4101",
      courseId: "31001",
      kind: "assignment",
      title: "Lab 3: Timer Interrupts",
      dueAt: "2026-09-11T03:59:00.000Z",
      dueLocal: "Thu, Sep 10, 11:59 PM",
      dueDate: "2026-09-10",
      bucket: "this-week",
      status: "not-started",
      visibility: "visible",
      pointsPossible: 100,
      url: "https://brightspace.villanova.edu/d2l/lms/dropbox/user/folder_submit_files.d2l?ou=31001&db=4101",
      priority: 72,
      reasons: ["Due in 2 days"],
    },
  ],
  announcements: [],
  changes: [],
  counts: { overdue: 0, today: 0, thisWeek: 1, unread: 0, activeItems: 1 },
  calendar: { today: "2026-09-08", weekStart: "2026-09-07", thisWeek: { from: "2026-09-08", to: "2026-09-14" }, nextWeek: { from: "2026-09-14", to: "2026-09-20" } },
});

describe("chat request schema", () => {
  it("accepts a well-formed request", () => {
    const parsed = chatRequestSchema.safeParse({ message: "What is due?", history: [], snapshot: minimalSnapshot(), client: { name: "nova-extension", version: "0.1.0" } });
    expect(parsed.success).toBe(true);
  });

  it("accepts version 2 only, so an older extension gets a clear bad_request", () => {
    expect(compactSnapshotSchema.safeParse({ ...minimalSnapshot(), version: 1 }).success).toBe(false);
    expect(compactSnapshotSchema.safeParse(minimalSnapshot()).success).toBe(true);
    const { calendar: _calendar, ...withoutCalendar } = minimalSnapshot();
    void _calendar;
    expect(compactSnapshotSchema.safeParse(withoutCalendar).success).toBe(false);
  });

  it("rejects oversize arrays, bad urls, and unknown modes", () => {
    const base = minimalSnapshot();
    expect(compactSnapshotSchema.safeParse({ ...base, mode: "fixture" }).success).toBe(false);
    expect(compactSnapshotSchema.safeParse({ ...base, courses: [{ ...base.courses[0], homeUrl: "javascript:alert(1)" }] }).success).toBe(false);
    const item = base.items[0] as CompactSnapshot["items"][number];
    expect(compactSnapshotSchema.safeParse({ ...base, items: Array.from({ length: 201 }, (_, i) => ({ ...item, id: `a${i}` })) }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: "   ", history: [], snapshot: base, client: { name: "nova-extension", version: "0.1.0" } }).success).toBe(false);
    expect(compactSnapshotSchema.safeParse({ ...base, items: [{ ...item, dueDate: "2026-9-8" }] }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: "hi", history: Array.from({ length: 13 }, () => ({ role: "user", content: "x" })), snapshot: base, client: { name: "nova-extension", version: "0.1.0" } }).success).toBe(false);
  });
});
