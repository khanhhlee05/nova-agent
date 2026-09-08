import type { FeasibilityReport } from "@nova-agent/brightspace";
import { isSafeTenantLink } from "@nova-agent/brightspace";
import type { DeadlineBucket } from "@nova-agent/core";
import { CheckCheck, EyeOff } from "lucide-react";
import { Tabs, Tooltip } from "radix-ui";
import { useCallback, useEffect, useState } from "react";
import type { SyncStatusRecord } from "../storage/novaDb";
import { PHASE_LABELS, isRunningPhase, isStale, type SyncRuntimeState } from "../sync/syncState";
import { StateBanners, SyncProgress } from "./components/Banners";
import { ChangesFeed } from "./components/ChangesFeed";
import { CountsStrip } from "./components/CountsStrip";
import { CourseFilter } from "./components/CourseFilter";
import { COLLAPSIBLE_SECTIONS, DeadlineSections } from "./components/DeadlineSections";
import { FieldHeader, Hero, freshness } from "./components/FieldHeader";
import { FirstRun } from "./components/FirstRun";
import { FocusHero } from "./components/FocusHero";
import { Menu } from "./components/Menu";
import { FocusSkeleton } from "./components/Skeleton";
import { WeekStrip } from "./components/WeekStrip";
import { WeekView } from "./components/WeekView";
import { countDismissed, type SessionDismissals } from "./dismissals";
import { format } from "date-fns";
import { pluralize } from "./format";
import { changesHero, weekHero } from "./heroes";
import type { CourseFilter as CourseFilterValue, Dashboard } from "./model";
import { applyTheme, type Theme } from "./theme";

export type TabId = "focus" | "week" | "changes";

