import type { FeasibilityReport, FileAccessReport } from "@nova-agent/brightspace";
import { isSafeTenantLink } from "@nova-agent/brightspace";
import { compactSnapshot, shortId } from "@nova-agent/agent";
import type { AcademicItem, ChangeEvent, DeadlineBucket } from "@nova-agent/core";
import type { ChatRequest, ClientToolName } from "@nova-agent/protocol";
import { CheckCheck, EyeOff, Plus } from "lucide-react";
import { Tabs, Tooltip } from "radix-ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AskChips, AskView, canUndo, resolveProposal, summaryOf, feedbackEntry, useAskThread, useServerUsage, type AskAbout, type AskProposal, type ProposalAction, type ProposalApplied, type ProposalContext, type AskClient, type AskClientFactory, type AskConsent, type AskDraft, type AskFeedbackControls, type AskFeedbackView, type AskHandlers, type AskMaterialsControls, type AskLive, type AskMessage, type AskRequestContext, type AskSettings, type ConversationStore, type PlanDraft } from "./ask";
import type { SyncStatusRecord } from "../storage/novaDb";
import { PHASE_LABELS, isRunningPhase, isStale, type SyncRuntimeState } from "../sync/syncState";
import { StateBanners, SyncProgress } from "./components/Banners";
import { UndoToast } from "./components/UndoToast";
import { ChangesFeed } from "./components/ChangesFeed";
import { CountsStrip } from "./components/CountsStrip";
import { CourseFilter } from "./components/CourseFilter";
import { DeadlineDialog, type DeadlineDraft } from "./components/DeadlineDialog";
import type { AttachmentControls } from "./components/ItemFiles";
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
import { format, startOfDay } from "date-fns";
import { pluralize } from "./format";
import { askHero, changesHero, weekHero } from "./heroes";
import { changeTitle, focusCategoryOf, lastWeekOffset, weekPage, type CourseFilter as CourseFilterValue, type Dashboard, type FocusCategory, type PersonalDeadline, type SortKey } from "./model";
import { applyTheme, type Theme } from "./theme";

export type TabId = "focus" | "week" | "changes" | "ask";

export type UiPreferences = {
  activeTab: TabId;
  courseFilter: CourseFilterValue;
  /** The Focus category the student picked. `null` until they pick one: Overdue when anything is overdue, Upcoming otherwise. */
  focusCategory: FocusCategory | null;
  sort: SortKey;
  /** Day groups inside Upcoming the student folded (Today, Tomorrow, Later this week, Later, No due date). */
  collapsedGroups: DeadlineBucket[];
  theme: Theme;
};

export const DEFAULT_PREFERENCES: UiPreferences = { activeTab: "focus", courseFilter: null, focusCategory: null, sort: "due", collapsedGroups: [], theme: "light" };

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
  /** `id` lets the caller name the new deadline so it can find it again; one is made up when absent. */
  addPersonal?: (draft: DeadlineDraft & { id?: string }) => void;
  updatePersonal?: (id: string, draft: DeadlineDraft) => void;
  /** Permanent after the Undo window, like deleting a change. */
  deletePersonal?: (id: string, title: string) => void;
  setPersonalDone?: (id: string, title: string, done: boolean) => void;
  /** Puts a study plan from Ask Nova on the Week tab, replacing any plan added before. */
  addPlanToWeek?: (planId: string, drafts: PlanDraft[]) => void;
  removePlanFromWeek?: (planId: string) => void;
  /** Permanently deletes a change event; it will not return on the next refresh. */
  deleteEvent: (id: string, title: string) => void;
  dismissBanner: (id: string) => void;
  restoreDismissed: () => void;
  /** Brings back a change deleted within the last few seconds. Optional so callers without Undo still work. */
  undoDelete?: () => void;
  /** Asks Brightspace whether it serves assignment files to this session and adds the answer to the connection report. */
  checkFileAccess?: () => void;
};

