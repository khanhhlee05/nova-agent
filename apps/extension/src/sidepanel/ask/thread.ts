import type { AskErrorEvent, ChatMessage, ModelUsage, ToolName, ToolRow } from "@nova-agent/protocol";

/**
 * The shape of a conversation and the pure rules over it. No React here, so
 * storage and tests can use these without the hook.
 */

/** `input` is what the model passed to the lookup; follow-up chips read it. */
export type AskTool = { id: string; name: ToolName; status: "running" | "ok" | "error"; summary: string | null; rows: number; input?: unknown };

/** Context for one question that is not part of its text. */
export type AskSendOptions = {
  /** Short id of the item the question was started from. */
  focusItemId?: string;
};

/** Everything `buildRequest` gets besides the question: the history window, what came before it, and the send options. */
export type AskRequestContext = AskSendOptions & { history: ChatMessage[]; summary: string | null };

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

export const HISTORY_LIMIT = 12;

/** A message the server may see: a question, or an answer that did not fail. */
export const sendable = (message: AskMessage): boolean => message.text.trim() !== "" && (message.role === "user" || message.error === null);

/** Text-only history the server sees: user questions and completed answers, newest last, capped. */
export const historyOf = (messages: readonly AskMessage[]): ChatMessage[] =>
  messages
    .filter(sendable)
    .map((message): ChatMessage => ({ role: message.role, content: message.text.slice(0, 4000) }))
    .slice(-HISTORY_LIMIT);

/** A lookup that never reported back must not read "Looking up…" forever once the answer has ended. */
export const settleTools = (message: AskMessage): AskMessage =>
  message.tools.some((tool) => tool.status === "running") ? { ...message, tools: message.tools.map((tool) => (tool.status === "running" ? { ...tool, status: "error" as const, summary: "stopped before it finished" } : tool)) } : message;

