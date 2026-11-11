import type { AskErrorEvent, ChatMessage, ModelUsage, ToolName, ToolRow } from "@nova-agent/protocol";
import type { AskProposal } from "./proposals";

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
  /** The model that wrote the answer, as the server named it. Absent on messages saved before it was kept. */
  model?: string | null;
  /** Set when the answer was made on this device because the server could not answer; says why. */
  offline?: "unreachable" | "not_configured" | "rate_limited" | "budget_exhausted";
  /** True when a first draft failed the check and was replaced by this text while the student watched. */
  revised?: boolean;
  /** Actions the answer suggested, each waiting for the student or already decided. Absent on messages saved before suggestions existed. */
  proposals?: AskProposal[];
};

export const HISTORY_LIMIT = 12;

/** A message the server may see: a question, or an answer that finished and did not fail. A stopped answer is a draft nobody checked. */
export const sendable = (message: AskMessage): boolean => message.text.trim() !== "" && (message.role === "user" || (message.error === null && !message.stopped));

/** Text-only history the server sees: user questions and completed answers, newest last, capped. */
export const historyOf = (messages: readonly AskMessage[]): ChatMessage[] =>
  messages
    .filter(sendable)
    .map((message): ChatMessage => ({ role: message.role, content: message.text.slice(0, 4000) }))
    .slice(-HISTORY_LIMIT);

const rowKey = (row: ToolRow): string => `${row.kind}\n${row.id}`;

/**
 * Adds the rows of one more lookup to an answer. A row seen before keeps its
 * place and takes the newer contents (a file listed, then read, shows as
 * read); new rows follow in the order they came, each once.
 */
export const mergeRows = (existing: readonly ToolRow[], incoming: readonly ToolRow[]): ToolRow[] => {
  // A Map keeps the first position of a key and the last value set for it.
  const merged = new Map<string, ToolRow>(existing.map((row) => [rowKey(row), row]));
  for (const row of incoming) merged.set(rowKey(row), row);
  return [...merged.values()];
};

/** A lookup that never reported back must not read "Looking up…" forever once the answer has ended. */
export const settleTools = (message: AskMessage): AskMessage =>
  message.tools.some((tool) => tool.status === "running") ? { ...message, tools: message.tools.map((tool) => (tool.status === "running" ? { ...tool, status: "error" as const, summary: "stopped before it finished" } : tool)) } : message;

