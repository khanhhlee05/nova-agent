import { ScriptedModel, compactSnapshot, demoRouter } from "@nova-agent/agent";
import { encodeSseFrame, streamFromChunks, type AskEvent, type ChatRequest } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpAskClient, LocalAskClient } from "../../apps/extension/src/sidepanel/ask/askClient";
import { checkApiBaseUrl, effectiveAskSettings, normalizeApiBaseUrl } from "../../apps/extension/src/sidepanel/ask/askSettings";
import { historyOf, type AskMessage } from "../../apps/extension/src/sidepanel/ask/useAskThread";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let request: ChatRequest;

beforeAll(async () => {
  const snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" });
  request = { message: "What is due today?", history: [], snapshot, client: { name: "nova-extension", version: "test" } };
});

const collect = async (source: AsyncIterable<AskEvent>): Promise<AskEvent[]> => {
  const events: AskEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
};

const sseResponse = (events: AskEvent[]) =>
  new Response(streamFromChunks(events.map((event, index) => encodeSseFrame({ event: event.type, data: JSON.stringify(event), id: String(index) }))), { status: 200, headers: { "content-type": "text/event-stream" } });

const fetchWith = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fetchImpl, calls };
};

describe("HttpAskClient", () => {
  it("posts the request with the token and yields validated events", async () => {
    const stream: AskEvent[] = [
      { type: "tool_call", id: "c1", name: "list_deadlines", input: { range: "today" } },
      { type: "tool_result", id: "c1", name: "list_deadlines", ok: true, summary: "2 items due today.", rows: [] },
      { type: "text", delta: "Two things today." },
      { type: "done", model: "m", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, rounds: 2, grounded: true, corrected: false },
    ];
    const { fetchImpl, calls } = fetchWith(() => sseResponse(stream));
    const client = new HttpAskClient({ baseUrl: "http://localhost:8787/", token: "secret", fetch: fetchImpl });
    expect(await collect(client.ask(request, new AbortController().signal))).toEqual(stream);
    expect(calls[0]?.url).toBe("http://localhost:8787/v1/chat");
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(String(calls[0]?.init?.body)).message).toBe("What is due today?");
  });

  it("drops frames that are not events and reports a stream that ends early", async () => {
    const { fetchImpl } = fetchWith(() => new Response(streamFromChunks(["data: not json\n\n", 'data: {"type":"mystery"}\n\n', 'event: text\ndata: {"type":"text","delta":"hi"}\n\n']), { status: 200 }));
    const client = new HttpAskClient({ baseUrl: "http://localhost:8787", token: null, fetch: fetchImpl });
    const events = await collect(client.ask(request, new AbortController().signal));
    expect(events[0]).toEqual({ type: "text", delta: "hi" });
    expect(events[1]).toMatchObject({ type: "error", code: "upstream_error" });
  });

  it("maps API error bodies, unreachable hosts, and aborts to typed events", async () => {
    const notConfigured = fetchWith(() => new Response(JSON.stringify({ error: { code: "not_configured", message: "no key" } }), { status: 503 }));
    expect(await collect(new HttpAskClient({ baseUrl: "http://x", token: null, fetch: notConfigured.fetchImpl }).ask(request, new AbortController().signal))).toEqual([
      { type: "error", code: "not_configured", message: "no key", retryable: true },
    ]);
    const capped = fetchWith(() => new Response(JSON.stringify({ error: { code: "budget_exhausted", message: "spent", retryable: true, retryAfterSeconds: 3600 } }), { status: 429 }));
    expect((await collect(new HttpAskClient({ baseUrl: "http://x", token: null, fetch: capped.fetchImpl }).ask(request, new AbortController().signal)))[0]).toMatchObject({ code: "budget_exhausted", retryAfterSeconds: 3600 });
    const plain = fetchWith(() => new Response("nope", { status: 401 }));
    expect((await collect(new HttpAskClient({ baseUrl: "http://x", token: null, fetch: plain.fetchImpl }).ask(request, new AbortController().signal)))[0]).toMatchObject({ code: "unauthorized" });
    const down = fetchWith(() => {
      throw new TypeError("fetch failed");
    });
    expect((await collect(new HttpAskClient({ baseUrl: "http://localhost:1", token: null, fetch: down.fetchImpl }).ask(request, new AbortController().signal)))[0]).toMatchObject({ code: "unreachable", message: expect.stringContaining("localhost:1") });

    const controller = new AbortController();
    const hanging = fetchWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const pending = collect(new HttpAskClient({ baseUrl: "http://x", token: null, fetch: hanging.fetchImpl }).ask(request, controller.signal));
    controller.abort();
    expect(await pending).toEqual([{ type: "error", code: "aborted", message: "Stopped.", retryable: true }]);
  });

  it("checks health", async () => {
    const good = fetchWith(() => new Response(JSON.stringify({ status: "ok", service: "nova-agent-api", configured: true, model: "m", usedToday: 5 }), { status: 200 }));
    expect(await new HttpAskClient({ baseUrl: "http://x", token: null, fetch: good.fetchImpl }).health()).toEqual({ ok: true, configured: true, model: "m", message: null });
    expect(good.calls[0]?.url).toBe("http://x/healthz");
    const wrong = fetchWith(() => new Response("<html>", { status: 200 }));
    expect((await new HttpAskClient({ baseUrl: "http://x", token: null, fetch: wrong.fetchImpl }).health()).ok).toBe(false);
    const down = fetchWith(() => {
      throw new TypeError("fetch failed");
    });
    expect((await new HttpAskClient({ baseUrl: "http://x", token: null, fetch: down.fetchImpl }).health()).message).toContain("Nothing answered at http://x");
  });
});

