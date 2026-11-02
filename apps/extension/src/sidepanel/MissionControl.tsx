import type { FeasibilityReport } from "@nova-agent/brightspace";
import { isSafeTenantLink } from "@nova-agent/brightspace";
import { compactSnapshot } from "@nova-agent/agent";
import type { ChangeEvent } from "@nova-agent/core";
import type { ChatMessage, ChatRequest } from "@nova-agent/protocol";
import { CheckCheck, EyeOff, Plus } from "lucide-react";
import { Tabs, Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AskChips, AskView, useAskThread, type AskClient, type AskClientFactory, type AskSettings } from "./ask";
import type { SyncStatusRecord } from "../storage/novaDb";
import { PHASE_LABELS, isRunningPhase, isStale, type SyncRuntimeState } from "../sync/syncState";
import { StateBanners, SyncProgress } from "./components/Banners";
import { UndoToast } from "./components/UndoToast";
import { ChangesFeed } from "./components/ChangesFeed";
import { CountsStrip } from "./components/CountsStrip";
import { CourseFilter } from "./components/CourseFilter";
import { DeadlineDialog, type DeadlineDraft } from "./components/DeadlineDialog";
import { FieldHeader, Hero, freshness } from "./components/FieldHeader";
import { FirstRun } from "./components/FirstRun";
import { FocusCategories } from "./components/FocusCategories";
import { FocusHero } from "./components/FocusHero";
import { FocusList } from "./components/FocusList";
import { Menu } from "./components/Menu";
import { FocusSkeleton } from "./components/Skeleton";
import { SortSelect } from "./components/SortSelect";
import { WeekNav } from "./components/WeekNav";
import { WeekStrip } from "./components/WeekStrip";
import { WeekView } from "./components/WeekView";
import { countDismissed, type SessionDismissals } from "./dismissals";
import { format } from "date-fns";
import { pluralize } from "./format";
import { askHero, changesHero, weekHero } from "./heroes";
import { focusCategoryOf, lastWeekOffset, weekPage, type CourseFilter as CourseFilterValue, type Dashboard, type FocusCategory, type PersonalDeadline, type SortKey } from "./model";
import { applyTheme, type Theme } from "./theme";

export type TabId = "focus" | "week" | "changes" | "ask";

export type UiPreferences = {
  activeTab: TabId;
  courseFilter: CourseFilterValue;
  /** The Focus category the student picked. `null` until they pick one: Overdue when anything is overdue, Upcoming otherwise. */
  focusCategory: FocusCategory | null;
  sort: SortKey;
  theme: Theme;
};

export const DEFAULT_PREFERENCES: UiPreferences = { activeTab: "focus", courseFilter: null, focusCategory: null, sort: "due", theme: "light" };

/** Older stored preferences lack the newer keys; every reader fills them from the defaults. */
export const withPreferenceDefaults = (stored: Partial<UiPreferences> | null | undefined): UiPreferences => ({ ...DEFAULT_PREFERENCES, ...stored });

/** Where the panel opens when the student has not chosen a category yet. */
export const effectiveFocusCategory = (preferences: Pick<UiPreferences, "focusCategory">, dashboard: Pick<Dashboard, "counts"> | null): FocusCategory =>
  preferences.focusCategory ?? (dashboard && dashboard.counts.overdue > 0 ? "overdue" : "upcoming");

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
  /** Sets or clears the on-device done mark. Brightspace is never written to. */
  setLocalDone: (key: string, title: string, done: boolean) => void;
  /** The student's own deadlines, Week tab only. Optional so callers without them still work. */
  addPersonal?: (draft: DeadlineDraft) => void;
  updatePersonal?: (id: string, draft: DeadlineDraft) => void;
  /** Permanent after the Undo window, like deleting a change. */
  deletePersonal?: (id: string, title: string) => void;
  setPersonalDone?: (id: string, title: string, done: boolean) => void;
  /** Permanently deletes a change event; it will not return on the next refresh. */
  deleteEvent: (id: string, title: string) => void;
  dismissBanner: (id: string) => void;
  restoreDismissed: () => void;
  /** Brings back a change deleted within the last few seconds. Optional so callers without Undo still work. */
  undoDelete?: () => void;
};