/** Everything the Ask tab needs. Optional so existing callers and tests are untouched. */
export type AskProps = {
  client: AskClient | null;
  settings: AskSettings;
  setSettings: (patch: Partial<AskSettings>) => void;
  clientFactory: AskClientFactory;
  /** Raw change events; the compact snapshot is built from them, ignoring the course filter. */
  events: readonly ChangeEvent[];
  /** Every done mark on this device, item key to when, for all courses. Optional so older callers still work. */
  localMarks?: ReadonlyMap<string, string>;
  /** Every deadline the student added by hand, for all courses. */
  personal?: readonly PersonalDeadline[];
  /** Where saved conversations live. Used only while the student has saving turned on. */
  conversations?: ConversationStore;
  /** The lookups this panel can make on the device for a turn, and the function that makes them. */
  clientTools?: { names: readonly ClientToolName[]; run: NonNullable<AskHandlers["clientTool"]> };
  /** The permission card for reading a file or a course's materials. */
  consent?: AskConsent;
  /** Course materials, course by course. */
  materials?: AskMaterialsControls;
  /** Ratings of answers, stored on this device. */
  feedback?: AskFeedbackControls;
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
  /** Reading assignment files from an item's details. Present while Ask Nova may read them. */
  attachments?: AttachmentControls;
  /** A change deleted moments ago that can still be restored. */
  pendingDelete?: { id: string; title: string } | null;
  /** True while the file access check runs. */
  checkingFiles?: boolean;
  /** The last file access check, shown in the connection report. */
  fileAccess?: FileAccessReport | null;
};

const CLIENT_VERSION = "0.1.0";

