import { ScriptedModel, compactSnapshot, demoRouter, type ScriptedTurn } from "@nova-agent/agent";
import { askEventSchema, parseSseStream, type AskEvent, type ChatRequest, type ClientToolResult } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";
import { createLogger } from "../../apps/api/src/log";
import { PendingClientCalls } from "../../apps/api/src/pending";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let request: ChatRequest;

beforeAll(async () => {
  const snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York", includeAttachments: true });
  request = { message: "What does the Lab 3 handout ask for?", history: [], snapshot, clientTools: ["read_attachment"], client: { name: "nova-extension", version: "test" } };
});

const HEADERS = { "Content-Type": "application/json", Origin: "chrome-extension://abc" };

const harness = (script: ScriptedTurn[] | ConstructorParameters<typeof ScriptedModel>[0] = demoRouter, env: Record<string, string> = {}) => {
  const lines: string[] = [];
  const pending = new PendingClientCalls();
  const app = createApp({ config: loadConfig({ OPENROUTER_API_KEY: "test", ...env }), model: new ScriptedModel(script), logger: createLogger((line) => lines.push(line), () => NOW), now: () => NOW, pending });
  return { app, lines, pending };
};

const result = (id: string, overrides: Partial<ClientToolResult> = {}): ClientToolResult => ({ id, ok: true, summary: 'Read "Lab 3 handout.pdf" (2 pages, 300 characters)', data: { file: "Lab 3 handout.pdf", text: "SECRET HANDOUT TEXT: configure Timer1 in CTC mode." }, rows: [], ...overrides });

/** Reads the stream and lets the caller act on each event as it arrives, the way the panel does. */
const readWith = async (response: Response, onEvent: (event: AskEvent) => Promise<void> | void): Promise<AskEvent[]> => {
  const events: AskEvent[] = [];
  for await (const frame of parseSseStream(response.body as ReadableStream<Uint8Array>)) {
    const event = askEventSchema.parse(JSON.parse(frame.data));
    events.push(event);
    await onEvent(event);
  }
  return events;
};

describe("PendingClientCalls", () => {
  it("delivers an answer once, to the call that is waiting, and to nothing else", async () => {
    const pending = new PendingClientCalls();
    const signal = new AbortController().signal;
    const waiting = pending.wait("turn-aaaa", "c1", 1000, signal);
    expect(pending.size).toBe(1);
    expect(pending.deliver("turn-bbbb", result("c1"))).toBe(false);
    expect(pending.deliver("turn-aaaa", result("c2"))).toBe(false);
    expect(pending.deliver("turn-aaaa", result("c1"))).toBe(true);
    expect(await waiting).toMatchObject({ id: "c1", ok: true });
    expect(pending.size).toBe(0);
    expect(pending.deliver("turn-aaaa", result("c1"))).toBe(false);
  });

  it("always settles: on a timeout, on a stop, on an already stopped turn, and on a repeated id", async () => {
    const pending = new PendingClientCalls();
    const timedOut = await pending.wait("turn-aaaa", "c1", 10, new AbortController().signal);
    expect(timedOut).toMatchObject({ ok: false, error: expect.stringContaining("did not answer in time") });
    expect(pending.size).toBe(0);
    const controller = new AbortController();
    const stopped = pending.wait("turn-aaaa", "c2", 10_000, controller.signal);
    controller.abort();
    expect(await stopped).toMatchObject({ ok: false, error: expect.stringContaining("stopped") });
    expect(await pending.wait("turn-aaaa", "c3", 10_000, controller.signal)).toMatchObject({ ok: false });
    expect(pending.size).toBe(0);
    const first = pending.wait("turn-aaaa", "c4", 10_000, new AbortController().signal);
    expect(await pending.wait("turn-aaaa", "c4", 10_000, new AbortController().signal)).toMatchObject({ ok: false, error: expect.stringContaining("already waiting") });
    expect(pending.deliver("turn-aaaa", result("c4"))).toBe(true);
    expect(await first).toMatchObject({ ok: true });
    // A late answer after the timeout finds nothing waiting.
    expect(pending.deliver("turn-aaaa", result("c1"))).toBe(false);
  });
});

