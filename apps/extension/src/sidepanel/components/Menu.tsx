import type { FeasibilityReport } from "@nova-agent/brightspace";
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
};

const verdictText: Record<FeasibilityReport["verdict"], string> = {
  "live-ok": "Read-only routes accepted the browser session.",
  "authorization-required": "Brightspace redirected to login. Official OAuth registration is required.",
  "permission-denied": "Brightspace returned 403 for the session. OAuth registration is required.",
  unreachable: "Brightspace could not be reached from the open tab.",
  unsupported: "Brightspace answered with an unexpected shape or API version.",
};

export const Menu = ({ mode, feasibility, busy, onConnectLive, onUseDemo, onClearData }: MenuProps) => {
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
              <p>This deletes every snapshot, change event, and preference stored on this device. Nothing changes in Brightspace.</p>
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
            <div className="card-actions">
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
