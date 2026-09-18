import type { AskErrorEvent, ToolName } from "@nova-agent/protocol";
import { AlertTriangle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Dashboard } from "../model";
import { AskRows } from "./AskRows";
import type { AskMessage, AskStatus } from "./useAskThread";

const TOOL_LABELS: Record<ToolName, string> = {
  get_brief: "your workload",
  list_deadlines: "deadlines",
  get_item_details: "item details",
  get_recent_announcements: "announcements",
  get_changes: "changes",
};

export const errorCopy = (error: AskErrorEvent, apiBaseUrl: string): { title: string; text: string; retry: boolean; settings: boolean } => {
  switch (error.code) {
    case "unreachable":
      return { title: "Nova API is not reachable", text: `Nothing answered at ${apiBaseUrl}. Start it with npm run dev:api, or change the address in Settings.`, retry: true, settings: true };
    case "not_configured":
      return { title: "The Nova API has no model key yet", text: "Add OPENROUTER_API_KEY to apps/api/.env and restart the API.", retry: true, settings: false };
    case "unauthorized":
      return { title: "The Nova API refused the request", text: error.message, retry: false, settings: true };
    case "rate_limited":
      return { title: "The model is rate limited", text: error.retryAfterSeconds ? `Try again in ${Math.ceil(error.retryAfterSeconds)} seconds.` : "Try again in a moment.", retry: true, settings: false };
    case "budget_exhausted":
      return { title: "Today's token budget is used up", text: "The Nova API caps tokens per day. Try again tomorrow.", retry: false, settings: false };
    case "upstream_timeout":
      return { title: "The model took too long", text: "Try a shorter question or ask again.", retry: true, settings: false };
    case "bad_request":
      return { title: "The Nova API rejected the question", text: error.message, retry: false, settings: false };
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
};

export const AskThread = ({ messages, status, dashboard, now, apiBaseUrl, canOpen, onOpen, onRetry, onSettings }: AskThreadProps) => {
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
                    {tool.status === "running" ? `Looking up ${TOOL_LABELS[tool.name]}…` : tool.status === "ok" ? `Looked up ${TOOL_LABELS[tool.name]} · ${tool.rows} ${tool.rows === 1 ? "row" : "rows"}` : `Could not look up ${TOOL_LABELS[tool.name]}: ${tool.summary ?? ""}`}
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
            <AskRows rows={message.rows} dashboard={dashboard} now={now} canOpen={canOpen} onOpen={onOpen} />
            {message.stopped ? <p className="ask-note">Stopped before Nova finished.</p> : null}
            {message.grounded === false ? <p className="ask-note">Nova could not verify every item named above against your data.</p> : null}
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
          </li>
        );
      })}
    </ol>
  );
};
