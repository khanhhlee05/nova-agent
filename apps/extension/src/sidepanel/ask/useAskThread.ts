import type { ChatRequest } from "@nova-agent/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskClient, AskHandlers } from "./askClient";
import type { AskProposal } from "./proposals";
import { historyOf, mergeRows, settleTools, type AskMessage, type AskRequestContext, type AskSendOptions } from "./thread";

export * from "./thread";

export type AskStatus = "idle" | "streaming";

export type AskThread = {
  /** Identity of the conversation on screen. Changes on clear, on a new conversation, and on load. */
  conversationId: string;
  messages: AskMessage[];
  status: AskStatus;
  send: (text: string, options?: AskSendOptions) => void;
  stop: () => void;
  retryLast: () => void;
  /** Empties the thread and starts a new conversation. */
  clear: () => void;
  /** Replaces the thread with a saved conversation. */
  load: (conversation: { id: string; messages: AskMessage[] }) => void;
  /** Records what the student decided about one suggestion, and what confirming it touched. */
  setProposal: (messageId: string, proposalId: string, patch: Partial<Pick<AskProposal, "state" | "applied" | "label">>) => void;
  /** Polite live-region text for screen readers. */
  announcement: string | null;
};

let counter = 0;
const nextId = (): string => `ask-${Date.now().toString(36)}-${(counter++).toString(36)}`;
const nextConversationId = (): string => `conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const noSummary = (): null => null;

/** What a failed lookup reads as: the line written for the student when there is one, otherwise the reason the model was given. */
const failureLine = (summary: string, error: string | undefined): string => (summary !== "" && summary !== "Lookup failed" ? summary : (error ?? "Lookup failed"));

/**
 * Conversation state for the Ask tab. The hook itself persists nothing: by
 * default closing the panel forgets the thread, the same rule as session
 * dismissals. A caller that saves conversations reads `conversationId` and
 * `messages` and restores with `load`.
 *
 * `summarize` writes what came before the history window, so a long thread
 * keeps its context without sending every message.
 */
export const useAskThread = (
  client: AskClient | null,
  buildRequest: (message: string, context: AskRequestContext) => ChatRequest | null,
  summarize: (messages: readonly AskMessage[]) => string | null = noSummary,
  handlers?: AskHandlers,
): AskThread => {
  const [conversationId, setConversationId] = useState(nextConversationId);
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [status, setStatus] = useState<AskStatus>("idle");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(messages);
  latest.current = messages;
  // What the last question was sent with, so Retry asks the same thing about the same item.
  const lastOptions = useRef<AskSendOptions>({});
  // Read at the moment a lookup arrives, so a turn always uses the handlers of the current render.
  const liveHandlers = useRef(handlers);
  liveHandlers.current = handlers;

  useEffect(() => () => controller.current?.abort(), []);

  const patch = useCallback((id: string, update: (message: AskMessage) => AskMessage) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? update(message) : message)));
  }, []);

  const send = useCallback(
    (text: string, options: AskSendOptions = {}) => {
      const question = text.trim();
      if (!client || question === "" || controller.current) return;
      const request = buildRequest(question, { ...options, history: historyOf(latest.current), summary: summarize(latest.current) });
      if (!request) return;
      lastOptions.current = options;
      const userId = nextId();
      const answerId = nextId();
      const empty: Omit<AskMessage, "id" | "role"> = { text: "", tools: [], rows: [], error: null, usage: null, grounded: null, stopped: false };
      setMessages((prev) => [...prev, { ...empty, id: userId, role: "user", text: question }, { ...empty, id: answerId, role: "assistant" }]);
      setStatus("streaming");
      setAnnouncement("Nova is answering.");
      const abort = new AbortController();
      controller.current = abort;

      void (async () => {
        let outcome: "answered" | "stopped" | "failed" = "answered";
        let failure: string | null = null;
        let answer = "";
        try {
          for await (const event of client.ask(request, abort.signal, { clientTool: (name, input, signal) => liveHandlers.current?.clientTool?.(name, input, signal) ?? Promise.resolve({ ok: false, summary: "", data: null, rows: [], error: "This panel cannot make that lookup." }) })) {
            switch (event.type) {
              case "text":
                answer += event.delta;
                patch(answerId, (message) => ({ ...message, text: message.text + event.delta }));
                break;
              case "tool_call":
                patch(answerId, (message) => ({ ...message, tools: [...message.tools, { id: event.id, name: event.name, status: "running", summary: null, rows: 0, input: event.input }] }));
                break;
              case "tool_result":
                patch(answerId, (message) => ({
                  ...message,
                  tools: message.tools.map((tool) => (tool.id === event.id ? { ...tool, status: event.ok ? "ok" : "error", summary: event.ok ? event.summary : failureLine(event.summary, event.error), rows: event.rows.length } : tool)),
                  rows: mergeRows(message.rows, event.rows),
                }));
                break;
              case "proposal":
                patch(answerId, (message) =>
                  (message.proposals ?? []).some((proposal) => proposal.id === event.id) ? message : { ...message, proposals: [...(message.proposals ?? []), { id: event.id, label: event.label, payload: event.payload, state: "pending" }] },
                );
                break;
              case "text_reset":
                // What was shown so far was not the answer: a remark before a lookup, or a draft that failed the check.
                answer = "";
                patch(answerId, (message) => ({ ...message, text: "", ...(event.reason === "correction" ? { revised: true } : {}) }));
                if (event.reason === "correction") setAnnouncement("Nova is correcting its answer.");
                break;
              case "client_tool":
                break;
              case "done":
                patch(answerId, (message) => ({ ...message, usage: event.usage, grounded: event.grounded, model: event.model, ...(event.offline ? { offline: event.offline } : {}) }));
                break;
              case "error":
                if (event.code === "aborted") {
                  outcome = "stopped";
                  patch(answerId, (message) => ({ ...message, stopped: true }));
                } else {
                  outcome = "failed";
                  failure = event.message;
                  patch(answerId, (message) => ({ ...message, error: event }));
                }
                break;
            }
          }
        } catch (error) {
          outcome = abort.signal.aborted ? "stopped" : "failed";
          failure = error instanceof Error ? error.message : "Nova hit an unexpected problem.";
          patch(answerId, (message) =>
            abort.signal.aborted ? { ...message, stopped: true } : { ...message, error: { type: "error", code: "internal", message: failure ?? "Nova hit an unexpected problem.", retryable: true } },
          );
        } finally {
          patch(answerId, settleTools);
          // A turn that was replaced (thread cleared, another conversation loaded) must not touch the one that replaced it.
          if (controller.current === abort) {
            controller.current = null;
            setStatus("idle");
            // The answer itself is announced, not just that one arrived: the thread is not a live region.
            setAnnouncement(outcome === "answered" ? (answer.trim() ? `Nova answered: ${answer.trim()}` : "Nova answered.") : outcome === "stopped" ? "Stopped." : `Nova could not answer. ${failure ?? ""}`.trim());
          }
        }
      })();
    },
    [buildRequest, client, patch, summarize],
  );

  const stop = useCallback(() => controller.current?.abort(), []);

  const retryLast = useCallback(() => {
    const lastUser = [...latest.current].reverse().find((message) => message.role === "user");
    if (!lastUser || controller.current) return;
    // Drop the failed pair so the retry does not carry a broken answer in its history.
    setMessages((prev) => {
      const index = prev.findIndex((message) => message.id === lastUser.id);
      return index === -1 ? prev : prev.slice(0, index);
    });
    latest.current = latest.current.slice(0, latest.current.findIndex((message) => message.id === lastUser.id));
    send(lastUser.text, lastOptions.current);
  }, [send]);

  /** Ends whatever is streaming and hands the thread over to `next` at once, so a question can follow immediately. */
  const replace = useCallback((id: string, next: AskMessage[], note: string) => {
    controller.current?.abort();
    controller.current = null;
    lastOptions.current = {};
    latest.current = next;
    setMessages(next);
    setConversationId(id);
    setStatus("idle");
    setAnnouncement(note);
  }, []);

  const clear = useCallback(() => replace(nextConversationId(), [], "Conversation cleared."), [replace]);

  const load = useCallback((conversation: { id: string; messages: AskMessage[] }) => replace(conversation.id, conversation.messages, "Conversation restored."), [replace]);

  const setProposal = useCallback(
    (messageId: string, proposalId: string, change: Partial<Pick<AskProposal, "state" | "applied" | "label">>) =>
      patch(messageId, (message) => ({ ...message, proposals: (message.proposals ?? []).map((proposal) => (proposal.id === proposalId ? { ...proposal, ...change } : proposal)) })),
    [patch],
  );

  return useMemo(() => ({ conversationId, messages, status, send, stop, retryLast, clear, load, setProposal, announcement }), [conversationId, messages, status, send, stop, retryLast, clear, load, setProposal, announcement]);
};
