import { runTurn, type ChatModel } from "@nova-agent/agent";
import type { CompactSnapshot } from "@nova-agent/protocol";

/** What one model did with one question over the demo data. Counts and flags only; no answer text. */
export type ModelTrial = {
  model: string;
  /** The model asked for at least one lookup. */
  calledTool: boolean;
  toolNames: string[];
  /** The answer named only what the lookups and the course data contain. */
  grounded: boolean;
  /** A first draft failed the check and was written again. */
  corrected: boolean;
  rounds: number;
  totalTokens: number | null;
  durationMs: number;
  outcome: "ok" | "error" | "aborted";
  errorCode: string | null;
};

/** A question that cannot be answered from the prompt's brief alone, so a model that never calls a tool shows it. */
export const TRIAL_QUESTION = "What is due next week, and in which courses?";

/**
 * Runs one turn of the real agent loop against a model and reports whether
 * it called a tool and whether its answer passed the check. Never throws:
 * a failure is a trial with an error code.
 */
export const tryModel = async (
  id: string,
  model: ChatModel,
  snapshot: CompactSnapshot,
  options: { question?: string; maxTokens?: number; maxRounds?: number; timeoutMs?: number; now?: () => number } = {},
): Promise<ModelTrial> => {
  const now = options.now ?? Date.now;
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
  try {
    const generator = runTurn({ snapshot, history: [], message: options.question ?? TRIAL_QUESTION, model, maxTokens: options.maxTokens ?? 500, maxRounds: options.maxRounds ?? 4, signal: controller.signal });
    for (;;) {
      const next = await generator.next();
      if (!next.done) continue;
      const result = next.value;
      return {
        model: id,
        calledTool: result.toolNames.length > 0,
        toolNames: [...new Set(result.toolNames)],
        grounded: result.grounded,
        corrected: result.corrected,
        rounds: result.rounds,
        totalTokens: result.usage?.totalTokens ?? null,
        durationMs: now() - started,
        outcome: result.outcome,
        errorCode: result.errorCode ?? null,
      };
    }
  } catch {
    return { model: id, calledTool: false, toolNames: [], grounded: false, corrected: false, rounds: 0, totalTokens: null, durationMs: now() - started, outcome: "error", errorCode: "internal" };
  } finally {
    clearTimeout(timer);
  }
};

/** How a trial reads in the "Tool calls" column. */
export const toolVerdict = (trial: ModelTrial): string => (trial.outcome !== "ok" ? `failed (${trial.errorCode ?? trial.outcome})` : trial.calledTool ? "yes" : "no");

/** Rows for the free-model table in docs/ASK_NOVA.md: model id, date, tool calls, notes. */
export const trialRows = (trials: readonly ModelTrial[], date: string): string[] =>
  trials.map((trial) => {
    const notes =
      trial.outcome !== "ok"
        ? "No answer."
        : [trial.calledTool ? trial.toolNames.join(", ") : "Answered without a lookup", trial.grounded ? "grounded" : "not grounded", ...(trial.corrected ? ["corrected once"] : []), `${trial.rounds} ${trial.rounds === 1 ? "round" : "rounds"}`, ...(trial.totalTokens !== null ? [`${trial.totalTokens} tokens`] : []), `${(trial.durationMs / 1000).toFixed(1)} s`].join("; ");
    return `| \`${trial.model}\` | ${date} | ${toolVerdict(trial)} | ${notes} |`;
  });

/** Best first: a model that answered, called a tool, and stayed grounded, then the faster one. */
export const rankTrials = (trials: readonly ModelTrial[]): ModelTrial[] => {
  const score = (trial: ModelTrial): number => (trial.outcome === "ok" ? 4 : 0) + (trial.calledTool ? 2 : 0) + (trial.grounded ? 1 : 0);
  return [...trials].sort((a, b) => score(b) - score(a) || a.durationMs - b.durationMs || a.model.localeCompare(b.model));
};
