import {
  DEMO_LE_VERSION,
  DEMO_LP_VERSION,
  FixtureTransport,
  SessionTransport,
  VILLANOVA_BRIGHTSPACE_ORIGIN,
  buildDemoTenant,
  demoResolver,
  htmlResponse,
  jsonResponse,
  routes,
  type DemoTenantData,
  type RawFetch,
} from "@nova-agent/brightspace";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createStubHost } from "../src/platform/host";
import { App } from "../src/sidepanel/App";
import type { UiPreferences } from "../src/sidepanel/MissionControl";
import { createNovaDb } from "../src/storage/novaDb";
import { setPreference } from "../src/storage/repositories";
import { DATA_MODE_PREFERENCE, DEMO_SCENARIO_PREFERENCE, SyncCoordinator, type TransportFactory } from "../src/sync/syncCoordinator";
import "../src/sidepanel/styles.css";

/**
 * Preview harness. Drives the real App, Dexie database, and sync coordinator
 * with a stub host so every UI state can be reviewed without Chrome APIs:
 *   preview.html?scenario=ready|changes|week|fixture|first-run|loading|partial|session-expired|stale|offline|permission-required|empty
 *   &theme=light|dark
 *   &mode=demo   (label the data as demo regardless of scenario)
 */

type Scenario = "ready" | "changes" | "week" | "fixture" | "first-run" | "loading" | "partial" | "session-expired" | "stale" | "offline" | "permission-required" | "empty";

const params = new URLSearchParams(location.search);
const scenario = (params.get("scenario") ?? "ready") as Scenario;
const tab = params.get("tab") as UiPreferences["activeTab"] | null;
const fixedNow = params.get("now") ? new Date(params.get("now") as string) : null;
const now = () => fixedNow ?? new Date();
const TENANT = VILLANOVA_BRIGHTSPACE_ORIGIN;

const emptyTenant = (data: DemoTenantData): DemoTenantData => ({
  ...data,
  courseData: Object.fromEntries(Object.entries(data.courseData).map(([id, entry]) => [id, { ...entry, folders: [], quizzes: [], news: [], submissions: {} }])),
});

const fixtureFactory =
  (overrides: Record<string, unknown> = {}, transform: (data: DemoTenantData) => DemoTenantData = (data) => data): TransportFactory =>
  (_mode, { now: at, demoScenario }) =>
    new FixtureTransport(demoResolver(transform(buildDemoTenant(at, demoScenario)), overrides));

const hanging: RawFetch = () => new Promise(() => {});

const main = async () => {
  const db = createNovaDb(`nova-preview-${scenario}`);
  await db.delete();
  await db.open();
  const host = createStubHost({ tenantOrigin: TENANT, rawFetch: hanging });
  let factory: TransportFactory = fixtureFactory();
  let autoSync = false;

  const seed = async (mode: "live" | "fixture", steps: TransportFactory[], at: () => Date = now) => {
    await setPreference(db, DATA_MODE_PREFERENCE, mode);
    await setPreference(db, DEMO_SCENARIO_PREFERENCE, "baseline");
    for (const step of steps) {
      const coordinator = new SyncCoordinator({ db, host, now: at, transportFactory: step });
      await coordinator.sync("manual");
      if (mode === "live") await setPreference(db, DEMO_SCENARIO_PREFERENCE, "changed");
    }
  };

  const hoursAgo = (h: number) => () => new Date(now().getTime() - h * 3_600_000);

  switch (scenario) {
    case "first-run":
      break;
    case "loading":
      await setPreference(db, DATA_MODE_PREFERENCE, "live");
      await db.syncStatus.put({ key: "current", mode: "live", phase: "idle", scope: null, displayName: null, lastSuccessfulSyncAt: null, lastAttemptedSyncAt: hoursAgo(1)().toISOString(), lastOutcome: null, error: null, failedCourseIds: [], warnings: [] });
      factory = () => new SessionTransport(hanging, { tenantOrigin: TENANT, timeoutMs: 600_000 });
      autoSync = true;
      break;
    case "fixture":
      await seed("fixture", [fixtureFactory(), fixtureFactory()]);
      break;
    case "partial":
      await seed("live", [fixtureFactory(), fixtureFactory({ [routes.dropboxFolders(DEMO_LE_VERSION, "31002")]: jsonResponse(null, 500), [routes.quizzes(DEMO_LE_VERSION, "31004")]: jsonResponse(null, 404) })]);
      break;
    case "session-expired":
      await seed("live", [fixtureFactory(), fixtureFactory({ [routes.whoami(DEMO_LP_VERSION)]: htmlResponse() })]);
      break;
    case "permission-required":
      await seed("live", [fixtureFactory(), fixtureFactory({ [routes.whoami(DEMO_LP_VERSION)]: jsonResponse(null, 403) })]);
      break;
    case "offline": {
      await seed("live", [fixtureFactory()]);
      const offlineHost = createStubHost({ tenantOrigin: TENANT, rawFetch: hanging, hasBrightspaceTab: async () => false });
      await new SyncCoordinator({ db, host: offlineHost, now, transportFactory: fixtureFactory() }).sync("manual");
      break;
    }
    case "stale":
      await seed("live", [fixtureFactory()], hoursAgo(3));
      break;
    case "empty":
      await seed("live", [fixtureFactory({}, emptyTenant)]);
      break;
    default:
      await seed("live", [fixtureFactory(), fixtureFactory()]);
  }

  const activeTab = tab ?? (scenario === "changes" ? "changes" : scenario === "week" ? "week" : "focus");
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  if (params.get("mode") === "demo") await setPreference(db, DATA_MODE_PREFERENCE, "fixture");
  await setPreference(db, "ui.preferences", { activeTab, courseFilter: null, collapsedSections: ["completed", "later"], theme } satisfies UiPreferences);

  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <App db={db} host={host} now={fixedNow ? now : undefined} transportFactory={factory} autoSync={autoSync} />
    </StrictMode>,
  );
};

void main();
