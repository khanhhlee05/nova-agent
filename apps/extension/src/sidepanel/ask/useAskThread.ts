import type { AskErrorEvent, ChatMessage, ChatRequest, ModelUsage, ToolName, ToolRow } from "@nova-agent/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AskClient } from "./askClient";

export type AskTool = { id: string; name: ToolName; status: "running" | "ok" | "error"; summary: string | null; rows: number };

export type AskMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: AskTool[];
  rows: ToolRow[];
  error: AskErrorEvent | null;
  usage: ModelUsage | null;
  grounded: boolean | null;
  /** True when the student pressed Stop before the answer finished. */
  stopped: boolean;
};

export type AskStatus = "idle" | "streaming";

export type AskThread = {
  messages: AskMessage[];
  status: AskStatus;
  send: (text: string) => void;
  stop: () => void;
  retryLast: () => void;
  clear: () => void;
  /** Polite live-region text for screen readers. */
  announcement: string | null;
};

export const HISTORY_LIMIT = 12;

let counter = 0;
const nextId = (): string => `ask-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Text-only history the server sees: user questions and completed answers, newest last, capped. */
export const historyOf = (messages: readonly AskMessage[]): ChatMessage[] =>
  messages
    .filter((message) => message.text.trim() !== "" && (message.role === "user" || message.error === null))
    .map((message): ChatMessage => ({ role: message.role, content: message.text.slice(0, 4000) }))
    .slice(-HISTORY_LIMIT);

/**
 * Session-only conversation state. Nothing is persisted: closing the panel
 * forgets the thread, the same rule as session dismissals.
 */
export const useAskThread = (client: AskClient | null, buildRequest: (message: string, history: ChatMessage[]) => ChatRequest | null): AskThread => {
  const [messages, setMessages] = useState<AskMessage[]>([]);
  const [status, setStatus] = useState<AskStatus>("idle");
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const latest = useRef(messages);
  latest.current = messages;

  useEffect(() => () => controller.current?.abort(), []);

  const patch = useCallback((id: string, update: (message: AskMessage) => AskMessage) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? update(message) : message)));
  }, []);

  const send = useCallback(
    (text: string) => {
      const question = text.trim();
      if (!client || question === "" || controller.current) return;
      const request = buildRequest(question, historyOf(latest.current));
      if (!request) return;
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
        try {
          for await (const event of client.ask(request, abort.signal)) {
            switch (event.type) {
              case "text":
                patch(answerId, (message) => ({ ...message, text: message.text + event.delta }));
                break;
              case "tool_call":
                patch(answerId, (message) => ({ ...message, tools: [...message.tools, { id: event.id, name: event.name, status: "running", summary: null, rows: 0 }] }));
                break;
              case "tool_result":
                patch(answerId, (message) => ({
                  ...message,
                  tools: message.tools.map((tool) => (tool.id === event.id ? { ...tool, status: event.ok ? "ok" : "error", summary: event.ok ? event.summary : (event.error ?? "Lookup failed"), rows: event.rows.length } : tool)),
                  rows: [...message.rows, ...event.rows.filter((row) => !message.rows.some((existing) => existing.kind === row.kind && existing.id === row.id))],
                }));
                break;
              case "done":
                patch(answerId, (message) => ({ ...message, usage: event.usage, grounded: event.grounded }));
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
          controller.current = null;
          setStatus("idle");
          setAnnouncement(outcome === "answered" ? "Nova answered." : outcome === "stopped" ? "Stopped." : `Nova could not answer. ${failure ?? ""}`.trim());
        }
      })();
    },
    [buildRequest, client, patch],
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
    send(lastUser.text);
  }, [send]);

  const clear = useCallback(() => {
    controller.current?.abort();
    setMessages([]);
    setAnnouncement("Conversation cleared.");
  }, []);

  return useMemo(() => ({ messages, status, send, stop, retryLast, clear, announcement }), [messages, status, send, stop, retryLast, clear, announcement]);
};
