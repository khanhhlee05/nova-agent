import { describe, expect, it } from "vitest";
import { bucketItems, classifyDeadline, deadlineWindow, workloadCounts } from "@nova-agent/core";
import { makeItem } from "../helpers/factories";

// TZ is pinned to America/New_York in vitest.config.ts.
const local = (iso: string): Date => new Date(iso);

describe("deadline buckets (local timezone)", () => {
  // Tuesday 2026-09-08 14:00 local (EDT, UTC-4).
  const now = local("2026-09-08T14:00:00-04:00");
  const at = (iso: string) => makeItem({ sourceId: iso, courseId: "1", dueAt: new Date(iso).toISOString() });

  it("classifies each bucket boundary", () => {
    expect(classifyDeadline(at("2026-09-08T13:59:59-04:00"), { now })).toBe("overdue");
    expect(classifyDeadline(at("2026-09-08T14:00:00-04:00"), { now })).toBe("today");
    expect(classifyDeadline(at("2026-09-08T23:59:59-04:00"), { now })).toBe("today");
    expect(classifyDeadline(at("2026-09-09T00:00:00-04:00"), { now })).toBe("tomorrow");
    expect(classifyDeadline(at("2026-09-09T23:59:59-04:00"), { now })).toBe("tomorrow");
    expect(classifyDeadline(at("2026-09-10T00:00:00-04:00"), { now })).toBe("this-week");
    expect(classifyDeadline(at("2026-09-13T23:59:59-04:00"), { now })).toBe("this-week");
    expect(classifyDeadline(at("2026-09-14T00:00:00-04:00"), { now })).toBe("later");
  });

  it("uses a Monday-start week that ends Sunday 23:59:59 local", () => {
    const window = deadlineWindow(now);
    expect(window.endOfWeekSunday.toISOString()).toBe(new Date("2026-09-13T23:59:59.999-04:00").toISOString());
    // On a Sunday, this-week is empty beyond today.
    const sunday = local("2026-09-13T10:00:00-04:00");
    expect(classifyDeadline(at("2026-09-13T22:00:00-04:00"), { now: sunday })).toBe("today");
    expect(classifyDeadline(at("2026-09-14T09:00:00-04:00"), { now: sunday })).toBe("tomorrow");
    expect(classifyDeadline(at("2026-09-15T09:00:00-04:00"), { now: sunday })).toBe("later");
  });

  it("puts no-date items in their own bucket and done items in completed", () => {
    expect(classifyDeadline(makeItem({ sourceId: "n", courseId: "1" }), { now })).toBe("no-date");
    expect(classifyDeadline(makeItem({ sourceId: "s", courseId: "1", status: "submitted", dueAt: "2026-09-01T00:00:00Z" }), { now })).toBe("completed");
    expect(classifyDeadline(makeItem({ sourceId: "c", courseId: "1", status: "completed", dueAt: "2026-09-08T15:00:00-04:00" }), { now })).toBe("completed");
  });

  it("handles the spring-forward DST day boundary", () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT. Saturday evening before.
    const saturday = local("2026-03-07T22:00:00-05:00");
    expect(classifyDeadline(at("2026-03-08T23:30:00-04:00"), { now: saturday })).toBe("tomorrow");
    expect(classifyDeadline(at("2026-03-09T00:30:00-04:00"), { now: saturday })).toBe("later"); // Monday of next week
    expect(classifyDeadline(at("2026-03-08T00:30:00-05:00"), { now: saturday })).toBe("tomorrow");
    expect(classifyDeadline(at("2026-03-07T23:59:00-05:00"), { now: saturday })).toBe("today");
  });

  it("handles the fall-back DST day boundary", () => {
    // 2026-11-01 02:00 EDT -> 01:00 EST. Sunday morning.
    const sunday = local("2026-11-01T00:30:00-04:00");
    expect(deadlineWindow(sunday).endOfToday.toISOString()).toBe(new Date("2026-11-01T23:59:59.999-05:00").toISOString());
    expect(classifyDeadline(at("2026-11-01T23:00:00-05:00"), { now: sunday })).toBe("today");
    expect(classifyDeadline(at("2026-11-02T00:10:00-05:00"), { now: sunday })).toBe("tomorrow");
    expect(classifyDeadline(at("2026-11-03T12:00:00-05:00"), { now: sunday })).toBe("later");
  });

  it("groups and counts consistently", () => {
    const items = [
      at("2026-09-07T10:00:00-04:00"),
      at("2026-09-08T20:00:00-04:00"),
      at("2026-09-09T20:00:00-04:00"),
      at("2026-09-12T20:00:00-04:00"),
      at("2026-09-20T20:00:00-04:00"),
      makeItem({ sourceId: "nodate", courseId: "1" }),
      makeItem({ sourceId: "done", courseId: "1", status: "submitted", dueAt: "2026-09-08T20:00:00-04:00" }),
    ];
    const buckets = bucketItems(items, { now });
    expect(Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]))).toEqual({
      overdue: 1,
      today: 1,
      tomorrow: 1,
      "this-week": 1,
      later: 1,
      "no-date": 1,
      completed: 1,
    });
    expect(workloadCounts(items, { now })).toEqual({ overdue: 1, today: 1, thisWeek: 3 });
  });
});
