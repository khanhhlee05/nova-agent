import { runTurn, type TurnResult } from "@nova-agent/agent";
import { chatRequestSchema, type AskEvent } from "@nova-agent/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../app";
import { turnTokenEstimate } from "../config";
import { errorBody } from "../errors";

const INTERNAL: AskEvent = { type: "error", code: "internal", message: "Nova hit an unexpected problem.", retryable: true };

export const chatRoute = (context: AppContext): Hono =>
  new Hono().post("/v1/chat", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(errorBody("bad_request", "Body must be JSON."), 400);
    }
    const parsed = chatRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // Paths only: the body carries course titles, which must not reach the logs or the error text.
      const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
      return c.json({ ...errorBody("bad_request", `Invalid request at: ${paths.join(", ")}.`), issues: paths }, 400);
    }
    if (!context.model) return c.json(errorBody("not_configured", "The Nova API has no model key configured."), 503);
    const startedAt = context.now();
    // Reserve the worst case synchronously (no await between check and charge) so concurrent turns cannot overshoot the cap.
    const reservation = context.usage.reserve(startedAt, turnTokenEstimate(context.config));
    if (!reservation) {
      return c.json(errorBody("budget_exhausted", "Today's token budget for this server is used up. Try again tomorrow.", { retryable: true }), 429);
    }

    const request = parsed.data;
    const requestId = crypto.randomUUID();
    const snapshotBytes = JSON.stringify(request.snapshot).length;
    const model = context.model;

    return streamSSE(
      c,
      async (stream) => {
        const controller = new AbortController();
        let timedOut = false;
        stream.onAbort(() => controller.abort());
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, context.config.REQUEST_TIMEOUT_MS);
        let seq = 0;
        let result: TurnResult | null = null;
        const generator = runTurn({
          snapshot: request.snapshot,
          history: request.history,
          message: request.message,
          model,
          maxRounds: context.config.MAX_ROUNDS,
          maxTokens: context.config.MAX_TOKENS,
          signal: controller.signal,
        });
        try {
          for (;;) {
            const next = await generator.next();
            if (next.done) {
              result = next.value;
              break;
            }
            let event = next.value;
            if (event.type === "error" && event.code === "aborted" && timedOut) {
              event = { type: "error", code: "upstream_timeout", message: "The model took too long to answer.", retryable: true };
            }
            if (!stream.closed) await stream.writeSSE({ event: event.type, data: JSON.stringify(event), id: String(seq++) });
          }
        } finally {
          clearTimeout(timer);
          // A turn that reported no usage is charged the ceiling for every round it attempted.
          const tokens = result?.usage?.totalTokens ?? context.config.MAX_TOKENS * Math.max(1, result?.rounds ?? 1);
          context.usage.settle(reservation, tokens);
          context.logger.info("chat.turn", {
            requestId,
            model: result?.model ?? context.config.OPENROUTER_MODEL,
            rounds: result?.rounds ?? 0,
            toolNames: result?.toolNames ?? [],
            promptTokens: result?.usage?.promptTokens ?? null,
            completionTokens: result?.usage?.completionTokens ?? null,
            durationMs: context.now().getTime() - startedAt.getTime(),
            outcome: timedOut ? "timeout" : (result?.outcome ?? "error"),
            errorCode: result?.errorCode ?? null,
            grounded: result?.grounded ?? null,
            corrected: result?.corrected ?? null,
            historyLength: request.history.length,
            snapshotBytes,
            mode: request.snapshot.mode,
            ...(context.config.LOG_PROMPTS ? { debug: { message: request.message, answer: result?.text ?? null } } : {}),
          });
        }
      },
      async (error, stream) => {
        context.logger.error("chat.failed", { requestId, name: error.name, message: error.message });
        if (!stream.closed) await stream.writeSSE({ event: "error", data: JSON.stringify(INTERNAL) });
      },
    );
  });
