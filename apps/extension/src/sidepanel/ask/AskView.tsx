import { FlaskConical, History, Settings2, SquarePen, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Banner } from "../components/Banners";
import { Tip } from "../components/Tip";
import type { Dashboard } from "../model";
import type { AskClientFactory } from "./askClient";
import { AskComposer, type AskAbout, type AskDraft } from "./AskComposer";
import { AskConversations } from "./AskConversations";
import type { ConversationSummary } from "./conversations";
import type { ProposalAction } from "./AskProposals";
import type { AskProposal, ProposalContext } from "./proposals";
import { formatBytes, type ConsentRequest } from "./clientTools";
import type { AskLive } from "./AskRows";
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
  /** Live state and row actions for every course. */
  live?: AskLive;
  /** A question another tab wrote into the composer. */
  draft?: AskDraft | null;
  /** The item that question is about, shown above the composer until sent or cleared. */
  about?: AskAbout | null;
  onClearAbout?: () => void;
  /** Sends from the composer, so the caller can attach the item the question is about. Defaults to `thread.send`. */
  onSend?: (text: string) => void;
  /** Saved conversations. Only used while the student has saving turned on. */
  conversations?: AskSavedConversations;
  /** The data suggestions are checked against, and the handler that carries one out. */
  proposalContext?: ProposalContext;
  onProposal?: (messageId: string, proposal: AskProposal, action: ProposalAction) => void;
  /** Present while Nova is waiting for the student to allow reading a file. */
  consent?: AskConsent;
};

export type AskConsent = {
  pending: ConsentRequest | null;
  /** Allows reading attachments for the rest of this session and asks the question again. */
  onAllow: () => void;
  onDecline: () => void;
};

export type AskSavedConversations = {
  list: readonly ConversationSummary[];
  onOpen: (id: string) => void;
  /** Deletes a saved conversation; when it is the one on screen, the thread is cleared too. */
  onDelete: (id: string) => void;
};

/** The Ask tab body: setup card until enabled, then the thread and the composer. */
export const AskView = ({ notices, thread, settings, onSettingsChange, clientFactory, dashboard, mode, now, canOpen, onOpen, live, draft = null, about = null, onClearAbout, onSend, conversations, proposalContext, onProposal, consent }: AskViewProps) => {
  const [editing, setEditing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const saved = settings.persistConversations === true && conversations ? conversations : null;
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
              Nova server · <span className="mono">{hostOf(settings.apiBaseUrl)}</span> · {saved ? "Saved on this device" : "Cleared when you close the panel"}
            </span>
            <span className="spacer" />
            {saved && thread.messages.length > 0 ? (
              <Tip label="New conversation">
                <button type="button" className="icon-button icon-button-sm" aria-label="New conversation" onClick={thread.clear}>
                  <SquarePen size={15} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
            {saved ? (
              <Tip label="Conversations">
                <button type="button" className="icon-button icon-button-sm" aria-label="Conversations" onClick={() => setBrowsing(true)}>
                  <History size={15} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
            {thread.messages.length > 0 ? (
              <Tip label={saved ? "Delete conversation" : "Clear conversation"}>
                <button type="button" className="icon-button icon-button-sm" aria-label={saved ? "Delete conversation" : "Clear conversation"} onClick={() => (saved ? saved.onDelete(thread.conversationId) : thread.clear())}>
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
            <AskThread messages={thread.messages} status={thread.status} dashboard={dashboard} now={now} apiBaseUrl={settings.apiBaseUrl} canOpen={canOpen} onOpen={onOpen} onRetry={thread.retryLast} onSettings={() => setEditing(true)} live={live} onAsk={thread.send} proposalContext={proposalContext} onProposal={onProposal} />
          )
        ) : null}
        {settings.enabled && !editing && consent?.pending ? (
          <section className="ask-proposal ask-consent" data-state="pending" aria-label="Permission to read a file">
            <p className="ask-proposal-kicker">Nova asks</p>
            <p className="ask-proposal-text">
              May Nova read <strong>{consent.pending.fileName}</strong> ({formatBytes(consent.pending.size)}) from "{consent.pending.itemTitle}"? It is downloaded through your Brightspace session and opened on this device. The part your question needs goes to the Nova server with it.
            </p>
            <div className="card-actions">
              <button type="button" className="button button-primary button-sm" onClick={consent.onAllow} disabled={streaming}>
                Allow for this session
              </button>
              <button type="button" className="button button-ghost button-sm" onClick={consent.onDecline}>
                Not now
              </button>
            </div>
          </section>
        ) : null}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {thread.announcement ?? ""}
        </p>
      </div>
      {saved && browsing ? <AskConversations conversations={saved.list} currentId={thread.conversationId} now={now} onOpen={saved.onOpen} onDelete={saved.onDelete} onClose={() => setBrowsing(false)} /> : null}
      <AskComposer streaming={streaming} disabled={!settings.enabled || editing} onSend={onSend ?? thread.send} onStop={thread.stop} draft={draft} about={about} onClearAbout={onClearAbout} />
    </div>
  );
};
