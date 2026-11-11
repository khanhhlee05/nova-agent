import { BrightspaceClient, DEMO_LE_VERSION, buildDemoTenant, demoFileFetch, isSafeTenantLink, type FeasibilityReport, type FileAccessReport, type RawFileFetch } from "@nova-agent/brightspace";
import type { AcademicItem, CourseMaterial, ItemAttachment } from "@nova-agent/core";
import { ATTACHMENT_FAILURE_COPY, readAttachment, type AttachmentOutcome } from "../files/attachments";
import type { PdfReader } from "../files/extract";
import { firstMaterialPath, readMaterial, readCourse, refreshToc, type CourseReadProgress, type MaterialDeps } from "../files/materials";
import { readPdf as defaultReadPdf } from "../files/pdf";
import { buildIndex } from "../files/search";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionHost } from "../platform/host";
import type { DataMode, NovaDb } from "../storage/novaDb";
import { attachmentTextId, clearAllData, clearConversations, createDexieVersionCache, deleteChangeEvent, deleteConversation, deletePersonalItem, deletePlanItems, forgetCourseMaterials, listMaterialTexts, listMaterialTocs, materialTextId, getConversation, getPreference, getSyncStatus, listAttachmentTexts, listChangeEvents, listConversations, listLocalMarks, listPersonalItems, latestSnapshot, markAllRead, putPersonalItem, replacePlanItems, saveConversation, setEventRead, setLocalMark, setPreference, unreadCount } from "../storage/repositories";
import { DATA_MODE_PREFERENCE, DEMO_SCENARIO_PREFERENCE, SyncCoordinator, defaultTransportFactory, type TransportFactory } from "../sync/syncCoordinator";
import { IDLE_STATE, isRunningPhase, type SyncRuntimeState } from "../sync/syncState";
import { ASK_SETTINGS_PREFERENCE, DEFAULT_ASK_SETTINGS, availableClientTools, defaultAskClientFactory, effectiveAskSettings, runReadAttachment, runReadMaterial, runSearchMaterials, summarize, type AskMaterialsControls, type MaterialsToolDeps, type AskClientFactory, type AskSettings, type ClientToolAnswer, type ConsentRequest, type ConversationStore } from "./ask";
import { FILE_ACCESS_PREFERENCE, checkFileAccess as runCheckFileAccess, connectLive as runConnectLive } from "./connect";
import { useSessionDismissals } from "./dismissals";
import { DEFAULT_PREFERENCES, MissionControl, withPreferenceDefaults, type UiPreferences } from "./MissionControl";
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
  /** Where file bytes come from. Null means files cannot be read right now. The preview harness and tests inject one. */
  fileFetchFactory?: FileFetchFactory;
  /** Reads PDF text. Tests inject a stand-in so they never load pdf.js. */
  readPdf?: PdfReader;
};

export type FileFetchFactory = (mode: DataMode, context: { now: Date }) => RawFileFetch | null;

/** Demo files come from the demo tenant; live files come through the content-script bridge, when the host has one. */
export const defaultFileFetchFactory =
  (host: ExtensionHost): FileFetchFactory =>
  (mode, { now }) =>
    mode === "fixture" ? demoFileFetch(buildDemoTenant(now)) : (host.rawFetchFile ?? null);

type PendingDelete = { id: string; title: string; kind: "event" | "personal" };

const PREFERENCES_KEY = "ui.preferences";

