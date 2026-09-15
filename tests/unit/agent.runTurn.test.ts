import { ModelError, ScriptedModel, briefTitles, checkHonesty, compactSnapshot, demoRouter, runTurn, type RunTurnInput, type ScriptedTurn, type TurnResult } from "@nova-agent/agent";
import type { AskEvent, CompactSnapshot } from "@nova-agent/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { NOW, demoSnapshot } from "../helpers/demoDashboard";

let snapshot: CompactSnapshot;

beforeAll(async () => {
  snapshot = compactSnapshot(await demoSnapshot("baseline", NOW), [], NOW, { mode: "demo", timezone: "America/New_York" });
});

const drive = async (script: ScriptedTurn[] | ConstructorParameters<typeof ScriptedModel>[0], overrides: Partial<RunTurnInput> = {}, onEvent?: (event: AskEvent, controller: AbortController) => void) => {
  const controller = new AbortController();
  const model = new ScriptedModel(script);
  const events: AskEvent[] = [];
  const generator = runTurn({ snapshot, history: [], message: "What should I start first?", model, maxTokens: 300, signal: controller.signal, ...overrides });
  let result: TurnResult | undefined;
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      result = next.value;
      break;
    }
    events.push(next.value);
    onEvent?.(next.value, controller);
  }
  return { events, result: result as TurnResult, model };
};

const usage = (n: number) => ({ promptTokens: n, completionTokens: 10, totalTokens: n + 10 });

describe("runTurn", () => {
  it("streams tool_call, tool_result, text, done in order and sums usage", async () => {
    const { events, result, model } = await drive([
      { toolCalls: [{ name: "get_brief", args: {} }], usage: usage(100) },
      { text: ["Start with ", "Lab 2: GPIO and Debouncing", "."], usage: usage(200) },
    ]);
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "text", "text", "text", "done"]);
    const toolResult = events[1];
    expect(toolResult?.type === "tool_result" && toolResult.ok && toolResult.rows.length > 0).toBe(true);
    const done = events.at(-1);
    expect(done?.type === "done" && done.usage?.totalTokens === 320 && done.rounds === 2 && done.grounded && !done.corrected).toBe(true);
    expect(result.text).toBe("Start with Lab 2: GPIO and Debouncing.");
    expect(result.toolNames).toEqual(["get_brief"]);
    expect(model.calls[0]?.toolChoice).toBe("auto");
    expect(model.calls[1]?.messages.at(-1)?.role).toBe("tool");
    expect(model.calls[0]?.messages[0]?.content).toContain("You are Nova");
    expect(model.calls[0]?.tools.map((tool) => tool.function.name)).toContain("list_deadlines");
  });

  it("runs several rounds and round-trips tool errors as tool messages", async () => {
    const { events, model } = await drive([
      { toolCalls: [{ name: "list_deadlines", args: { course: "Underwater Basket Weaving" } }] },
      { toolCalls: [{ name: "list_deadlines", args: { course: "Microcontrollers" } }] },
      { text: ["Two things in Microcontrollers."] },
    ]);
    const results = events.filter((event) => event.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(results[0]?.type === "tool_result" && !results[0].ok && results[0].error?.includes("No course matches")).toBe(true);
    expect(results[1]?.type === "tool_result" && results[1].ok).toBe(true);
    const secondCallTool = model.calls[1]?.messages.at(-1);
    expect(secondCallTool?.role === "tool" && secondCallTool.content.includes("No course matches")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("forces an answer on the last round with toolChoice none and falls back when the model still calls a tool", async () => {
    const { events, result, model } = await drive([{ toolCalls: [{ name: "get_brief", args: {} }] }, { toolCalls: [{ name: "get_brief", args: {} }] }], { maxRounds: 2 });
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]?.toolChoice).toBe("none");
    expect(result.rounds).toBe(2);
    expect(result.text).toContain("could not finish");
    expect(events.at(-1)?.type).toBe("done");
  });

  it("buffers an ungrounded answer, nudges once, and reports corrected", async () => {
    const { events, result, model } = await drive([
      { text: ["Do the Project Proposal first."] },
      { toolCalls: [{ name: "list_deadlines", args: { range: "all" } }] },
      { text: ["Project Proposal is due next week."] },
    ]);
    expect(briefTitles(snapshot)).not.toContain("Project Proposal");
    expect(events[0]?.type).toBe("tool_call");
    expect(events.filter((event) => event.type === "text").map((event) => (event.type === "text" ? event.delta : "")).join("")).toBe("Project Proposal is due next week.");
    const nudge = model.calls[1]?.messages.at(-1);
    expect(nudge?.role === "user" && nudge.content.includes("Project Proposal")).toBe(true);
    expect(result.corrected).toBe(true);
    expect(result.grounded).toBe(true);
    const done = events.at(-1);
    expect(done?.type === "done" && done.corrected).toBe(true);
  });

  it("lets a brief-grounded answer through without a tool and flushes it as one text event", async () => {
    const top = briefTitles(snapshot)[0] as string;
    const { events, result } = await drive([{ text: [`Start with ${top}.`] }]);
    expect(events.map((event) => event.type)).toEqual(["text", "done"]);
    expect(result.grounded).toBe(true);
    expect(result.corrected).toBe(false);
    expect(checkHonesty(`Start with ${top}.`, snapshot, briefTitles(snapshot)).ok).toBe(true);
  });

  it("stops on abort mid-answer and reports aborted", async () => {
    const { events, result } = await drive([{ toolCalls: [{ name: "get_brief", args: {} }] }, { text: ["First part.", " Second part.", " Third."] }], {}, (event, controller) => {
      if (event.type === "text") controller.abort();
    });
    expect(events.filter((event) => event.type === "text")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "aborted" });
    expect(result.outcome).toBe("aborted");
  });

  it("maps model errors to typed error events", async () => {
    const { events, result } = await drive([{ throw: new ModelError("rate_limited", "Slow down", true, 30) }]);
    expect(events).toEqual([{ type: "error", code: "rate_limited", message: "Slow down", retryable: true, retryAfterSeconds: 30 }]);
    expect(result.outcome).toBe("error");
    expect(result.errorCode).toBe("rate_limited");
  });

  it("passes history through in order", async () => {
    const { model } = await drive([{ text: ["Sure."] }], { history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], message: "thanks" });
    expect(model.calls[0]?.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(model.calls[0]?.messages.at(-1)?.content).toBe("thanks");
  });
});

describe("demoRouter", () => {
  it("answers deadline questions from a real tool result", async () => {
    const { events, result } = await drive(demoRouter, { message: "What is due this week?" });
    expect(events[0]).toMatchObject({ type: "tool_call", name: "list_deadlines" });
    const toolResult = events[1];
    expect(toolResult?.type === "tool_result" && toolResult.ok).toBe(true);
    expect(result.text).toContain("due this week");
    expect(result.grounded).toBe(true);
  });

  it("routes change and announcement questions and falls back to the brief", async () => {
    expect((await drive(demoRouter, { message: "What changed since yesterday?" })).events[0]).toMatchObject({ type: "tool_call", name: "get_changes" });
    expect((await drive(demoRouter, { message: "Any new announcements?" })).events[0]).toMatchObject({ type: "tool_call", name: "get_recent_announcements" });
    expect((await drive(demoRouter, { message: "How am I doing?" })).events[0]).toMatchObject({ type: "tool_call", name: "get_brief" });
  });
});