describe("POST /v1/chat with a lookup the panel makes", () => {
  it("asks the panel over the stream, takes its answer on the result endpoint, and finishes the turn", async () => {
    const { app, lines, pending } = harness();
    const response = await app.request("/v1/chat", { method: "POST", headers: HEADERS, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    const posts: number[] = [];
    const events = await readWith(response, async (event) => {
      if (event.type !== "client_tool") return;
      expect(event).toMatchObject({ name: "read_attachment", input: { itemId: "a4101", fileId: "9101" } });
      expect(pending.size).toBe(1);
      const answered = await app.request(`/v1/chat/${event.turnId}/tool-result`, { method: "POST", headers: HEADERS, body: JSON.stringify(result(event.id)) });
      posts.push(answered.status);
      expect(await answered.json()).toEqual({ ok: true });
      // The same answer cannot be delivered twice.
      posts.push((await app.request(`/v1/chat/${event.turnId}/tool-result`, { method: "POST", headers: HEADERS, body: JSON.stringify(result(event.id)) })).status);
    });
    expect(posts).toEqual([200, 404]);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "client_tool", "tool_result", "text", "done"]);
    expect(events[2]).toMatchObject({ type: "tool_result", name: "read_attachment", ok: true });
    const text = events.find((event) => event.type === "text");
    expect(text?.type === "text" && text.delta).toContain("Lab 3 handout.pdf says: SECRET HANDOUT TEXT");
    expect(pending.size).toBe(0);
    // File text passes through for the turn and never reaches the logs.
    const turn = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "chat.turn");
    expect(turn).toMatchObject({ toolNames: ["read_attachment"], outcome: "ok" });
    expect(lines.join("\n")).not.toContain("SECRET HANDOUT TEXT");
    expect(lines.join("\n")).not.toContain("handout");
  });

  it("tells the model when the panel does not answer in time, and the turn still ends", async () => {
    const { app, pending } = harness(demoRouter, { CLIENT_TOOL_TIMEOUT_MS: "500" });
    const events = await readWith(await app.request("/v1/chat", { method: "POST", headers: HEADERS, body: JSON.stringify(request) }), () => undefined);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "client_tool", "tool_result", "text", "done"]);
    expect(events[2]).toMatchObject({ type: "tool_result", ok: false, error: expect.stringContaining("did not answer in time") });
    expect(pending.size).toBe(0);
  });

  it("does not offer the tool to a panel that did not ask for it", async () => {
    const { app } = harness();
    const { clientTools: _dropped, ...older } = request;
    void _dropped;
    const events = await readWith(await app.request("/v1/chat", { method: "POST", headers: HEADERS, body: JSON.stringify(older) }), () => undefined);
    expect(events.some((event) => event.type === "client_tool")).toBe(false);
    expect(events.at(-1)?.type).toBe("done");
  });
});

describe("POST /v1/chat/:turnId/tool-result", () => {
  it("answers 404 when nothing is waiting, and 400 for a malformed or oversize result, naming paths only", async () => {
    const { app, pending } = harness();
    const post = (turnId: string, body: unknown) => app.request(`/v1/chat/${turnId}/tool-result`, { method: "POST", headers: HEADERS, body: typeof body === "string" ? body : JSON.stringify(body) });
    expect((await post("0123abcd-0000-4000-8000-000000000000", result("c1"))).status).toBe(404);
    expect((await post("not a turn id!", result("c1"))).status).toBe(404);
    expect((await post("0123abcd-0000-4000-8000-000000000000", "{not json")).status).toBe(400);
    const waiting = pending.wait("0123abcd-0000-4000-8000-000000000000", "c1", 2000, new AbortController().signal);
    const oversize = await post("0123abcd-0000-4000-8000-000000000000", result("c1", { data: { text: "PRIVATE ".repeat(5000) } }));
    expect(oversize.status).toBe(400);
    const body = (await oversize.json()) as { error: { message: string }; issues: string[] };
    expect(body.issues).toEqual(["data"]);
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect((await post("0123abcd-0000-4000-8000-000000000000", { id: "c1", ok: "yes" })).status).toBe(400);
    // A rejected result leaves the lookup waiting for a good one.
    expect(pending.size).toBe(1);
    expect((await post("0123abcd-0000-4000-8000-000000000000", result("c1"))).status).toBe(200);
    expect(await waiting).toMatchObject({ ok: true });
  });

  it("requires the access code when the server has one", async () => {
    const { app, pending } = harness(demoRouter, { NOVA_DEV_TOKEN: "s3cret" });
    const turnId = "0123abcd-0000-4000-8000-000000000000";
    const waiting = pending.wait(turnId, "c1", 2000, new AbortController().signal);
    expect((await app.request(`/v1/chat/${turnId}/tool-result`, { method: "POST", headers: HEADERS, body: JSON.stringify(result("c1")) })).status).toBe(401);
    expect(pending.size).toBe(1);
    expect((await app.request(`/v1/chat/${turnId}/tool-result`, { method: "POST", headers: { ...HEADERS, Authorization: "Bearer s3cret" }, body: JSON.stringify(result("c1")) })).status).toBe(200);
    expect(await waiting).toMatchObject({ ok: true });
  });
});
