import type { ResolvedVersions, VersionCacheStore } from "@nova-agent/brightspace";
import {
  MAX_CHANGE_EVENTS,
  MAX_CHANGE_EVENT_AGE_DAYS,
  MAX_SNAPSHOTS_PER_USER,
  dedupeEvents,
  sortSnapshotsNewestFirst,
  type AcademicSnapshot,
  type ChangeEvent,
} from "@nova-agent/core";
import type { NovaDb, StoredChangeEvent, StoredSnapshot, SyncStatusRecord } from "./novaDb";

export const INITIAL_SYNC_STATUS: SyncStatusRecord = {
  key: "current",
  mode: "fixture",
  phase: "idle",
  scope: null,
  displayName: null,
  lastSuccessfulSyncAt: null,
  lastAttemptedSyncAt: null,
  lastOutcome: null,
  error: null,
  failedCourseIds: [],
  warnings: [],
};

export const listSnapshots = async (db: NovaDb, scope: string, limit = MAX_SNAPSHOTS_PER_USER): Promise<AcademicSnapshot[]> => {
  const rows = await db.snapshots.where("[scope+capturedAt]").between([scope, Dexie_MIN], [scope, Dexie_MAX]).reverse().limit(limit).toArray();
  return sortSnapshotsNewestFirst(rows);
};

// Dexie key range sentinels for compound indexes.
const Dexie_MIN = "";
const Dexie_MAX = "￿";

export const latestSnapshot = async (db: NovaDb, scope: string): Promise<AcademicSnapshot | null> => (await listSnapshots(db, scope, 1))[0] ?? null;

export const listChangeEvents = async (db: NovaDb, scope: string): Promise<ChangeEvent[]> =>
  db.changeEvents.where("[scope+detectedAt]").between([scope, Dexie_MIN], [scope, Dexie_MAX]).reverse().toArray();

export const unreadCount = async (db: NovaDb, scope: string): Promise<number> =>
  db.changeEvents.where("scope").equals(scope).filter((event) => event.readAt === null).count();

export const markAllRead = async (db: NovaDb, scope: string, readAt: string): Promise<number> =>
  db.changeEvents.where("scope").equals(scope).filter((event) => event.readAt === null).modify({ readAt });

export const setEventRead = async (db: NovaDb, id: string, readAt: string | null): Promise<void> => {
  await db.changeEvents.update(id, { readAt });
};

export const getSyncStatus = async (db: NovaDb): Promise<SyncStatusRecord> => (await db.syncStatus.get("current")) ?? INITIAL_SYNC_STATUS;

export const putSyncStatus = async (db: NovaDb, patch: Partial<SyncStatusRecord>): Promise<SyncStatusRecord> => {
  const next = { ...(await getSyncStatus(db)), ...patch, key: "current" as const };
  await db.syncStatus.put(next);
  return next;
};

export type SaveSyncOutcomeInput = {
  snapshot: AcademicSnapshot;
  events: ChangeEvent[];
  status: Partial<SyncStatusRecord>;
  now: Date;
};

export type SaveSyncOutcomeResult = { savedEvents: ChangeEvent[]; prunedSnapshots: number; prunedEvents: number };

/**
 * Persists the snapshot, deduplicated change events, and sync status in one
 * transaction, then applies retention limits.
 */
export const saveSyncOutcome = async (db: NovaDb, input: SaveSyncOutcomeInput): Promise<SaveSyncOutcomeResult> => {
  const scope = `${input.snapshot.tenantOrigin}|${input.snapshot.userId}`;
  return db.transaction("rw", db.snapshots, db.changeEvents, db.syncStatus, async () => {
    const known = new Set((await db.changeEvents.where("scope").equals(scope).toArray()).map((event) => event.fingerprint));
    const fresh = dedupeEvents(input.events, known);

    await db.snapshots.put({ ...input.snapshot, scope } satisfies StoredSnapshot);
    if (fresh.length > 0) await db.changeEvents.bulkPut(fresh.map((event) => ({ ...event, scope }) satisfies StoredChangeEvent));

    const status = { ...(await getSyncStatus(db)), ...input.status, key: "current" as const, scope };
    await db.syncStatus.put(status);

    // Retention: newest MAX_SNAPSHOTS_PER_USER snapshots per scope.
    const snapshots = await db.snapshots.where("scope").equals(scope).toArray();
    const stale = sortSnapshotsNewestFirst(snapshots).slice(MAX_SNAPSHOTS_PER_USER);
    if (stale.length > 0) await db.snapshots.bulkDelete(stale.map((snapshot) => snapshot.id));

    // Retention: 30 days or 2,000 events, whichever is smaller.
    const cutoff = new Date(input.now.getTime() - MAX_CHANGE_EVENT_AGE_DAYS * 86_400_000).toISOString();
    const events = await db.changeEvents.where("scope").equals(scope).toArray();
    const ordered = [...events].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    const expired = ordered.filter((event, index) => event.detectedAt < cutoff || index >= MAX_CHANGE_EVENTS);
    if (expired.length > 0) await db.changeEvents.bulkDelete(expired.map((event) => event.id));

    return { savedEvents: fresh, prunedSnapshots: stale.length, prunedEvents: expired.length };
  });
};

export const getPreference = async <T>(db: NovaDb, key: string, fallback: T): Promise<T> => {
  const row = await db.preferences.get(key);
  return row ? (row.value as T) : fallback;
};

export const setPreference = async (db: NovaDb, key: string, value: unknown): Promise<void> => {
  await db.preferences.put({ key, value });
};

export const createDexieVersionCache = (db: NovaDb, tenantOrigin: string): VersionCacheStore => ({
  get: async () => (await db.versionCache.get(tenantOrigin))?.value ?? null,
  set: async (value: ResolvedVersions) => {
    await db.versionCache.put({ tenantOrigin, value });
  },
  clear: async () => {
    await db.versionCache.delete(tenantOrigin);
  },
});

/** "Clear local Nova data": wipes every table. */
export const clearAllData = async (db: NovaDb): Promise<void> => {
  await db.transaction("rw", db.tables, async () => {
    for (const table of db.tables) await table.clear();
  });
};
