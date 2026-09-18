import type { FeasibilityReport } from "@nova-agent/brightspace";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionHost } from "../platform/host";
import type { NovaDb } from "../storage/novaDb";
import { clearAllData, deleteChangeEvent, getPreference, getSyncStatus, listChangeEvents, latestSnapshot, markAllRead, setEventRead, setPreference, unreadCount } from "../storage/repositories";
import { DATA_MODE_PREFERENCE, DEMO_SCENARIO_PREFERENCE, SyncCoordinator, type TransportFactory } from "../sync/syncCoordinator";
import { IDLE_STATE, isRunningPhase, type SyncRuntimeState } from "../sync/syncState";
import { ASK_SETTINGS_PREFERENCE, DEFAULT_ASK_SETTINGS, defaultAskClientFactory, effectiveAskSettings, type AskClientFactory, type AskSettings } from "./ask";
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
  /** Builds the Ask Nova client from settings. The preview harness and tests inject an in-process one. */
  askClientFactory?: AskClientFactory;
  /** How long a deleted change can be restored before it is removed for good. */
  undoMs?: number;
};

type PendingDelete = { id: string; title: string };

const PREFERENCES_KEY = "ui.preferences";

export const App = ({ db, host, now: nowFn, transportFactory, autoSync = true, askClientFactory = defaultAskClientFactory, undoMs = 5000 }: AppDeps) => {
  const now = useNow(60_000, nowFn);
  // Every timestamp the panel writes comes from the same injected clock as the one it reads with.
  const clock = useCallback(() => (nowFn ? nowFn() : new Date()), [nowFn]);
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
  // A saved address that no longer passes the https rule turns Ask off rather than producing a client.
  const askSettings = useLiveQuery(async () => effectiveAskSettings(await getPreference<AskSettings>(db, ASK_SETTINGS_PREFERENCE, DEFAULT_ASK_SETTINGS)), [db]);
  const askClient = useMemo(() => (askSettings?.enabled ? askClientFactory(askSettings) : null), [askClientFactory, askSettings]);
  const setAskSettings = useCallback(
    (patch: Partial<AskSettings>) => {
      void setPreference(db, ASK_SETTINGS_PREFERENCE, { ...(askSettings ?? DEFAULT_ASK_SETTINGS), ...patch });
    },
    [askSettings, db],
  );

  // Session-only dismissals: forgotten when the panel closes, restored whenever fresh data arrives.
  const { dismissals, dismissItem, dismissBanner, restoreAll } = useSessionDismissals(snapshot?.capturedAt ?? null);

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

  // A deleted change leaves the feed at once but stays in the database until its Undo window closes.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const pending = useRef<{ entry: PendingDelete; timer: ReturnType<typeof setTimeout> } | null>(null);
  const commitDelete = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    clearTimeout(current.timer);
    pending.current = null;
    setPendingDelete(null);
    void deleteChangeEvent(db, current.entry.id).then(publishBadge);
  }, [db, publishBadge]);
  // Closing the panel inside the window still deletes: the student asked for it and never pressed Undo.
  const commitLatest = useRef(commitDelete);
  commitLatest.current = commitDelete;
  useEffect(() => {
    const flush = () => commitLatest.current();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  const visibleEvents = useMemo(() => (events && pendingDelete ? events.filter((event) => event.id !== pendingDelete.id) : events), [events, pendingDelete]);

  const dashboard = useMemo(
    () =>
      snapshot && visibleEvents && preferences
        ? buildDashboard({ snapshot, events: visibleEvents, now, courseFilter: preferences.courseFilter, dismissedItemKeys: dismissals.items })
        : null,
    [snapshot, visibleEvents, now, preferences, dismissals],
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
      deleteEvent: (id: string, title: string) => {
        // One Undo at a time: a second delete makes the first one final.
        commitDelete();
        const entry = { id, title };
        pending.current = { entry, timer: setTimeout(commitDelete, undoMs) };
        setPendingDelete(entry);
        setAnnouncement(`Deleted the change for "${title}". Undo to restore it.`);
      },
      undoDelete: () => {
        const current = pending.current;
        if (!current) return;
        clearTimeout(current.timer);
        pending.current = null;
        setPendingDelete(null);
        setAnnouncement(`Restored the change for "${current.entry.title}".`);
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
        void markAllRead(db, scope, clock().toISOString()).then(publishBadge);
      },
      setEventRead: (id: string, read: boolean) => {
        void setEventRead(db, id, read ? clock().toISOString() : null).then(publishBadge);
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
    [clock, commitDelete, coordinator, db, dismissBanner, dismissItem, host, nowFn, publishBadge, restoreAll, scope, setPreferences, undoMs],
  );

  if (!status || !preferences || feasibility === undefined || !askSettings) return null;

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
      pendingDelete={pendingDelete}
      ask={{ client: askClient, settings: askSettings, setSettings: setAskSettings, clientFactory: askClientFactory, events: visibleEvents ?? [] }}
    />
  );
};