/** Presentational root. Everything it needs arrives through props so tests and the preview harness can drive every state. */
export const MissionControl = ({ dashboard, status, runtime, feasibility, preferences, hasEverSynced, announcement, now, tenantOrigin, dismissals, actions, ask, attachments, pendingDelete = null, checkingFiles = false, fileAccess = null }: MissionControlProps) => {
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
  const collapsedGroups = new Set<DeadlineBucket>(preferences.collapsedGroups ?? []);
  const toggleGroup = (bucket: DeadlineBucket) =>
    actions.setPreferences({ collapsedGroups: collapsedGroups.has(bucket) ? (preferences.collapsedGroups ?? []).filter((entry) => entry !== bucket) : [...(preferences.collapsedGroups ?? []), bucket] });
  const toggleAllGroups = (buckets: readonly DeadlineBucket[], collapse: boolean) =>
    actions.setPreferences({ collapsedGroups: collapse ? [...new Set([...(preferences.collapsedGroups ?? []), ...buckets])] : (preferences.collapsedGroups ?? []).filter((entry) => !buckets.includes(entry)) });

  // The tab the student was on before Ask, sent as a hint with each question.
  const lastTab = useRef<Exclude<TabId, "ask">>("focus");
  if (tab !== "ask") lastTab.current = tab;

  // The thread lives here so the hero's suggestion chips and the tab body share one conversation. Inert without `ask`.
  const buildRequest = useCallback(
    (message: string, context: AskRequestContext): ChatRequest | null =>
      dashboard && ask
        ? {
            message,
            history: context.history,
            ...(context.summary ? { summary: context.summary } : {}),
            // Built from the whole snapshot, not the filtered dashboard: Ask covers every course, and honors what the panel honors.
            snapshot: compactSnapshot(dashboard.snapshot, ask.events, now, {
              mode: status.mode === "fixture" ? "demo" : "live",
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              localDone: ask.localMarks,
              dismissedItemKeys: dismissals.items,
              personal: ask.personal,
              includeAttachments: ask.clientTools?.names.includes("read_attachment") === true,
              // Topic names go only for the courses the student turned on; the field's presence is what says "this course can be searched".
              materials: new Map((ask.materials?.courses ?? []).filter((entry) => entry.allowed).map((entry) => [entry.course.id, (entry.topics ?? []).map((topic) => ({ id: topic.id, title: topic.title, modulePath: topic.modulePath, type: topic.type, read: entry.readIds.has(topic.id) }))])),
            }),
            focus: { courseId: preferences.courseFilter, tab: lastTab.current, ...(context.focusItemId ? { itemId: context.focusItemId } : {}) },
            ...(ask.clientTools && ask.clientTools.names.length > 0 ? { clientTools: [...ask.clientTools.names] } : {}),
            // This panel shows text as it is written and can take back a draft.
            streamText: true,
            client: { name: "nova-extension", version: CLIENT_VERSION },
          }
        : null,
    [ask, dashboard, dismissals.items, now, preferences.courseFilter, status.mode],
  );
  const runClientTool = ask?.clientTools?.run;
  const askHandlers = useMemo<AskHandlers | undefined>(() => (runClientTool ? { clientTool: runClientTool } : undefined), [runClientTool]);
  const thread = useAskThread(ask?.client ?? null, buildRequest, summaryOf, askHandlers);

  // After the student allows a course's materials, the question is asked again once the reading has finished and
  // the panel has re-rendered with what was read, so the new request carries it.
  const [awaitingMaterials, setAwaitingMaterials] = useState(false);
  const consentPending = ask?.consent?.pending ?? null;
  useEffect(() => {
    if (!awaitingMaterials || consentPending !== null || thread.status !== "idle") return;
    setAwaitingMaterials(false);
    thread.retryLast();
  }, [awaitingMaterials, consentPending, thread]);
  // The server's use for the day is read when the Ask tab is shown and after each answer.
  const answered = thread.messages.filter((message) => message.role === "assistant" && (message.grounded !== null || message.error !== null)).length;
  const serverUsage = useServerUsage(ask?.settings.enabled ? (ask.client ?? null) : null, tab === "ask", answered);

  // "/" goes to the composer from anywhere in the panel, unless the student is typing somewhere or a dialog is open.
  const [composerFocus, setComposerFocus] = useState(0);
  const [slashPending, setSlashPending] = useState(false);
  const askEnabled = ask?.settings.enabled === true;
  const setPreferences = actions.setPreferences;
  useEffect(() => {
    if (!askEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      event.preventDefault();
      setPreferences({ activeTab: "ask" });
      setSlashPending(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [askEnabled, setPreferences]);

  // The composer can only take focus once its tab is showing, which may be a moment after the key.
  useEffect(() => {
    if (!slashPending || tab !== "ask") return;
    setSlashPending(false);
    setComposerFocus((count) => count + 1);
  }, [slashPending, tab]);

  const feedbackControls = ask?.feedback;
  const feedbackView = useMemo<AskFeedbackView | undefined>(
    () =>
      feedbackControls
        ? {
            votes: feedbackControls.votes,
            count: feedbackControls.votes.size,
            onExport: feedbackControls.onExport,
            onVote: (messageId, verdict) => {
              const entry = feedbackEntry(thread.messages, messageId, thread.conversationId);
              if (entry) feedbackControls.onVote(entry, verdict);
            },
          }
        : undefined,
    [feedbackControls, thread.conversationId, thread.messages],
  );

  const allowConsent = () => {
    const pending = ask?.consent?.pending;
    if (!pending || !ask?.consent) return;
    ask.consent.onAllow();
    if (pending.kind === "materials") setAwaitingMaterials(true);
    else thread.retryLast();
  };

  // Saving is opt-in. While it is on, the thread is written after every finished answer; the array a save or a
  // restore last saw is remembered so opening a conversation does not count as changing it.
  const store = ask?.conversations;
  const persist = !!store && ask?.settings.persistConversations === true;
  const savedMessages = useRef<AskMessage[] | null>(null);
  useEffect(() => {
    if (!persist || !store || thread.status !== "idle" || thread.messages.length === 0 || thread.messages === savedMessages.current) return;
    savedMessages.current = thread.messages;
    store.save({ id: thread.conversationId, messages: thread.messages });
  }, [persist, store, thread.conversationId, thread.messages, thread.status]);
  const openConversation = (id: string) => {
    void store?.load(id).then((conversation) => {
      if (!conversation) return;
      savedMessages.current = conversation.messages;
      thread.load(conversation);
    });
  };
  const deleteConversation = (id: string) => {
    store?.remove(id);
    if (id === thread.conversationId) {
      savedMessages.current = null;
      thread.clear();
    }
  };

  // A question another tab starts: written into the composer, with the item it is about, and the Ask tab opened.
  const [askDraft, setAskDraft] = useState<AskDraft | null>(null);
  const [askAbout, setAskAbout] = useState<AskAbout | null>(null);
  const draftCount = useRef(0);
  const canAsk = !!ask && ask.settings.enabled && ask.client !== null;
  const startQuestion = (text: string, item: AcademicItem | null) => {
    draftCount.current += 1;
    setAskDraft({ nonce: draftCount.current, text });
    setAskAbout(item ? { itemId: shortId(item.key, item.kind), title: item.title } : null);
    actions.setPreferences({ activeTab: "ask" });
  };
  const askAboutItem = (item: AcademicItem) => startQuestion(dashboard?.changedAt.has(item.key) ? `What changed on "${item.title}"?` : `Why is "${item.title}" ranked where it is?`, item);
  const askAboutChange = (event: ChangeEvent) => startQuestion(`What does this change to "${changeTitle(event)}" mean for me?`, dashboard?.itemByKey.get(event.entityKey) ?? null);
  const askWhyFirst = (key: string) => {
    const item = dashboard?.itemByKey.get(key);
    if (item) startQuestion(`Why is "${item.title}" my next move?`, item);
  };
  const sendFromComposer = (text: string) => {
    thread.send(text, askAbout ? { focusItemId: askAbout.itemId } : {});
    setAskAbout(null);
  };

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
    const patch: Partial<UiPreferences> = {};
    if (target !== category) patch.focusCategory = target;
    if (bucket && collapsedGroups.has(bucket)) patch.collapsedGroups = (preferences.collapsedGroups ?? []).filter((entry) => entry !== bucket);
    if (Object.keys(patch).length > 0) actions.setPreferences(patch);
    setExpandedKey(key);
    requestAnimationFrame(() => document.getElementById(`details-${key.replace(/[^a-z0-9]+/gi, "-")}`)?.scrollIntoView({ block: "nearest" }));
  };

  // "Show on Week" from an answer: the page that holds the deadline, that day picked, and no filter hiding it.
  const showPersonal = (deadline: PersonalDeadline) => {
    const due = startOfDay(new Date(deadline.dueAt));
    const offset = Math.floor((due.getTime() - startOfDay(now).getTime()) / (7 * 86_400_000));
    const patch: Partial<UiPreferences> = { activeTab: "week" };
    if (preferences.courseFilter !== null && deadline.courseId !== preferences.courseFilter) patch.courseFilter = null;
    // The Week tab starts today: a deadline that is already past has no page to show, so the tab opens on this week.
    setWeekOffset(Math.max(0, offset));
    setSelectedDay(offset >= 0 ? format(due, "yyyy-MM-dd") : null);
    actions.setPreferences(patch);
  };

  const askLive: AskLive | undefined = ask
    ? {
        localMarks: ask.localMarks ?? dashboard?.localDone ?? new Map<string, string>(),
        dismissed: dismissals.items,
        events: ask.events,
        personal: ask.personal ?? dashboard?.personal ?? [],
        actions: {
          onSetDone: actions.setLocalDone,
          onDismiss: actions.dismissItem,
          onSetRead: actions.setEventRead,
          onSetPersonalDone: actions.setPersonalDone,
          onShowPersonal: showPersonal,
          onShowCourse: (courseId: string) => actions.setPreferences({ activeTab: "focus", courseFilter: courseId }),
          onAddPlan: actions.addPlanToWeek,
          onRemovePlan: actions.removePlanFromWeek,
        },
      }
    : undefined;

  // Suggestions are read against the same live data the rows read, and carried out by the same handlers the tabs call.
  const proposalContext: ProposalContext | undefined =
    dashboard && askLive ? { items: dashboard.snapshot.items, courseById: dashboard.courseById, localMarks: askLive.localMarks, dismissed: askLive.dismissed, events: askLive.events, personal: askLive.personal } : undefined;
  const onProposal = (messageId: string, proposal: AskProposal, action: ProposalAction) => {
    if (!proposalContext || !dashboard) return;
    if (action === "dismiss") {
      if (proposal.state === "pending") thread.setProposal(messageId, proposal.id, { state: "dismissed" });
      return;
    }
    if (action === "show") {
      const added = proposalContext.personal.find((deadline) => deadline.id === proposal.applied?.personalId);
      if (added) showPersonal(added);
      return;
    }
    if (action === "undo") {
      const applied = proposal.applied;
      if (!canUndo(proposal) || !applied) return;
      const own = proposalContext.personal.find((deadline) => deadline.id === applied.personalId);
      switch (proposal.payload.kind) {
        case "mark_done":
          for (const key of applied.itemKeys ?? []) actions.setLocalDone(key, dashboard.itemByKey.get(key)?.title ?? "Item", false);
          break;
        case "mark_changes_read":
          for (const id of applied.eventIds ?? []) actions.setEventRead(id, false);
          break;
        case "move_personal_deadline":
          if (own && applied.previousDueAt) actions.updatePersonal?.(own.id, { title: own.title, dueAt: applied.previousDueAt, courseId: own.courseId });
          break;
        case "complete_personal_deadline":
          if (own) actions.setPersonalDone?.(own.id, own.title, false);
          break;
        default:
          return;
      }
      thread.setProposal(messageId, proposal.id, { state: "undone", applied: undefined });
      return;
    }
    if (proposal.state !== "pending") return;
    // Read again at the moment of confirming: only what is still true is carried out, and that is what the card records.
    const resolved = resolveProposal(proposal.payload, proposalContext);
    let applied: ProposalApplied = {};
    switch (resolved.kind) {
      case "unavailable":
        return;
      case "mark_done":
        for (const item of resolved.items) actions.setLocalDone(item.key, item.title, true);
        applied = { itemKeys: resolved.items.map((item) => item.key) };
        break;
      case "hide_item":
        for (const item of resolved.items) actions.dismissItem(item.key, item.title);
        break;
      case "mark_changes_read":
        for (const event of resolved.events) actions.setEventRead(event.id, true);
        applied = { eventIds: resolved.events.map((event) => event.id) };
        break;
      case "add_personal_deadline": {
        if (!actions.addPersonal) return;
        const id = `personal-${crypto.randomUUID()}`;
        actions.addPersonal({ ...resolved.draft, id });
        applied = { personalId: id };
        break;
      }
      case "move_personal_deadline":
        if (!actions.updatePersonal) return;
        actions.updatePersonal(resolved.deadline.id, { title: resolved.deadline.title, dueAt: resolved.dueAt, courseId: resolved.deadline.courseId });
        applied = { personalId: resolved.deadline.id, previousDueAt: resolved.deadline.dueAt };
        break;
      case "complete_personal_deadline":
        if (!actions.setPersonalDone) return;
        actions.setPersonalDone(resolved.deadline.id, resolved.deadline.title, true);
        applied = { personalId: resolved.deadline.id };
        break;
    }
    thread.setProposal(messageId, proposal.id, { state: "confirmed", applied, label: resolved.text });
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
    <FocusHero nextMove={dashboard.nextMove} course={dashboard.nextMove ? dashboard.courseById.get(dashboard.nextMove.item.courseId) : undefined} now={now} canOpen={canOpen(dashboard.nextMove?.item.url ?? null)} onOpen={actions.openUrl} onInspect={inspect} onDismiss={actions.dismissItem} onAsk={canAsk ? askWhyFirst : undefined} />
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
            menu={<Menu mode={status.mode} feasibility={feasibility} busy={running} onConnectLive={actions.connectLive} onUseDemo={actions.useDemoData} onClearData={actions.clearData} onCheckFiles={actions.checkFileAccess} checkingFiles={checkingFiles} fileAccess={fileAccess} />}
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
                      <FocusList dashboard={dashboard} category={category} sort={preferences.sort} now={now} courseFiltered={preferences.courseFilter !== null} expandedKey={expandedKey} onExpand={setExpandedKey} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} onSetDone={actions.setLocalDone} showLongOverdue={showLongOverdue} onToggleLongOverdue={() => setShowLongOverdue((value) => !value)} collapsedGroups={collapsedGroups} onToggleGroup={toggleGroup} onToggleAllGroups={toggleAllGroups} onAsk={canAsk ? askAboutItem : undefined} files={attachments} />
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
                {dashboard && page ? <WeekView dashboard={dashboard} days={page.days} now={now} canOpen={canOpen} onOpen={actions.openUrl} onDismiss={actions.dismissItem} selectedDay={selectedDay} personal={personalActions} onAsk={canAsk ? askAboutItem : undefined} files={attachments} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
              </Tabs.Content>
              <Tabs.Content className="tab-content" value="changes">
                {stateBanners}
                {dashboard ? <ChangesFeed dashboard={dashboard} now={now} baselineOnly={dashboard.totalChanges === 0 && hasEverSynced} canOpen={canOpen} onOpen={actions.openUrl} onSetRead={actions.setEventRead} onDelete={actions.deleteEvent} onAsk={canAsk ? askAboutChange : undefined} /> : showSkeleton ? <FocusSkeleton /> : <div className="empty"><strong>No data yet</strong></div>}
              </Tabs.Content>
              {ask ? (
                // Force-mounted and hidden so the conversation survives a switch to another tab.
                <Tabs.Content className="tab-content tab-content-ask" value="ask" forceMount hidden={tab !== "ask"}>
                  {dashboard ? (
                    <AskView notices={tab === "ask" ? stateBanners : null} thread={thread} settings={ask.settings} onSettingsChange={ask.setSettings} clientFactory={ask.clientFactory} dashboard={dashboard} mode={status.mode} now={now} canOpen={canOpen} onOpen={actions.openUrl} live={askLive} draft={askDraft} about={askAbout} onClearAbout={() => setAskAbout(null)} onSend={sendFromComposer} conversations={store ? { list: store.list, onOpen: openConversation, onDelete: deleteConversation } : undefined} proposalContext={proposalContext} onProposal={onProposal} consent={ask.consent ? { pending: ask.consent.pending, working: ask.consent.working, onDecline: ask.consent.onDecline, onAllow: allowConsent } : undefined} materials={ask.materials} feedback={feedbackView} serverUsage={serverUsage} focusNonce={composerFocus} />
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
