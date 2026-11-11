import { FlaskConical, History, LibraryBig, Settings2, SquarePen, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Banner } from "../components/Banners";
import { Tip } from "../components/Tip";
import type { Dashboard } from "../model";
import type { AskClientFactory } from "./askClient";
import { AskComposer, type AskAbout, type AskDraft } from "./AskComposer";
import { AskConversations } from "./AskConversations";
import { AskMaterials, type AskMaterialsControls } from "./AskMaterials";
import type { ConversationSummary } from "./conversations";
import type { ProposalAction } from "./AskProposals";
import type { AskProposal, ProposalContext } from "./proposals";
import { formatBytes, type ConsentRequest } from "./clientTools";
import type { AskLive } from "./AskRows";
import { hostOf, type AskSettings } from "./askSettings";
import { AskSetup, type AskAccountControls } from "./AskSetup";
import { AskThread } from "./AskThread";
import type { AskVerdict } from "./feedback";
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
  /** Course materials, course by course. Absent when files cannot be read at all. */
  materials?: AskMaterialsControls;
  /** Ratings of answers, kept on this device. */
  feedback?: AskFeedbackView;
  /** How much of the server's daily allowance is used, when the server reports a limit. */
  serverUsage?: ServerUsage | null;
  /** Changes when the composer should take focus. */
  focusNonce?: number;
  /** The student's account on a hosted Nova server. */
  account?: AskAccountControls;
};

export type AskFeedbackView = {
  votes: ReadonlyMap<string, AskVerdict>;
  onVote: (messageId: string, verdict: AskVerdict | null) => void;
  /** How many ratings are stored, across every conversation. */
  count: number;
  onExport: () => void;
};

/** Tokens the server has used today, for everyone who uses it, against its daily limit. */
export type ServerUsage = { usedToday: number; dailyCap: number };

/** From this share of the daily limit on, the panel warns that answers may stop. */
export const USAGE_WARN_AT = 0.9;

export const usagePercent = (usage: ServerUsage): number => Math.min(100, Math.max(0, Math.round((usage.usedToday / usage.dailyCap) * 100)));

export type AskConsent = {
  pending: ConsentRequest | null;
  /** Allows what was asked (and, for a course, reads its materials first), then asks the question again. */
  onAllow: () => void;
  onDecline: () => void;
  /** Shown while a course's materials are being read after Allow. */
  working?: string | null;
};

export type AskSavedConversations = {
  list: readonly ConversationSummary[];
  onOpen: (id: string) => void;
  /** Deletes a saved conversation; when it is the one on screen, the thread is cleared too. */
  onDelete: (id: string) => void;
};

