import type { ModelUsage, ToolName } from "@nova-agent/protocol";
import type { ChatModel, ModelError, ModelEvent, ModelInput, ModelStop } from "./model";
import { addCalendarDays } from "./tools/period";

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

const parseTool = (content: string): { summary?: string; proposed?: string; error?: string; items?: { id?: string }[] } => {
  try {
    return JSON.parse(content) as { summary?: string; proposed?: string; error?: string; items?: { id?: string }[] };
  } catch {
    return {};
  }
};

/** The local calendar day the system prompt states, so the router never reads a clock. */
const todayOf = (input: ModelInput): string | null => /Today is \w{3} (\d{4}-\d{2}-\d{2})/.exec(input.messages[0]?.content ?? "")?.[1] ?? null;

const WANTS_DONE = /\bmark\b.*\bdone\b|\bcheck(ed)? off\b|\btick(ed)? off\b/;

/**
 * Keyword router for demos and UI tests: a lookup, sometimes a suggestion
 * built from that lookup, then a sentence that quotes the tool's own summary
 * so the answer is always grounded.
 */
export const demoRouter: ScriptedRouter = (input) => {
  const toolMessages = input.messages.filter((message) => message.role === "tool");
  const lastTool = toolMessages.at(-1);
  const question = lastUserText(input);
  // "Mark what is overdue as done": the lookup comes first, then the suggestion names exactly the items it returned.
  if (WANTS_DONE.test(question) && toolMessages.length === 1 && lastTool && input.toolChoice !== "none") {
    const ids = (parseTool(lastTool.content).items ?? []).flatMap((item) => (typeof item.id === "string" ? [item.id] : []));
    if (ids.length > 0) return { toolCalls: [{ name: "propose_mark_done", args: { ids: ids.slice(0, 20) } }] };
  }
  if (lastTool) {
    const result = parseTool(lastTool.content);
    if (result.proposed) return { text: [result.summary ?? "I made a suggestion", ". ", "It waits for you to confirm below; nothing has changed yet."], usage: { promptTokens: 140, completionTokens: 20, totalTokens: 160 } };
    if (result.error) return { text: ["I could not do that: ", result.error] };
    return { text: [result.summary ?? "Here is what I found.", " ", "The rows below come straight from your Brightspace data."], usage: { promptTokens: 120, completionTokens: 24, totalTokens: 144 } };
  }
  if (input.toolChoice === "none") return { text: ["I could not look that up. Try asking about deadlines, changes, or what to start first."] };
  if (WANTS_DONE.test(question)) {
    const range = /overdue|late/.test(question) ? "overdue" : /today|tonight/.test(question) ? "today" : "week";
    return { toolCalls: [{ name: "list_deadlines", args: { range, includePersonal: false } }] };
  }
  if (/\bmark\b.*\bread\b/.test(question)) return { toolCalls: [{ name: "propose_mark_read", args: { all: true } }] };
  const remind = /\b(?:remind me to|add a deadline to|add a reminder to)\s+(.+?)(?:\s+(today|tonight|tomorrow))?(?:\s+at\s+(\d{1,2}(?::\d{2})?\s?(?:am|pm)))?[.?!]*$/.exec(question);
  const today = todayOf(input);
  if (remind?.[1] && today) {
    const date = remind[2] === "tomorrow" || remind[2] === undefined ? addCalendarDays(today, 1) : today;
    return { toolCalls: [{ name: "propose_personal_deadline", args: { action: "add", title: `${remind[1].charAt(0).toUpperCase()}${remind[1].slice(1)}`, date, ...(remind[3] ? { time: remind[3] } : {}) } }] };
  }
  // "What is left in <course>?", the chip the Ask hero draws from the course with the most open work.
  const leftIn = /\bleft in (.+?)\??$/.exec(question);
  if (leftIn?.[1]) return { toolCalls: [{ name: "list_deadlines", args: { range: "all", course: leftIn[1].trim() } }] };
  if (/\bplan\b|\bschedule\b/.test(question)) {
    const days = /\bweek\b|\b7 days\b|\bseven days\b/.test(question) ? 7 : /\btwo days\b|\b2 days\b/.test(question) ? 2 : 3;
    return { toolCalls: [{ name: "build_study_plan", args: { days } }] };
  }
  if (/\bwhich course\b|\bcourses?\b.*\b(most|attention|workload|busiest)\b|\bworkload\b/.test(question)) return { toolCalls: [{ name: "get_course_load", args: {} }] };
  if (/\b(announce|announcements?|posted|news)\b/.test(question)) return { toolCalls: [{ name: "get_recent_announcements", args: {} }] };
  if (/\b(change|changed|changes|new|moved|since)\b/.test(question)) return { toolCalls: [{ name: "get_changes", args: { since: "week" } }] };
  if (/\b(due|deadline|week|tomorrow|today|overdue)\b/.test(question)) {
    const range = /next week/.test(question) ? "next-week" : /overdue/.test(question) ? "overdue" : /tomorrow/.test(question) ? "tomorrow" : /today/.test(question) ? "today" : "week";
    return { toolCalls: [{ name: "list_deadlines", args: { range } }] };
  }
  return { toolCalls: [{ name: "get_brief", args: {} }] };
};
