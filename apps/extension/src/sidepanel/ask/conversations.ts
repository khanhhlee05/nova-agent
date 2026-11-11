import { CHAT_LIMITS, askEventSchema, modelUsageSchema, proposalPayloadSchema, toolNameSchema, toolRowSchema, type AskErrorEvent, type ToolRow } from "@nova-agent/protocol";
import { z } from "zod";
import type { AskProposal } from "./proposals";
import { HISTORY_LIMIT, sendable, type AskMessage, type AskTool } from "./thread";

/** How many conversations are kept per account. The oldest goes first. */
export const MAX_CONVERSATIONS = 20;

export const CONVERSATION_TITLE_LIMIT = 60;

/** What the conversations list shows. No message text beyond the title. */
export type ConversationSummary = { id: string; title: string; updatedAt: string; questions: number };

export type StoredConversation = { id: string; title: string; createdAt: string; updatedAt: string; messages: AskMessage[] };

/**
 * Where saved conversations live. The Ask tab only sees this seam, so the
 * same UI runs over Dexie today and over a server later.
 */
export type ConversationStore = {
  list: readonly ConversationSummary[];
  save: (conversation: { id: string; messages: AskMessage[] }) => void;
  load: (id: string) => Promise<StoredConversation | null>;
  remove: (id: string) => void;
};

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

const clip = (text: string, max: number): string => {
  const clean = oneLine(text);
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};

/** The first question, clipped. No model call names a conversation. */
export const conversationTitle = (messages: readonly AskMessage[]): string => {
  const first = messages.find((message) => message.role === "user" && message.text.trim() !== "");
  return first ? clip(first.text, CONVERSATION_TITLE_LIMIT) : "New conversation";
};

/**
 * What was said before the twelve messages the server sees, written without
 * a model: each earlier question, and for each answer the summaries of the
 * lookups it made (or its first words when it made none). When it would not
 * fit, the oldest exchanges are dropped first. Null while everything still
 * fits in the history window.
 */
export const summaryOf = (messages: readonly AskMessage[]): string | null => {
  const eligible = messages.filter(sendable);
  if (eligible.length <= HISTORY_LIMIT) return null;
  const parts = eligible.slice(0, -HISTORY_LIMIT).map((message) => {
    if (message.role === "user") return `The student asked: ${clip(message.text, 160)}`;
    const looked = message.tools
      .filter((tool) => tool.status === "ok" && tool.summary)
      .map((tool) => tool.summary)
      .join(" ");
    return `Nova answered: ${clip(looked || message.text, 220)}`;
  });
  const kept: string[] = [];
  let length = 0;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index] as string;
    if (length + part.length + 3 > CHAT_LIMITS.summary) break;
    kept.unshift(part);
    length += part.length + 3;
  }
  return kept.length > 0 ? kept.join(" | ") : null;
};

const storedToolSchema = z.object({
  id: z.string(),
  name: toolNameSchema,
  status: z.enum(["running", "ok", "error"]),
  summary: z.string().nullable(),
  rows: z.number(),
  input: z.unknown().optional(),
});

const storedProposalSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  payload: proposalPayloadSchema,
  state: z.enum(["pending", "confirmed", "dismissed", "undone", "expired"]),
});

const errorEventSchema = askEventSchema.refine((event): event is AskErrorEvent => event.type === "error");

const storedMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  tools: z.array(z.unknown()),
  rows: z.array(z.unknown()),
  error: z.unknown(),
  usage: modelUsageSchema.nullable().catch(null),
  grounded: z.boolean().nullable().catch(null),
  stopped: z.boolean().catch(false),
  proposals: z.array(z.unknown()).optional().catch(undefined),
});

/**
 * Reads messages back from storage defensively: a build that saved a shape
 * this build no longer knows loses that row, tool, or message, never the
 * whole conversation, and nothing malformed reaches a component.
 */
export const reviveMessages = (raw: unknown): AskMessage[] => {
  if (!Array.isArray(raw)) return [];
  const out: AskMessage[] = [];
  for (const entry of raw) {
    const parsed = storedMessageSchema.safeParse(entry);
    if (!parsed.success) continue;
    const tools: AskTool[] = parsed.data.tools.flatMap((tool) => {
      const result = storedToolSchema.safeParse(tool);
      // A lookup still "running" in storage never finished; it must not spin forever on restore.
      return result.success ? [result.data.status === "running" ? { ...result.data, status: "error" as const, summary: "stopped before it finished" } : result.data] : [];
    });
    const rows: ToolRow[] = parsed.data.rows.flatMap((row) => {
      const result = toolRowSchema.safeParse(row);
      return result.success ? [result.data] : [];
    });
    const error = errorEventSchema.safeParse(parsed.data.error);
    // A suggestion made against older data is not offered again, and a restored "Done" cannot be undone: what it touched may have changed since.
    const proposals: AskProposal[] = (parsed.data.proposals ?? []).flatMap((proposal) => {
      const result = storedProposalSchema.safeParse(proposal);
      return result.success ? [{ ...result.data, state: result.data.state === "pending" ? ("expired" as const) : result.data.state }] : [];
    });
    out.push({ id: parsed.data.id, role: parsed.data.role, text: parsed.data.text, tools, rows, error: error.success ? (error.data as AskErrorEvent) : null, usage: parsed.data.usage, grounded: parsed.data.grounded, stopped: parsed.data.stopped, ...(proposals.length > 0 ? { proposals } : {}) });
  }
  return out;
};

export const summarize = (conversation: StoredConversation): ConversationSummary => ({
  id: conversation.id,
  title: conversation.title,
  updatedAt: conversation.updatedAt,
  questions: conversation.messages.filter((message) => message.role === "user").length,
});
