# Ask Nova: plan for a chatbot over Brightspace data

Status: slice 1 built (tools, loop, API, Ask tab) on the backend architecture in `BACKEND_PLAN.md`. See `ASK_NOVA.md` for what shipped. The "no backend" position below is superseded.

## What it is

A fourth tab in Mission Control, **Ask**, where a student types a question in plain words and gets an answer grounded in the same local data the other three tabs show. Examples:

- "What is due this week in Microcontrollers?"
- "What changed since yesterday?"
- "Which one should I start first, and why?"
- "Plan my next three days."
- "Put my deadlines on my calendar."

Every answer is built from tool calls over the local snapshot, change events, and the priority engine. The model writes the prose; the numbers, titles, dates, and links come from the tools and are rendered as real rows under the answer, never retyped by the model.

## What it is not

- **Not a write path.** Ask Nova never submits, posts, or changes anything in Brightspace. The extension keeps its read-only allowlist of routes. The only "action" is opening a Brightspace page the student could open themselves, through the existing `isSafeTenantLink` guard.
- **Not a scraper.** No new Brightspace routes. The chatbot reads IndexedDB, not Brightspace. If data is stale, it says so and offers a refresh.
- **Not a server.** `apps/api` stays a placeholder. No academic data goes to it.

## Where the model runs

Today `PRODUCT.md` says "nothing is sent to a server or a model". A chatbot needs a model, so that sentence changes to: "nothing is sent to a model unless Ask Nova is turned on, and then only the normalized course data a question needs".

The course provides an OpenRouter account per team ($200 allotment in $50 increments, token-based) and a ChatGPT license. That settles the provider:

| Option | Data leaves device? | Quality | Cost | Notes |
|---|---|---|---|---|
| A. **OpenRouter** (OpenAI-compatible API, many models) | Yes, to OpenRouter and the model vendor, only after opt-in | High; native tool calling, streaming | Team allotment | Primary adapter. Access pending. |
| B. Chrome built-in Prompt API (Gemini Nano, on-device) | No | Limited; tool use emulated | Free | Second adapter, feature-detected, Chrome 138+ |
| C. Our own backend holding the key | Yes, to us too | High | Hosting | Rejected: breaks the "no academic data to apps/api" rule |

The ChatGPT license is a chat product, not an API, so it cannot power the extension. It is useful for prompt drafting and evaluation during development.

### OpenRouter adapter

