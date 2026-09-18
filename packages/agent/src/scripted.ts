import type { ModelUsage, ToolName } from "@nova-agent/protocol";
import type { ChatModel, ModelError, ModelEvent, ModelInput, ModelStop } from "./model";

export type ScriptedTurn = {
  text?: string[];
  toolCalls?: { name: ToolName; args: unknown; id?: string }[];
  stop?: ModelStop;
  usage?: ModelUsage;
  model?: string;
  /** Throw this instead of producing events, after any text already listed. */
  throw?: ModelError;
};

export type ScriptedRouter = (input: ModelInput, callIndex: number) => ScriptedTurn;

/**
 * A model that replays a script. Tests use the array form; the preview
 * harness and UI tests use the router form to answer common questions from
 * real tool results without any network.
 */
export class ScriptedModel implements ChatModel {
  readonly id = "scripted";
  readonly calls: ModelInput[] = [];
  private readonly router: ScriptedRouter;

  constructor(script: ScriptedTurn[] | ScriptedRouter) {
    this.router = typeof script === "function" ? script : (_input, index) => script[Math.min(index, script.length - 1)] ?? { text: ["…"] };
  }

  async *complete(input: ModelInput): AsyncIterable<ModelEvent> {
    const turn = this.router(input, this.calls.length);
    // Copy the message list: the loop mutates it, and tests inspect what each call saw.
    this.calls.push({ ...input, messages: [...input.messages] });
    for (const delta of turn.text ?? []) {
      await Promise.resolve();
      if (input.signal.aborted) throw abortError();
      yield { type: "text", delta };
    }
    if (turn.throw) throw turn.throw;
    const calls = turn.toolCalls ?? [];
    for (const [index, call] of calls.entries()) {
      yield { type: "tool_call", call: { id: call.id ?? `call_${this.calls.length}_${index}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) } };
    }
    yield { type: "done", stop: turn.stop ?? (calls.length > 0 ? "tool_use" : "end"), usage: turn.usage ?? null, model: turn.model ?? "scripted" };
  }
}

const abortError = (): Error => {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

const lastUserText = (input: ModelInput): string => {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const message = input.messages[i];
    if (message?.role === "user") return message.content.toLowerCase();
  }
  return "";
};

/**
 * Keyword router for demos and UI tests: one tool call, then a sentence that
 * quotes the tool's own summary so the answer is always grounded.
 */
export const demoRouter: ScriptedRouter = (input) => {
  const lastTool = [...input.messages].reverse().find((message) => message.role === "tool");
  if (lastTool && lastTool.role === "tool") {
    const summary = (() => {
      try {
        return (JSON.parse(lastTool.content) as { summary?: string }).summary ?? "Here is what I found.";
      } catch {
        return "Here is what I found.";
      }
    })();
    return { text: [summary, " ", "The rows below come straight from your Brightspace data."], usage: { promptTokens: 120, completionTokens: 24, totalTokens: 144 } };
  }
  if (input.toolChoice === "none") return { text: ["I could not look that up. Try asking about deadlines, changes, or what to start first."] };
  const question = lastUserText(input);
  if (/\b(announce|announcements?|posted|news)\b/.test(question)) return { toolCalls: [{ name: "get_recent_announcements", args: {} }] };
  if (/\b(change|changed|changes|new|moved|since)\b/.test(question)) return { toolCalls: [{ name: "get_changes", args: { since: "week" } }] };
  if (/\b(due|deadline|week|tomorrow|today|overdue)\b/.test(question)) {
    const range = /next week/.test(question) ? "next-week" : /overdue/.test(question) ? "overdue" : /tomorrow/.test(question) ? "tomorrow" : /today/.test(question) ? "today" : "week";
    return { toolCalls: [{ name: "list_deadlines", args: { range } }] };
  }
  return { toolCalls: [{ name: "get_brief", args: {} }] };
};
