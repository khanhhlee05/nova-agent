import { probeFileRoute, runFeasibilityProbe, type ApprovedBrightspacePath, type FeasibilityReport, type FileAccessReport, type RawFileFetch } from "@nova-agent/brightspace";
import type { AcademicItem } from "@nova-agent/core";
import { attachmentPath } from "../files/attachments";
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

/** Preference key holding the last file access check. Outcomes only: no file name or id. */
export const FILE_ACCESS_PREFERENCE = "files.access";

/**
 * "Check file access": asks each file route for the headers of one file the
 * last refresh found, and stores the outcome beside the connection report.
 * Nothing is downloaded, and no file name or id is recorded. `materialPath`
 * is one file of a course whose materials are turned on, when there is one.
 */
export const checkFileAccess = async (
  db: NovaDb,
  fetchFile: RawFileFetch | null,
  le: string | null,
  items: readonly AcademicItem[],
  now: () => Date = () => new Date(),
  materialPath: ApprovedBrightspacePath | null = null,
): Promise<FileAccessReport> => {
  const firstPath = (source: "instructor" | "submission") => {
    if (!le) return null;
    for (const item of items) {
      const file = item.attachments?.find((candidate) => candidate.source === source);
      const path = file ? attachmentPath(le, item, file) : null;
      if (path) return path;
    }
    return null;
  };
  const report: FileAccessReport = {
    probedAt: now().toISOString(),
    steps: [await probeFileRoute(fetchFile, "dropboxAttachment", firstPath("instructor")), await probeFileRoute(fetchFile, "submissionFile", firstPath("submission")), await probeFileRoute(fetchFile, "contentTopicFile", materialPath)],
  };
  await setPreference(db, FILE_ACCESS_PREFERENCE, report);
  return report;
};
