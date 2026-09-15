# Ask Nova: plan for a chatbot over Brightspace data

Status: proposal. Nothing here is built yet.

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

## The one real decision: where the model runs

Today `PRODUCT.md` says "nothing is sent to a server or a model". A chatbot needs a model, so one of these gives:

| Option | Data leaves device? | Quality | Cost to student | Availability |
|---|---|---|---|---|
| A. Chrome built-in Prompt API (Gemini Nano, on-device) | No | Limited; no native tool use, JSON output via schema constraint | Free | Chrome 138+, Prompt API for extensions, several GB download, not on every machine |
| B. Bring your own Anthropic key, called directly from the extension | Yes, to Anthropic, only after explicit opt-in | High; native tool use, streaming | Student pays per use (Haiku 4.5 is cents per day) | Any Chrome 116+ |
| C. Our own backend holding a key | Yes, to us and to the provider | High | Free to student, hosting cost to us | Breaks the "no academic data to apps/api" rule |

**Recommendation: build for B first, keep A as a second adapter, never C.**

- B works everywhere today and gives real tool use.
- A is the right long-term default for a local-first product, so the model boundary is an adapter interface from day one and A slots in behind feature detection.
- Ask Nova stays fully useful without either: a deterministic intent matcher answers the common questions ("what's due tomorrow", "what changed in X") from the same tools, so a student with no key and no on-device model still gets grounded answers in demo and live mode.

The privacy statement changes from "nothing is sent to a model" to "nothing is sent to a model unless you turn Ask Nova on with your own key, and then only the normalized course data a question needs". That sentence goes in `PRODUCT.md`, the README, and the opt-in card.

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
3. **`AnthropicModel`**: Messages API with tools and streaming, called directly from the side panel with the browser-access header. Default model Claude Haiku 4.5, switchable to Sonnet 5 in settings. Key stored in `chrome.storage.local` under its own key, never in Dexie, never in "Clear local Nova data" exports, never logged, never sent anywhere but Anthropic. Network permission requested at opt-in through `optional_host_permissions` so students who never enable it never grant it.
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
4. **Anthropic BYOK**: adapter, opt-in card, optional host permission, key storage, privacy text in `PRODUCT.md` and README. Contract tests against recorded API responses, no network in CI.
5. **Study plan and calendar**: `build_study_plan` rendering and ICS download.
6. **Chrome on-device adapter**: feature-detected, behind a "Use on-device model" setting.

Step 4 is the only step that changes the privacy promise. Steps 1 to 3 keep everything on the device.

## Testing

- Every tool has unit tests over the demo tenant and the diff fixtures, including empty and partial-sync snapshots.
- The agent loop is tested with `ScriptedModel` for: single tool answer, multi-round, tool error, abort, max rounds.
- UI tests in jsdom cover states, keyboard, streaming, and that rendered rows match tool results exactly.
- The Anthropic adapter is tested against recorded stream fixtures. A manual checklist covers a live call with a real key.
- Honesty checks: an answer must not name an item that no tool returned. The loop rejects a final answer containing an item title absent from tool results in that turn and asks the model to correct it once.

## Open decisions

1. Provider order: Anthropic BYOK first (recommended), on-device first, or both in one step.
2. Persist conversations by default, or session-only by default.
3. Whether step 3 ships to `master` before step 4, or the tab stays hidden until a real model is in.
