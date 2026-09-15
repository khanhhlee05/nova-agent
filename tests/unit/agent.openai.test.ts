import { ModelError, OpenAiCompatibleModel, type ModelEvent, type ModelInput } from "@nova-agent/agent";
import { encodeSseFrame, streamFromChunks } from "@nova-agent/protocol";
import { describe, expect, it } from "vitest";

type Recorded = { url: string; init: RequestInit; body: Record<string, unknown> };

const sse = (chunks: unknown[], options: { comments?: boolean; done?: boolean } = {}): string[] => {
  const frames = chunks.map((chunk) => encodeSseFrame({ data: JSON.stringify(chunk) }));
  const prefix = options.comments === false ? [] : [": OPENROUTER PROCESSING\n\n"];
  return [...prefix, ...frames, ...(options.done === false ? [] : ["data: [DONE]\n\n"])];
};

const streamResponse = (chunks: string[], init: ResponseInit = {}) => new Response(streamFromChunks(chunks), { status: 200, headers: { "content-type": "text/event-stream" }, ...init });

const fakeFetch = (responses: (() => Response | Promise<Response>)[]) => {
  const calls: Recorded[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new TypeError("fetch failed");
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
};

const model = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiCompatibleModel>[0]> = {}) =>
  new OpenAiCompatibleModel({ baseUrl: "https://openrouter.ai/api/v1/", apiKey: "test-key", model: "vendor/free-model:free", fetch: fetchImpl, retryDelayMs: 0, headers: { "X-Title": "Nova" }, ...extra });

const input = (overrides: Partial<ModelInput> = {}): ModelInput => ({
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "get_brief", arguments: "{}" }] },
    { role: "tool", toolCallId: "call_a", content: "{}" },
  ],
  tools: [{ type: "function", function: { name: "get_brief", description: "d", parameters: { type: "object", properties: {} } } }],
  toolChoice: "auto",
  maxTokens: 300,
  signal: new AbortController().signal,
  ...overrides,
});

