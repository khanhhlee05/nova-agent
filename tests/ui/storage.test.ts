import "fake-indexeddb/auto";
import { DEMO_LE_VERSION, DEMO_LP_VERSION, FixtureTransport, buildDemoTenant, demoResolver, htmlResponse, jsonResponse, routes } from "@nova-agent/brightspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubHost } from "../../apps/extension/src/platform/host";
import { createNovaDb, type NovaDb } from "../../apps/extension/src/storage/novaDb";
import { getSyncStatus, listChangeEvents, listSnapshots, markAllRead, saveSyncOutcome, setPreference, unreadCount } from "../../apps/extension/src/storage/repositories";
import { DATA_MODE_PREFERENCE, SyncCoordinator, type TransportFactory } from "../../apps/extension/src/sync/syncCoordinator";
import { makeItem, makeSnapshot } from "../helpers/factories";
import { NOW, TENANT } from "../helpers/demoDashboard";

let db: NovaDb;
let counter = 0;

beforeEach(() => {
  db = createNovaDb(`test-${Date.now()}-${counter++}`);
});

afterEach(async () => {
  await db.delete();
});

const T = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000);

describe("repositories", () => {
  it("saves snapshot, events, and status in one transaction and dedupes fingerprints", async () => {
    const snapshot = makeSnapshot(NOW.toISOString(), [makeItem({ sourceId: "1", courseId: "c1" })]);
    const event = { id: "e1", fingerprint: "fp1", kind: "item-added" as const, entityKey: "k", courseId: "c1", detectedAt: NOW.toISOString(), before: null, after: { title: "x" }, readAt: null };
    const first = await saveSyncOutcome(db, { snapshot, events: [event], status: { lastSuccessfulSyncAt: NOW.toISOString() }, now: NOW });
    expect(first.savedEvents).toHaveLength(1);
    const again = await saveSyncOutcome(db, { snapshot: { ...snapshot, id: "s2", capturedAt: T(5).toISOString() }, events: [{ ...event, id: "e2", detectedAt: T(5).toISOString() }], status: {}, now: T(5) });
    expect(again.savedEvents).toHaveLength(0);
    const scope = `${TENANT}|2001`;
    expect(await listChangeEvents(db, scope)).toHaveLength(1);
    expect(await listSnapshots(db, scope)).toHaveLength(2);
    expect((await getSyncStatus(db)).scope).toBe(scope);
  });

  it("prunes snapshots beyond 20 and events beyond 30 days", async () => {
    const scope = `${TENANT}|2001`;
    for (let i = 0; i < 23; i++) {
      const at = T(i * 10);
      await saveSyncOutcome(db, { snapshot: makeSnapshot(at.toISOString(), []), events: [], status: {}, now: at });
    }
    expect(await listSnapshots(db, scope, 100)).toHaveLength(20);
    const old = { id: "old", fingerprint: "old", kind: "item-added" as const, entityKey: "k", courseId: "c", detectedAt: T(-31 * 24 * 60).toISOString(), before: null, after: null, readAt: null };
    const fresh = { ...old, id: "fresh", fingerprint: "fresh", detectedAt: NOW.toISOString() };
    const result = await saveSyncOutcome(db, { snapshot: makeSnapshot(T(300).toISOString(), []), events: [old, fresh], status: {}, now: T(300) });
    expect(result.prunedEvents).toBe(1);
    expect((await listChangeEvents(db, scope)).map((event) => event.id)).toEqual(["fresh"]);
  });

  it("tracks unread counts and mark-all-read", async () => {
    const scope = `${TENANT}|2001`;
    const events = [1, 2, 3].map((n) => ({ id: `e${n}`, fingerprint: `f${n}`, kind: "item-added" as const, entityKey: `k${n}`, courseId: "c", detectedAt: NOW.toISOString(), before: null, after: null, readAt: null }));
    await saveSyncOutcome(db, { snapshot: makeSnapshot(NOW.toISOString(), []), events, status: {}, now: NOW });
    expect(await unreadCount(db, scope)).toBe(3);
    expect(await markAllRead(db, scope, NOW.toISOString())).toBe(3);
    expect(await unreadCount(db, scope)).toBe(0);
  });
});

