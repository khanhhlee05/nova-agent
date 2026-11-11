import { PROPOSAL_LIMITS, type AskEvent, type ChatFocus, type ChatMessage, type ClientToolName, type ClientToolResult, type CompactSnapshot, type ModelUsage, type ToolName } from "@nova-agent/protocol";
import { checkHonesty } from "./honesty";
import { ModelError, addUsage, isAbortError, type ChatModel, type ModelMessage, type ToolCall } from "./model";
import { briefTitles, buildSystemPrompt, quote } from "./prompt";
import { TOOLS, executeTool, isClientToolName, isToolName, rowTitles, toolSchemasForModel, toolsFor, type ToolResult, type ToolSpec } from "./tools";

export type TurnLog = { rounds: number; toolNames: ToolName[]; usage: ModelUsage | null; model: string | null; outcome: "ok" | "error" | "aborted"; errorCode?: string; grounded: boolean; corrected: boolean };

export type RunTurnInput = {
  snapshot: CompactSnapshot;
  history: ChatMessage[];
  message: string;
  /** What the student was looking at; a prompt hint only. */
  focus?: ChatFocus;
  /** Summary of the conversation before `history`. Placed inside the data section of the prompt. */
  summary?: string;
  model: ChatModel;
  /**
   * How to reach the panel for the lookups only it can make. Without it no client tool is offered.
   * `call` must settle, never hang or reject: on a timeout or a stop it resolves with `ok: false`.
   */
  clientTools?: ClientToolChannel;
  tools?: readonly ToolSpec[];
  /** Tool rounds before the model is forced to answer. Default 4. */
  maxRounds?: number;
  maxTokens: number;
  signal: AbortSignal;
};

export type ClientToolChannel = {
  /** Identifies this turn to the panel, so its answer finds its way back. */
  turnId: string;
  /** The client tools this panel can answer. */
  names: readonly ClientToolName[];
  call: (request: { id: string; name: ClientToolName; input: unknown }, signal: AbortSignal) => Promise<ClientToolResult>;
};

export type TurnResult = {
  text: string;
  usage: ModelUsage | null;
  model: string | null;
  rounds: number;
  toolNames: ToolName[];
  grounded: boolean;
  corrected: boolean;
  returnedTitles: string[];
  /** How many suggestions were shown to the student. */
  proposals: number;
  outcome: "ok" | "error" | "aborted";
  errorCode?: string;
};

const abortError = (): Error => {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
};

/** The summary of a failed lookup that has nothing better to say. */
export const LOOKUP_FAILED = "Lookup failed";

const FALLBACK = "I could not finish looking that up. Try asking again, or press Refresh if the data looks old.";

const parseArgs = (raw: string): unknown => {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __invalid: raw };
  }
};

const nudge = (title: string, canLookUp: boolean): string =>
  `Your draft names ${quote(title)}, which no tool result or course data line contains. ${canLookUp ? "Call a tool to verify it, then answer using only tool results and the course data." : "Answer again without naming it, using only the course data and the tool results above."}`;

/**
 * One chat turn: at most `maxRounds` model calls with tools, then a forced
 * answer. Emits the events the client renders. Tool calls and results stream
 * as they happen; the answer text is held back until it has been checked
 * against the titles the tools returned and the brief listed. If the model
 * named an item it never looked up, it is nudged once (while a round is
 * left), and `grounded` reports whether the flushed answer passed. Model
 * calls never exceed `maxRounds`.
 */
