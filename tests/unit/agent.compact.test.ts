import { compactSnapshot, estimateSize, shortId } from "@nova-agent/agent";
import { classifyDeadline, diffSnapshots } from "@nova-agent/core";
import { compactSnapshotSchema } from "@nova-agent/protocol";
import { describe, expect, it } from "vitest";
import { buildDashboard } from "../../apps/extension/src/sidepanel/model";
import { makeCourse, makeItem, makeSnapshot } from "../helpers/factories";
import { NOW, TENANT, demoSnapshot } from "../helpers/demoDashboard";

const demo = async () => {
  const earlier = new Date(NOW.getTime() - 3_600_000);
  const baseline = await demoSnapshot("baseline", earlier);
  const snapshot = await demoSnapshot("changed", NOW);
  const events = diffSnapshots({ current: snapshot, history: [baseline] });
  return { snapshot, events };
};

describe("compactSnapshot", () => {
  it("keeps only titles, dates, statuses, and links, and validates against the protocol schema", async () => {
    const { snapshot, events } = await demo();
    const compact = compactSnapshot(snapshot, events, NOW, { mode: "demo", timezone: "America/New_York" });
    expect(compactSnapshotSchema.safeParse(compact).success).toBe(true);
    const json = JSON.stringify(compact);
    expect(json).not.toContain(`${TENANT}|`);
    expect(json).not.toContain(snapshot.userId);
    expect(json).not.toContain("bodyText");
    expect(json).not.toContain("observedAt");
    expect(json).not.toContain("fingerprint");
    expect(json).not.toContain("entityKey");
    expect(compact.items.every((item) => /^[aq]\d+$/.test(item.id))).toBe(true);
    expect(compact.items.some((item) => (item.visibility as string) === "hidden" || (item.visibility as string) === "expired")).toBe(false);
    expect(estimateSize(compact)).toBeLessThan(16_000);
    expect(compact.mode).toBe("demo");
    expect(compact.timezone).toBe("America/New_York");
  });

  it("agrees with the dashboard on counts and with core on buckets", async () => {
    const { snapshot, events } = await demo();
    const compact = compactSnapshot(snapshot, events, NOW, { mode: "live" });
    const dashboard = buildDashboard({ snapshot, events, now: NOW, courseFilter: null });
    expect(compact.counts.overdue).toBe(dashboard.counts.overdue);
    expect(compact.counts.today).toBe(dashboard.counts.today);
    expect(compact.counts.thisWeek).toBe(dashboard.counts.thisWeek);
    expect(compact.counts.unread).toBe(dashboard.counts.unread);
    const byKey = new Map(snapshot.items.map((item) => [shortId(item.key, item.kind), item]));
    for (const item of compact.items) {
      const source = byKey.get(item.id);
      expect(source).toBeDefined();
      expect(item.bucket).toBe(classifyDeadline(source!, { now: NOW }));
    }
    expect(compact.changes.length).toBe(events.length);
    expect(compact.changes.every((change) => change.daysAgo === 0)).toBe(true);
    const top = dashboard.nextMove?.item;
    const topCompact = compact.items.find((item) => item.id === shortId(top!.key, top!.kind));
    expect(topCompact?.priority).toBe(Math.round(dashboard.nextMove!.ranked.priority.score));
    expect(topCompact?.reasons.length).toBeGreaterThan(0);
  });

  it("drops hidden, expired, and stale completed items and enforces the caps", () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      makeItem({ sourceId: String(1000 + i), courseId: "c1", title: `Task ${i}`, dueAt: new Date(NOW.getTime() + i * 3_600_000).toISOString() }),
    );
    const hidden = makeItem({ sourceId: "9001", courseId: "c1", visibility: "hidden", dueAt: NOW.toISOString() });
    const expired = makeItem({ sourceId: "9002", courseId: "c1", visibility: "expired", dueAt: NOW.toISOString() });
    const oldDone = makeItem({ sourceId: "9003", courseId: "c1", status: "submitted", dueAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() });
    const recentDone = makeItem({ sourceId: "9004", courseId: "c1", status: "submitted", dueAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() });
    const inactiveCourseItem = makeItem({ sourceId: "9005", courseId: "c2", dueAt: NOW.toISOString() });
    const snapshot = makeSnapshot(NOW.toISOString(), [...items, hidden, expired, oldDone, recentDone, inactiveCourseItem], {
      courses: [makeCourse("c1"), makeCourse("c2", { active: false })],
    });
    const compact = compactSnapshot(snapshot, [], NOW, { mode: "live" });
    expect(compact.items).toHaveLength(200);
    const ids = new Set(compact.items.map((item) => item.id));
    expect(ids.has("a9001")).toBe(false);
    expect(ids.has("a9002")).toBe(false);
    expect(ids.has("a9003")).toBe(false);
    expect(ids.has("a9004")).toBe(true);
    expect(ids.has("a9005")).toBe(false);
    expect(compact.courses.map((course) => course.id)).toEqual(["c1"]);
    expect(compactSnapshotSchema.safeParse(compact).success).toBe(true);
  });
});
