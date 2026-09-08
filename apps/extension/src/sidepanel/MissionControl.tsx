import type { FeasibilityReport } from "@nova-agent/brightspace";
import { isSafeTenantLink } from "@nova-agent/brightspace";
import type { DeadlineBucket } from "@nova-agent/core";
import { EyeOff } from "lucide-react";
import { Tabs, Tooltip } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncStatusRecord } from "../storage/novaDb";
import { isRunningPhase, isStale, type SyncRuntimeState } from "../sync/syncState";
import { StateBanners, SyncProgress } from "./components/Banners";
import { ChangesFeed } from "./components/ChangesFeed";
import { DeadlineSections } from "./components/DeadlineSections";
import { FirstRun } from "./components/FirstRun";
import { Menu } from "./components/Menu";
import { NextMoveCard } from "./components/NextMoveCard";
import { FocusSkeleton } from "./components/Skeleton";
import { SummaryChips } from "./components/SummaryChips";
import { TopBar } from "./components/TopBar";
import { WeekView } from "./components/WeekView";
import { countDismissed, type SessionDismissals } from "./dismissals";
import { pluralize } from "./format";
import { applyTheme, type Theme } from "./theme";
import type { CourseFilter, Dashboard } from "./model";

export type TabId = "focus" | "week" | "changes";

export type UiPreferences = { activeTab: TabId; courseFilter: CourseFilter; collapsedSections: DeadlineBucket[]; theme: Theme };

export const DEFAULT_PREFERENCES: UiPreferences = { activeTab: "focus", courseFilter: null, collapsedSections: ["completed", "later"], theme: "light" };

export type MissionControlActions = {
  refresh: () => void;
  setPreferences: (patch: Partial<UiPreferences>) => void;
  markAllRead: () => void;
  setEventRead: (id: string, read: boolean) => void;
  openUrl: (url: string) => void;
  connectLive: () => void;
  useDemoData: () => void;
  clearData: () => Promise<void> | void;
  /** Session-only: hides an item everywhere until the next refresh. */
  dismissItem: (key: string, title: string) => void;
  dismissEvent: (id: string, title: string) => void;
  dismissBanner: (id: string) => void;
  restoreDismissed: () => void;
};

export type MissionControlProps = {
  dashboard: Dashboard | null;
  status: SyncStatusRecord;
  runtime: SyncRuntimeState;
  feasibility: FeasibilityReport | null;
  preferences: UiPreferences;
  hasEverSynced: boolean;
  announcement: string | null;
  now: Date;
  tenantOrigin: string;
  dismissals: SessionDismissals;
  actions: MissionControlActions;
};

