import type { AskErrorEvent, ToolName } from "@nova-agent/protocol";
import { AlertTriangle, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useRef } from "react";
import { Tip } from "../components/Tip";
import type { Dashboard } from "../model";
import { AskFollowUps } from "./AskChips";
import { AskPlans } from "./AskPlan";
import { AskProposals, type ProposalAction } from "./AskProposals";
import type { AskProposal, ProposalContext } from "./proposals";
import { AskRowsDisclosure, type AskLive } from "./AskRows";
import { hostOf } from "./askSettings";
import { canRate, type AskVerdict } from "./feedback";
import { OFFLINE_NOTE, OFFLINE_REASON_COPY } from "./offline";
import type { AskMessage, AskStatus } from "./useAskThread";

/** A suggestion's own summary already starts with "Suggested", so nothing is put in front of it. The same holds for any lookup whose `done` is empty. */
const SUGGESTION_COPY = { running: "Preparing a suggestion", done: "", failed: "Could not suggest that" };

/** What each lookup reads as while it runs, once it is done, and when it fails. */
const TOOL_COPY: Record<ToolName, { running: string; done: string; failed: string }> = {
  get_brief: { running: "Looking up your workload", done: "Looked up your workload", failed: "Could not look up your workload" },
  list_deadlines: { running: "Looking up deadlines", done: "Looked up deadlines", failed: "Could not look up deadlines" },
  get_item_details: { running: "Looking up item details", done: "Looked up item details", failed: "Could not look up item details" },
  get_recent_announcements: { running: "Looking up announcements", done: "Looked up announcements", failed: "Could not look up announcements" },
  get_changes: { running: "Looking up changes", done: "Looked up changes", failed: "Could not look up changes" },
  build_study_plan: { running: "Building a study plan", done: "Built a study plan", failed: "Could not build a study plan" },
  get_course_load: { running: "Comparing your courses", done: "Compared your courses", failed: "Could not compare your courses" },
  read_attachment: { running: "Reading a file", done: "", failed: "Could not read the file" },
  search_course_materials: { running: "Searching your course materials", done: "Searched your course materials", failed: "Could not search your course materials" },
  read_course_material: { running: "Reading a topic", done: "", failed: "Could not read the topic" },
  propose_mark_done: SUGGESTION_COPY,
  propose_hide: SUGGESTION_COPY,
  propose_mark_read: SUGGESTION_COPY,
  propose_personal_deadline: SUGGESTION_COPY,
};

const toolLine = (tool: AskMessage["tools"][number]): string => {
  const copy = TOOL_COPY[tool.name];
  if (tool.status === "running") return `${copy.running}…`;
  if (tool.status === "ok" && copy.done === "") return tool.summary ? tool.summary.replace(/\.$/, "") : "Done";
  if (tool.status === "ok") return tool.summary ? `${copy.done}: ${tool.summary.replace(/\.$/, "")}` : `${copy.done} · ${tool.rows} ${tool.rows === 1 ? "row" : "rows"}`;
  return `${copy.failed}: ${tool.summary ?? ""}`;
};

export const errorCopy = (error: AskErrorEvent, apiBaseUrl: string): { title: string; text: string; retry: boolean; settings: boolean } => {
  switch (error.code) {
    case "unreachable":
      return { title: "Can't reach the Nova server", text: `Nothing answered at ${hostOf(apiBaseUrl)}. If the server runs on this computer, make sure it's started, then retry. Otherwise, check the address in Settings.`, retry: true, settings: true };
    case "not_configured":
      return { title: "The Nova server can't answer yet", text: "It still needs a model key. Whoever set up the server can add one, then retry.", retry: true, settings: false };
    case "unauthorized":
      return { title: "The Nova server didn't accept your access code", text: "Check the access code in Settings. It's missing or doesn't match the one the server expects.", retry: false, settings: true };
    case "rate_limited":
      return { title: "The AI model is busy", text: error.retryAfterSeconds ? `Try again in ${Math.ceil(error.retryAfterSeconds)} seconds.` : "Try again in a moment.", retry: true, settings: false };
    case "budget_exhausted":
      return { title: "Ask Nova has hit today's limit", text: "The Nova server allows a set amount of use per day, and it's used up. Try again tomorrow.", retry: false, settings: false };
    case "upstream_timeout":
      return { title: "The answer took too long", text: "Try a shorter question or ask again.", retry: true, settings: false };
    case "bad_request":
      return { title: "Nova couldn't send that question", text: "Try asking it again in fewer words.", retry: false, settings: false };
    default:
      return { title: "Nova could not answer", text: error.message, retry: error.retryable, settings: false };
  }
};

export type AskThreadProps = {
  messages: AskMessage[];
  status: AskStatus;
  dashboard: Dashboard;
  now: Date;
  apiBaseUrl: string;
  canOpen: (url: string | null) => boolean;
  onOpen: (url: string) => void;
  onRetry: () => void;
  onSettings: () => void;
  /** Live state and row actions; rows are read-only without it. */
  live?: AskLive;
  /** Sends a follow-up question. Follow-up chips are hidden without it. */
  onAsk?: (question: string) => void;
  /** The data suggestions are checked against, and what the student decided about one. */
  proposalContext?: ProposalContext;
  onProposal?: (messageId: string, proposal: AskProposal, action: ProposalAction) => void;
  /** The student's rating of each answer. Without it answers cannot be rated. */
  feedback?: { votes: ReadonlyMap<string, AskVerdict>; onVote: (messageId: string, verdict: AskVerdict | null) => void };
};

