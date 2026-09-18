import { parseSseStream } from "@nova-agent/protocol";
import type { ModelUsage } from "@nova-agent/protocol";
import { ModelError, isAbortError, type ChatModel, type ModelEvent, type ModelInput, type ModelMessage, type ModelStop, type ToolCall } from "./model";

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
  /** Extra request headers, for example OpenRouter's HTTP-Referer and X-Title. */
  headers?: Record<string, string>;
  /** How to ask for usage in the stream: OpenRouter's `usage.include`, OpenAI's `stream_options`, or nothing. */
  usageParam?: "openrouter" | "openai" | "none";
  timeoutMs?: number;
  retryDelayMs?: number;
};

type WireMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCallDelta = { index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } };

type StreamChunk = {
  id?: string;
  model?: string;
  choices?: { index?: number; delta?: { content?: string | null; tool_calls?: ToolCallDelta[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
  error?: { message?: string; code?: number | string } | null;
};

const toWire = (message: ModelMessage): WireMessage => {
  switch (message.role) {
    case "system":
    case "user":
      return { role: message.role, content: message.content };
    case "assistant":
      return {
        role: "assistant",
        content: message.content === "" ? null : message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
};

const mapStop = (reason: string | null | undefined, hasCalls: boolean): ModelStop => {
  if (reason === "tool_calls" || reason === "function_call") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop" || reason === null || reason === undefined) return hasCalls ? "tool_use" : "end";
  return "other";
};

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.round((date - Date.now()) / 1000));
};

const errorFor = async (response: Response): Promise<ModelError> => {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? "";
  } catch {
    detail = "";
  }
  const suffix = detail ? `: ${detail}` : "";
  switch (response.status) {
    case 401:
      return new ModelError("unauthorized", `The model provider rejected the API key${suffix}`);
    case 402:
      return new ModelError("budget_exhausted", `The model provider reports no credit left${suffix}`);
    case 403:
      return new ModelError("unauthorized", `The model provider refused the request${suffix}`);
    case 404:
      return new ModelError("upstream_error", `The model was not found${suffix}`);
    case 408:
    case 504:
      return new ModelError("upstream_timeout", `The model provider timed out${suffix}`, true);
    case 429:
      return new ModelError("rate_limited", `The model provider is rate limiting${suffix}`, true, parseRetryAfter(response.headers.get("retry-after")));
    default:
      return new ModelError("upstream_error", `The model provider answered ${response.status}${suffix}`, response.status >= 500);
  }
};

/**
 * Streams chat completions from any OpenAI-compatible endpoint (OpenRouter by
 * default). Tool-call fragments are accumulated by index and emitted once the
 * choice finishes, which is what free-tier providers need: some omit ids,
 * some send everything in one delta, some finish with "stop" after a call.
 */
export class OpenAiCompatibleModel implements ChatModel {
  readonly id: string;
  private readonly options: Required<Omit<OpenAiCompatibleOptions, "headers">> & { headers: Record<string, string> };

  constructor(options: OpenAiCompatibleOptions) {
    this.options = {
      fetch: globalThis.fetch,
      headers: {},
      usageParam: "openrouter",
      timeoutMs: 60_000,
      retryDelayMs: 500,
      ...options,
      baseUrl: options.baseUrl.replace(/\/+$/, ""),
    };
    this.id = `openai-compatible:${options.model}`;
  }

  async *complete(input: ModelInput): AsyncIterable<ModelEvent> {
    const body = {
      model: this.options.model,
      messages: input.messages.map(toWire),
      ...(input.tools.length > 0 ? { tools: input.tools, tool_choice: input.toolChoice } : {}),
      stream: true,
      max_tokens: input.maxTokens,
      ...(this.options.usageParam === "openrouter" ? { usage: { include: true } } : this.options.usageParam === "openai" ? { stream_options: { include_usage: true } } : {}),
    };
    const response = await this.request(body, input.signal);
    if (!response.body) throw new ModelError("upstream_error", "The model provider returned an empty stream", true);

    const calls = new Map<number, { id: string; name: string; args: string }>();
    let usage: ModelUsage | null = null;
    let model: string | null = null;
    let finish: string | null | undefined;
    let sawDone = false;

    for await (const frame of parseSseStream(response.body, input.signal)) {
      if (frame.data === "[DONE]") {
        sawDone = true;
        break;
      }
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(frame.data) as StreamChunk;
      } catch {
        continue;
      }
      if (chunk.error) throw new ModelError("upstream_error", chunk.error.message ?? "The model provider reported an error mid-stream", true);
      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? (chunk.usage.prompt_tokens ?? 0) + (chunk.usage.completion_tokens ?? 0),
        };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.delta?.content) yield { type: "text", delta: choice.delta.content };
      for (const [position, delta] of (choice.delta?.tool_calls ?? []).entries()) {
        const index = delta.index ?? position;
        const existing = calls.get(index);
        if (!existing || (delta.id && existing.id !== delta.id && existing.id !== `call_${index}` && delta.function?.name)) {
          calls.set(index, { id: delta.id || `call_${index}`, name: delta.function?.name ?? "", args: delta.function?.arguments ?? "" });
          continue;
        }
        if (delta.id && existing.id === `call_${index}`) existing.id = delta.id;
        if (delta.function?.name) existing.name = existing.name ? existing.name : delta.function.name;
        if (delta.function?.arguments) existing.args += delta.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (!sawDone && finish === undefined && calls.size === 0 && usage === null) {
      throw new ModelError("upstream_error", "The model stream ended before any answer", true);
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.args.trim() === "" ? "{}" : call.args }))
      .filter((call) => call.name !== "");
    for (const call of toolCalls) yield { type: "tool_call", call };
    yield { type: "done", stop: mapStop(finish, toolCalls.length > 0), usage, model };
  }

  private async request(body: unknown, signal: AbortSignal): Promise<Response> {
    const url = `${this.options.baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.options.apiKey}`,
      Accept: "text/event-stream",
      ...this.options.headers,
    };
    const attempt = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      const forward = () => controller.abort();
      signal.addEventListener("abort", forward, { once: true });
      try {
        return await this.options.fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      } catch (error) {
        if (signal.aborted) throw error;
        if (isAbortError(error)) throw new ModelError("upstream_timeout", "The model provider did not answer in time", true);
        throw new ModelError("upstream_error", `Could not reach the model provider${error instanceof Error && error.message ? `: ${error.message}` : ""}`, true);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", forward);
      }
    };

    let response: Response;
    try {
      response = await attempt();
    } catch (error) {
      if (error instanceof ModelError && error.retryable && !signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
        response = await attempt();
      } else {
        throw error;
      }
    }
    if (response.ok) return response;
    const failure = await errorFor(response);
    if (failure.retryable && response.status >= 500 && !signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs));
      const retry = await attempt();
      if (retry.ok) return retry;
      throw await errorFor(retry);
    }
    throw failure;
  }
}
