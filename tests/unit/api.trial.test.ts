import { ModelError, ScriptedModel, compactSnapshot, demoRouter, type ChatModel } from "@nova-agent/agent";
import { askEventSchema, parseSseStream, type AskEvent, type CompactSnapshot } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/app";
import { loadConfig } from "../../apps/api/src/config";
import { createLogger } from "../../apps/api/src/log";
import { TRIAL_QUESTION, rankTrials, toolVerdict, trialRows, tryModel, type ModelTrial } from "../../apps/api/src/trial";
import { UsageCounter } from "../../apps/api/src/usage";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let snapshot: CompactSnapshot;

beforeAll(async () => {
  snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" });
});

/** A clock that moves 250 ms each time it is read, so a trial has a duration without waiting. */
const ticking = () => {
  let at = 0;
  return () => (at += 250);
};

describe("tryModel", () => {
  it("records that a model called a tool and stayed grounded", async () => {
    const trial = await tryModel("vendor/good:free", new ScriptedModel(demoRouter), snapshot, { now: ticking() });
    expect(trial).toEqual({ model: "vendor/good:free", calledTool: true, toolNames: ["list_deadlines"], grounded: true, corrected: false, rounds: 2, totalTokens: expect.any(Number), durationMs: 250, outcome: "ok", errorCode: null });
    expect(toolVerdict(trial)).toBe("yes");
  });

  it("records a model that answers without looking anything up", async () => {
    const lazy = new ScriptedModel([{ text: ["You have a few things due next week."] }]);
    const trial = await tryModel("vendor/lazy:free", lazy, snapshot, { now: ticking() });
    expect(trial).toMatchObject({ calledTool: false, toolNames: [], rounds: 1, outcome: "ok", totalTokens: null });
    expect(toolVerdict(trial)).toBe("no");
    // The question is one the prompt's brief cannot answer, so skipping the lookup is visible.
    expect(lazy.calls[0]?.messages.at(-1)?.content).toBe(TRIAL_QUESTION);
  });

  it("records a model that invents an item as not grounded, and one that fails as failed", async () => {
    const inventing = new ScriptedModel([{ toolCalls: [{ name: "list_deadlines", args: { range: "next-week" } }] }, { text: ["Project Proposal is due Sep 30."] }, { text: ["Project Proposal is due Sep 30."] }]);
    expect(await tryModel("vendor/invents:free", inventing, snapshot)).toMatchObject({ calledTool: true, grounded: false, corrected: true, outcome: "ok" });
    const limited = await tryModel("vendor/limited:free", new ScriptedModel([{ throw: new ModelError("rate_limited", "slow down", true, 10) }]), snapshot);
    expect(limited).toMatchObject({ calledTool: false, grounded: false, outcome: "error", errorCode: "rate_limited" });
    expect(toolVerdict(limited)).toBe("failed (rate_limited)");
    const throwing: ChatModel = {
      id: "broken",
      // eslint-disable-next-line require-yield
      async *complete() {
        throw new Error("socket hang up");
      },
    };
    expect(await tryModel("vendor/broken:free", throwing, snapshot)).toMatchObject({ outcome: "error", errorCode: "internal", calledTool: false });
  });

  it("gives up on a model that never answers", async () => {
    const hanging: ChatModel = {
      id: "hang",
      async *complete(input) {
        await new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
        yield { type: "done", stop: "end", usage: null, model: "hang" };
      },
    };
    expect(await tryModel("vendor/hang:free", hanging, snapshot, { timeoutMs: 20 })).toMatchObject({ outcome: "aborted", errorCode: "aborted", calledTool: false });
  });
});

const trial = (overrides: Partial<ModelTrial>): ModelTrial => ({ model: "m", calledTool: true, toolNames: ["list_deadlines"], grounded: true, corrected: false, rounds: 2, totalTokens: 900, durationMs: 2400, outcome: "ok", errorCode: null, ...overrides });

describe("trial reports", () => {
  it("ranks a model that answered, called a tool, and stayed grounded first, then the faster one", () => {
    const ranked = rankTrials([
      trial({ model: "failed", outcome: "error", errorCode: "rate_limited", calledTool: false, grounded: false }),
      trial({ model: "no-tools", calledTool: false, toolNames: [] }),
      trial({ model: "slow", durationMs: 9000 }),
      trial({ model: "ungrounded", grounded: false }),
      trial({ model: "fast", durationMs: 1200 }),
    ]);
    expect(ranked.map((entry) => entry.model)).toEqual(["fast", "slow", "ungrounded", "no-tools", "failed"]);
  });

  it("writes rows that fit the table in the docs", () => {
    const rows = trialRows([trial({ model: "vendor/a:free", corrected: true }), trial({ model: "vendor/b:free", calledTool: false, toolNames: [], grounded: false, rounds: 1, totalTokens: null }), trial({ model: "vendor/c:free", outcome: "error", errorCode: "upstream_timeout" })], "2026-09-08");
    expect(rows).toEqual([
      "| `vendor/a:free` | 2026-09-08 | yes | list_deadlines; grounded; corrected once; 2 rounds; 900 tokens; 2.4 s |",
      "| `vendor/b:free` | 2026-09-08 | no | Answered without a lookup; not grounded; 1 round; 2.4 s |",
      "| `vendor/c:free` | 2026-09-08 | failed (upstream_timeout) | No answer. |",
    ]);
    for (const row of rows) expect(row.split("|")).toHaveLength(6);
  });
});

describe("the API and streamed text", () => {
  const app = () => createApp({ config: loadConfig({ OPENROUTER_API_KEY: "sk-test", CORS_ORIGINS: "chrome-extension://abc" }), model: new ScriptedModel(demoRouter), logger: createLogger(() => undefined, () => NOW), usage: new UsageCounter(0), now: () => NOW });
  const ask = async (body: Record<string, unknown>): Promise<AskEvent[]> => {
    const response = await app().request("/v1/chat", { method: "POST", headers: { "Content-Type": "application/json", Origin: "chrome-extension://abc" }, body: JSON.stringify({ message: "What is due this week?", history: [], snapshot, client: { name: "nova-extension", version: "0.1.0" }, ...body }) });
    expect(response.status).toBe(200);
    const events: AskEvent[] = [];
    for await (const frame of parseSseStream(response.body as ReadableStream<Uint8Array>)) events.push(askEventSchema.parse(JSON.parse(frame.data)));
    return events;
  };

  it("sends one checked text event to a panel that did not ask for a stream", async () => {
    const events = await ask({});
    expect(events.filter((event) => event.type === "text")).toHaveLength(1);
  });

  it("sends the words as they are written to a panel that asked", async () => {
    const plain = await ask({});
    const streamed = await ask({ streamText: true });
    const text = (events: AskEvent[]) => events.flatMap((event) => (event.type === "text" ? [event.delta] : [])).join("");
    expect(streamed.filter((event) => event.type === "text").length).toBeGreaterThan(1);
    expect(text(streamed)).toBe(text(plain));
    expect(streamed.at(-1)).toMatchObject({ type: "done", grounded: true });
  });
});
