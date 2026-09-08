import Dexie, { type EntityTable } from "dexie";
import type { FeasibilityReport, ResolvedVersions, SyncWarning, BrightspaceError } from "@nova-agent/brightspace";
import type { AcademicSnapshot, ChangeEvent } from "@nova-agent/core";
import type { SyncPhase } from "../messaging/protocol";

/** Snapshot rows carry the tenant|user scope so multiple accounts never mix. */
export type StoredSnapshot = AcademicSnapshot & { scope: string };
export type StoredChangeEvent = ChangeEvent & { scope: string };

export type DataMode = "fixture" | "live";

export type SyncStatusRecord = {
  key: "current";
  mode: DataMode;
  phase: SyncPhase;
  /** Scope (tenant|user) of the data currently shown. */
  scope: string | null;
  displayName: string | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptedSyncAt: string | null;
  lastOutcome: Extract<SyncPhase, "ready" | "partial" | "session-expired" | "permission-required" | "offline" | "failed"> | null;
  error: BrightspaceError | null;
  failedCourseIds: string[];
  warnings: SyncWarning[];
};

export type PreferenceRecord = { key: string; value: unknown };

export type VersionCacheRecord = { tenantOrigin: string; value: ResolvedVersions };

export type FeasibilityRecord = { tenantOrigin: string; report: FeasibilityReport };

export class NovaDb extends Dexie {
  snapshots!: EntityTable<StoredSnapshot, "id">;
  changeEvents!: EntityTable<StoredChangeEvent, "id">;
  syncStatus!: EntityTable<SyncStatusRecord, "key">;
  preferences!: EntityTable<PreferenceRecord, "key">;
  versionCache!: EntityTable<VersionCacheRecord, "tenantOrigin">;
  feasibility!: EntityTable<FeasibilityRecord, "tenantOrigin">;

  constructor(name = "nova-agent") {
    super(name);
    this.version(1).stores({
      snapshots: "id, scope, capturedAt, [scope+capturedAt]",
      changeEvents: "id, scope, fingerprint, detectedAt, readAt, [scope+fingerprint], [scope+detectedAt]",
      syncStatus: "key",
      preferences: "key",
      versionCache: "tenantOrigin",
      feasibility: "tenantOrigin",
    });
  }
}

export const createNovaDb = (name?: string): NovaDb => new NovaDb(name);
