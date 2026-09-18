# Ask Nova

A fourth tab in Mission Control where a student asks a question in plain words and gets an answer grounded in the same local data the other three tabs show. Slice 1: a stateless local backend, a free OpenRouter model, session-only conversations, no sign-in.

## What it is

- The student types a question (or taps a suggestion in the field). The side panel builds a **compact snapshot** of the course data on this device and sends it with the question to the Nova API.
- The API runs a small agent loop: the model may call read-only tools (`get_brief`, `list_deadlines`, `get_item_details`, `get_recent_announcements`, `get_changes`) over that snapshot, then writes a short answer. Events stream back as server-sent events.
- `list_deadlines` takes a `range` (`overdue`, `today`, `tomorrow`, `week` for the panel's next 7 days, `next-week` for Monday to Sunday of next calendar week, `later`, `no-date`, `all` for totals only) or an inclusive `from`/`to` window in `YYYY-MM-DD` for any other period. It filters on the local calendar date by string comparison, so the server does no date math, and the prompt tells the model never to fetch `all` or `later` and narrow the result itself.
- The panel shows the lookups it made (each with the tool's own summary, such as "2 items due next week (Sep 14 to Sep 20)"), the answer, and a "Show N matching items" toggle. The rows behind it, collapsed by default, use the same markup as the Focus and Changes tabs and come from tool results, never from the model's text.
- Nothing is written to Brightspace. The only actions are opening a Brightspace page the student could open themselves.

## What is sent, and what never leaves the device

Sent with every question, whatever the question is about (nothing is filtered by the question), in memory on the server for the duration of that request only:

| Field | Notes |
|---|---|
| Course names, ids, codes, home links | Active courses only |
| Item titles, kinds, due dates (ISO, local text, and local calendar date), buckets, statuses, points, links, priority and reasons | Visible items; hidden and expired items are dropped |
| Calendar: today, the Monday of this week, the panel's next 7 days, and next week (Monday to Sunday), all as `YYYY-MM-DD` | Computed in the browser in the student's zone |
| Announcement titles, dates, pinned flag, links | No body text |
| Change events: kind, title, before and after values, detected date, read flag | Last 14 days |
| Counts, refresh time, whether the refresh was complete, mode (live or demo) | |
| The question and up to twelve prior messages of this session's thread | Text only |

Never sent: cookies, raw Brightspace responses, the tenant origin, the student id or name, announcement bodies, observation metadata, anything from a course the student is not enrolled in. The API stores nothing academic; its logs carry counts only (`LOG_PROMPTS=0`).

Ask Nova is off until the student turns it on in the tab, after reading the same statement there.

## Run it locally

```bash
cp apps/api/.env.example apps/api/.env      # then put the OpenRouter key in OPENROUTER_API_KEY
npm run probe:api                            # lists free models with tool support; pick one for OPENROUTER_MODEL
npm run dev:api                              # http://localhost:8787, prints {"event":"api.listening",...}
```

Then either:

- **Preview harness**: `npm run dev:extension`, open `http://localhost:5174/preview.html?scenario=ask&mode=demo&api=http://localhost:8787`. Without `&api=` the Ask tab uses an in-process scripted model and no network.
- **The extension**: `npm run build --workspace @nova-agent/extension`, load `apps/extension/dist`, open the Ask tab, keep `http://localhost:8787` as the address, press **Test connection**, then **Turn on Ask Nova**.

Smoke test from the terminal (sends the demo snapshot):

```bash
npm run smoke:api -- --question "What is due this week in Microcontrollers?"
npm run smoke:api -- --direct        # runs the loop in-process, no server
npm run smoke:api -- --api http://127.0.0.1:8787 --token <NOVA_DEV_TOKEN>   # explicit address and token
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | | Required for answers. Without it `/v1/chat` answers 503 `not_configured`. |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct:free` | Any OpenAI-compatible model id on OpenRouter. Free ids change; use the probe. |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint works. |
| `PORT` | `8787` | |
| `HOST` | `127.0.0.1` | Bind address. Loopback keeps the key reachable only from this machine. Any other value refuses to start unless `NOVA_DEV_TOKEN` is set, because CORS is not authentication and anyone who can reach `/v1/chat` can spend the key. |
| `CORS_ORIGINS` | `chrome-extension://*,http://localhost:5174` | Exact origins, or a prefix ending in `*` for development. Use the exact extension id in production. |
| `NOVA_DEV_TOKEN` | | Optional bearer token for `/v1/*`. Paste the same value into the tab's settings. |
| `MAX_TOKENS` | `700` | Per model call. |
| `MAX_ROUNDS` | `4` | Tool rounds before the model is forced to answer. |
| `REQUEST_TIMEOUT_MS` | `60000` | |
| `DAILY_TOKEN_CAP` | `200000` | Tokens per UTC day for the whole server, counted in memory per process: it resets on restart and is not shared between instances (best effort). Each request reserves `TURN_TOKEN_ESTIMATE` up front and answers 429 `budget_exhausted` at once if that would pass the cap, then settles to the real usage when the turn ends. A turn with no usage report is charged `MAX_TOKENS × rounds`. `0` disables the cap. |
| `TURN_TOKEN_ESTIMATE` | `MAX_TOKENS × MAX_ROUNDS` (2800) | Worst-case tokens reserved per request. A cap below this refuses to start. |
| `LOG_PROMPTS` | `0` | `1` adds question and answer text to the turn log. |

`apps/api/.env` is gitignored. The key must never be committed, logged, or built into the extension.

## Free models

OpenRouter's free tier is rate limited (roughly 20 requests per minute and a small daily allowance without credits) and some free endpoints route to providers whose data policy allows training on prompts. Prefer demo data with free models. The probe filters for `tools` support; models without it answer from the brief in the system prompt but cannot look anything up.

Record here which ids worked once the live test runs:

| Model id | Date | Tool calls | Notes |
|---|---|---|---|
| (pending) | | | |

## How a turn works

1. `compactSnapshot` (`packages/agent`) runs in the browser: buckets, local dates, days-ago, and the calendar ranges (today, the next 7 days, next week) follow the student's time zone, so the server never does date math. The system prompt states those ranges with their weekdays.
2. `POST /v1/chat` validates the body (`packages/protocol`), reserves the turn's worst-case tokens against the daily cap, and starts the loop (`runTurn`); the reservation is settled to real usage when the turn ends.
3. The system prompt carries the date, the courses, counts, and a brief (next move, overdue, today, upcoming), so a weak model still answers from real facts. Tools cover everything deeper.
4. Up to `MAX_ROUNDS` rounds: tool calls run over the snapshot, results go back to the model. The last round forces a text answer.
5. The answer text is held back until it has been checked against the item titles the tools returned and the brief listed. If it names an item that neither contains, the model is nudged once (only while a round is left, so model calls never exceed `MAX_ROUNDS`); `done.grounded` reports whether the answer that was finally shown passed. The check is title-level: dates, points, and statuses in the answer text are not verified, and the rows under the answer carry the real values.
6. Events: `tool_call`, `tool_result` (with rows), one `text` event with the checked answer, then `done` (usage, rounds, grounded) or a typed `error`.

## Prompt injection

Course names, codes, and item titles come from Brightspace and can contain anything an instructor or a compromised course types. In the system prompt they are stripped of control characters, quoted, and placed between whole-line `BEGIN COURSE DATA` and `END COURSE DATA` markers under a notice that nothing inside is an instruction; tool results reach the model as JSON. Tests prove the shape: a hostile title cannot add a marker line, a `system:` line, or a control character, and it flows through tools and the honesty nudge as data. What the tests cannot prove is that a given model obeys the notice. What bounds the damage if it does not: the tools are read-only (the model cannot act on anything), the honesty check flags names it did not look up, and the panel renders rows from tool results rather than from the answer text.

## States the tab carries

Off (setup card), API unreachable, API without a key, streaming (Stop replaces Send), stopped, typed errors (rate limited with retry-after, budget exhausted, unauthorized, timeout), demo banner, empty data. The thread is session-only and survives switching tabs, not closing the panel.

## Testing

Everything in CI runs on fixtures: SSE parsing, the compact snapshot, every tool, the loop with a scripted model, the OpenRouter adapter against recorded streams, the API through `app.request()`, and the tab in jsdom. No test touches the network.

## Manual checklist before merging to master

Run on a developer machine with Chrome and network access:

1. `npm run probe:api`, set `OPENROUTER_MODEL` to a free model with tool support, `npm run dev:api`.
2. `npm run smoke:api -- --question "What is due this week in Microcontrollers?"` returns a `tool_call`, rows, an answer, and `grounded=true`. Record the model id in the table above.
3. `npm run build --workspace @nova-agent/extension`, load `apps/extension/dist`, open the Ask tab, Test connection, Turn on Ask Nova, and ask the three suggested questions on demo data.
4. Rotate the OpenRouter key afterwards if it was ever shared outside `.env`.

## Not in slice 1

Sign-in, a database, saved conversations, per-user quotas, Google Calendar, the no-model intent matcher as an offline fallback, hosting, and the on-device model adapter. See `BACKEND_PLAN.md`.
