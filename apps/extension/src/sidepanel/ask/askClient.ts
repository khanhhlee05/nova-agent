import { runTurn, type ChatModel } from "@nova-agent/agent";
import { apiErrorBodySchema, askEventSchema, healthResponseSchema, parseSseStream, type AskErrorCode, type AskEvent, type ChatRequest } from "@nova-agent/protocol";
import type { AskSettings } from "./askSettings";

export type AskHealth = { ok: boolean; configured: boolean; model: string | null; message: string | null };

/** One seam between the Ask tab and wherever the answer comes from. */
export interface AskClient {
  ask(request: ChatRequest, signal: AbortSignal): AsyncIterable<AskEvent>;
  health(signal?: AbortSignal): Promise<AskHealth>;
}

const errorEvent = (code: AskErrorCode, message: string, retryable: boolean, retryAfterSeconds?: number): AskEvent => ({
  type: "error",
  code,
  message,
  retryable,
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

/** Talks to apps/api over fetch and server-sent events. */
export class HttpAskClient implements AskClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; token: string | null; fetch?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private headers(json: boolean): Record<string, string> {
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
  }

  async *ask(request: ChatRequest, signal: AbortSignal): AsyncIterable<AskEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/chat`, { method: "POST", headers: this.headers(true), body: JSON.stringify(request), signal });
    } catch {
      yield signal.aborted ? errorEvent("aborted", "Stopped.", true) : errorEvent("unreachable", `Nova API is not reachable at ${this.baseUrl}.`, true);
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const parsed = apiErrorBodySchema.safeParse(body);
      if (parsed.success) {
        yield errorEvent(parsed.data.error.code, parsed.data.error.message, parsed.data.error.retryable ?? response.status >= 500, parsed.data.error.retryAfterSeconds);
      } else {
        yield errorEvent(response.status === 401 ? "unauthorized" : "upstream_error", `Nova API answered ${response.status}.`, response.status >= 500);
      }
      return;
    }
    if (!response.body) {
      yield errorEvent("upstream_error", "Nova API sent an empty reply.", true);
      return;
    }
    let terminal = false;
    try {
      for await (const frame of parseSseStream(response.body, signal)) {
        let data: unknown;
        try {
          data = JSON.parse(frame.data);
        } catch {
          continue;
        }
        const parsed = askEventSchema.safeParse(data);
        if (!parsed.success) continue;
        if (parsed.data.type === "done" || parsed.data.type === "error") terminal = true;
        yield parsed.data;
      }
    } catch {
      if (!signal.aborted) yield errorEvent("upstream_error", "The connection dropped before Nova finished.", true);
      terminal = true;
    }
    if (signal.aborted && !terminal) yield errorEvent("aborted", "Stopped.", true);
    else if (!terminal) yield errorEvent("upstream_error", "The connection closed before Nova finished.", true);
  }

  async health(signal?: AbortSignal): Promise<AskHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/healthz`, { headers: this.headers(false), signal });
      if (!response.ok) return { ok: false, configured: false, model: null, message: `Nova API answered ${response.status}.` };
      const parsed = healthResponseSchema.safeParse(await response.json());
      if (!parsed.success) return { ok: false, configured: false, model: null, message: "That address did not answer like the Nova API." };
      return { ok: true, configured: parsed.data.configured, model: parsed.data.model, message: null };
    } catch {
      return { ok: false, configured: false, model: null, message: `Nova API is not reachable at ${this.baseUrl}.` };
    }
  }
}

/** Runs the agent loop in-process against any ChatModel. Used by the preview harness and UI tests. */
export class LocalAskClient implements AskClient {
  constructor(
    private readonly model: ChatModel,
    private readonly options: { maxTokens?: number; maxRounds?: number } = {},
  ) {}

  async *ask(request: ChatRequest, signal: AbortSignal): AsyncIterable<AskEvent> {
    const generator = runTurn({
      snapshot: request.snapshot,
      history: request.history,
      message: request.message,
      model: this.model,
      maxTokens: this.options.maxTokens ?? 400,
      maxRounds: this.options.maxRounds,
      signal,
    });
    for (;;) {
      const next = await generator.next();
      if (next.done) return;
      yield next.value;
    }
  }

  async health(): Promise<AskHealth> {
    return { ok: true, configured: true, model: this.model.id, message: null };
  }
}

export type AskClientFactory = (settings: AskSettings) => AskClient;

export const defaultAskClientFactory: AskClientFactory = (settings) => new HttpAskClient({ baseUrl: settings.apiBaseUrl, token: settings.token });
