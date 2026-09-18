import type { AskErrorCode, ModelUsage } from "@nova-agent/protocol";
import type { ToolDefinition } from "./tools";

export type ToolCall = { id: string; name: string; arguments: string };

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type ModelStop = "end" | "tool_use" | "max_tokens" | "other";

export type ModelEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; stop: ModelStop; usage: ModelUsage | null; model: string | null };

export type ModelInput = {
  messages: ModelMessage[];
  tools: ToolDefinition[];
  toolChoice: "auto" | "none";
  maxTokens: number;
  signal: AbortSignal;
};

/** The one seam between Nova and any model provider. Everything above it is provider-agnostic. */
export interface ChatModel {
  readonly id: string;
  complete(input: ModelInput): AsyncIterable<ModelEvent>;
}

export class ModelError extends Error {
  constructor(
    public readonly code: AskErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

export const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

export const addUsage = (a: ModelUsage | null, b: ModelUsage | null): ModelUsage | null => {
  if (!a) return b;
  if (!b) return a;
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens, totalTokens: a.totalTokens + b.totalTokens };
};
