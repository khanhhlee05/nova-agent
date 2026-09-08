import { describe, expect, it } from "vitest";
import {
  carryForwardKnownStatuses,
  dedupeEvents,
  diffSnapshots,
  snapshotsToPrune,
  type AcademicSnapshot,
} from "@nova-agent/core";
import { makeAnnouncement, makeItem, makeSnapshot } from "../helpers/factories";

const T0 = "2026-09-08T12:00:00.000Z";
const T1 = "2026-09-08T13:00:00.000Z";
const T2 = "2026-09-08T14:00:00.000Z";
const T3 = "2026-09-08T15:00:00.000Z";

const kinds = (events: ReturnType<typeof diffSnapshots>) => events.map((event) => event.kind).sort();

describe("semantic diff", () => {
  it("creates no events for the baseline snapshot", () => {
    const current = makeSnapshot(T0, [makeItem({ sourceId: "1", courseId: "c1" }), makeItem({ sourceId: "2", courseId: "c1" })]);
    expect(diffSnapshots({ current, history: [] })).toEqual([]);
  });

  it("detects a new item", () => {
    const previous = makeSnapshot(T0, [makeItem({ sourceId: "1", courseId: "c1" })]);
    const current = makeSnapshot(T1, [makeItem({ sourceId: "1", courseId: "c1" }), makeItem({ sourceId: "2", courseId: "c1", title: "New Lab" })]);
    const events = diffSnapshots({ current, history: [previous] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "item-added", courseId: "c1", after: { title: "New Lab", kind: "assignment" } });
  });

  it("does not flood when a newly enrolled course appears", () => {
    const previous = makeSnapshot(T0, [makeItem({ sourceId: "1", courseId: "c1" })]);
    const current = makeSnapshot(T1, [
      makeItem({ sourceId: "1", courseId: "c1" }),
      makeItem({ sourceId: "9", courseId: "c9" }),
      makeItem({ sourceId: "10", courseId: "c9" }),
    ]);
    expect(diffSnapshots({ current, history: [previous] })).toEqual([]);
  });

  it("detects a deadline move with old and new dates", () => {
    const before = makeItem({ sourceId: "1", courseId: "c1", dueAt: "2026-09-10T03:59:00.000Z" });
    const after = { ...before, dueAt: "2026-09-11T03:59:00.000Z" };
    const events = diffSnapshots({ current: makeSnapshot(T1, [after]), history: [makeSnapshot(T0, [before])] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "due-date-changed", before: { dueAt: "2026-09-10T03:59:00.000Z" }, after: { dueAt: "2026-09-11T03:59:00.000Z" } });
  });

  it("ignores harmless differences", () => {
    const before = makeItem({ sourceId: "1", courseId: "c1", title: "Lab  3", dueAt: "2026-09-10T03:59:00.000Z", observedAt: T0 });
    const after = { ...before, title: "Lab 3 ", dueAt: "2026-09-10T03:59:00Z", observedAt: T1, url: "https://x/y", sourceUpdatedAt: T1 };
    expect(diffSnapshots({ current: makeSnapshot(T1, [after]), history: [makeSnapshot(T0, [before])] })).toEqual([]);
  });

  it("detects visibility, status, and announcement changes", () => {
    const item = makeItem({ sourceId: "1", courseId: "c1", visibility: "scheduled", status: "not-started" });
    const ann = makeAnnouncement({ sourceId: "a1", courseId: "c1", bodyText: "Room  changed" });
    const previous = makeSnapshot(T0, [item], { announcements: [ann] });
    const current = makeSnapshot(T1, [{ ...item, visibility: "visible", status: "submitted" }], {
      announcements: [
        { ...ann, bodyText: "Room changed to Tolentine 215" },
        makeAnnouncement({ sourceId: "a2", courseId: "c1", title: "Office hours" }),
      ],
    });
    const events = diffSnapshots({ current, history: [previous] });
    expect(kinds(events)).toEqual(["announcement-added", "announcement-updated", "status-changed", "visibility-changed"]);
  });

  it("ignores whitespace-only announcement edits", () => {
    const ann = makeAnnouncement({ sourceId: "a1", courseId: "c1", bodyText: "Bring   notes" });
    const events = diffSnapshots({
      current: makeSnapshot(T1, [], { announcements: [{ ...ann, bodyText: " Bring notes \n" }] }),
      history: [makeSnapshot(T0, [], { announcements: [ann] })],
    });
    expect(events).toEqual([]);
  });

  it("never reports a status change into unknown", () => {
    const item = makeItem({ sourceId: "1", courseId: "c1", status: "submitted" });
    const events = diffSnapshots({ current: makeSnapshot(T1, [{ ...item, status: "unknown" }]), history: [makeSnapshot(T0, [item])] });
    expect(events).toEqual([]);
  });

  it("carries a known status forward over a permission-limited unknown", () => {
    const known = makeItem({ sourceId: "1", courseId: "c1", status: "submitted" });
    const merged = carryForwardKnownStatuses([{ ...known, status: "unknown" }, makeItem({ sourceId: "2", courseId: "c1", status: "unknown" })], makeSnapshot(T0, [known]));
    expect(merged.map((item) => item.status)).toEqual(["submitted", "unknown"]);
  });

  it("emits became-overdue only on the transition", () => {
    const item = makeItem({ sourceId: "1", courseId: "c1", dueAt: "2026-09-08T13:30:00.000Z" });
    const s0 = makeSnapshot(T0, [item]);
    const s1 = makeSnapshot(T1, [item]);
    const s2 = makeSnapshot(T2, [item]);
    const s3 = makeSnapshot(T3, [item]);
    expect(kinds(diffSnapshots({ current: s1, history: [s0] }))).toEqual([]);
    expect(kinds(diffSnapshots({ current: s2, history: [s1, s0] }))).toEqual(["became-overdue"]);
    expect(kinds(diffSnapshots({ current: s3, history: [s2, s1, s0] }))).toEqual([]);
  });

  it("does not report overdue for done items", () => {
    const item = makeItem({ sourceId: "1", courseId: "c1", dueAt: "2026-09-08T13:30:00.000Z", status: "submitted" });
    expect(diffSnapshots({ current: makeSnapshot(T2, [item]), history: [makeSnapshot(T1, [item])] })).toEqual([]);
  });

  it("creates no removals or additions for a course that failed in the current sync", () => {
    const a = makeItem({ sourceId: "1", courseId: "c1" });
    const b = makeItem({ sourceId: "2", courseId: "c2" });
    const s0 = makeSnapshot(T0, [a, b]);
    const s1 = makeSnapshot(T1, [a, b]);
    const partial = makeSnapshot(T2, [a], { failedCourseIds: ["c2"], courses: [] });
    expect(partial.isComplete).toBe(false);
    expect(diffSnapshots({ current: partial, history: [s1, s0] })).toEqual([]);
  });

  it("requires two consecutive successful observations before reporting a removal", () => {
    const a = makeItem({ sourceId: "1", courseId: "c1" });
    const b = makeItem({ sourceId: "2", courseId: "c1" });
    const s0 = makeSnapshot(T0, [a, b]);
    const s1 = makeSnapshot(T1, [a]);
    expect(diffSnapshots({ current: s1, history: [s0] })).toEqual([]);
    const s2 = makeSnapshot(T2, [a]);
    const events = diffSnapshots({ current: s2, history: [s1, s0] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "item-removed", entityKey: b.key, before: { title: "Item 2" } });
    const s3 = makeSnapshot(T3, [a]);
    expect(diffSnapshots({ current: s3, history: [s2, s1, s0] })).toEqual([]);
  });

  it("skips failed observations when counting the removal grace period", () => {
    const a = makeItem({ sourceId: "1", courseId: "c1" });
    const b = makeItem({ sourceId: "2", courseId: "c1" });
    const s0 = makeSnapshot(T0, [a, b]);
    const failed = makeSnapshot(T1, [], { failedCourseIds: ["c1"], courses: [] });
    const s2 = makeSnapshot(T2, [a]);
    expect(diffSnapshots({ current: s2, history: [failed, s0] })).toEqual([]);
    const s3 = makeSnapshot(T3, [a]);
    expect(kinds(diffSnapshots({ current: s3, history: [s2, failed, s0] }))).toEqual(["item-removed"]);
  });

  it("reports an explicit hide immediately as a visibility change", () => {
    const item = makeItem({ sourceId: "1", courseId: "c1", visibility: "visible" });
    const events = diffSnapshots({ current: makeSnapshot(T1, [{ ...item, visibility: "hidden" }]), history: [makeSnapshot(T0, [item])] });
    expect(events[0]).toMatchObject({ kind: "visibility-changed", after: { visibility: "hidden" } });
  });

  it("produces identical fingerprints for repeated syncs so events dedupe", () => {
    const before = makeItem({ sourceId: "1", courseId: "c1", dueAt: "2026-09-10T03:59:00.000Z" });
    const after = { ...before, dueAt: "2026-09-11T03:59:00.000Z" };
    const first = diffSnapshots({ current: makeSnapshot(T1, [after]), history: [makeSnapshot(T0, [before])] });
    const again = diffSnapshots({ current: makeSnapshot(T2, [after]), history: [makeSnapshot(T1, [after]), makeSnapshot(T0, [before])] });
    expect(again).toEqual([]);
    // Even if the same transition were re-detected, the fingerprint dedupe drops it.
    const replay = diffSnapshots({ current: makeSnapshot(T3, [after]), history: [makeSnapshot(T0, [before])] });
    expect(replay[0]?.fingerprint).toBe(first[0]?.fingerprint);
    expect(dedupeEvents(replay, new Set(first.map((e) => e.fingerprint)))).toEqual([]);
  });

  it("prunes snapshots beyond the retention limit", () => {
    const snapshots: AcademicSnapshot[] = Array.from({ length: 23 }, (_, i) => makeSnapshot(`2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`, []));
    expect(snapshotsToPrune(snapshots)).toHaveLength(3);
  });
});
