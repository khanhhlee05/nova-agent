import { runTurn, type ChatModel } from "@nova-agent/agent";
import { CLIENT_TOOL_LIMITS, apiErrorBodySchema, askEventSchema, healthResponseSchema, parseSseStream, type AskErrorCode, type AskEvent, type ChatRequest, type ClientToolName, type ClientToolResult } from "@nova-agent/protocol";
import type { AskAuth } from "./account";
import type { AskSettings } from "./askSettings";
import type { ClientToolAnswer } from "./clientTools";
import { FallbackAskClient } from "./offline";

/** `usedToday` and `dailyCap` are the server's token count for the day and its limit (0 for none), when it reports them. */
export type AskHealth = { ok: boolean; configured: boolean; model: string | null; message: string | null; usedToday?: number; dailyCap?: number; /** `google` when the server asks students to sign in. */ auth?: "none" | "google"; googleClientId?: string };

/** What the panel can do for a turn while it runs. */
export type AskHandlers = {
  /** Answers a lookup only this device can make. Must settle; a rejection is reported to the model as a failure. */
  clientTool?: (name: ClientToolName, input: unknown, signal: AbortSignal) => Promise<ClientToolAnswer>;
};

const NO_HANDLER: ClientToolAnswer = { ok: false, summary: "", data: null, rows: [], error: "This panel cannot make that lookup." };

/** Runs the panel's handler and always comes back with something the server will accept. */
export const answerClientTool = async (handlers: AskHandlers | undefined, id: string, name: ClientToolName, input: unknown, signal: AbortSignal): Promise<ClientToolResult> => {
  let answer: ClientToolAnswer;
  try {
    answer = handlers?.clientTool ? await handlers.clientTool(name, input, signal) : NO_HANDLER;
  } catch {
    answer = { ok: false, summary: "", data: null, rows: [], error: "The panel hit a problem making that lookup." };
  }
  const tooBig = JSON.stringify(answer.data ?? null).length > CLIENT_TOOL_LIMITS.dataBytes;
  return {
    id,
    ok: answer.ok && !tooBig,
    summary: answer.summary.slice(0, CLIENT_TOOL_LIMITS.summary),
    data: tooBig ? null : answer.data,
    rows: answer.rows.slice(0, CLIENT_TOOL_LIMITS.rows),
    ...(tooBig ? { error: "The result was too large to send." } : answer.error ? { error: answer.error.slice(0, CLIENT_TOOL_LIMITS.error) } : {}),
  };
};

/** One seam between the Ask tab and wherever the answer comes from. */
export interface AskClient {
  ask(request: ChatRequest, signal: AbortSignal, handlers?: AskHandlers): AsyncIterable<AskEvent>;
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
  private readonly auth: AskAuth | null;
  /** The access token the current turn was sent with, so its lookups answer under the same sign-in. */
  private sessionToken: string | null = null;

  constructor(options: { baseUrl: string; token: string | null; fetch?: typeof fetch; auth?: AskAuth | null }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.auth = options.auth ?? null;
  }

