/**
 * Sends one question with the demo snapshot and prints the stream.
 *
 *   npm run smoke:api -- --question "What is due this week?"
 *   npm run smoke:api -- --direct        # run the loop in-process, no server
 *   npm run smoke:api -- --api http://localhost:8787 --token <NOVA_DEV_TOKEN>
 */
import { OpenAiCompatibleModel, compactSnapshot, runTurn } from "@nova-agent/agent";
import { BrightspaceClient, FixtureTransport, buildDemoTenant, demoResolver } from "@nova-agent/brightspace";
import { createSnapshot, diffSnapshots } from "@nova-agent/core";
import { askEventSchema, parseSseStream, type AskEvent, type ChatRequest } from "@nova-agent/protocol";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // Environment only.
}

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? (process.argv[index + 1] as string) : fallback;
};

const TENANT = "https://brightspace.villanova.edu";

const demoRequest = async (question: string): Promise<ChatRequest> => {
  const now = new Date();
  const load = async (scenario: "baseline" | "changed", at: Date) => {
    const client = new BrightspaceClient(new FixtureTransport(demoResolver(buildDemoTenant(at, scenario))), { tenantOrigin: TENANT, now: () => at });
    return createSnapshot({ ...(await client.loadAcademicState()), capturedAt: at.toISOString() });
  };
  const earlier = await load("baseline", new Date(now.getTime() - 3_600_000));
  const current = await load("changed", now);
  const events = diffSnapshots({ current, history: [earlier] });
  return {
    message: question,
    history: [],
    snapshot: compactSnapshot(current, events, now, { mode: "demo", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    client: { name: "nova-extension", version: "smoke" },
  };
};

const print = (event: AskEvent) => {
  switch (event.type) {
    case "text":
      process.stdout.write(event.delta);
      break;
    case "tool_call":
      console.log(`\n[tool_call] ${event.name} ${JSON.stringify(event.input)}`);
      break;
    case "tool_result":
      console.log(`[tool_result] ${event.ok ? "ok" : "error"}: ${event.ok ? event.summary : event.error} (${event.rows.length} rows)`);
      break;
    case "done":
      console.log(`\n[done] model=${event.model} rounds=${event.rounds} grounded=${event.grounded} corrected=${event.corrected} usage=${JSON.stringify(event.usage)}`);
      break;
    case "error":
      console.log(`\n[error] ${event.code}: ${event.message}`);
      break;
  }
};

const main = async () => {
  const config = loadConfig(process.env);
  const question = arg("question", "What should I start first?");
  const request = await demoRequest(question);
  console.log(`Question: ${question}\nSnapshot: ${JSON.stringify(request.snapshot).length} bytes, ${request.snapshot.items.length} items, ${request.snapshot.changes.length} changes\n`);

  if (process.argv.includes("--direct")) {
    if (!config.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
    const model = new OpenAiCompatibleModel({ baseUrl: config.OPENROUTER_BASE_URL, apiKey: config.OPENROUTER_API_KEY, model: config.OPENROUTER_MODEL, headers: { "X-Title": "Nova Agent smoke" } });
    const generator = runTurn({ snapshot: request.snapshot, history: [], message: question, model, maxTokens: config.MAX_TOKENS, signal: new AbortController().signal });
    for (;;) {
      const next = await generator.next();
      if (next.done) break;
      print(next.value);
    }
    return;
  }

  const api = arg("api", `http://localhost:${config.PORT}`);
  const token = arg("token", config.NOVA_DEV_TOKEN ?? "");
  const response = await fetch(`${api}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.body) {
    console.error(`API answered ${response.status}: ${await response.text()}`);
    process.exit(1);
  }
  for await (const frame of parseSseStream(response.body)) {
    const parsed = askEventSchema.safeParse(JSON.parse(frame.data));
    if (parsed.success) print(parsed.data);
    else console.log(`[unknown frame] ${frame.data}`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
