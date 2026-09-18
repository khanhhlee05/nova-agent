/**
 * Lists OpenRouter models that are free and support tool calling, so
 * OPENROUTER_MODEL can be set to one that actually works today.
 *
 *   npm run probe:api            # table
 *   npm run probe:api -- --json  # raw list
 */
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";

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