describe("SyncCoordinator", () => {
  const fixtureFactory =
    (overrides: Record<string, unknown> = {}): TransportFactory =>
    (_mode, { now, demoScenario }) =>
      new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario), overrides));

  it("captures a baseline, then detects changes without duplicates across repeated syncs", async () => {
    const host = createStubHost();
    let clock = NOW;
    const coordinator = new SyncCoordinator({ db, host, now: () => clock, transportFactory: fixtureFactory() });
    const phases: string[] = [];
    coordinator.subscribe((state) => phases.push(state.phase));

    const first = await coordinator.sync("manual");
    expect(first.phase).toBe("ready");
    expect(first.newEventCount).toBe(0);
    expect(phases).toEqual(expect.arrayContaining(["checking-session", "discovering-versions", "loading-courses", "loading-course-data", "normalizing", "comparing", "saving", "ready"]));
    expect(host.badges.at(-1)).toBe(0);

    clock = T(30);
    const second = await coordinator.sync("manual");
    expect(second.phase).toBe("ready");
    expect(second.newEventCount).toBeGreaterThan(0);
    const scope = `${TENANT}|2001`;
    const events = await listChangeEvents(db, scope);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["due-date-changed", "item-added", "status-changed", "announcement-added"]));
    expect(host.badges.at(-1)).toBe(events.length);

    clock = T(60);
    const third = await coordinator.sync("manual");
    expect(third.newEventCount).toBe(0);
    expect(await listChangeEvents(db, scope)).toHaveLength(events.length);

    const status = await getSyncStatus(db);
    expect(status.lastSuccessfulSyncAt).toBe(T(60).toISOString());
    expect(status.lastAttemptedSyncAt).toBe(T(60).toISOString());
  });

  it("shares one in-flight run between overlapping manual and automatic syncs", async () => {
    const coordinator = new SyncCoordinator({ db, host: createStubHost(), now: () => NOW, transportFactory: fixtureFactory() });
    const a = coordinator.sync("manual");
    const b = coordinator.sync("auto");
    expect(a).toBe(b);
    await a;
    expect(await listSnapshots(db, `${TENANT}|2001`)).toHaveLength(1);
  });

  it("keeps the last good state and records a partial outcome when a course fails", async () => {
    let clock = NOW;
    const factory = vi.fn<TransportFactory>();
    factory.mockImplementationOnce(fixtureFactory());
    factory.mockImplementationOnce(fixtureFactory({ [routes.dropboxFolders(DEMO_LE_VERSION, "31002")]: jsonResponse(null, 503) }));
    const coordinator = new SyncCoordinator({ db, host: createStubHost(), now: () => clock, transportFactory: factory });
    await coordinator.sync("manual");
    clock = T(20);
    const result = await coordinator.sync("manual");
    expect(result.phase).toBe("partial");
    expect(result.failedCourseIds).toEqual(["31002"]);
    const snapshots = await listSnapshots(db, `${TENANT}|2001`);
    expect(snapshots[0]?.isComplete).toBe(false);
    expect(snapshots[0]?.failedCourseIds).toEqual(["31002"]);
    // Successful courses still produce events; the failed course produces none (and no removals anywhere).
    const events = await listChangeEvents(db, `${TENANT}|2001`);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.courseId === "31002")).toBe(false);
    expect(events.some((event) => event.kind === "item-removed")).toBe(false);
    expect((await getSyncStatus(db)).lastOutcome).toBe("partial");
  });

  it("reports session expiry, keeps cached data, and separates attempted from successful timestamps", async () => {
    let clock = NOW;
    const factory = vi.fn<TransportFactory>();
    factory.mockImplementationOnce(fixtureFactory());
    factory.mockImplementationOnce(fixtureFactory({ [routes.whoami(DEMO_LP_VERSION)]: htmlResponse() }));
    await setPreference(db, DATA_MODE_PREFERENCE, "live");
    const coordinator = new SyncCoordinator({ db, host: createStubHost(), now: () => clock, transportFactory: factory });
    await coordinator.sync("manual");
    clock = T(20);
    const result = await coordinator.sync("manual");
    expect(result.phase).toBe("session-expired");
    expect(result.error).toEqual({ kind: "session-expired" });
    const status = await getSyncStatus(db);
    expect(status.lastSuccessfulSyncAt).toBe(NOW.toISOString());
    expect(status.lastAttemptedSyncAt).toBe(T(20).toISOString());
    expect(await listSnapshots(db, `${TENANT}|2001`)).toHaveLength(1);
  });

  it("goes offline when no Brightspace tab is available in live mode", async () => {
    await setPreference(db, DATA_MODE_PREFERENCE, "live");
    const host = createStubHost({ hasBrightspaceTab: async () => false });
    const result = await new SyncCoordinator({ db, host, now: () => NOW, transportFactory: fixtureFactory() }).sync("manual");
    expect(result.phase).toBe("offline");
    expect(result.error).toMatchObject({ kind: "network", operation: "no-brightspace-tab" });
  });

  it("only auto-syncs when data is older than fifteen minutes", async () => {
    let clock = NOW;
    const coordinator = new SyncCoordinator({ db, host: createStubHost(), now: () => clock, transportFactory: fixtureFactory() });
    expect(await coordinator.syncIfStale()).not.toBeNull();
    clock = T(10);
    expect(await coordinator.syncIfStale()).toBeNull();
    clock = T(16);
    expect(await coordinator.syncIfStale()).not.toBeNull();
  });
});
