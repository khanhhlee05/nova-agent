import type { FeasibilityReport } from "@nova-agent/brightspace";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionHost } from "../platform/host";
import type { NovaDb } from "../storage/novaDb";
import { clearAllData, getPreference, getSyncStatus, listChangeEvents, latestSnapshot, markAllRead, setEventRead, setPreference, unreadCount } from "../storage/repositories";
import { DATA_MODE_PREFERENCE, DEMO_SCENARIO_PREFERENCE, SyncCoordinator, type TransportFactory } from "../sync/syncCoordinator";
import { IDLE_STATE, isRunningPhase, type SyncRuntimeState } from "../sync/syncState";
import { connectLive as runConnectLive } from "./connect";
import { useSessionDismissals } from "./dismissals";
import { DEFAULT_PREFERENCES, MissionControl, type UiPreferences } from "./MissionControl";
import { buildDashboard } from "./model";
import { useNow } from "./useNow";

export type AppDeps = {
  db: NovaDb;
  host: ExtensionHost;
  now?: () => Date;
  transportFactory?: TransportFactory;
  /** Skip the automatic refresh on open (used by the preview harness). */
  autoSync?: boolean;
};

const PREFERENCES_KEY = "ui.preferences";

export const App = ({ db, host, now: nowFn, transportFactory, autoSync = true }: AppDeps) => {
  const now = useNow(60_000, nowFn);
  const coordinator = useMemo(() => new SyncCoordinator({ db, host, now: nowFn, transportFactory }), [db, host, nowFn, transportFactory]);
  const [runtime, setRuntime] = useState<SyncRuntimeState>(IDLE_STATE);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const announced = useRef<string | null>(null);

  useEffect(() => coordinator.subscribe(setRuntime), [coordinator]);

  const status = useLiveQuery(() => getSyncStatus(db), [db]);
  const preferences = useLiveQuery(() => getPreference<UiPreferences>(db, PREFERENCES_KEY, DEFAULT_PREFERENCES), [db]);
  const feasibility = useLiveQuery(async () => (await db.feasibility.get(host.tenantOrigin))?.report ?? null, [db, host.tenantOrigin]) as FeasibilityReport | null | undefined;
  const scope = status?.scope ?? null;
  const snapshot = useLiveQuery(() => (scope ? latestSnapshot(db, scope) : Promise.resolve(null)), [db, scope]);
  const events = useLiveQuery(() => (scope ? listChangeEvents(db, scope) : Promise.resolve([])), [db, scope]);

  // Session-only dismissals: forgotten when the panel closes, restored whenever fresh data arrives.
  const { dismissals, dismissItem, dismissEvent, dismissBanner, restoreAll } = useSessionDismissals(snapshot?.capturedAt ?? null);

  // Show cached data immediately, then refresh in the background when stale.
  // The first run waits for the student to choose a data source.
  const hasAttempted = !!status && (status.lastAttemptedSyncAt !== null || status.lastSuccessfulSyncAt !== null);
  useEffect(() => {
    if (!autoSync || !hasAttempted) return;
    void coordinator.syncIfStale();
  }, [autoSync, coordinator, hasAttempted, scope]);

  // Announce sync completion and errors politely.
  useEffect(() => {
    if (isRunningPhase(runtime.phase) || runtime.phase === "idle" || !runtime.finishedAt || announced.current === runtime.finishedAt) return;
    announced.current = runtime.finishedAt;
    if (runtime.phase === "ready" || runtime.phase === "partial") {
      setAnnouncement(runtime.newEventCount > 0 ? `Refresh complete. ${runtime.newEventCount} new change${runtime.newEventCount === 1 ? "" : "s"}.` : "Refresh complete. No new changes.");
    } else {
      setAnnouncement(`Refresh did not complete: ${runtime.phase.replace(/-/g, " ")}.`);
    }
  }, [runtime]);

  const publishBadge = useCallback(async () => {
    if (scope) await host.publishBadge(await unreadCount(db, scope));
  }, [db, host, scope]);

  const dashboard = useMemo(
    () =>
      snapshot && events && preferences
        ? buildDashboard({ snapshot, events, now, courseFilter: preferences.courseFilter, dismissedItemKeys: dismissals.items, dismissedEventIds: dismissals.events })
        : null,
    [snapshot, events, now, preferences, dismissals],
  );

  const setPreferences = useCallback(
    (patch: Partial<UiPreferences>) => {
      void setPreference(db, PREFERENCES_KEY, { ...(preferences ?? DEFAULT_PREFERENCES), ...patch });
    },
    [db, preferences],
  );

  const actions = useMemo(
    () => ({
      refresh: () => {
        // A refresh always repopulates everything the student hid this session.
        restoreAll();
        void coordinator.sync("manual");
      },
      setPreferences,
      dismissItem: (key: string, title: string) => {
        dismissItem(key);
        setAnnouncement(`Hid "${title}" until the next refresh.`);
      },
      dismissEvent: (id: string, title: string) => {
        dismissEvent(id);
        setAnnouncement(`Hid the change for "${title}" until the next refresh.`);
      },
      dismissBanner: (id: string) => {
        dismissBanner(id);
        setAnnouncement("Notice hidden until the next refresh.");
      },
      restoreDismissed: () => {
        restoreAll();
        setAnnouncement("Everything hidden this session is back.");
      },
      markAllRead: () => {
        if (!scope) return;
        void markAllRead(db, scope, new Date().toISOString()).then(publishBadge);
      },
      setEventRead: (id: string, read: boolean) => {
        void setEventRead(db, id, read ? new Date().toISOString() : null).then(publishBadge);
      },
      openUrl: (url: string) => host.openTenantUrl(url),
      connectLive: () => {
        setBusy(true);
        void runConnectLive(db, host, nowFn)
          .then(async (report) => {
            if (report.verdict === "live-ok") {
              setAnnouncement("Brightspace accepted the connection. Loading your courses.");
              await coordinator.sync("manual");
            } else {
              setAnnouncement("Brightspace did not accept the connection. Authorization is required.");
              await db.syncStatus.put({
                ...(await getSyncStatus(db)),
                key: "current",
                phase: report.verdict === "unreachable" ? "offline" : "permission-required",
                lastOutcome: report.verdict === "unreachable" ? "offline" : "permission-required",
                lastAttemptedSyncAt: report.probedAt,
                error: report.verdict === "unreachable" ? { kind: "network", retryable: true, operation: "no-brightspace-tab" } : { kind: "permission-denied", operation: "probe" },
              });
            }
          })
          .finally(() => setBusy(false));
      },
      useDemoData: () => {
        void (async () => {
          await setPreference(db, DATA_MODE_PREFERENCE, "fixture");
          await setPreference(db, DEMO_SCENARIO_PREFERENCE, "baseline");
          await coordinator.sync("manual");
        })();
      },
      clearData: async () => {
        await clearAllData(db);
        await host.publishBadge(0);
        setRuntime(IDLE_STATE);
        setAnnouncement("Local Nova data cleared.");
      },
    }),
    [coordinator, db, dismissBanner, dismissEvent, dismissItem, host, nowFn, publishBadge, restoreAll, scope, setPreferences],
  );

  if (!status || !preferences || feasibility === undefined) return null;

  return (
    <MissionControl
      dashboard={dashboard}
      status={status}
      runtime={busy && runtime.phase === "idle" ? { ...runtime, phase: "checking-session" } : runtime}
      feasibility={feasibility}
      preferences={preferences}
      hasEverSynced={status.lastSuccessfulSyncAt !== null}
      announcement={announcement}
      now={now}
      tenantOrigin={host.tenantOrigin}
      dismissals={dismissals}
      actions={actions}
    />
  );
};