/** Everything the Ask tab needs. Optional so existing callers and tests are untouched. */
export type AskProps = {
  client: AskClient | null;
  settings: AskSettings;
  setSettings: (patch: Partial<AskSettings>) => void;
  clientFactory: AskClientFactory;
  /** Raw change events; the compact snapshot is built from them, ignoring the course filter. */
  events: readonly ChangeEvent[];
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
  ask?: AskProps;
  /** A change deleted moments ago that can still be restored. */
  pendingDelete?: { id: string; title: string } | null;
};

const CLIENT_VERSION = "0.1.0";

/** Presentational root. Everything it needs arrives through props so tests and the preview harness can drive every state. */
export const MissionControl = ({ dashboard, status, runtime, feasibility, preferences, hasEverSynced, announcement, now, tenantOrigin, dismissals, actions, ask, pendingDelete = null }: MissionControlProps) => {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // Session-only: which seven days the Week tab shows. Paging drops any selected day, since it belongs to the page it was picked on.
  const [weekOffset, setWeekOffset] = useState(0);
  const page = useMemo(() => (dashboard ? weekPage(dashboard, now, weekOffset) : null), [dashboard, now, weekOffset]);
  const lastOffset = useMemo(() => (dashboard ? lastWeekOffset(dashboard, now) : 0), [dashboard, now]);
  const goToWeek = (offset: number) => {
    setWeekOffset(Math.max(0, Math.min(offset, lastOffset)));
    setSelectedDay(null);
  };
  // The add/edit dialog for the student's own deadlines. Adding needs a tapped day; editing carries its own.
  const [deadlineDialog, setDeadlineDialog] = useState<{ date: Date; existing: PersonalDeadline | null } | null>(null);
  const selectedDate = page && selectedDay ? (page.days.find((day) => format(day.date, "yyyy-MM-dd") === selectedDay)?.date ?? null) : null;
  const personalActions =
    actions.addPersonal && actions.updatePersonal && actions.deletePersonal && actions.setPersonalDone
      ? {
          onAdd: (date: Date) => setDeadlineDialog({ date, existing: null }),
          onEdit: (deadline: PersonalDeadline) => setDeadlineDialog({ date: new Date(deadline.dueAt), existing: deadline }),
          onDelete: (deadline: PersonalDeadline) => actions.deletePersonal?.(deadline.id, deadline.title),
          onSetDone: (deadline: PersonalDeadline, done: boolean) => actions.setPersonalDone?.(deadline.id, deadline.title, done),
        }
      : undefined;
  // Session-only: items overdue for more than two weeks stay folded away until asked for, every time the panel opens.
  const [showLongOverdue, setShowLongOverdue] = useState(false);
  const phase = runtime.phase === "idle" ? status.phase : runtime.phase;
  const running = isRunningPhase(phase);
  const stale = isStale(status.lastSuccessfulSyncAt, now);
  const canOpen = useCallback((url: string | null) => isSafeTenantLink(url, tenantOrigin), [tenantOrigin]);
  const tab: TabId = preferences.activeTab;
  const category = effectiveFocusCategory(preferences, dashboard);

  // The thread lives here so the hero's suggestion chips and the tab body share one conversation. Inert without `ask`.
  const buildRequest = useCallback(
    (message: string, history: ChatMessage[]): ChatRequest | null =>
      dashboard && ask
        ? {
            message,
            history,
            snapshot: compactSnapshot(dashboard.snapshot, ask.events, now, { mode: status.mode === "fixture" ? "demo" : "live", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
            client: { name: "nova-extension", version: CLIENT_VERSION },
          }
        : null,
    [ask, dashboard, now, status.mode],
  );
  const thread = useAskThread(ask?.client ?? null, buildRequest);

  useEffect(() => {
    setExpandedKey(null);
  }, [preferences.courseFilter]);

  const theme: Theme = preferences.theme ?? "light";
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // "Why this first?" opens the item's row: switch to the category that holds it, then expand.
  const inspect = (key: string) => {
    const item = dashboard?.itemByKey.get(key);
    if (!item || !dashboard) return;
    const bucket = (Object.keys(dashboard.buckets) as (keyof typeof dashboard.buckets)[]).find((candidate) => dashboard.buckets[candidate].some((entry) => entry.key === key));
    const target = bucket ? focusCategoryOf(bucket) : "upcoming";
    if (target !== category) actions.setPreferences({ focusCategory: target });
    setExpandedKey(key);
    requestAnimationFrame(() => document.getElementById(`details-${key.replace(/[^a-z0-9]+/gi, "-")}`)?.scrollIntoView({ block: "nearest" }));
  };

  const jumpTo = (target: "overdue" | "this-week" | "changes") => {
    if (target === "overdue") {
      actions.setPreferences({ activeTab: "focus", focusCategory: "overdue" });
      return;
    }
    if (target === "this-week") goToWeek(0);
    actions.setPreferences({ activeTab: target === "changes" ? "changes" : "week" });
  };

  const showFirstRun = !dashboard && !hasEverSynced && !running && status.lastAttemptedSyncAt === null;
  const showSkeleton = !dashboard && running;
  const hiddenCount = dashboard ? dashboard.hidden.items + dismissals.banners.size : countDismissed(dismissals);
  const fresh = freshness(status.mode, phase, status.lastSuccessfulSyncAt, stale, now);

  // The same notices head every tab: a broken connection must be visible wherever the student is looking.
  const stateBanners = (
    <div className="state-banners">
      <StateBanners
        mode={status.mode}
        showDemo={tab !== "ask"}
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
    </div>
  );

  const hero = showFirstRun ? (
    <Hero title="Know what changed. Know what matters next." meta="Nova · Mission Control for Brightspace" text="Nova reads your Brightspace courses through your own logged-in session and keeps everything on this device. Nothing leaves it unless you turn on Ask Nova." />
  ) : !dashboard ? (
    running ? (
      <Hero title="Loading your courses" meta={PHASE_LABELS[phase]} text="Your last snapshot appears here as soon as a refresh completes." />
    ) : (
      <Hero title="No data yet" meta={PHASE_LABELS[phase]} text="Nova could not complete a first refresh. Fix the connection below and retry." />
    )
  ) : tab === "ask" && ask ? (
    <Hero {...askHero(dashboard, ask.settings.enabled, status.lastSuccessfulSyncAt, now)} extra={ask.settings.enabled ? <AskChips dashboard={dashboard} disabled={thread.status === "streaming" || !ask.client} onPick={thread.send} /> : undefined} />
  ) : tab === "week" && page ? (
    <Hero
      {...weekHero(dashboard, selectedDay, page)}
      actions={
        personalActions && selectedDate ? (
          <button type="button" className="button button-on-field" onClick={() => personalActions.onAdd(selectedDate)}>
            <Plus size={14} aria-hidden="true" />
            Add your own deadline
          </button>
        ) : undefined
      }
      extra={
        <>
          <WeekNav page={page} lastOffset={lastOffset} onChange={goToWeek} />
          <WeekStrip week={page.days} offset={page.offset} courseById={dashboard.courseById} selected={selectedDay} onSelect={setSelectedDay} />
        </>
      }
    />
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
      {ask ? (
        <Tabs.Trigger className="tab-trigger" value="ask">
          Ask
        </Tabs.Trigger>
      ) : null}
    </Tabs.List>
  );

  const filterNote =
    tab === "week" ? (
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
        <a
          href="#panel-main"
          className="skip-link"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById("panel-main")?.focus();
          }}
        >
          Skip to content
        </a>
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
          <main id="panel-main" className="panel-main" tabIndex={-1} aria-label="Content">
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
              {tab === "focus" && dashboard ? (
                <div className="focus-controls">
                  <FocusCategories value={category} counts={{ overdue: dashboard.buckets.overdue.length, upcoming: dashboard.items.length - dashboard.buckets.overdue.length - dashboard.buckets.completed.length, completed: dashboard.buckets.completed.length }} onChange={(focusCategory) => actions.setPreferences({ focusCategory })} />
                  <div className="filter-row">
                    <CourseFilter courses={dashboard.courses} value={preferences.courseFilter} onChange={(courseFilter) => actions.setPreferences({ courseFilter })} />
                    <span className="spacer" />
                    <SortSelect value={preferences.sort} onChange={(sort) => actions.setPreferences({ sort })} />
                  </div>
                </div>
              ) : tab !== "ask" ? (
                <div className="filter-row">
                  <CourseFilter courses={dashboard?.courses ?? []} value={preferences.courseFilter} onChange={(courseFilter) => actions.setPreferences({ courseFilter })} />
                  <span className="spacer" />
                  <span className="filter-note">{filterNote}</span>
                </div>
              ) : null}
              <Tabs.Content className="tab-content" value="focus">
                <div className="stack">
                  {stateBanners}
                  {showSkeleton ? (
                    <FocusSkeleton />
                  ) : dashboard ? (
                    dashboard.items.length === 0 ? (
                      <div className="empty">
                        <strong>No assignments or quizzes yet</strong>
                        <span>{preferences.courseFilter ? "This course has nothing visible. Try All courses." : "Nova found no visible assignments or quizzes in your active courses."}</span>
                      </div>
                    ) : (
                      <FocusList dashboard={dashboard} category={category} sort={preferences.sort} now={now} courseFiltered={preferences.courseFilter !== null} expandedKey={expandedKey} onExpand={setExpandedKey} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} onSetDone={actions.setLocalDone} showLongOverdue={showLongOverdue} onToggleLongOverdue={() => setShowLongOverdue((value) => !value)} />
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
                {stateBanners}
                {dashboard && page ? <WeekView dashboard={dashboard} days={page.days} now={now} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} selectedDay={selectedDay} personal={personalActions} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
              </Tabs.Content>
              <Tabs.Content className="tab-content" value="changes">
                {stateBanners}
                {dashboard ? <ChangesFeed dashboard={dashboard} now={now} baselineOnly={dashboard.totalChanges === 0 && hasEverSynced} canOpen={canOpen} onOpen={actions.openUrl} onSetRead={actions.setEventRead} onDelete={actions.deleteEvent} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
              </Tabs.Content>
              {ask ? (
                // Force-mounted and hidden so the conversation survives a switch to another tab.
                <Tabs.Content className="tab-content tab-content-ask" value="ask" forceMount hidden={tab !== "ask"}>
                  {dashboard ? (
                    <AskView notices={tab === "ask" ? stateBanners : null} thread={thread} settings={ask.settings} onSettingsChange={ask.setSettings} clientFactory={ask.clientFactory} dashboard={dashboard} mode={status.mode} now={now} canOpen={canOpen} onOpen={actions.openUrl} />
                  ) : showSkeleton ? (
                    <FocusSkeleton />
                  ) : (
                    <div className="ask-thread">
                      {stateBanners}
                      <div className="empty">
                        <strong>No data yet</strong>
                        <span>Ask Nova needs a completed refresh first.</span>
                      </div>
                    </div>
                  )}
                </Tabs.Content>
              ) : null}
            </>
          )}
          </main>
        </Tabs.Root>
        {pendingDelete && actions.undoDelete ? <UndoToast key={pendingDelete.id} message={`Deleted "${pendingDelete.title}"`} onUndo={actions.undoDelete} /> : null}
        {deadlineDialog && dashboard ? (
          <DeadlineDialog
            date={deadlineDialog.date}
            courses={dashboard.courses}
            existing={deadlineDialog.existing}
            onClose={() => setDeadlineDialog(null)}
            onSave={(draft) => {
              if (deadlineDialog.existing) actions.updatePersonal?.(deadlineDialog.existing.id, draft);
              else actions.addPersonal?.(draft);
              setDeadlineDialog(null);
            }}
          />
        ) : null}
      </div>
    </Tooltip.Provider>
  );
};
