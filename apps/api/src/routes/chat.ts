import { runTurn, type TurnResult } from "@nova-agent/agent";
import { chatRequestSchema, clientToolResultSchema, type AskEvent } from "@nova-agent/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../app";
import { turnTokenEstimate } from "../config";
import { errorBody } from "../errors";

const INTERNAL: AskEvent = { type: "error", code: "internal", message: "Nova hit an unexpected problem.", retryable: true };

const TURN_ID = /^[0-9a-f-]{8,64}$/i;

export const chatRoute = (context: AppContext): Hono<{ Variables: { userId: string } }> =>
  new Hono<{ Variables: { userId: string } }>()
    // The panel's answer to a `client_tool` event. Accepted once, and only for a lookup a turn is waiting on.
    .post("/v1/chat/:turnId/tool-result", async (c) => {
      const turnId = c.req.param("turnId");
      if (!TURN_ID.test(turnId)) return c.json(errorBody("bad_request", "Unknown turn."), 404);
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(errorBody("bad_request", "Body must be JSON."), 400);
      }
      const parsed = clientToolResultSchema.safeParse(raw);
      if (!parsed.success) {
        // Paths only: the body carries file text, which must not reach the logs or the error text.
        const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
        return c.json({ ...errorBody("bad_request", `Invalid result at: ${paths.join(", ")}.`), issues: paths }, 400);
      }
      if (!context.pending.deliver(turnId, parsed.data)) return c.json(errorBody("bad_request", "No lookup is waiting for this result."), 404);
      return c.json({ ok: true });
    })
    .post("/v1/chat", async (c) => {
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
    // The kill switch answers before anything is charged. The panel treats it like an exhausted budget and answers what it can on the device.
    if (context.config.ASK_DISABLED) return c.json(errorBody("budget_exhausted", "Ask Nova is paused on this server for now.", { retryable: true }), 429);
    if (!context.model) return c.json(errorBody("not_configured", "The Nova API has no model key configured."), 503);
    const startedAt = context.now();
    const hosted = context.hosted;
    const userId = hosted ? c.get("userId") : null;
    // Reserve the worst case synchronously (no await between check and charge) so concurrent turns cannot overshoot the cap.
    const reservation = context.usage.reserve(startedAt, turnTokenEstimate(context.config));
    if (!reservation) {
      return c.json(errorBody("budget_exhausted", "Today's token budget for this server is used up. Try again tomorrow.", { retryable: true }), 429);
    }

    // Signed-in mode: the student's own daily allowance and pace, checked and charged under a lock so two questions sent at once cannot both pass.
    let turnId: string | null = null;
    if (hosted && userId) {
      const turn = await hosted.store.reserveTurn(userId, turnTokenEstimate(context.config), { dailyCap: context.config.USER_DAILY_TOKEN_CAP, turnLimit: context.config.USER_TURNS_PER_10_MIN }, startedAt);
      if (!turn.ok) {
        context.usage.settle(reservation, 0);
        if (turn.reason === "no_user") return c.json(errorBody("unauthorized", "This account no longer exists. Sign in again."), 401);
        if (turn.reason === "rate") return c.json(errorBody("rate_limited", "You are asking faster than this server allows. Try again shortly.", { retryable: true, retryAfterSeconds: turn.retryAfterSeconds }), 429);
        return c.json(errorBody("budget_exhausted", "You have used your Ask Nova allowance for today. It resets at midnight UTC.", { retryable: true }), 429);
      }
      turnId = turn.id;
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
          focus: request.focus,
          summary: request.summary,
          streamText: request.streamText === true,
          model,
          maxRounds: context.config.MAX_ROUNDS,
          maxTokens: context.config.MAX_TOKENS,
          signal: controller.signal,
          // Offered only when this panel said it can answer; the wait always ends, by answer, timeout, or abort.
          ...(request.clientTools && request.clientTools.length > 0
            ? { clientTools: { turnId: requestId, names: request.clientTools, call: ({ id }: { id: string }, signal: AbortSignal) => context.pending.wait(requestId, id, context.config.CLIENT_TOOL_TIMEOUT_MS, signal) } }
            : {}),
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
          if (hosted && turnId) {
            await hosted.store
              .settleTurn(turnId, { tokens, promptTokens: result?.usage?.promptTokens ?? null, completionTokens: result?.usage?.completionTokens ?? null, model: result?.model ?? null })
              .catch((error: unknown) => context.logger.error("usage.settle_failed", { requestId, message: error instanceof Error ? error.message : "unknown" }));
          }
          context.logger.info("chat.turn", {
            requestId,
            ...(userId ? { userId } : {}),
            model: result?.model ?? context.config.OPENROUTER_MODEL,
            rounds: result?.rounds ?? 0,
            toolNames: result?.toolNames ?? [],
            promptTokens: result?.usage?.promptTokens ?? null,
            completionTokens: result?.usage?.completionTokens ?? null,
            durationMs: context.now().getTime() - startedAt.getTime(),
            outcome: timedOut ? "timeout" : (result?.outcome ?? "error"),
            errorCode: result?.errorCode ?? null,
            grounded: result?.grounded ?? null,
            proposals: result?.proposals ?? 0,
            corrected: result?.corrected ?? null,
            historyLength: request.history.length,
            snapshotBytes,
            mode: request.snapshot.mode,
            snapshotVersion: request.snapshot.version,
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