/** Presentational root. Everything it needs arrives through props so tests and the preview harness can drive every state. */
export const MissionControl = ({ dashboard, status, runtime, feasibility, preferences, hasEverSynced, announcement, now, tenantOrigin, dismissals, actions }: MissionControlProps) => {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const focusRef = useRef<HTMLDivElement>(null);
  const phase = runtime.phase === "idle" ? status.phase : runtime.phase;
  const running = isRunningPhase(phase);
  const stale = isStale(status.lastSuccessfulSyncAt, now);
  const canOpen = useCallback((url: string | null) => isSafeTenantLink(url, tenantOrigin), [tenantOrigin]);
  const collapsed = new Set(preferences.collapsedSections);

  useEffect(() => {
    setExpandedKey(null);
  }, [preferences.courseFilter]);

  const theme: Theme = preferences.theme ?? "light";
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const inspect = (key: string) => {
    const item = dashboard?.itemByKey.get(key);
    if (!item) return;
    const bucket = (Object.keys(dashboard?.buckets ?? {}) as DeadlineBucket[]).find((candidate) => dashboard?.buckets[candidate].some((entry) => entry.key === key));
    if (bucket && collapsed.has(bucket === "no-date" ? "later" : bucket)) actions.setPreferences({ collapsedSections: preferences.collapsedSections.filter((section) => section !== (bucket === "no-date" ? "later" : bucket)) });
    setExpandedKey(key);
    requestAnimationFrame(() => document.getElementById(`details-${key.replace(/[^a-z0-9]+/gi, "-")}`)?.scrollIntoView({ block: "nearest" }));
  };

  const jumpTo = (target: "overdue" | "today" | "this-week" | "changes") => {
    if (target === "changes") {
      actions.setPreferences({ activeTab: "changes" });
      return;
    }
    if (collapsed.has(target)) actions.setPreferences({ collapsedSections: preferences.collapsedSections.filter((section) => section !== target) });
    requestAnimationFrame(() => document.getElementById(`section-${target}`)?.focus());
  };

  const showFirstRun = !dashboard && !hasEverSynced && !running && status.lastAttemptedSyncAt === null;
  const showSkeleton = !dashboard && running;
  const hiddenCount = dashboard ? dashboard.hidden.items + dashboard.hidden.events + dismissals.banners.size : countDismissed(dismissals);

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="panel">
        <TopBar
          mode={status.mode}
          phase={phase}
          lastSuccessfulSyncAt={status.lastSuccessfulSyncAt}
          stale={stale && !!dashboard}
          now={now}
          courses={dashboard?.courses ?? []}
          courseFilter={preferences.courseFilter}
          onCourseFilter={(courseFilter) => actions.setPreferences({ courseFilter })}
          theme={theme}
          onThemeChange={(next) => actions.setPreferences({ theme: next })}
          onRefresh={actions.refresh}
          refreshDisabled={showFirstRun}
          menu={<Menu mode={status.mode} feasibility={feasibility} busy={running} onConnectLive={actions.connectLive} onUseDemo={actions.useDemoData} onClearData={actions.clearData} />}
        />
        <SyncProgress phase={phase} progress={runtime.progress} />
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement ?? ""}
        </p>
        {showFirstRun ? (
          <div className="tab-content">
            <FirstRun busy={running} onConnectLive={actions.connectLive} onUseDemo={actions.useDemoData} />
          </div>
        ) : (
          <Tabs.Root className="panel-body" value={preferences.activeTab} onValueChange={(value) => actions.setPreferences({ activeTab: value as TabId })}>
            <Tabs.List className="tabs-list" aria-label="Mission Control views">
              <Tabs.Trigger className="tab-trigger" value="focus">
                Focus
              </Tabs.Trigger>
              <Tabs.Trigger className="tab-trigger" value="week">
                Week
              </Tabs.Trigger>
              <Tabs.Trigger className="tab-trigger" value="changes">
                Changes
                {dashboard && dashboard.counts.unread > 0 ? (
                  <span className="count-pill" aria-label={`${dashboard.counts.unread} unread`}>
                    {dashboard.counts.unread}
                  </span>
                ) : null}
              </Tabs.Trigger>
            </Tabs.List>
            {hiddenCount > 0 ? (
              <div className="hidden-bar" role="status">
                <EyeOff size={14} aria-hidden="true" />
                <span>{pluralize(hiddenCount, "item")} hidden until the next refresh</span>
                <button type="button" className="button button-ghost button-sm" onClick={actions.restoreDismissed}>
                  Show all
                </button>
              </div>
            ) : null}
            <Tabs.Content className="tab-content" value="focus" ref={focusRef}>
              <div className="stack">
                <StateBanners
                  mode={status.mode}
                  phase={phase}
                  error={runtime.error ?? status.error}
                  warnings={runtime.warnings.length > 0 ? runtime.warnings : status.warnings}
                  failedCourseIds={runtime.failedCourseIds.length > 0 ? runtime.failedCourseIds : status.failedCourseIds}
                  courses={dashboard?.courseById ?? new Map()}
                  lastSuccessfulSyncAt={status.lastSuccessfulSyncAt}
                  lastAttemptedSyncAt={status.lastAttemptedSyncAt}
                  stale={stale}
                  hasData={!!dashboard}
                  now={now}
                  onRefresh={actions.refresh}
                  onConnectLive={actions.connectLive}
                  onOpenBrightspace={() => actions.openUrl(`${tenantOrigin}/d2l/home`)}
                  onUseDemo={actions.useDemoData}
                  dismissed={dismissals.banners}
                  onDismiss={actions.dismissBanner}
                />
                {showSkeleton ? (
                  <FocusSkeleton />
                ) : dashboard ? (
                  <>
                    <SummaryChips counts={dashboard.counts} onSelect={jumpTo} />
                    <NextMoveCard nextMove={dashboard.nextMove} course={dashboard.nextMove ? dashboard.courseById.get(dashboard.nextMove.item.courseId) : undefined} now={now} canOpen={canOpen(dashboard.nextMove?.item.url ?? null)} onOpen={actions.openUrl} onInspect={inspect} onDismiss={actions.dismissItem} />
                    {dashboard.items.length === 0 ? (
                      <div className="empty">
                        <strong>No assignments or quizzes yet</strong>
                        <span>{preferences.courseFilter ? "This course has nothing visible. Try All courses." : "Nova found no visible assignments or quizzes in your active courses."}</span>
                      </div>
                    ) : (
                      <DeadlineSections dashboard={dashboard} now={now} collapsed={collapsed} onToggle={(bucket) => actions.setPreferences({ collapsedSections: collapsed.has(bucket) ? preferences.collapsedSections.filter((section) => section !== bucket) : [...preferences.collapsedSections, bucket] })} expandedKey={expandedKey} onExpand={setExpandedKey} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} />
                    )}
                  </>
                ) : (
                  <div className="empty">
                    <strong>No data yet</strong>
                    <span>Nova could not complete a first refresh. Fix the connection above and retry.</span>
                  </div>
                )}
              </div>
            </Tabs.Content>
            <Tabs.Content className="tab-content" value="week">
              {dashboard ? <WeekView dashboard={dashboard} now={now} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
            </Tabs.Content>
            <Tabs.Content className="tab-content" value="changes">
              {dashboard ? <ChangesFeed dashboard={dashboard} now={now} baselineOnly={dashboard.totalChanges === 0 && hasEverSynced} canOpen={canOpen} onOpen={actions.openUrl} onMarkAllRead={actions.markAllRead} onSetRead={actions.setEventRead} onDismiss={actions.dismissEvent} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
            </Tabs.Content>
          </Tabs.Root>
        )}
      </div>
    </Tooltip.Provider>
  );
};
