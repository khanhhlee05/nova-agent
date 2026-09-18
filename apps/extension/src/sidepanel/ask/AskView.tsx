import { FlaskConical, Settings2, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Banner } from "../components/Banners";
import { Tip } from "../components/Tip";
import type { Dashboard } from "../model";
import type { AskClientFactory } from "./askClient";
import { AskComposer } from "./AskComposer";
import { hostOf, type AskSettings } from "./askSettings";
import { AskSetup } from "./AskSetup";
import { AskThread } from "./AskThread";
import type { AskThread as AskThreadState } from "./useAskThread";

export type AskViewProps = {
  thread: AskThreadState;
  settings: AskSettings;
  onSettingsChange: (patch: Partial<AskSettings>) => void;
  clientFactory: AskClientFactory;
  dashboard: Dashboard;
  mode: "live" | "fixture";
  now: Date;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  /** Connection and data notices shared with the other tabs, shown above everything else. */
  notices?: ReactNode;
};

/** The Ask tab body: setup card until enabled, then the thread and the composer. */
export const AskView = ({ notices, thread, settings, onSettingsChange, clientFactory, dashboard, mode, now, canOpen, onOpen }: AskViewProps) => {
  const [editing, setEditing] = useState(false);
  const showSetup = !settings.enabled || editing;
  const streaming = thread.status === "streaming";

  return (
    <div className="ask">
      <div className="ask-thread">
        {notices}
        {mode === "fixture" ? (
          <Banner tone="info" icon={<FlaskConical size={16} aria-hidden="true" />} title="Demo data">
            <p>Answers describe fictional demo courses, not your Brightspace.</p>
          </Banner>
        ) : null}
        {showSetup ? (
          <AskSetup key={`${settings.apiBaseUrl}|${settings.token ?? ""}`} settings={settings} onChange={onSettingsChange} clientFactory={clientFactory} editing={settings.enabled} onClose={settings.enabled ? () => setEditing(false) : undefined} />
        ) : (
          <div className="ask-status">
            <span>
              Nova server · <span className="mono">{hostOf(settings.apiBaseUrl)}</span> · Cleared when you close the panel
            </span>
            <span className="spacer" />
            {thread.messages.length > 0 ? (
              <Tip label="Clear conversation">
                <button type="button" className="icon-button icon-button-sm" aria-label="Clear conversation" onClick={thread.clear}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
            <Tip label="Ask Nova settings">
              <button type="button" className="icon-button icon-button-sm" aria-label="Ask Nova settings" onClick={() => setEditing(true)}>
                <Settings2 size={15} aria-hidden="true" />
              </button>
            </Tip>
          </div>
        )}
        {settings.enabled && !editing ? (
          thread.messages.length === 0 ? (
            <div className="empty ask-empty">
              <strong>Ask about your courses</strong>
              <span>Deadlines, what changed, what to start first. Answers cover every course and use the data on this device.</span>
            </div>
          ) : (
            <AskThread messages={thread.messages} status={thread.status} dashboard={dashboard} now={now} apiBaseUrl={settings.apiBaseUrl} canOpen={canOpen} onOpen={onOpen} onRetry={thread.retryLast} onSettings={() => setEditing(true)} />
          )
        ) : null}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {thread.announcement ?? ""}
        </p>
      </div>
      <AskComposer streaming={streaming} disabled={!settings.enabled || editing} onSend={thread.send} onStop={thread.stop} />
    </div>
  );
};