export const AskThread = ({ messages, status, dashboard, now, apiBaseUrl, canOpen, onOpen, onRetry, onSettings, live, onAsk, proposalContext, onProposal, feedback }: AskThreadProps) => {
  const list = useRef<HTMLOListElement>(null);
  const lastId = messages.at(-1)?.id;
  const lastText = messages.at(-1)?.text.length ?? 0;
  useEffect(() => {
    // Scroll the thread's own container only; scrollIntoView would also move ancestor scrollers.
    const scroller = list.current?.closest(".ask-thread");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [lastId, lastText, status]);

  return (
    <ol ref={list} className="ask-messages" aria-label="Conversation">
      {messages.map((message, index) => {
        const last = index === messages.length - 1;
        if (message.role === "user") {
          return (
            <li key={message.id} className="ask-msg" data-role="user">
              <p className="ask-bubble">{message.text}</p>
            </li>
          );
        }
        const streaming = last && status === "streaming";
        const copy = message.error ? errorCopy(message.error, apiBaseUrl) : null;
        return (
          <li key={message.id} className="ask-msg" data-role="assistant" aria-busy={streaming}>
            {message.tools.length > 0 ? (
              <ul className="ask-tools" aria-label="Lookups">
                {message.tools.map((tool) => (
                  <li key={tool.id} className="ask-tool" data-state={tool.status}>
                    {toolLine(tool)}
                  </li>
                ))}
              </ul>
            ) : null}
            {message.text ? (
              <p className="ask-answer">
                {message.text}
                {streaming ? <span className="ask-caret" aria-hidden="true" /> : null}
              </p>
            ) : streaming ? (
              <p className="ask-answer ask-thinking">
                Thinking…
                <span className="ask-caret" aria-hidden="true" />
              </p>
            ) : null}
            <AskPlans rows={message.rows} dashboard={dashboard} now={now} canOpen={canOpen} onOpen={onOpen} live={live} />
            <AskProposals proposals={message.proposals ?? []} context={proposalContext} onAction={onProposal ? (proposal, action) => onProposal(message.id, proposal, action) : undefined} />
            <AskRowsDisclosure rows={message.rows} dashboard={dashboard} now={now} canOpen={canOpen} onOpen={onOpen} live={live} />
            {message.stopped ? <p className="ask-note">{message.text.trim() !== "" ? "Stopped before Nova finished. What is shown above was not checked against your data." : "Stopped before Nova finished."}</p> : null}
            {message.offline ? (
              <p className="ask-note" data-tone="offline">
                {OFFLINE_REASON_COPY[message.offline]} {OFFLINE_NOTE}
              </p>
            ) : null}
            {message.revised && !streaming && message.grounded !== false ? <p className="ask-note">Nova corrected this answer after checking it against your data.</p> : null}
            {message.grounded === false ? <p className="ask-note">Nova could not verify everything in this answer against your data. Check the rows and Brightspace before relying on it.</p> : null}
            {copy && message.error ? (
              <div className="banner" data-tone="critical" role="alert">
                <AlertTriangle size={16} aria-hidden="true" />
                <div className="banner-main">
                  <strong>{copy.title}</strong>
                  <p>{copy.text}</p>
                  {(copy.retry && last) || copy.settings ? (
                    <div className="card-actions">
                      {copy.retry && last ? (
                        <button type="button" className="button button-sm" onClick={onRetry} disabled={status === "streaming"}>
                          Retry
                        </button>
                      ) : null}
                      {copy.settings ? (
                        <button type="button" className="button button-ghost button-sm" onClick={onSettings}>
                          Settings
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {feedback && !streaming && canRate(message) ? (
              <div className="ask-feedback" role="group" aria-label="Rate this answer">
                {(["up", "down"] as const).map((verdict) => {
                  const pressed = feedback.votes.get(message.id) === verdict;
                  const label = verdict === "up" ? "Good answer" : "Bad answer";
                  return (
                    <Tip key={verdict} label={pressed ? `${label}. Press again to take it back` : label}>
                      <button type="button" className="icon-button icon-button-sm" aria-label={label} aria-pressed={pressed} onClick={() => feedback.onVote(message.id, pressed ? null : verdict)}>
                        {verdict === "up" ? <ThumbsUp size={14} aria-hidden="true" /> : <ThumbsDown size={14} aria-hidden="true" />}
                      </button>
                    </Tip>
                  );
                })}
              </div>
            ) : null}
            {last && onAsk && status === "idle" && !message.error && !message.stopped && message.text.trim() !== "" ? <AskFollowUps tools={message.tools} onPick={onAsk} /> : null}
          </li>
        );
      })}
    </ol>
  );
};