export const App = ({ db, host, now: nowFn, transportFactory, autoSync = true, askClientFactory = defaultAskClientFactory, undoMs = 5000, fileFetchFactory, readPdf = defaultReadPdf }: AppDeps) => {
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
  const preferences = useLiveQuery(async () => withPreferenceDefaults(await getPreference<Partial<UiPreferences>>(db, PREFERENCES_KEY, DEFAULT_PREFERENCES)), [db]);
  const feasibility = useLiveQuery(async () => (await db.feasibility.get(host.tenantOrigin))?.report ?? null, [db, host.tenantOrigin]) as FeasibilityReport | null | undefined;
  const scope = status?.scope ?? null;
  const snapshot = useLiveQuery(() => (scope ? latestSnapshot(db, scope) : Promise.resolve(null)), [db, scope]);
  const events = useLiveQuery(() => (scope ? listChangeEvents(db, scope) : Promise.resolve([])), [db, scope]);
  const localMarks = useLiveQuery(async () => (scope ? new Map((await listLocalMarks(db, scope)).map((mark) => [mark.key, mark.markedAt])) : new Map<string, string>()), [db, scope]);
  const personalItems = useLiveQuery(async () => (scope ? listPersonalItems(db, scope) : []), [db, scope]);
  // A saved address that no longer passes the https rule turns Ask off rather than producing a client.
  const askSettings = useLiveQuery(async () => effectiveAskSettings(await getPreference<AskSettings>(db, ASK_SETTINGS_PREFERENCE, DEFAULT_ASK_SETTINGS)), [db]);
  const askClient = useMemo(() => (askSettings?.enabled ? askClientFactory(askSettings) : null), [askClientFactory, askSettings]);
  // Changes are written one after another, each on top of what is stored, so two quick changes never undo each other.
  const settingsWrite = useRef<Promise<void>>(Promise.resolve());
  const setAskSettings = useCallback(
    (patch: Partial<AskSettings>): Promise<void> => {
      settingsWrite.current = settingsWrite.current
        .then(async () => {
          const current = effectiveAskSettings(await getPreference<AskSettings>(db, ASK_SETTINGS_PREFERENCE, DEFAULT_ASK_SETTINGS));
          // Turning saving off is a promise that nothing stays behind, so the saved conversations go with it.
          if (current.persistConversations === true && patch.persistConversations === false) await clearConversations(db);
          await setPreference(db, ASK_SETTINGS_PREFERENCE, { ...current, ...patch });
        })
        .catch(() => undefined);
      return settingsWrite.current;
    },
    [db],
  );
  const savedConversations = useLiveQuery(async () => (scope ? listConversations(db, scope) : []), [db, scope]);

  // Assignment files: read on request, text kept in the extension's own storage, never the bytes.
  const mode = status?.mode ?? "fixture";
  const fileFetch = useMemo(() => (fileFetchFactory ?? defaultFileFetchFactory(host))(mode, { now: clock() }), [clock, fileFetchFactory, host, mode]);
  const readTexts = useLiveQuery(async () => (scope ? listAttachmentTexts(db, scope) : []), [db, scope]);
  const attachmentTexts = useMemo(() => new Map((readTexts ?? []).map((record) => [record.id, record])), [readTexts]);
  const [readingFiles, setReadingFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [fileErrors, setFileErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  // The Brightspace API version the last refresh used; file routes are built with it.
  const leVersion = useCallback(async () => (mode === "fixture" ? DEMO_LE_VERSION : ((await createDexieVersionCache(db, host.tenantOrigin).get())?.le ?? null)), [db, host.tenantOrigin, mode]);
  const readFile = useCallback(
    async (item: AcademicItem, attachment: ItemAttachment): Promise<AttachmentOutcome> => {
      if (!scope) return { ok: false, reason: "no-version", message: ATTACHMENT_FAILURE_COPY["no-version"] };
      const id = attachmentTextId(item.key, attachment.id);
      setReadingFiles((prev) => new Set(prev).add(id));
      setFileErrors((prev) => new Map([...prev].filter(([key]) => key !== id)));
      try {
        const outcome = await readAttachment(
          {
            db,
            scope,
            tenantOrigin: host.tenantOrigin,
            fetchFile: fileFetch,
            leVersion,
            readPdf,
            now: clock,
          },
          item,
          attachment,
        );
        if (!outcome.ok) setFileErrors((prev) => new Map(prev).set(id, outcome.message));
        return outcome;
      } finally {
        setReadingFiles((prev) => new Set([...prev].filter((key) => key !== id)));
      }
    },
    [clock, db, fileFetch, host.tenantOrigin, leVersion, readPdf, scope],
  );
  const [checkingFiles, setCheckingFiles] = useState(false);
  const fileAccess = useLiveQuery(() => getPreference<FileAccessReport | null>(db, FILE_ACCESS_PREFERENCE, null), [db]);
  const checkFiles = useCallback(() => {
    if (!snapshot) return;
    setCheckingFiles(true);
    void (async () => {
      try {
        const le = await leVersion();
        const report = await runCheckFileAccess(db, fileFetch, le, snapshot.items, clock, le && scope ? await firstMaterialPath(db, scope, le) : null);
        const served = report.steps.filter((step) => step.outcome === "ok").length;
        const tested = report.steps.filter((step) => step.outcome !== "not-tested").length;
        setAnnouncement(tested === 0 ? "No files in your courses to try yet." : `File access checked: Brightspace served ${served} of ${tested} kinds of file.`);
      } finally {
        setCheckingFiles(false);
      }
    })();
  }, [clock, db, fileFetch, leVersion, scope, snapshot]);
  // Permission to read a file for an answer is asked once per panel session and never stored.
  const fileConsent = useRef(false);
  const [pendingConsent, setPendingConsent] = useState<ConsentRequest | null>(null);
  const [readingConsent, setReadingConsent] = useState(false);
  const clientToolNames = useMemo(() => availableClientTools({ readAttachments: askSettings?.readAttachments !== false, canFetchFiles: fileFetch !== null, materials: true }), [askSettings, fileFetch]);

  // Course materials: a course's Content area is listed and read only after the student turns that course on.
  const allowedCourses = useMemo(() => new Set(askSettings?.materialsCourses ?? []), [askSettings]);
  const excludedTopics = useMemo(() => askSettings?.materialsExcluded ?? {}, [askSettings]);
  const materialTocs = useLiveQuery(async () => (scope ? listMaterialTocs(db, scope) : []), [db, scope]);
  const materialTexts = useLiveQuery(async () => (scope ? listMaterialTexts(db, scope) : []), [db, scope]);
  const tocByCourse = useMemo(() => new Map((materialTocs ?? []).map((record) => [record.courseId, record])), [materialTocs]);
  const allowedTexts = useMemo(() => (materialTexts ?? []).filter((record) => allowedCourses.has(record.courseId)), [allowedCourses, materialTexts]);
  const materialIndex = useMemo(() => buildIndex(allowedTexts), [allowedTexts]);
  const [materialProgress, setMaterialProgress] = useState<ReadonlyMap<string, CourseReadProgress>>(() => new Map());
  const [materialErrors, setMaterialErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const materialDeps = useMemo<MaterialDeps | null>(() => (scope ? { db, scope, tenantOrigin: host.tenantOrigin, fetchFile: fileFetch, leVersion, readPdf, now: clock } : null), [clock, db, fileFetch, host.tenantOrigin, leVersion, readPdf, scope]);
  // The same transport a refresh uses, for the one extra request that lists a course's Content area.
  const brightspace = useMemo(
    () => new BrightspaceClient((transportFactory ?? defaultTransportFactory(host))(mode, { now: clock(), demoScenario: "baseline" }), { tenantOrigin: host.tenantOrigin, versionCache: createDexieVersionCache(db, host.tenantOrigin), now: clock }),
    [clock, db, host, mode, transportFactory],
  );
  const readingCourses = useRef(new Set<string>());
  const excludedRef = useRef(excludedTopics);
  excludedRef.current = excludedTopics;
  const setCourseNote = (update: (prev: ReadonlyMap<string, string>) => Map<string, string>) => setMaterialErrors((prev) => update(prev));
  /** Lists one course's Content area, then reads what is chosen and new. One course at a time per course; never throws. */
  const loadCourseMaterials = useCallback(
    async (courseId: string): Promise<void> => {
      if (!materialDeps || readingCourses.current.has(courseId)) return;
      readingCourses.current.add(courseId);
      const progress = (value: CourseReadProgress | null) => setMaterialProgress((prev) => new Map(value ? [...prev, [courseId, value]] : [...prev].filter(([key]) => key !== courseId)));
      progress({ done: 0, total: 0, title: null });
      setCourseNote((prev) => new Map([...prev].filter(([key]) => key !== courseId)));
      try {
        const listed = await refreshToc(db, materialDeps.scope, courseId, (id) => brightspace.listMaterials(id), clock);
        if (!listed.ok) {
          setCourseNote((prev) => new Map(prev).set(courseId, listed.message));
          return;
        }
        const result = await readCourse(materialDeps, courseId, listed.record.topics, new Set(excludedRef.current[courseId] ?? []), progress);
        const notes = [
          ...(result.failed.length > 0 ? [`${result.failed.length} ${result.failed.length === 1 ? "file" : "files"} could not be read. ${result.failed[0]?.message ?? ""}`] : []),
          ...(result.stoppedAtLimit ? ["Nova stopped at this course's download limit of 150 MB."] : []),
        ];
        if (notes.length > 0) setCourseNote((prev) => new Map(prev).set(courseId, notes.join(" ")));
      } finally {
        readingCourses.current.delete(courseId);
        progress(null);
      }
    },
    [brightspace, clock, db, materialDeps],
  );
  // After a refresh, the turned-on courses are listed again and anything new or changed is read. A course whose
  // listing is newer than the snapshot is left alone, so opening the panel does not download anything by itself.
  const capturedAt = snapshot?.capturedAt ?? null;
  useEffect(() => {
    if (!capturedAt || !materialTocs || !fileFetch) return;
    for (const courseId of allowedCourses) {
      const listed = tocByCourse.get(courseId);
      if (listed && listed.fetchedAt >= capturedAt) continue;
      void loadCourseMaterials(courseId);
    }
  }, [allowedCourses, capturedAt, fileFetch, loadCourseMaterials, materialTocs, tocByCourse]);
  // What a lookup reads is taken at the moment it runs, not when the question was sent: a course turned on a
  // moment ago is searched by the retried question even if a render is still on its way.
  const materialsLive = useRef<Omit<MaterialsToolDeps, "askPermission" | "read" | "canOpen">>({ courses: [], allowed: allowedCourses, toc: new Map(), texts: [], index: materialIndex });
  materialsLive.current = { courses: (snapshot?.courses ?? []).filter((course) => course.active), allowed: allowedCourses, toc: new Map([...tocByCourse].map(([courseId, record]) => [courseId, record.topics])), texts: allowedTexts, index: materialIndex };
  // Courses allowed a moment ago whose setting may not have come back from storage yet. A lookup counts them as on.
  const justAllowed = useRef(new Set<string>());
  const runClientTool = useCallback(
    async (name: string, input: unknown): Promise<ClientToolAnswer> => {
      const none: ClientToolAnswer = { ok: false, summary: "", data: null, rows: [], error: "This panel cannot make that lookup." };
      if (!snapshot) return none;
      if (name === "search_course_materials" || name === "read_course_material") {
        const live = materialsLive.current;
        const deps: MaterialsToolDeps = {
          ...live,
          allowed: new Set([...live.allowed, ...justAllowed.current]),
          askPermission: setPendingConsent,
          read: async (material: CourseMaterial) => (materialDeps ? readMaterial(materialDeps, material) : { ok: false, reason: "no-version", message: ATTACHMENT_FAILURE_COPY["no-version"] }),
          canOpen: (url) => isSafeTenantLink(url, host.tenantOrigin),
        };
        return name === "search_course_materials" ? runSearchMaterials(input, deps) : runReadMaterial(input, deps);
      }
      if (name !== "read_attachment") return none;
      return runReadAttachment(input, {
        items: snapshot.items,
        courseById: new Map(snapshot.courses.map((course) => [course.id, course])),
        texts: attachmentTexts,
        allowed: () => fileConsent.current,
        askPermission: setPendingConsent,
        read: readFile,
        canOpen: (url) => isSafeTenantLink(url, host.tenantOrigin),
      });
    },
    [attachmentTexts, host.tenantOrigin, materialDeps, readFile, snapshot],
  );
  const attachmentControls = useMemo(
    () => (clientToolNames.includes("read_attachment") && askSettings?.enabled ? { texts: attachmentTexts, busy: readingFiles, errors: fileErrors, onRead: (item: AcademicItem, attachment: ItemAttachment) => void readFile(item, attachment) } : undefined),
    [askSettings, attachmentTexts, clientToolNames, fileErrors, readFile, readingFiles],
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
  // Ids whose delete has been sent to the database. The live query trails a write by a tick, so a
  // committed row stays hidden until it has actually left the query instead of flashing back first.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(() => new Set());
  const commitDelete = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    clearTimeout(current.timer);
    pending.current = null;
    setPendingDelete(null);
    const { id, kind } = current.entry;
    setDeleting((prev) => new Set(prev).add(id));
    if (kind === "personal") void deletePersonalItem(db, id);
    else void deleteChangeEvent(db, id).then(publishBadge);
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

  const visibleEvents = useMemo(() => {
    if (!events || (!pendingDelete && deleting.size === 0)) return events;
    return events.filter((event) => event.id !== pendingDelete?.id && !deleting.has(event.id));
  }, [deleting, events, pendingDelete]);
  const visiblePersonal = useMemo(() => {
    if (!personalItems || (!pendingDelete && deleting.size === 0)) return personalItems;
    return personalItems.filter((item) => item.id !== pendingDelete?.id && !deleting.has(item.id));
  }, [deleting, personalItems, pendingDelete]);
  useEffect(() => {
    if (!events || !personalItems || deleting.size === 0) return;
    const gone = [...deleting].filter((id) => !events.some((event) => event.id === id) && !personalItems.some((item) => item.id === id));
    if (gone.length > 0) setDeleting((prev) => new Set([...prev].filter((id) => !gone.includes(id))));
  }, [deleting, events, personalItems]);

  const dashboard = useMemo(
    () =>
      snapshot && visibleEvents && preferences
        ? buildDashboard({ snapshot, events: visibleEvents, now, courseFilter: preferences.courseFilter, dismissedItemKeys: dismissals.items, localMarks, personal: visiblePersonal ?? [] })
        : null,
    [snapshot, visibleEvents, now, preferences, dismissals, localMarks, visiblePersonal],
  );

  const conversationStore = useMemo<ConversationStore | undefined>(
    () =>
      scope
        ? {
            list: (savedConversations ?? []).map(summarize),
            save: (conversation) => void saveConversation(db, scope, conversation, clock()),
            load: (id) => getConversation(db, id),
            remove: (id) => void deleteConversation(db, id),
          }
        : undefined,
    [clock, db, savedConversations, scope],
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
      setLocalDone: (key: string, title: string, done: boolean) => {
        if (!scope) return;
        void setLocalMark(db, scope, key, done ? clock().toISOString() : null);
        setAnnouncement(done ? `Marked "${title}" done on this device. Brightspace still lists it as open.` : `"${title}" is back in your list.`);
      },
      deleteEvent: (id: string, title: string) => {
        // One Undo at a time: a second delete makes the first one final.
        commitDelete();
        const entry: PendingDelete = { id, title, kind: "event" };
        pending.current = { entry, timer: setTimeout(commitDelete, undoMs) };
        setPendingDelete(entry);
        setAnnouncement(`Deleted the change for "${title}". Undo to restore it.`);
      },
      addPersonal: (draft: { title: string; dueAt: string; courseId: string | null; id?: string }) => {
        if (!scope) return;
        const at = clock().toISOString();
        void putPersonalItem(db, { id: draft.id ?? `personal-${crypto.randomUUID()}`, scope, title: draft.title, dueAt: draft.dueAt, courseId: draft.courseId, completedAt: null, createdAt: at, updatedAt: at })
          .then(() => setAnnouncement(`Added "${draft.title}" to your Week tab. It stays on this device.`))
          .catch((error: unknown) => setAnnouncement(error instanceof Error ? error.message : "Nova could not save that deadline."));
      },
      updatePersonal: (id: string, draft: { title: string; dueAt: string; courseId: string | null }) => {
        const current = personalItems?.find((item) => item.id === id);
        if (!current) return;
        void putPersonalItem(db, { ...current, title: draft.title, dueAt: draft.dueAt, courseId: draft.courseId, updatedAt: clock().toISOString() }).then(() => setAnnouncement(`Saved "${draft.title}".`));
      },
      deletePersonal: (id: string, title: string) => {
        commitDelete();
        const entry: PendingDelete = { id, title, kind: "personal" };
        pending.current = { entry, timer: setTimeout(commitDelete, undoMs) };
        setPendingDelete(entry);
        setAnnouncement(`Deleted your deadline "${title}". Undo to restore it.`);
      },
      setPersonalDone: (id: string, title: string, done: boolean) => {
        const current = personalItems?.find((item) => item.id === id);
        if (!current) return;
        const at = clock().toISOString();
        void putPersonalItem(db, { ...current, completedAt: done ? at : null, updatedAt: at }).then(() => setAnnouncement(done ? `Marked "${title}" done.` : `"${title}" is back on your list.`));
      },
      addPlanToWeek: (planId: string, drafts: { id: string; title: string; dueAt: string; courseId: string | null }[]) => {
        if (!scope || drafts.length === 0) return;
        const at = clock().toISOString();
        void replacePlanItems(
          db,
          scope,
          drafts.map((draft) => ({ ...draft, scope, completedAt: null, createdAt: at, updatedAt: at, planId })),
        )
          .then(() => setAnnouncement(`Added the plan to your Week tab: ${drafts.length} ${drafts.length === 1 ? "entry" : "entries"}. They stay on this device.`))
          .catch((error: unknown) => setAnnouncement(error instanceof Error ? error.message : "Nova could not add the plan."));
      },
      removePlanFromWeek: (planId: string) => {
        if (!scope) return;
        void deletePlanItems(db, scope, planId).then((count) => setAnnouncement(count > 0 ? "Removed the plan from your Week tab." : "That plan was not on your Week tab."));
      },
      undoDelete: () => {
        const current = pending.current;
        if (!current) return;
        clearTimeout(current.timer);
        pending.current = null;
        setPendingDelete(null);
        setAnnouncement(current.entry.kind === "personal" ? `Restored your deadline "${current.entry.title}".` : `Restored the change for "${current.entry.title}".`);
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
      // Demo files are always "served"; the check only says something about a real tenant.
      ...(mode === "live" ? { checkFileAccess: checkFiles } : {}),
      clearData: async () => {
        await clearAllData(db);
        // Permissions given in this session go with the data they were given for.
        fileConsent.current = false;
        justAllowed.current.clear();
        setPendingConsent(null);
        setMaterialErrors(new Map());
        await host.publishBadge(0);
        setRuntime(IDLE_STATE);
        setAnnouncement("Local Nova data cleared.");
      },
    }),
    [checkFiles, clock, commitDelete, coordinator, db, dismissBanner, dismissItem, host, mode, nowFn, personalItems, publishBadge, restoreAll, scope, setPreferences, undoMs],
  );

  if (!status || !preferences || feasibility === undefined || !askSettings || !personalItems) return null;

  const allowCourse = async (courseId: string): Promise<void> => {
    justAllowed.current.add(courseId);
    if (!allowedCourses.has(courseId)) await setAskSettings({ materialsCourses: [...new Set([...allowedCourses, ...justAllowed.current])] });
    await loadCourseMaterials(courseId);
  };
  const forgetCourse = (courseId: string): void => {
    justAllowed.current.delete(courseId);
    const { [courseId]: _dropped, ...restExcluded } = excludedTopics;
    void _dropped;
    void setAskSettings({ materialsCourses: [...allowedCourses].filter((id) => id !== courseId), materialsExcluded: restExcluded });
    setMaterialErrors((prev) => new Map([...prev].filter(([key]) => key !== courseId)));
    if (scope) void forgetCourseMaterials(db, scope, courseId).then(() => setAnnouncement("Forgot this course's materials. Nothing read from it is kept."));
  };
  const toggleTopic = (courseId: string, topicId: string, include: boolean): void => {
    const current = new Set(excludedTopics[courseId] ?? []);
    if (include) current.delete(topicId);
    else current.add(topicId);
    void setAskSettings({ materialsExcluded: { ...excludedTopics, [courseId]: [...current] } });
    // An unticked topic's text goes at once; a ticked one is read with the next "Read".
    if (!include && scope) void db.materialText.delete(materialTextId(scope, courseId, topicId));
  };
  const materials: AskMaterialsControls | undefined =
    snapshot && fileFetch && clientToolNames.includes("search_course_materials")
      ? {
          courses: [...snapshot.courses]
            .filter((course) => course.active)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((course) => {
              const texts = (materialTexts ?? []).filter((record) => record.courseId === course.id);
              return {
                course,
                allowed: allowedCourses.has(course.id),
                topics: tocByCourse.get(course.id)?.topics ?? null,
                fetchedAt: tocByCourse.get(course.id)?.fetchedAt ?? null,
                excluded: new Set(excludedTopics[course.id] ?? []),
                readIds: new Set(texts.filter((record) => record.failure === null).map((record) => record.topicId)),
                unreadableIds: new Set(texts.filter((record) => record.failure !== null).map((record) => record.topicId)),
                chars: texts.reduce((sum, record) => sum + record.chars, 0),
                progress: materialProgress.get(course.id) ?? null,
                error: materialErrors.get(course.id) ?? null,
              };
            }),
          onAllow: allowCourse,
          onForget: forgetCourse,
          onRead: (courseId) => void loadCourseMaterials(courseId),
          onToggleTopic: toggleTopic,
        }
      : undefined;

  const consentCourse = pendingConsent?.kind === "materials" ? pendingConsent.courseId : null;
  const consentProgress = consentCourse ? materialProgress.get(consentCourse) : undefined;
  const consent = {
    pending: pendingConsent,
    // While a course is being read after Allow, the card says how far it is instead of offering the buttons again.
    working: consentCourse && readingConsent ? (consentProgress?.title ? `Reading ${consentProgress.done + 1} of ${consentProgress.total}: ${consentProgress.title}` : "Listing the course's Content area…") : null,
    onAllow: () => {
      if (pendingConsent?.kind === "materials") {
        setReadingConsent(true);
        void allowCourse(pendingConsent.courseId).finally(() => {
          setReadingConsent(false);
          setPendingConsent(null);
        });
        return;
      }
      fileConsent.current = true;
      setPendingConsent(null);
    },
    onDecline: () => setPendingConsent(null),
  };

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
      ask={{ client: askClient, settings: askSettings, setSettings: setAskSettings, clientFactory: askClientFactory, events: visibleEvents ?? [], localMarks, personal: visiblePersonal ?? [], conversations: conversationStore, clientTools: { names: clientToolNames, run: runClientTool }, consent, materials }}
      attachments={attachmentControls}
      checkingFiles={checkingFiles}
      fileAccess={fileAccess ?? null}
    />
  );
};