export type UiPreferences = { activeTab: TabId; courseFilter: CourseFilterValue; collapsedSections: DeadlineBucket[]; theme: Theme };

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
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const phase = runtime.phase === "idle" ? status.phase : runtime.phase;
  const running = isRunningPhase(phase);
  const stale = isStale(status.lastSuccessfulSyncAt, now);
  const canOpen = useCallback((url: string | null) => isSafeTenantLink(url, tenantOrigin), [tenantOrigin]);
  const collapsed = new Set(preferences.collapsedSections);
  const tab: TabId = preferences.activeTab;

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
    const section = bucket === "no-date" ? "later" : bucket;
    if (section && collapsed.has(section)) actions.setPreferences({ collapsedSections: preferences.collapsedSections.filter((s) => s !== section) });
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
  const fresh = freshness(status.mode, phase, status.lastSuccessfulSyncAt, stale, now);

  const hero = showFirstRun ? (
    <Hero title="Know what changed. Know what matters next." meta="Nova · Mission Control for Brightspace" text="Nova reads your Brightspace courses through your own logged-in session, keeps everything on this device, and never sends academic data anywhere." />
  ) : !dashboard ? (
    running ? (
      <Hero title="Loading your courses" meta={PHASE_LABELS[phase]} text="Your last snapshot appears here as soon as a refresh completes." />
    ) : (
      <Hero title="No data yet" meta={PHASE_LABELS[phase]} text="Nova could not complete a first refresh. Fix the connection below and retry." />
    )
  ) : tab === "week" ? (
    <Hero {...weekHero(dashboard, selectedDay)} extra={<WeekStrip week={dashboard.week} courseById={dashboard.courseById} selected={selectedDay} onSelect={setSelectedDay} />} />
  ) : tab === "changes" ? (
    <Hero
      {...changesHero(dashboard, null, now)}
      actions={
        <>
          <button type="button" className="button button-on-field" onClick={actions.markAllRead} disabled={dashboard.counts.unread === 0}>
            <CheckCheck size={14} aria-hidden="true" />
            Mark all read
          </button>
          <span className="hero-note">
            <strong className="mono">{dashboard.counts.unread}</strong> unread
          </span>
        </>
      }
    />
  ) : (
    <FocusHero nextMove={dashboard.nextMove} course={dashboard.nextMove ? dashboard.courseById.get(dashboard.nextMove.item.courseId) : undefined} now={now} canOpen={canOpen(dashboard.nextMove?.item.url ?? null)} onOpen={actions.openUrl} onInspect={inspect} onDismiss={actions.dismissItem} />
  );

  const tabs = showFirstRun ? null : (
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
  );

  const filterNote =
    tab === "focus" ? (
      format(now, "EEE, MMM d")
    ) : tab === "week" ? (
      selectedDay ? (
        <button type="button" className="button button-ghost button-sm" onClick={() => setSelectedDay(null)}>
          Show all days
        </button>
      ) : (
        "Local time"
      )
    ) : (
      "Newest first"
    );

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="panel">
        <Tabs.Root className="panel-root" value={tab} onValueChange={(value) => actions.setPreferences({ activeTab: value as TabId })}>
          <FieldHeader
            freshness={fresh}
            theme={theme}
            onThemeChange={(next) => actions.setPreferences({ theme: next })}
            onRefresh={actions.refresh}
            refreshing={running}
            refreshDisabled={showFirstRun}
            menu={<Menu mode={status.mode} feasibility={feasibility} busy={running} onConnectLive={actions.connectLive} onUseDemo={actions.useDemoData} onClearData={actions.clearData} />}
            hero={hero}
            counts={tab === "focus" && dashboard ? <CountsStrip counts={dashboard.counts} onSelect={jumpTo} /> : undefined}
            tabs={tabs}
          />
          <SyncProgress phase={phase} progress={runtime.progress} showLabel={!!dashboard} />
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement ?? ""}
          </p>
          {showFirstRun ? (
            <div className="tab-content">
              <FirstRun busy={running} onConnectLive={actions.connectLive} onUseDemo={actions.useDemoData} />
            </div>
          ) : (
            <>
              {hiddenCount > 0 ? (
                <div className="hidden-bar" role="status">
                  <EyeOff size={14} aria-hidden="true" />
                  <span>{pluralize(hiddenCount, "item")} hidden until the next refresh</span>
                  <button type="button" className="button button-ghost button-sm" onClick={actions.restoreDismissed}>
                    Show all
                  </button>
                </div>
              ) : null}
              <div className="filter-row">
                <CourseFilter courses={dashboard?.courses ?? []} value={preferences.courseFilter} onChange={(courseFilter) => actions.setPreferences({ courseFilter })} />
                <span className="spacer" />
                <span className="filter-note">{filterNote}</span>
              </div>
              <Tabs.Content className="tab-content" value="focus">
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
                    dashboard.items.length === 0 ? (
                      <div className="empty">
                        <strong>No assignments or quizzes yet</strong>
                        <span>{preferences.courseFilter ? "This course has nothing visible. Try All courses." : "Nova found no visible assignments or quizzes in your active courses."}</span>
                      </div>
                    ) : (
                      <DeadlineSections dashboard={dashboard} now={now} collapsed={collapsed} onToggle={(bucket) => actions.setPreferences({ collapsedSections: collapsed.has(bucket) ? preferences.collapsedSections.filter((section) => section !== bucket) : [...preferences.collapsedSections, bucket] })} onToggleAll={(collapseAll) => actions.setPreferences({ collapsedSections: collapseAll ? [...COLLAPSIBLE_SECTIONS] : [] })} expandedKey={expandedKey} onExpand={setExpandedKey} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} />
                    )
                  ) : (
                    <div className="empty">
                      <strong>No data yet</strong>
                      <span>Nova could not complete a first refresh. Fix the connection above and retry.</span>
                    </div>
                  )}
                </div>
              </Tabs.Content>
              <Tabs.Content className="tab-content" value="week">
                {dashboard ? <WeekView dashboard={dashboard} now={now} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} selectedDay={selectedDay} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
              </Tabs.Content>
              <Tabs.Content className="tab-content" value="changes">
                {dashboard ? <ChangesFeed dashboard={dashboard} now={now} baselineOnly={dashboard.totalChanges === 0 && hasEverSynced} canOpen={canOpen} onOpen={actions.openUrl} onSetRead={actions.setEventRead} onDismiss={actions.dismissEvent} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
              </Tabs.Content>
            </>
          )}
        </Tabs.Root>
      </div>
    </Tooltip.Provider>
  );
};