export async function* runTurn(input: RunTurnInput): AsyncGenerator<AskEvent, TurnResult> {
  const tools = input.tools ?? (input.clientTools ? toolsFor(input.clientTools.names) : TOOLS);
  const maxRounds = Math.max(1, input.maxRounds ?? 4);
  const definitions = toolSchemasForModel(tools);
  const messages: ModelMessage[] = [
    { role: "system", content: buildSystemPrompt(input.snapshot, { focus: input.focus, summary: input.summary }) },
    ...input.history.map((entry): ModelMessage => ({ role: entry.role, content: entry.content })),
    { role: "user", content: input.message },
  ];
  const allowedTitles = new Set(briefTitles(input.snapshot, { focus: input.focus }));
  const returnedTitles = new Set<string>();
  const toolNames: ToolName[] = [];
  let usage: ModelUsage | null = null;
  let modelId: string | null = null;
  let rounds = 0;
  let corrected = false;
  let grounded = false;
  let finalText = "";
  let proposals = 0;

  const finish = (outcome: TurnResult["outcome"], errorCode?: string): TurnResult => ({
    text: finalText,
    usage,
    model: modelId,
    rounds,
    toolNames,
    grounded,
    corrected,
    returnedTitles: [...returnedTitles],
    proposals,
    outcome,
    ...(errorCode ? { errorCode } : {}),
  });

  try {
    for (;;) {
      rounds += 1;
      const lastRound = rounds >= maxRounds;
      const toolChoice = lastRound ? "none" : "auto";
      let text = "";
      const calls: ToolCall[] = [];
      let stop: string = "end";
      for await (const event of input.model.complete({ messages, tools: definitions, toolChoice, maxTokens: input.maxTokens, signal: input.signal })) {
        if (event.type === "text") {
          text += event.delta;
        } else if (event.type === "tool_call") {
          calls.push(event.call);
        } else {
          stop = event.stop;
          usage = addUsage(usage, event.usage);
          modelId = event.model ?? modelId;
        }
      }

      if (calls.length > 0 && !lastRound) {
        messages.push({ role: "assistant", content: text, toolCalls: calls });
        for (const call of calls) {
          const args = parseArgs(call.arguments);
          const name = isToolName(call.name, tools) ? call.name : null;
          yield { type: "tool_call", id: call.id, name: name ?? "get_brief", input: args };
          const spec = tools.find((candidate) => candidate.name === call.name);
          let result: ToolResult;
          if (spec?.client && isClientToolName(spec.name) && input.clientTools) {
            // The arguments are checked here; only a well-formed request is ever sent to the panel.
            const parsed = spec.input.safeParse(args ?? {});
            if (!parsed.success) {
              result = { ok: false, error: `Invalid arguments for ${spec.name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}` };
            } else {
              // Start listening for the answer before the request goes out: a panel with the text already at hand
              // can answer faster than this generator is resumed, and its answer must find someone waiting.
              const pending = input.clientTools.call({ id: call.id, name: spec.name, input: parsed.data }, input.signal);
              yield { type: "client_tool", turnId: input.clientTools.turnId, id: call.id, name: spec.name, input: parsed.data };
              const answer = await pending;
              if (input.signal.aborted) throw abortError();
              // A failed lookup may carry a line for the student in `summary`; the model reads `error`.
              result = answer.ok ? { ok: true, summary: answer.summary, data: answer.data, rows: answer.rows } : { ok: false, error: answer.error ?? "The panel could not do that.", ...(answer.summary ? { note: answer.summary } : {}) };
            }
          } else {
            result = executeTool(call.name, args, { snapshot: input.snapshot }, tools);
          }
          // A turn may suggest a few actions, not a wall of cards; past the limit the model is told and nothing is shown.
          if (result.ok && result.proposal && proposals >= PROPOSAL_LIMITS.perTurn) {
            result = { ok: false, error: `Only ${PROPOSAL_LIMITS.perTurn} suggestions fit in one answer. This one was not shown; tell the student what else you would suggest.` };
          }
          if (name) toolNames.push(name);
          if (result.ok) {
            for (const row of result.rows) for (const title of rowTitles(row)) returnedTitles.add(title);
            yield { type: "tool_result", id: call.id, name: name ?? "get_brief", ok: true, summary: result.summary, rows: result.rows };
            if (result.proposal) {
              proposals += 1;
              yield { type: "proposal", id: `proposal-${rounds}-${call.id}`.slice(0, 120), label: result.proposal.label.slice(0, 300), payload: result.proposal.payload };
            }
            // A client tool's data may be anything JSON; only a plain object is spread beside the summary.
            const data = typeof result.data === "object" && result.data !== null && !Array.isArray(result.data) ? (result.data as object) : { result: result.data ?? null };
            messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ summary: result.summary, ...data }) });
          } else {
            yield { type: "tool_result", id: call.id, name: name ?? "get_brief", ok: false, summary: result.note ?? LOOKUP_FAILED, rows: [], error: result.error };
            messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ error: result.error }) });
          }
        }
        continue;
      }

      // Final answer. A tool call on the last round is dropped in favour of the text, or a fallback.
      if (text.trim() === "") text = stop === "max_tokens" ? FALLBACK : calls.length > 0 ? FALLBACK : "I do not have enough to answer that. Try asking about deadlines, changes, or what to start first.";
      const check = checkHonesty(text, input.snapshot, [...allowedTitles, ...returnedTitles]);
      // One correction, and only while a round is left: the last round is reserved for the answer.
      if (!check.ok && !corrected && !lastRound) {
        corrected = true;
        messages.push({ role: "assistant", content: text });
        messages.push({ role: "user", content: nudge(check.unverified[0] ?? "", rounds + 1 < maxRounds) });
        continue;
      }
      finalText = text;
      grounded = check.ok;
      yield { type: "text", delta: text };
      yield { type: "done", model: modelId, usage, rounds, grounded, corrected };
      return finish("ok");
    }
  } catch (error) {
    if (isAbortError(error) || input.signal.aborted) {
      yield { type: "error", code: "aborted", message: "Stopped.", retryable: true };
      return finish("aborted", "aborted");
    }
    if (error instanceof ModelError) {
      yield { type: "error", code: error.code, message: error.message, retryable: error.retryable, ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}) };
      return finish("error", error.code);
    }
    yield { type: "error", code: "internal", message: "Nova hit an unexpected problem.", retryable: true };
    return finish("error", "internal");
  }
}
