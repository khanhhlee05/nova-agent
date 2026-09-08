import {
  BrightspaceClient,
  FixtureTransport,
  SessionTransport,
  buildDemoTenant,
  demoResolver,
  toBrightspaceError,
  type BrightspaceTransport,
  type DemoScenario,
  type LoadPhase,
} from "@nova-agent/brightspace";
import { carryForwardKnownStatuses, createSnapshot, diffSnapshots, userScope } from "@nova-agent/core";
import type { SyncPhase } from "../messaging/protocol";
import type { ExtensionHost } from "../platform/host";
import type { DataMode, NovaDb } from "../storage/novaDb";
import { createDexieVersionCache, getPreference, getSyncStatus, listSnapshots, putSyncStatus, saveSyncOutcome, setPreference, unreadCount } from "../storage/repositories";
import { IDLE_STATE, isStale, phaseForError, type SyncRuntimeState } from "./syncState";

export type SyncReason = "manual" | "auto";

export type TransportFactory = (mode: DataMode, context: { now: Date; demoScenario: DemoScenario }) => BrightspaceTransport;

export type SyncCoordinatorDeps = {
  db: NovaDb;
  host: ExtensionHost;
  now?: () => Date;
  transportFactory?: TransportFactory;
};

export const DEMO_SCENARIO_PREFERENCE = "demo.scenario";
export const DATA_MODE_PREFERENCE = "data.mode";

export const defaultTransportFactory =
  (host: ExtensionHost): TransportFactory =>
  (mode, { now, demoScenario }) =>
    mode === "fixture"
      ? new FixtureTransport(demoResolver(buildDemoTenant(now, demoScenario)))
      : new SessionTransport(host.rawFetch, { tenantOrigin: host.tenantOrigin, now: () => now });

const loadPhaseToSyncPhase: Record<LoadPhase, SyncPhase> = {
  "checking-session": "checking-session",
  "discovering-versions": "discovering-versions",
  "loading-courses": "loading-courses",
  "loading-course-data": "loading-course-data",
  normalizing: "normalizing",
};

/**
 * Runs the full sync flow. Cached data is shown immediately by the UI; this
 * class only refreshes in the background and guarantees a single in-flight sync.
 */
export class SyncCoordinator {
  private readonly db: NovaDb;
  private readonly host: ExtensionHost;
  private readonly now: () => Date;
  private readonly transportFactory: TransportFactory;
  private readonly listeners = new Set<(state: SyncRuntimeState) => void>();
  private state: SyncRuntimeState = IDLE_STATE;
  private inFlight: Promise<SyncRuntimeState> | null = null;

  constructor(deps: SyncCoordinatorDeps) {
    this.db = deps.db;
    this.host = deps.host;
    this.now = deps.now ?? (() => new Date());
    this.transportFactory = deps.transportFactory ?? defaultTransportFactory(deps.host);
  }

  getState(): SyncRuntimeState {
    return this.state;
  }

  subscribe(listener: (state: SyncRuntimeState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private setState(patch: Partial<SyncRuntimeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
    if (patch.phase) this.host.publishSyncPhase(patch.phase, 0);
  }

  /** Refreshes only when the last successful sync is older than the stale window. */
  async syncIfStale(): Promise<SyncRuntimeState | null> {
    const status = await getSyncStatus(this.db);
    if (!isStale(status.lastSuccessfulSyncAt, this.now())) return null;
    return this.sync("auto");
  }

  /** Overlapping manual and automatic syncs share the in-flight run. */
  sync(reason: SyncReason): Promise<SyncRuntimeState> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(reason: SyncReason): Promise<SyncRuntimeState> {
    const now = this.now();
    const startedAt = now.toISOString();
    const mode = await getPreference<DataMode>(this.db, DATA_MODE_PREFERENCE, "fixture");
    await putSyncStatus(this.db, { mode, lastAttemptedSyncAt: startedAt, phase: "checking-session" });
    this.setState({ ...IDLE_STATE, phase: "checking-session", startedAt, reason });

    if (mode === "live") {
      if (!this.host.isOnline()) return this.finish("offline", { kind: "network", retryable: true, operation: "offline" });
      if (!(await this.host.hasBrightspaceTab())) return this.finish("offline", { kind: "network", retryable: true, operation: "no-brightspace-tab" });
    }

    const demoScenario = await getPreference<DemoScenario>(this.db, DEMO_SCENARIO_PREFERENCE, "baseline");
    const transport = this.transportFactory(mode, { now, demoScenario });
    const client = new BrightspaceClient(transport, {
      tenantOrigin: this.host.tenantOrigin,
      now: () => now,
      versionCache: mode === "live" ? createDexieVersionCache(this.db, this.host.tenantOrigin) : undefined,
      onPhase: (phase, detail) => this.setState({ phase: loadPhaseToSyncPhase[phase], progress: detail ?? null }),
    });

    try {
      const result = await client.loadAcademicState();
      if (result.courses.length > 0 && result.successfulCourseIds.length === 0) {
        const first = result.failures[0]?.error ?? { kind: "network" as const, retryable: true };
        return this.finish(phaseForError(first), first, { warnings: result.warnings, failedCourseIds: result.failedCourseIds });
      }

      this.setState({ phase: "comparing", progress: null });
      const scope = userScope(result.tenantOrigin, result.userId);
      const history = await listSnapshots(this.db, scope);
      const items = carryForwardKnownStatuses(result.items, history[0] ?? null);
      const snapshot = createSnapshot({
        tenantOrigin: result.tenantOrigin,
        userId: result.userId,
        capturedAt: result.capturedAt,
        courses: result.courses,
        items,
        announcements: result.announcements,
        successfulCourseIds: result.successfulCourseIds,
        failedCourseIds: result.failedCourseIds,
      });
      const events = diffSnapshots({ current: snapshot, history });

      this.setState({ phase: "saving" });
      const outcome: "ready" | "partial" = result.failedCourseIds.length > 0 ? "partial" : "ready";
      const saved = await saveSyncOutcome(this.db, {
        snapshot,
        events,
        now,
        status: {
          mode,
          phase: outcome,
          displayName: result.displayName,
          lastSuccessfulSyncAt: result.capturedAt,
          lastOutcome: outcome,
          error: null,
          failedCourseIds: result.failedCourseIds,
          warnings: result.warnings,
        },
      });
      if (mode === "fixture") await setPreference(this.db, DEMO_SCENARIO_PREFERENCE, "changed");

      const unread = await unreadCount(this.db, scope);
      await this.host.publishBadge(unread);
      this.setState({
        phase: outcome,
        progress: null,
        error: null,
        warnings: result.warnings,
        failedCourseIds: result.failedCourseIds,
        finishedAt: this.now().toISOString(),
        newEventCount: saved.savedEvents.length,
      });
      return this.state;
    } catch (caught) {
      const error = toBrightspaceError(caught, "sync");
      return this.finish(phaseForError(error), error);
    }
  }

  private async finish(
    phase: Extract<SyncPhase, "session-expired" | "permission-required" | "offline" | "failed">,
    error: SyncRuntimeState["error"],
    extra: Partial<SyncRuntimeState> = {},
  ): Promise<SyncRuntimeState> {
    await putSyncStatus(this.db, {
      phase,
      lastOutcome: phase,
      error,
      warnings: extra.warnings ?? [],
      failedCourseIds: extra.failedCourseIds ?? [],
    });
    this.setState({ phase, progress: null, error, finishedAt: this.now().toISOString(), ...extra });
    return this.state;
  }
}