describe("LocalAskClient", () => {
  it("runs the loop in-process against a scripted model", async () => {
    const client = new LocalAskClient(new ScriptedModel(demoRouter));
    const events = await collect(client.ask(request, new AbortController().signal));
    expect(events[0]).toMatchObject({ type: "tool_call", name: "list_deadlines", input: { range: "today" } });
    expect(events.at(-1)).toMatchObject({ type: "done", grounded: true });
    expect(await client.health()).toMatchObject({ ok: true, configured: true });
  });
});

describe("settings and history helpers", () => {
  it("requires https for remote addresses and allows plain http only for local hosts", () => {
    expect(normalizeApiBaseUrl(" http://localhost:8787/ ")).toBe("http://localhost:8787");
    expect(normalizeApiBaseUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(normalizeApiBaseUrl("http://[::1]:8787")).toBe("http://[::1]:8787");
    expect(normalizeApiBaseUrl("http://api.localhost:8787")).toBe("http://api.localhost:8787");
    expect(normalizeApiBaseUrl("https://nova.example/api/")).toBe("https://nova.example/api");
    expect(checkApiBaseUrl("http://nova.example:8787")).toEqual({ url: null, reason: "insecure" });
    expect(checkApiBaseUrl("http://10.0.0.5:8787")).toEqual({ url: null, reason: "insecure" });
    expect(checkApiBaseUrl("http://localhost.evil.example")).toEqual({ url: null, reason: "insecure" });
    expect(checkApiBaseUrl("ftp://x")).toEqual({ url: null, reason: "invalid" });
    expect(checkApiBaseUrl("not a url")).toEqual({ url: null, reason: "invalid" });
    expect(effectiveAskSettings({ enabled: true, apiBaseUrl: "http://nova.example", token: "t" }).enabled).toBe(false);
    expect(effectiveAskSettings({ enabled: true, apiBaseUrl: "https://nova.example", token: "t" }).enabled).toBe(true);
    expect(effectiveAskSettings({ enabled: true, apiBaseUrl: "http://localhost:8787", token: null }).enabled).toBe(true);
  });

  it("builds text-only history from completed turns and caps it", () => {
    const base = { tools: [], rows: [], usage: null, grounded: null, stopped: false, error: null };
    const messages: AskMessage[] = [
      { ...base, id: "1", role: "user", text: "q1" },
      { ...base, id: "2", role: "assistant", text: "a1" },
      { ...base, id: "3", role: "user", text: "q2" },
      { ...base, id: "4", role: "assistant", text: "", error: { type: "error", code: "internal", message: "x", retryable: true } },
      { ...base, id: "5", role: "user", text: "q3" },
      { ...base, id: "6", role: "assistant", text: "partial", error: { type: "error", code: "upstream_error", message: "x", retryable: true } },
    ];
    expect(historyOf(messages)).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "user", content: "q3" },
    ]);
    const many = Array.from({ length: 20 }, (_, i): AskMessage => ({ ...base, id: String(i), role: i % 2 === 0 ? "user" : "assistant", text: `m${i}` }));
    expect(historyOf(many)).toHaveLength(12);
    expect(historyOf(many).at(-1)?.content).toBe("m19");
  });
});