  /** A sign-in, when there is one, goes in place of the shared access code. */
  private headers(json: boolean): Record<string, string> {
    const bearer = this.sessionToken ?? this.token;
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) };
  }

  async *ask(request: ChatRequest, signal: AbortSignal, handlers?: AskHandlers): AsyncIterable<AskEvent> {
    let response: Response;
    try {
      this.sessionToken = this.auth ? await this.auth.accessToken() : null;
      const send = () => this.fetchImpl(`${this.baseUrl}/v1/chat`, { method: "POST", headers: this.headers(true), body: JSON.stringify(request), signal });
      response = await send();
      // An access token can expire between two questions: renew once and ask again.
      if (response.status === 401 && this.auth && this.sessionToken) {
        this.sessionToken = await this.auth.refresh();
        if (this.sessionToken) response = await send();
      }
    } catch {
      yield signal.aborted ? errorEvent("aborted", "Stopped.", true) : errorEvent("unreachable", `Nothing answered at ${this.baseUrl}.`, true);
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const parsed = apiErrorBodySchema.safeParse(body);
      if (parsed.success) {
        yield errorEvent(parsed.data.error.code, parsed.data.error.message, parsed.data.error.retryable ?? response.status >= 500, parsed.data.error.retryAfterSeconds);
      } else {
        yield errorEvent(response.status === 401 ? "unauthorized" : "upstream_error", `The Nova server answered with an error (${response.status}). Try again in a moment.`, response.status >= 500);
      }
      return;
    }
    if (!response.body) {
      yield errorEvent("upstream_error", "The Nova server sent back an empty answer. Try again.", true);
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
        if (parsed.data.type === "client_tool") {
          // Answered out of band; the server's own tool_result event tells the thread how it went.
          void this.answerTool(parsed.data.turnId, parsed.data.id, parsed.data.name, parsed.data.input, handlers, signal);
          continue;
        }
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

  /** Makes the lookup and posts the result. A failed post is left alone: the server stops waiting on its own. */
  private async answerTool(turnId: string, id: string, name: ClientToolName, input: unknown, handlers: AskHandlers | undefined, signal: AbortSignal): Promise<void> {
    const result = await answerClientTool(handlers, id, name, input, signal);
    if (signal.aborted) return;
    try {
      await this.fetchImpl(`${this.baseUrl}/v1/chat/${encodeURIComponent(turnId)}/tool-result`, { method: "POST", headers: this.headers(true), body: JSON.stringify(result), signal });
    } catch {
      // Nothing to do: the turn fails the lookup after its own timeout and says so.
    }
  }

  async health(signal?: AbortSignal): Promise<AskHealth> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/healthz`, { headers: this.headers(false), signal });
      if (!response.ok) return { ok: false, configured: false, model: null, message: response.status === 401 || response.status === 403 ? "The Nova server didn't accept the access code. Check it and try again." : `The Nova server answered with an error (${response.status}). Check the address and try again.` };
      const parsed = healthResponseSchema.safeParse(await response.json());
      if (!parsed.success) return { ok: false, configured: false, model: null, message: "Something answered at that address, but it isn't a Nova server. Check the address." };
      return {
        ok: true,
        configured: parsed.data.configured,
        model: parsed.data.model,
        message: null,
        usedToday: parsed.data.usedToday,
        ...(parsed.data.dailyCap !== undefined ? { dailyCap: parsed.data.dailyCap } : {}),
        ...(parsed.data.auth !== undefined ? { auth: parsed.data.auth } : {}),
        ...(parsed.data.googleClientId !== undefined ? { googleClientId: parsed.data.googleClientId } : {}),
      };
    } catch {
      return { ok: false, configured: false, model: null, message: `Nothing answered at ${this.baseUrl}. If the server runs on this computer, make sure it's started.` };
    }
  }
}

/** Runs the agent loop in-process against any ChatModel. Used by the preview harness and UI tests. */
export class LocalAskClient implements AskClient {
  constructor(
    private readonly model: ChatModel,
    private readonly options: { maxTokens?: number; maxRounds?: number } = {},
  ) {}

  async *ask(request: ChatRequest, signal: AbortSignal, handlers?: AskHandlers): AsyncIterable<AskEvent> {
    const generator = runTurn({
      snapshot: request.snapshot,
      history: request.history,
      message: request.message,
      focus: request.focus,
      summary: request.summary,
      model: this.model,
      maxTokens: this.options.maxTokens ?? 400,
      maxRounds: this.options.maxRounds,
      streamText: request.streamText === true,
      signal,
      ...(request.clientTools && request.clientTools.length > 0
        ? { clientTools: { turnId: "in-process", names: request.clientTools, call: ({ id, name, input }: { id: string; name: ClientToolName; input: unknown }, inner: AbortSignal) => answerClientTool(handlers, id, name, input, inner) } }
        : {}),
    });
    for (;;) {
      const next = await generator.next();
      if (next.done) return;
      // The lookup was already made in place; the thread only needs the result that follows.
      if (next.value.type === "client_tool") continue;
      yield next.value;
    }
  }

  async health(): Promise<AskHealth> {
    return { ok: true, configured: true, model: this.model.id, message: null };
  }
}

/** Builds the client for the saved server. `auth` is the student's sign-in on a hosted server, when there is one. */
export type AskClientFactory = (settings: AskSettings, auth?: AskAuth | null) => AskClient;

export const defaultAskClientFactory: AskClientFactory = (settings, auth = null) => new FallbackAskClient(new HttpAskClient({ baseUrl: settings.apiBaseUrl, token: settings.token, auth }));
