import type { AskEvent, ChatMessage, CompactSnapshot, ModelUsage, ToolName } from "@nova-agent/protocol";
import { checkHonesty } from "./honesty";
import { ModelError, addUsage, isAbortError, type ChatModel, type ModelMessage, type ToolCall } from "./model";
import { briefTitles, buildSystemPrompt } from "./prompt";
import { TOOLS, executeTool, isToolName, toolSchemasForModel, type ToolSpec } from "./tools";

export type TurnLog = { rounds: number; toolNames: ToolName[]; usage: ModelUsage | null; model: string | null; outcome: "ok" | "error" | "aborted"; errorCode?: string; grounded: boolean; corrected: boolean };

export type RunTurnInput = {
  snapshot: CompactSnapshot;
  history: ChatMessage[];
  message: string;
  model: ChatModel;
  tools?: readonly ToolSpec[];
  /** Tool rounds before the model is forced to answer. Default 4. */
  maxRounds?: number;
  maxTokens: number;
  signal: AbortSignal;
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
  outcome: "ok" | "error" | "aborted";
  errorCode?: string;
};

const FALLBACK = "I could not finish looking that up. Try asking again, or press Refresh if the data looks old.";

const parseArgs = (raw: string): unknown => {
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { __invalid: raw };
  }
};

/**
 * One chat turn: at most `maxRounds` model calls with tools, then a forced
 * answer. Emits the events the client renders. Streams text live once a tool
 * has been consulted; when the model answers without any tool, the text is
 * checked against known titles first and the model is nudged once if it
 * named something it never looked up.
 */
export async function* runTurn(input: RunTurnInput): AsyncGenerator<AskEvent, TurnResult> {
  const tools = input.tools ?? TOOLS;
  const maxRounds = Math.max(1, input.maxRounds ?? 4);
  const definitions = toolSchemasForModel(tools);
  const messages: ModelMessage[] = [
    { role: "system", content: buildSystemPrompt(input.snapshot) },
    ...input.history.map((entry): ModelMessage => ({ role: entry.role, content: entry.content })),
    { role: "user", content: input.message },
  ];
  const allowedTitles = new Set(briefTitles(input.snapshot));
  const returnedTitles = new Set<string>();
  const toolNames: ToolName[] = [];
  let usage: ModelUsage | null = null;
  let modelId: string | null = null;
  let rounds = 0;
  let corrected = false;
  let usedTool = false;
  let finalText = "";

  const finish = (outcome: TurnResult["outcome"], errorCode?: string): TurnResult => ({
    text: finalText,
    usage,
    model: modelId,
    rounds,
    toolNames,
    grounded: usedTool || checkHonesty(finalText, input.snapshot, [...allowedTitles, ...returnedTitles]).ok,
    corrected,
    returnedTitles: [...returnedTitles],
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
          // Live streaming once the answer is grounded in a tool result; otherwise buffer for the honesty check.
          if (usedTool) yield { type: "text", delta: event.delta };
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
          const result = executeTool(call.name, args, { snapshot: input.snapshot }, tools);
          if (name) toolNames.push(name);
          if (result.ok) {
            usedTool = true;
            for (const row of result.rows) returnedTitles.add(row.title);
            yield { type: "tool_result", id: call.id, name: name ?? "get_brief", ok: true, summary: result.summary, rows: result.rows };
            messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ summary: result.summary, ...(result.data as object) }) });
          } else {
            yield { type: "tool_result", id: call.id, name: name ?? "get_brief", ok: false, summary: "Lookup failed", rows: [], error: result.error };
            messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ error: result.error }) });
          }
        }
        continue;
      }

      // Final answer. A tool call on the last round is dropped in favour of the text, or a fallback.
      if (text.trim() === "") text = stop === "max_tokens" ? FALLBACK : calls.length > 0 ? FALLBACK : "I do not have enough to answer that. Try asking about deadlines, changes, or what to start first.";
      if (!usedTool) {
        const check = checkHonesty(text, input.snapshot, allowedTitles);
        if (!check.ok && !corrected) {
          corrected = true;
          messages.push({ role: "assistant", content: text });
          messages.push({ role: "user", content: `Your draft names "${check.unverified[0]}" but you did not look it up. Call a tool to verify, then answer using only tool results and the brief.` });
          continue;
        }
        yield { type: "text", delta: text };
      }
      finalText = text;
      yield { type: "done", model: modelId, usage, rounds, grounded: usedTool || checkHonesty(finalText, input.snapshot, allowedTitles).ok, corrected };
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