- Endpoint `https://openrouter.ai/api/v1/chat/completions`, OpenAI chat format with `tools`, `tool_choice`, and SSE streaming. Because the format is OpenAI-compatible, the same adapter works against OpenAI directly or any compatible endpoint by changing the base URL.
- Called directly from the side panel with the key in the `Authorization` header plus the `HTTP-Referer` and `X-Title` headers OpenRouter asks for. Network access through `optional_host_permissions` for `https://openrouter.ai/*`, requested at opt-in.
- The key is pasted once in the settings dialog and stored in `chrome.storage.local` under its own key. It is never in Dexie, never in the repo, never in a build, never logged. The repo ships no key; each install (each teammate's Chrome) enters it.
- Model is a setting with a curated list and a free-text override. Default: a current mid-tier model with tool calling (Claude Haiku 4.5 via OpenRouter is the reference choice; the list also carries a Claude Sonnet, a GPT, and a Gemini entry so the same questions can be compared for the report).
- Data minimization: the system prompt carries course names and counts; tool results carry titles, dates, statuses, and links. Never cookies, raw Brightspace responses, or the student's name.

### Budget controls (the allotment is shared and finite)

- Every response's `usage` is recorded per turn in the conversation row. Settings shows tokens and estimated spend for today, this week, and total, using OpenRouter's per-model pricing fetched once a day from its models endpoint.
- A daily token cap per install (default 100k) and a per-turn `max_tokens`. Past the cap the tab falls back to the intent matcher and says so.
- Prompt caching where the model supports it, a short system prompt, and tool results trimmed to the fields the model needs. Conversation history is windowed to the last 12 messages plus a rolling summary.
- Demo and tests never call the network: `ScriptedModel` and recorded fixtures only.

Ask Nova stays useful without a key: a deterministic intent matcher answers the common questions from the same tools.

## Architecture

```
Ask tab (React)  ──▶  runTurn()  ──▶  ChatModel adapter  ──▶  Anthropic API (BYOK)
                        │                    │                 or Chrome Prompt API
                        │                    └── ScriptedModel (tests, demo)
                        └── tools (packages/agent) ──▶ Dexie snapshot + events + planner
```

### `packages/agent` (today a placeholder)

Pure, deterministic tools over `{ snapshot, events, now, tenantOrigin }`. Zod input schemas, JSON-serializable outputs, no I/O. Every tool returns both `data` (for the model) and `render` (rows for the UI).

| Tool | Input | Output |
|---|---|---|
| `get_brief` | none | counts, next move, its priority reasons in words, freshness |
| `list_deadlines` | `range: overdue/today/tomorrow/week/later/all`, `courseId?`, `kind?`, `includeDone?` | items with due date, status, course, link |
| `get_item_details` | `key` or `titleQuery` | item, priority breakdown, related change events, link |
| `get_recent_announcements` | `courseId?`, `sinceHours?` | announcements with course and link |
| `get_changes` | `courseId?`, `since: today/yesterday/all` | change events with before/after |
| `build_study_plan` | `days`, `hoursPerDay?`, `courseId?` | day-by-day ordered list from the priority engine, with the rule that produced each slot |
| `export_calendar` | `range` | ICS text for a local download, no network |

Guardrails live in the tools, not in the prompt: the model has no fetch, no cookies, no URLs except `item.url` and `course.homeUrl` already validated by `isSafeTenantLink`. Course and item titles are the only free text that reaches the model.

### Agent loop

`runTurn({ history, question, tools, model, context, signal })`:

1. Builds the system prompt: today's date and timezone, the course list (names and ids), counts, data mode (live or demo, with "this data is fictional" in demo), freshness, and the rule "cite tool results, never invent an item".
2. Sends history plus question to the adapter with tool definitions.
3. Runs at most 4 tool rounds, then forces a final answer.
4. Streams text tokens and tool-call events to the UI. Abortable.
5. Returns the assistant message with an attached list of tool results for rendering.

### `ChatModel` adapter interface

```ts
type ChatModel = {
  id: "anthropic" | "chrome" | "scripted" | "intents";
  complete(input: { system: string; messages: Message[]; tools: ToolSpec[]; signal: AbortSignal }): AsyncIterable<ModelEvent>;
};
type ModelEvent = { type: "text"; delta: string } | { type: "tool_call"; id: string; name: string; input: unknown } | { type: "done"; stop: "end" | "tool_use" | "max_tokens" };
```

Implementations, in build order:

1. **`IntentsModel`**: no LLM. A small grammar maps common questions to one tool call and a templated sentence. Ships first so the tab is useful for everyone.
2. **`ScriptedModel`**: replays a fixed transcript. Tests and the preview harness.
3. **`OpenAiCompatibleModel`**: chat completions with tools and streaming against OpenRouter by default (base URL configurable). Key stored in `chrome.storage.local` under its own key, never in Dexie, never in "Clear local Nova data" exports, never logged. Network permission requested at opt-in through `optional_host_permissions`. Records `usage` per turn for the budget controls.
4. **`ChromeModel`**: Prompt API when `LanguageModel` is available. Tool use emulated with a JSON schema response constraint and one tool per round. Feature-detected, hidden otherwise.

### Storage

- New Dexie table `conversations` (`id, scope, createdAt, updatedAt`) holding messages and tool results. Retention 20 conversations per scope. Wiped by "Clear local Nova data".
- A preference `ai.persistConversations` (default on). Off means the thread lives in React state only, like session dismissals.
- Settings in `preferences`: `ai.provider`, `ai.model`, `ai.enabled`. The key itself is not a preference.

### UI (Field direction)

- Tab **Ask** after Changes. Field hero: "Ask Nova" headline, a freshness line ("Answers use data refreshed 4m ago"), and three suggested-question chips that change with the data (busiest day, most recent change, next move).
- Thread below: student bubbles right-aligned in the accent, Nova answers as plain text with tool result rows underneath reusing the existing task row and change row components, so an answer about deadlines looks like the Focus list.
- Composer pinned at the bottom: textarea, send, stop while streaming. Enter sends, Shift+Enter newline. `aria-live` on new answers.
- States: not enabled (opt-in card stating exactly what is sent where), no key, offline, rate limited, model error, empty data, demo mode banner ("answers describe fictional demo data").
- Settings dialog from the existing menu: provider, model, key paste with a test button and a remove button, persistence toggle.
- Design through the Impeccable flow: extend the surface brief with the Ask tab, run the finish reviewer, keep the detector at zero findings, update `DESIGN.md`.

## Delivery plan

Each step is one PR into `main`, `npm run check` green, then a release PR to `master` when a step is visible to students.

1. **Tools**: `packages/agent` tools, schemas, and unit tests over the demo fixtures. No UI.
2. **Loop and adapters**: `runTurn`, `ChatModel`, `IntentsModel`, `ScriptedModel`, tests with recorded transcripts.
3. **Ask tab**: UI with intents only, conversations table, settings without a provider, preview scenarios, screenshots. Useful and shippable on its own.
4. **OpenRouter adapter**: adapter, opt-in card, optional host permission, key storage, model picker, budget controls, privacy text in `PRODUCT.md` and README. Contract tests against recorded stream fixtures, no network in CI. Steps 1 to 3 do not need the OpenRouter access, so they proceed while it is pending.
5. **Study plan and calendar**: `build_study_plan` rendering and ICS download.
6. **Chrome on-device adapter**: feature-detected, behind a "Use on-device model" setting.

Step 4 is the only step that changes the privacy promise. Steps 1 to 3 keep everything on the device.

## Testing

- Every tool has unit tests over the demo tenant and the diff fixtures, including empty and partial-sync snapshots.
- The agent loop is tested with `ScriptedModel` for: single tool answer, multi-round, tool error, abort, max rounds.
- UI tests in jsdom cover states, keyboard, streaming, and that rendered rows match tool results exactly.
- The OpenRouter adapter is tested against recorded stream fixtures. A manual checklist covers a live call with the team key once access arrives.
- Honesty checks: an answer must not name an item that no tool returned. The loop rejects a final answer containing an item title absent from tool results in that turn and asks the model to correct it once.

## Open decisions

1. Default model on OpenRouter, and the daily token cap per install.
2. Persist conversations by default, or session-only by default.
3. Whether step 3 ships to `master` before step 4, or the tab stays hidden until a real model is in.
