import { runFeasibilityProbe, type FeasibilityReport } from "@nova-agent/brightspace";
import type { ExtensionHost } from "../platform/host";
import type { NovaDb } from "../storage/novaDb";
import { setPreference } from "../storage/repositories";
import { DATA_MODE_PREFERENCE } from "../sync/syncCoordinator";

/**
 * "Connect to Brightspace": runs the Phase 0 probe through the content-script
 * bridge, stores the sanitized report, and enables live mode only on success.
 */
export const connectLive = async (db: NovaDb, host: ExtensionHost, now: () => Date = () => new Date()): Promise<FeasibilityReport> => {
  const hasTab = await host.hasBrightspaceTab();
  const report: FeasibilityReport = hasTab
    ? await runFeasibilityProbe(host.rawFetch, { tenantOrigin: host.tenantOrigin, now })
    : { probedAt: now().toISOString(), tenantOrigin: host.tenantOrigin, verdict: "unreachable", steps: [], selectedVersions: null, activeEnrollmentCount: null };
  await db.feasibility.put({ tenantOrigin: host.tenantOrigin, report });
  if (report.verdict === "live-ok") await setPreference(db, DATA_MODE_PREFERENCE, "live");
  return report;
};
