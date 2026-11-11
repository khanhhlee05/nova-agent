/**
 * Lists OpenRouter models that are free and support tool calling, so
 * OPENROUTER_MODEL can be set to one that actually works today.
 *
 *   npm run probe:api                      # table
 *   npm run probe:api -- --json            # raw list
 *   npm run probe:api -- --try             # ask the first 5 one real question over demo data
 *   npm run probe:api -- --try 8           # the first 8
 *   npm run probe:api -- --try --model a/b:free --model c/d:free
 *
 * `--try` needs OPENROUTER_API_KEY. It runs the real agent loop once per
 * model and records whether the model called a tool, whether its answer
 * passed the check, and how long it took, then prints rows for the table
 * in docs/ASK_NOVA.md. Only demo data is sent.
 */
import { OpenAiCompatibleModel, compactSnapshot } from "@nova-agent/agent";
import { BrightspaceClient, FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { createSnapshot } from "@nova-agent/core";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";
import { rankTrials, toolVerdict, trialRows, tryModel, type ModelTrial } from "../trial";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Environment only.
}

type ModelInfo = {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
};

const main = async () => {
  const config = loadConfig(process.env);
  const json = process.argv.includes("--json");
  const response = await fetch(`${config.OPENROUTER_BASE_URL}/models`, {
    headers: config.OPENROUTER_API_KEY ? { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` } : {},
  });
  if (!response.ok) {
    console.error(`OpenRouter answered ${response.status}`);
    process.exit(1);
  }
  const body = (await response.json()) as { data: ModelInfo[] };
  const free = body.data
    .filter((model) => Number(model.pricing?.prompt ?? "1") === 0 && Number(model.pricing?.completion ?? "1") === 0)
    .filter((model) => (model.supported_parameters ?? []).includes("tools"))
    .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
  const tryIndex = process.argv.indexOf("--try");
  if (tryIndex !== -1) {
    if (!config.OPENROUTER_API_KEY) {
      console.error("--try needs OPENROUTER_API_KEY in apps/api/.env.");
      process.exit(1);
    }
    const named = process.argv.flatMap((value, index) => (value === "--model" && process.argv[index + 1] ? [process.argv[index + 1] as string] : []));
    const count = Math.max(1, Math.min(20, Number(process.argv[tryIndex + 1]) || 5));
    const ids = named.length > 0 ? named : free.slice(0, count).map((model) => model.id);
    const now = new Date();
    const client = new BrightspaceClient(new FixtureTransport(demoResolver(buildDemoTenant(now))), { tenantOrigin: "https://brightspace.villanova.edu", now: () => now });
    const snapshot = compactSnapshot(createSnapshot({ ...(await client.loadAcademicState()), capturedAt: now.toISOString() }), [], now, { mode: "demo", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const trials: ModelTrial[] = [];
    for (const id of ids) {
      // One at a time: the free tier allows few requests per minute.
      const trial = await tryModel(id, new OpenAiCompatibleModel({ baseUrl: config.OPENROUTER_BASE_URL, apiKey: config.OPENROUTER_API_KEY, model: id, headers: { "X-Title": "Nova Agent" }, timeoutMs: config.REQUEST_TIMEOUT_MS }), snapshot, { maxTokens: config.MAX_TOKENS, maxRounds: config.MAX_ROUNDS });
      trials.push(trial);
      if (!json) console.log(`${id.padEnd(56)} tool calls: ${toolVerdict(trial).padEnd(22)} grounded: ${trial.grounded ? "yes" : "no "} ${(trial.durationMs / 1000).toFixed(1)} s`);
    }
    const ranked = rankTrials(trials);
    if (json) {
      console.log(JSON.stringify(ranked, null, 2));
      return;
    }
    console.log("\nRows for the table in docs/ASK_NOVA.md, best first:\n");
    for (const row of trialRows(ranked, now.toISOString().slice(0, 10))) console.log(row);
    const best = ranked[0];
    if (best && best.outcome === "ok" && best.calledTool) console.log(`\nBest today: OPENROUTER_MODEL=${best.model}`);
    else console.log("\nNo model both answered and called a tool. Try again later or name others with --model.");
    return;
  }
  if (json) {
    console.log(JSON.stringify(free.map((model) => ({ id: model.id, name: model.name, context: model.context_length, toolChoice: (model.supported_parameters ?? []).includes("tool_choice") })), null, 2));
    return;
  }
  console.log(`${free.length} free models with tool support (current OPENROUTER_MODEL=${config.OPENROUTER_MODEL}):\n`);
  for (const model of free) {
    const choice = (model.supported_parameters ?? []).includes("tool_choice") ? "tool_choice" : "";
    console.log(`${model.id.padEnd(56)} ${String(model.context_length ?? "?").padStart(8)} ctx  ${choice}`);
  }
  console.log("\nSet OPENROUTER_MODEL in apps/api/.env, restart dev:api, then run npm run smoke:api.");
};

void main();
