import { ModelError, ScriptedModel, compactSnapshot, demoRouter, type ChatModel, type ModelEvent, type ModelInput } from "@nova-agent/agent";
import { askEventSchema, parseSseStream, type AskEvent, type ChatRequest } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp, MAX_BODY_BYTES } from "../../apps/api/src/app";
import { loadConfig, type ApiConfig } from "../../apps/api/src/config";
import { createLogger } from "../../apps/api/src/log";
import { UsageCounter } from "../../apps/api/src/usage";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let request: ChatRequest;

beforeAll(async () => {
  const snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" });
  request = { message: "What is due this week in Microcontrollers?", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], snapshot, client: { name: "nova-extension", version: "test" } };
});

const config = (overrides: Partial<Record<string, string>> = {}): ApiConfig => loadConfig({ OPENROUTER_API_KEY: "test", ...overrides });

const harness = (options: { model?: ChatModel | null; env?: Partial<Record<string, string>>; cap?: number } = {}) => {
  const lines: string[] = [];
  const cfg = config(options.env);
  const usage = new UsageCounter(options.cap ?? cfg.DAILY_TOKEN_CAP);
  const model = options.model === undefined ? new ScriptedModel(demoRouter) : options.model;
  const app = createApp({ config: cfg, model, logger: createLogger((line) => lines.push(line), () => NOW), usage, now: () => NOW });
  return { app, lines, usage };
};

const post = (app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request("/v1/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: "chrome-extension://abc", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const readEvents = async (response: Response): Promise<AskEvent[]> => {
  const events: AskEvent[] = [];
  for await (const frame of parseSseStream(response.body as ReadableStream<Uint8Array>)) {
    const parsed = askEventSchema.safeParse(JSON.parse(frame.data));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(frame.event).toBe(parsed.data.type);
      events.push(parsed.data);
    }
  }
  return events;
};

describe("GET /healthz", () => {
  it("reports configuration and usage", async () => {
    const { app } = harness();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "nova-agent-api", configured: true, model: "meta-llama/llama-3.3-70b-instruct:free", usedToday: 0 });
    const unconfigured = harness({ model: null });
    expect(await (await unconfigured.app.request("/healthz")).json()).toMatchObject({ configured: false, model: null });
  });
});

describe("POST /v1/chat", () => {
  it("streams a validated turn and logs counts without the question text", async () => {
    const { app, lines, usage } = harness();
    const response = await post(app, request);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
    const events = await readEvents(response);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "text", "done"]);
    expect(events[0]).toMatchObject({ type: "tool_call", name: "list_deadlines" });
    const done = events.at(-1);
    expect(done?.type === "done" && done.usage?.totalTokens === 144 && done.grounded).toBe(true);
    expect(usage.usedToday(NOW)).toBe(144);
    const turn = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "chat.turn");
    expect(turn).toMatchObject({ rounds: 2, toolNames: ["list_deadlines"], promptTokens: 120, completionTokens: 24, outcome: "ok", historyLength: 2, mode: "demo" });
    expect(lines.join("\n")).not.toContain("Microcontrollers");
    expect(lines.join("\n")).not.toContain("What is due");
  });

  it("logs the question only when LOG_PROMPTS is on", async () => {
    const { app, lines } = harness({ env: { LOG_PROMPTS: "1" } });
    await readEvents(await post(app, request));
    expect(lines.join("\n")).toContain("What is due this week");
  });

  it("rejects bad JSON and invalid bodies with paths only", async () => {
    const { app } = harness();
    expect((await post(app, "{not json")).status).toBe(400);
    const invalid = await post(app, { ...request, snapshot: { ...request.snapshot, mode: "fixture" }, message: "" });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: { code: string; message: string }; issues: string[] };
    expect(body.error.code).toBe("bad_request");
    expect(body.issues).toEqual(expect.arrayContaining(["snapshot.mode", "message"]));
    expect(JSON.stringify(body)).not.toContain("fixture");
  });

  it("answers 503 without a model, 429 past the daily cap, and 413 over the body limit", async () => {
    expect((await post(harness({ model: null }).app, request)).status).toBe(503);
    // Each turn reserves 2800 (700 × 4) and settles to 144; the third would need 288 + 2800 > 3000.
    const capped = harness({ cap: 3000 });
    await readEvents(await post(capped.app, request));
    await readEvents(await post(capped.app, request));
    expect(capped.usage.usedToday(NOW)).toBe(288);
    const third = await post(capped.app, request);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: { code: "budget_exhausted" } });
    expect(capped.usage.usedToday(NOW)).toBe(288);
    const huge = await post(harness().app, { ...request, message: "x".repeat(MAX_BODY_BYTES + 1) });
    expect(huge.status).toBe(413);
  });

  it("reserves the budget up front so concurrent requests cannot overshoot the cap", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: ChatModel = {
      id: "gated",
      async *complete(input: ModelInput): AsyncIterable<ModelEvent> {
        await gate;
        void input;
        yield { type: "text", delta: "Start with Lab 2: GPIO and Debouncing." };
        yield { type: "done", stop: "end", usage: { promptTokens: 100, completionTokens: 44, totalTokens: 144 }, model: "gated" };
      },
    };
    const { app, usage } = harness({ model: gated, cap: 5000 });
    const first = await post(app, request);
    expect(first.status).toBe(200);
    expect(usage.usedToday(NOW)).toBe(2800);
    const second = await post(app, request);
    expect(second.status).toBe(429);
    release();
    const events = await readEvents(first);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    expect(usage.usedToday(NOW)).toBe(144);
    expect((await post(app, request)).status).toBe(200);
  });

  it("charges the ceiling for every attempted round when the model reports no usage", async () => {
    const failing = harness({ model: new ScriptedModel([{ throw: new ModelError("upstream_error", "boom", true) }]) });
    await readEvents(await post(failing.app, request));
    expect(failing.usage.usedToday(NOW)).toBe(700);
    const silent = harness({ model: new ScriptedModel([{ toolCalls: [{ name: "get_brief", args: {} }] }, { text: ["Start with Lab 2: GPIO and Debouncing."] }]) });
    await readEvents(await post(silent.app, request));
    expect(silent.usage.usedToday(NOW)).toBe(1400);
  });

  it("enforces the dev token when configured", async () => {
    const { app } = harness({ env: { NOVA_DEV_TOKEN: "secret" } });
    expect((await post(app, request)).status).toBe(401);
    expect((await post(app, request, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(app, request, { Authorization: "Bearer secret" })).status).toBe(200);
    expect((await app.request("/healthz")).status).toBe(200);
  });

  it("turns model failures into typed error frames", async () => {
    const { ModelError } = await import("@nova-agent/agent");
    const { app, lines } = harness({ model: new ScriptedModel([{ throw: new ModelError("rate_limited", "slow down", true, 12) }]) });
    const events = await readEvents(await post(app, request));
    expect(events).toEqual([{ type: "error", code: "rate_limited", message: "slow down", retryable: true, retryAfterSeconds: 12 }]);
    expect(lines.join("\n")).toContain('"errorCode":"rate_limited"');
  });
});

describe("CORS", () => {
  it("allows configured origins on preflight and denies others", async () => {
    const { app } = harness();
    const allowed = await app.request("/v1/chat", { method: "OPTIONS", headers: { Origin: "chrome-extension://abc", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
    expect(allowed.headers.get("access-control-allow-headers")).toContain("Authorization");
    const denied = await app.request("/v1/chat", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const exact = harness({ env: { CORS_ORIGINS: "chrome-extension://exactid" } });
    const other = await exact.app.request("/healthz", { headers: { Origin: "chrome-extension://otherid" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });
});
