import type { FeasibilityReport, FileAccessReport } from "@nova-agent/brightspace";
import { ClipboardList, FlaskConical, KeyRound, MoreVertical, Trash2 } from "lucide-react";
import { AlertDialog, Popover } from "radix-ui";
import { useState } from "react";
import { Tip } from "./Tip";

export type MenuProps = {
  mode: "live" | "fixture";
  feasibility: FeasibilityReport | null;
  busy: boolean;
  onConnectLive: () => void;
  onUseDemo: () => void;
  onClearData: () => Promise<void> | void;
  /** Asks Brightspace whether it serves assignment files to this session. Absent when there is no way to ask. */
  onCheckFiles?: () => void;
  checkingFiles?: boolean;
  /** The last file access check, if one has run. */
  fileAccess?: FileAccessReport | null;
};

const verdictText: Record<FeasibilityReport["verdict"], string> = {
  "live-ok": "Read-only routes accepted the browser session.",
  "authorization-required": "Brightspace redirected to login. Official OAuth registration is required.",
  "permission-denied": "Brightspace returned 403 for the session. OAuth registration is required.",
  unreachable: "Brightspace could not be reached from the open tab.",
  unsupported: "Brightspace answered with an unexpected shape or API version.",
};

const fileOutcomeText: Record<string, string> = {
  ok: "served",
  "not-tested": "not tested: no such file in your courses yet",
  "session-expired": "sign-in required",
  "permission-denied": "denied (403)",
  "not-found": "not found (404)",
  "too-large": "too large",
  "rate-limited": "rate limited",
  network: "no answer",
  "unsafe-path": "refused: off the allowlist",
};

const FILE_ROUTE_LABELS = { dropboxAttachment: "Instructor attachments", submissionFile: "Your submitted files" } as const;

export const Menu = ({ mode, feasibility, busy, onConnectLive, onUseDemo, onClearData, onCheckFiles, checkingFiles = false, fileAccess = null }: MenuProps) => {
  const [reportOpen, setReportOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  return (
    <>
      <Popover.Root>
        <Tip label="More options">
          <Popover.Trigger asChild>
            <button type="button" className="icon-button" aria-label="More options">
              <MoreVertical size={16} aria-hidden="true" />
            </button>
          </Popover.Trigger>
        </Tip>
        <Popover.Portal>
          <Popover.Content className="menu" align="end" sideOffset={6} collisionPadding={8}>
            <p className="menu-label">Data source</p>
            <Popover.Close asChild>
              <button type="button" className="menu-item" onClick={onConnectLive} disabled={busy}>
                <KeyRound size={15} aria-hidden="true" />
                {mode === "live" ? "Re-check Brightspace connection" : "Connect to Brightspace"}
              </button>
            </Popover.Close>
            <Popover.Close asChild>
              <button type="button" className="menu-item" onClick={onUseDemo} disabled={busy || mode === "fixture"}>
                <FlaskConical size={15} aria-hidden="true" />
                {mode === "fixture" ? "Using demo data" : "Switch to demo data"}
              </button>
            </Popover.Close>
            <Popover.Close asChild>
              <button type="button" className="menu-item" onClick={() => setReportOpen(true)} disabled={!feasibility}>
                <ClipboardList size={15} aria-hidden="true" />
                Connection report
              </button>
            </Popover.Close>
            <div className="menu-separator" role="separator" />
            <Popover.Close asChild>
              <button type="button" className="menu-item" data-danger="true" onClick={() => setConfirmOpen(true)}>
                <Trash2 size={15} aria-hidden="true" />
                Clear local Nova data…
              </button>
            </Popover.Close>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="overlay" />
          <AlertDialog.Content className="dialog">
            <AlertDialog.Title asChild>
              <h2>Clear local Nova data?</h2>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p>This deletes every snapshot, change event, preference, done mark, deadline you added yourself, and saved Ask Nova conversation, all stored on this device. Nothing changes in Brightspace.</p>
            </AlertDialog.Description>
            <div className="card-actions">
              <AlertDialog.Cancel asChild>
                <button type="button" className="button">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button type="button" className="button button-danger" onClick={() => void onClearData()}>
                  Clear data
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root open={reportOpen} onOpenChange={setReportOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="overlay" />
          <AlertDialog.Content className="dialog">
            <AlertDialog.Title asChild>
              <h2>Connection report</h2>
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <p>{feasibility ? verdictText[feasibility.verdict] : "No probe has run yet."}</p>
            </AlertDialog.Description>
            {feasibility ? (
              <pre className="report" style={{ marginTop: 10 }}>
                {JSON.stringify(
                  {
                    probedAt: feasibility.probedAt,
                    tenant: feasibility.tenantOrigin,
                    verdict: feasibility.verdict,
                    versions: feasibility.selectedVersions,
                    activeCourses: feasibility.activeEnrollmentCount,
                    steps: feasibility.steps.map((step) => ({ op: step.operation, status: step.status, type: step.contentType, json: step.isJson, valid: step.schemaValid, outcome: step.outcome })),
                  },
                  null,
                  2,
                )}
              </pre>
            ) : null}
            {onCheckFiles || fileAccess ? (
              <section className="report-files" aria-label="File access">
                <h3>File access</h3>
                {fileAccess ? (
                  <ul>
                    {fileAccess.steps.map((step) => (
                      <li key={step.operation}>
                        {FILE_ROUTE_LABELS[step.operation]}: <strong>{fileOutcomeText[step.outcome] ?? step.outcome}</strong>
                        {step.status !== null ? ` (${step.status}${step.contentType ? `, ${step.contentType.split(";")[0]}` : ""})` : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Not checked yet. Ask Nova reads assignment files only if Brightspace serves them to your session.</p>
                )}
              </section>
            ) : null}
            <div className="card-actions">
              {onCheckFiles ? (
                <button type="button" className="button" onClick={onCheckFiles} disabled={checkingFiles}>
                  {checkingFiles ? "Checking…" : "Check file access"}
                </button>
              ) : null}
              <AlertDialog.Cancel asChild>
                <button type="button" className="button">
                  Close
                </button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
};