/** The Ask tab body: setup card until enabled, then the thread and the composer. */
export const AskView = ({ notices, thread, settings, onSettingsChange, clientFactory, dashboard, mode, now, canOpen, onOpen, live, draft = null, about = null, onClearAbout, onSend, conversations, proposalContext, onProposal, consent, materials, feedback, serverUsage = null, focusNonce = 0, account }: AskViewProps) => {
  const [editing, setEditing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const saved = settings.persistConversations === true && conversations ? conversations : null;
  const showSetup = !settings.enabled || editing;
  const streaming = thread.status === "streaming";
  const lastQuestion = [...thread.messages].reverse().find((message) => message.role === "user")?.text ?? null;
  // Tokens of the newest answer a model wrote; an answer made on the device used none.
  const lastTokens = [...thread.messages].reverse().find((message) => message.role === "assistant" && message.grounded !== null)?.usage?.totalTokens ?? null;
  const percent = serverUsage && serverUsage.dailyCap > 0 ? usagePercent(serverUsage) : null;
  const nearlyOut = serverUsage !== null && serverUsage.dailyCap > 0 && serverUsage.usedToday / serverUsage.dailyCap >= USAGE_WARN_AT;

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
          <AskSetup
            key={`${settings.apiBaseUrl}|${settings.token ?? ""}`}
            settings={settings}
            onChange={onSettingsChange}
            clientFactory={clientFactory}
            editing={settings.enabled}
            onClose={settings.enabled ? () => setEditing(false) : undefined}
            feedback={feedback ? { count: feedback.count, onExport: feedback.onExport } : undefined}
            account={account}
          />
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
            {materials ? (
              <Tip label="Course materials">
                <button type="button" className="icon-button icon-button-sm" aria-label="Course materials" onClick={() => setChoosing(true)}>
                  <LibraryBig size={15} aria-hidden="true" />
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
        {settings.enabled && !editing && (lastTokens !== null || percent !== null) ? (
          <p className="ask-usage" data-tone={nearlyOut ? "warn" : undefined}>
            {lastTokens !== null ? <span>Last answer: {lastTokens.toLocaleString("en-US")} tokens</span> : null}
            {percent !== null ? (
              <span className="ask-usage-server">
                <span>Server use today: {percent}%</span>
                <span className="ask-meter" role="meter" aria-label="Share of the Nova server's daily limit used today" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                  <span className="ask-meter-fill" style={{ width: `${percent}%` }} />
                </span>
              </span>
            ) : null}
            {nearlyOut ? <span role="status">Nearly out for today. Simple questions are still answered on this device.</span> : null}
          </p>
        ) : null}
        {settings.enabled && !editing ? (
          thread.messages.length === 0 ? (
            <div className="empty ask-empty">
              <strong>Ask about your courses</strong>
              <span>Deadlines, what changed, what to start first. Answers cover every course and use the data on this device.</span>
            </div>
          ) : (
            <AskThread messages={thread.messages} status={thread.status} dashboard={dashboard} now={now} apiBaseUrl={settings.apiBaseUrl} canOpen={canOpen} onOpen={onOpen} onRetry={thread.retryLast} onSettings={() => setEditing(true)} live={live} onAsk={thread.send} proposalContext={proposalContext} onProposal={onProposal} feedback={feedback ? { votes: feedback.votes, onVote: feedback.onVote } : undefined} />
          )
        ) : null}
        {settings.enabled && !editing && consent?.pending ? (
          <section className="ask-proposal ask-consent" data-state="pending" aria-label={consent.pending.kind === "attachment" ? "Permission to read a file" : "Permission to read course materials"}>
            <p className="ask-proposal-kicker">Nova asks</p>
            {consent.pending.kind === "attachment" ? (
              <p className="ask-proposal-text">
                May Nova read <strong>{consent.pending.fileName}</strong> ({formatBytes(consent.pending.size)}) from "{consent.pending.itemTitle}"? It is downloaded through your Brightspace session and opened on this device. The part your question needs goes to the Nova server with it.
              </p>
            ) : (
              <p className="ask-proposal-text">
                May Nova read the course materials of <strong>{consent.pending.courseName}</strong>? Nova downloads the files in its Content area through your Brightspace session, keeps their text on this device, and sends only the passages a question needs. You can undo this under Course materials.
              </p>
            )}
            {consent.working ? (
              <p className="ask-proposal-status" role="status">
                {consent.working}
              </p>
            ) : (
              <div className="card-actions">
                <button type="button" className="button button-primary button-sm" onClick={consent.onAllow} disabled={streaming}>
                  {consent.pending.kind === "attachment" ? "Allow for this session" : "Allow and read"}
                </button>
                <button type="button" className="button button-ghost button-sm" onClick={consent.onDecline}>
                  Not now
                </button>
              </div>
            )}
          </section>
        ) : null}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {thread.announcement ?? ""}
        </p>
      </div>
      {materials && choosing ? <AskMaterials {...materials} now={now} onClose={() => setChoosing(false)} /> : null}
      {saved && browsing ? <AskConversations conversations={saved.list} currentId={thread.conversationId} now={now} onOpen={saved.onOpen} onDelete={saved.onDelete} onClose={() => setBrowsing(false)} /> : null}
      <AskComposer streaming={streaming} disabled={!settings.enabled || editing} onSend={onSend ?? thread.send} onStop={thread.stop} draft={draft} about={about} onClearAbout={onClearAbout} lastQuestion={lastQuestion} focusNonce={focusNonce} />
    </div>
  );
};
