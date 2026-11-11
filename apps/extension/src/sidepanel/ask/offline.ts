import { OFFLINE_MODEL_ID, ScriptedModel, TOOLS, intentRouter, matchIntent, runTurn, type Intent } from "@nova-agent/agent";
import type { AskEvent, ChatRequest } from "@nova-agent/protocol";
import type { AskClient, AskHandlers, AskHealth } from "./askClient";

/** Why the server could not answer, for the failures an answer made on the device can stand in for. */
export type OfflineReason = NonNullable<Extract<AskEvent, { type: "done" }>["offline"]>;

const OFFLINE_REASONS: readonly OfflineReason[] = ["unreachable", "not_configured", "rate_limited", "budget_exhausted"];

export const isOfflineReason = (code: string): code is OfflineReason => (OFFLINE_REASONS as readonly string[]).includes(code);

/** What the note under an answer says about why no model wrote it. */
export const OFFLINE_REASON_COPY: Record<OfflineReason, string> = {
  unreachable: "The Nova server could not be reached.",
  not_configured: "The Nova server has no model key yet.",
  rate_limited: "The AI model is busy.",
  budget_exhausted: "Ask Nova has hit today's limit.",
};

export const OFFLINE_NOTE = "Answered on this device without the AI model.";

/**
 * One lookup over the snapshot the question came with, and a sentence made
 * from the lookup's own summary. Nothing leaves the device and no model is
 * called. Only the lookups that read the snapshot are available: no file is
 * read and no action is suggested.
 */
export async function* answerOnDevice(request: ChatRequest, intent: Intent, signal: AbortSignal, reason: OfflineReason): AsyncGenerator<AskEvent> {
  const generator = runTurn({ snapshot: request.snapshot, history: [], message: request.message, model: new ScriptedModel(intentRouter(intent)), tools: TOOLS, maxRounds: 2, maxTokens: 200, signal });
  for (;;) {
    const next = await generator.next();
    if (next.done) return;
    yield next.value.type === "done" ? { ...next.value, model: OFFLINE_MODEL_ID, usage: null, offline: reason } : next.value;
  }
}

/**
 * Wraps the client that talks to the server. When the server cannot answer
 * at all (it is unreachable, has no key, is rate limited, or is out of
 * budget) and the question is one a single lookup answers, the answer is
 * made on the device and says so. Any other question keeps the error, and
 * so does any failure that arrives after the server had begun to answer.
 */
export class FallbackAskClient implements AskClient {
  constructor(private readonly primary: AskClient) {}

  async *ask(request: ChatRequest, signal: AbortSignal, handlers?: AskHandlers): AsyncIterable<AskEvent> {
    let first = true;
    for await (const event of this.primary.ask(request, signal, handlers)) {
      if (first && event.type === "error" && isOfflineReason(event.code) && !signal.aborted) {
        const intent = matchIntent(request.message, request.snapshot);
        if (intent) {
          yield* answerOnDevice(request, intent, signal, event.code);
          return;
        }
      }
      first = false;
      yield event;
    }
  }

  health(signal?: AbortSignal): Promise<AskHealth> {
    return this.primary.health(signal);
  }
}