const collect = async (source: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> => {
  const events: ModelEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
};

const textChunk = (content: string, extra: Record<string, unknown> = {}) => ({ id: "gen-1", model: "vendor/free-model:free", choices: [{ index: 0, delta: { content }, finish_reason: null }], ...extra });

describe("OpenAiCompatibleModel", () => {
  it("streams text deltas and reads usage from the final chunk", async () => {
    const { fetchImpl, calls } = fakeFetch([
      () =>
        streamResponse(
          sse([
            textChunk("Hel"),
            textChunk("lo"),
            { id: "gen-1", model: "vendor/free-model:free", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } },
          ]),
        ),
    ]);
    const events = await collect(model(fetchImpl).complete(input()));
    expect(events).toEqual([
      { type: "text", delta: "Hel" },
      { type: "text", delta: "lo" },
      { type: "done", stop: "end", usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 }, model: "vendor/free-model:free" },
    ]);
    const call = calls[0] as Recorded;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.body).toMatchObject({ model: "vendor/free-model:free", stream: true, tool_choice: "auto", max_tokens: 300, usage: { include: true } });
    expect((call.body.messages as unknown[])[2]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "get_brief", arguments: "{}" } }] });
    expect((call.body.messages as unknown[])[3]).toEqual({ role: "tool", tool_call_id: "call_a", content: "{}" });
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["X-Title"]).toBe("Nova");
  });

  it("accumulates a tool call split across many deltas", async () => {
    const fragments = ['{"ra', 'nge":', '"we', 'ek"', "}"];
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", type: "function", function: { name: "list_deadlines", arguments: "" } }] }, finish_reason: null }] },
      ...fragments.map((piece) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null }] })),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
    const { fetchImpl } = fakeFetch([() => streamResponse(sse(chunks))]);
    const events = await collect(model(fetchImpl).complete(input()));
    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_x", name: "list_deadlines", arguments: '{"range":"week"}' } },
      { type: "done", stop: "tool_use", usage: null, model: null },
    ]);
  });

  it("keeps parallel tool calls apart by index, synthesizes missing ids, and treats stop-with-calls as tool use", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "get_brief", arguments: "" } }, { index: 1, function: { name: "get_changes", arguments: '{"since":' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"today"}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    const { fetchImpl } = fakeFetch([() => streamResponse(sse(chunks))]);
    const events = await collect(model(fetchImpl).complete(input()));
    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_0", name: "get_brief", arguments: "{}" } },
      { type: "tool_call", call: { id: "call_1", name: "get_changes", arguments: '{"since":"today"}' } },
      { type: "done", stop: "tool_use", usage: null, model: null },
    ]);
  });

  it("handles a whole tool call in one delta without an index and maps length to max_tokens", async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { tool_calls: [{ id: "abc", type: "function", function: { name: "get_brief", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    ];
    const { fetchImpl } = fakeFetch([() => streamResponse(sse(chunks)), () => streamResponse(sse([textChunk("partial"), { choices: [{ index: 0, delta: {}, finish_reason: "length" }] }]))]);
    const adapter = model(fetchImpl);
    expect(await collect(adapter.complete(input()))).toEqual([
      { type: "tool_call", call: { id: "abc", name: "get_brief", arguments: "{}" } },
      { type: "done", stop: "tool_use", usage: null, model: null },
    ]);
    const second = await collect(adapter.complete(input()));
    expect(second.at(-1)).toMatchObject({ type: "done", stop: "max_tokens" });
  });

  it("maps 429 to rate_limited with Retry-After and does not retry it", async () => {
    const { fetchImpl, calls } = fakeFetch([() => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429, headers: { "retry-after": "30" } })]);
    await expect(collect(model(fetchImpl).complete(input()))).rejects.toMatchObject({ code: "rate_limited", retryable: true, retryAfterSeconds: 30, message: expect.stringContaining("slow down") });
    expect(calls).toHaveLength(1);
  });

  it("retries once after a 5xx or a network failure, then succeeds", async () => {
    const { fetchImpl, calls } = fakeFetch([() => new Response("bad gateway", { status: 502 }), () => streamResponse(sse([textChunk("ok"), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]))]);
    const events = await collect(model(fetchImpl).complete(input()));
    expect(events[0]).toEqual({ type: "text", delta: "ok" });
    expect(calls).toHaveLength(2);

    const network = fakeFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      () => streamResponse(sse([textChunk("back"), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }])),
    ]);
    expect((await collect(model(network.fetchImpl).complete(input())))[0]).toEqual({ type: "text", delta: "back" });
    expect(network.calls).toHaveLength(2);

    const twice = fakeFetch([() => new Response("", { status: 503 }), () => new Response("", { status: 503 })]);
    await expect(collect(model(twice.fetchImpl).complete(input()))).rejects.toBeInstanceOf(ModelError);
    expect(twice.calls).toHaveLength(2);
  });

  it("maps 401 to unauthorized and mid-stream error objects to upstream_error", async () => {
    const { fetchImpl } = fakeFetch([() => new Response("{}", { status: 401 })]);
    await expect(collect(model(fetchImpl).complete(input()))).rejects.toMatchObject({ code: "unauthorized" });
    const mid = fakeFetch([() => streamResponse(sse([textChunk("a"), { error: { message: "provider overloaded", code: 502 } }]))]);
    await expect(collect(model(mid.fetchImpl).complete(input()))).rejects.toMatchObject({ code: "upstream_error", message: expect.stringContaining("overloaded") });
  });

  it("propagates abort to fetch and does not retry an aborted request", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      seen.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }) as typeof fetch;
    const pending = collect(model(fetchImpl).complete(input({ signal: controller.signal })));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toHaveLength(1);
  });

  it("times out a hung provider as upstream_timeout", async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as typeof fetch;
    await expect(collect(model(fetchImpl, { timeoutMs: 5 }).complete(input()))).rejects.toMatchObject({ code: "upstream_timeout" });
  });
});
