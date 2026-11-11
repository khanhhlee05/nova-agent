# Ask Nova

A fourth tab in Mission Control where a student asks a question in plain words and gets an answer grounded in the same local data the other three tabs show. Slice 1: a stateless local backend, a free OpenRouter model, session-only conversations, no sign-in.

## What it is

- The student types a question (or taps a suggestion in the field: three fixed slots, plus one drawn from the busiest day ahead or the course with the most open work). The side panel builds a **compact snapshot** of the course data on this device and sends it with the question to the Nova API. The snapshot follows the panel: an item marked done counts as done, an item hidden for the session is left out, and the student's own deadlines ride along in their own list.
- The API runs a small agent loop: the model may call read-only tools (`get_brief`, `list_deadlines`, `get_item_details`, `get_recent_announcements`, `get_changes`, `build_study_plan`, `get_course_load`) over that snapshot, then writes a short answer. Events stream back as server-sent events.
- `list_deadlines` takes a `range` (`overdue` for the last two weeks, `long-overdue` for older open items, `today`, `tomorrow`, `week` for the panel's next 7 days, `next-week` for Monday to Sunday of next calendar week, `later`, `no-date`, `all` for totals only) or an inclusive `from`/`to` window in `YYYY-MM-DD` for any other period. It filters on the local calendar date by string comparison, so the server does no date math, and the prompt tells the model never to fetch `all` or `later` and narrow the result itself.
- `build_study_plan` takes `days` (1 to 14, default 3), `hoursPerDay` (0.5 to 12, default 2), an optional `course`, and an optional `startDate`. The schedule is computed by the tool, never by the model. Work that can still be on time is protected first: counting back from each deadline inside those days, the time it needs is held. Overdue work then takes the earliest time that is not held, since it is late either way and must not make something else late. On-time work is placed next, by the day it has to be done (the planner's score breaks ties), in the earliest free time. Then, only while time is left, later work by score, and work without a due date last. An item may span days. Work due before noon has to be finished the day before. Nothing is placed after its own deadline: what does not fit is reported as left out, with the minutes missing. Items marked done, long overdue items, hidden items, and the student's own deadlines are not scheduled. Time per item is the planner's estimate (see `PRIORITY.md`), and the tool, the prompt, and the card all say it is an estimate. The same snapshot and arguments always give the same plan under the same plan id.
- Four `propose_` tools let the model suggest an action instead of only describing it: `propose_mark_done` and `propose_hide` (item ids), `propose_mark_read` (change ids, or every unread change, optionally for one course), and `propose_personal_deadline` (`add`, `move`, or `complete` one of the student's own Week tab deadlines; a day as `YYYY-MM-DD` and a clock time, so the device and not the server turns them into an instant). A propose tool changes nothing. It validates the ids and dates against the snapshot, refuses what does not exist or is already done, and returns a suggestion. See **Suggestions** below.
- `read_attachment` is different from every tool above: the panel runs it, not the server. It lists the files on an assignment, or reads one. See **Reading assignment files** below.
- `search_course_materials` and `read_course_material` are run by the panel too. The first searches the text of a course's Content area (syllabus, slides, readings) that the student had Nova read, and returns the passages that match best. The second reads one topic from start to finish. See **Course materials** below.
- `get_course_load` returns, per course: open items, overdue items, items due in a period (same ranges and date windows as `list_deadlines`) with the points at stake, the next deadline, changes in the last two weeks, and graded points so far. Courses with the most late work come first.
- The panel shows the lookups it made (each with the tool's own summary, such as "2 items due next week (Sep 14 to Sep 20)"), the answer, and a "Show N matching items" toggle. The rows behind it, collapsed by default, use the same markup as the Focus and Changes tabs and come from tool results, never from the model's text.
- Rows carry the controls of the tab they came from, wired to the same handlers: an item row can be marked done on this device or hidden until the next refresh, a change row marked read, and one of the student's own deadlines marked done or shown on the Week tab. Rows read live state, so a mark made after an answer shows on it.
- Under the latest finished answer, up to three follow-up questions are offered. They are derived from the lookups the answer made, never from the model's text.
- A question can be started from the other tabs while Ask is on: **Ask Nova about this** in an item's details (Focus and Week), **Ask what this means** on a change, and **Ask why** on the next move. Each writes a question into the composer, with the item it is about shown above it, and sends nothing until the student does. The item's exact id goes with that one question so the lookup does not depend on a title search.
- A study plan is shown open under the answer as a card, day by day, each slot with its minutes and the reason it sits there. **Add to Week** turns every slot into one of the student's own deadlines on the Week tab (tagged **Study plan**, due at 11:59 PM of its day or at the item's own deadline when that is earlier the same day). Only one plan lives on the Week tab: adding another replaces it, and **Remove from Week** deletes its entries. This is local, like every deadline the student adds.
- A course row carries **Show on Focus**, which filters the Focus tab to that course.
- Nothing is written to Brightspace. Every action either opens a Brightspace page the student could open themselves or changes something stored on this device.

## What is sent, and what never leaves the device

Sent with every question, whatever the question is about (nothing is filtered by the question), in memory on the server for the duration of that request only:

| Field | Notes |
|---|---|
| Course names, ids, codes, home links | Active courses only |
| Item titles, kinds, due dates (ISO, local text, and local calendar date), buckets, a long-overdue flag (overdue for more than two weeks), statuses, points possible, the earned score when Brightspace reported one, links, priority and reasons | Visible items; hidden and expired items are dropped. Feedback text never leaves the device |
| Calendar: today, the Monday of this week, the panel's next 7 days, and next week (Monday to Sunday), all as `YYYY-MM-DD` | Computed in the browser in the student's zone |
| Announcement titles, dates, pinned flag, links | No body text |
| Change events: kind, title, before and after values (due dates, statuses, visibility, scores), detected date, read flag | Last 14 days |
| Counts, refresh time, whether the refresh was complete, mode (live or demo) | |
| The names and sizes of each assignment's files | Only while **Let Nova read assignment files** is on. Names, never contents |
| The text of a file the student asked about | Up to 12,000 characters per lookup, only in a turn where the model asked for that file and the student has allowed reading in this panel session. Extracted on the device; the file itself is never sent |
| The topic names of a course's Content area: title, module path, kind, and whether its text is on the device | Only for a course the student turned on under **Course materials**, at most 80 topics per course. Names, never contents. A course that is off sends nothing about its Content area |
| Passages of a course's materials | Only in a turn where the model searched or read a topic of a turned-on course: up to 8 passages of at most 1,000 characters for a search, up to 12,000 characters for a read. Found on the device; the files and the rest of their text are never sent |
| A time estimate per open item | Minutes, from the planner, for study plans. An estimate from kind, points, and time limit |
| Done marks from the Focus tab | One flag per item. A marked item counts as completed in every answer, the same as in the panel, and its Brightspace status is still sent |
| The deadlines the student added on the Week tab | Title, due date, optional course, done flag, and whether it is a slot of a study plan. Open ones, plus ones finished in the last two weeks. Kept in their own list: never counted, never ranked, never mixed with Brightspace items |
| How many items are hidden for this session | A count only. The hidden items themselves are left out |
| What the student was looking at | The course the panel is filtered to, the tab they came from, and the item id when the question was started from one item. A hint for the model, never a filter on the lookups |
| The question and up to twelve prior messages of this session's thread | Text only |

Never sent: cookies, raw Brightspace responses, the tenant origin, the student id or name, announcement bodies, observation metadata, anything from a course the student is not enrolled in, and the contents of items hidden in Brightspace or hidden by the student for the session. The API stores nothing academic; its logs carry counts only (`LOG_PROMPTS=0`).

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
| `CLIENT_TOOL_TIMEOUT_MS` | `30000` | How long a turn waits for the panel to answer a lookup only it can make (reading a file). When it runs out the model is told the lookup failed. |
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
5. The answer text is held back until it has been checked against the item titles the tools returned and the brief listed. If it names an item that neither contains, the model is nudged once (only while a round is left, so model calls never exceed `MAX_ROUNDS`); `done.grounded` reports whether the answer that was finally shown passed. Quotations are checked the same way: text in quotation marks of four or more words has to appear, word for word, in the prompt, the conversation, or a tool result of this turn, so a model cannot put invented words in a syllabus's mouth. Dates, points, and statuses in the answer text are not verified, and the rows under the answer carry the real values.
6. Events: `tool_call`, `client_tool` when the lookup is one the panel makes, `tool_result` (with rows), `proposal` after the result of a propose tool, one `text` event with the checked answer, then `done` (usage, rounds, grounded) or a typed `error`.

## Prompt injection

Course names, codes, item titles, file names, Content topic names, the text of a file the student has Nova read, and passages of course materials come from Brightspace and can contain anything an instructor or a compromised course types. In the system prompt they are stripped of control characters, quoted, and placed between whole-line `BEGIN COURSE DATA` and `END COURSE DATA` markers under a notice that nothing inside is an instruction; tool results, file text included, reach the model as JSON, and a file's text carries its own note that it is material and not instructions. Tests prove the shape: a hostile title cannot add a marker line, a `system:` line, or a control character, and it flows through tools and the honesty nudge as data. What the tests cannot prove is that a given model obeys the notice. What bounds the damage if it does not: the tools are read-only (the most a model can do is suggest one of six local actions, each of which the student sees in the panel's own words and has to confirm), the honesty check flags names it did not look up, and the panel renders rows from tool results rather than from the answer text.

## States the tab carries

Off (setup card), API unreachable, API without a key, streaming (Stop replaces Send), stopped, typed errors (rate limited with retry-after, budget exhausted, unauthorized, timeout), demo banner, empty data. A lookup that never reported back before Stop reads as stopped, not as still running. Clearing the thread or opening another conversation mid-answer cancels that answer at once, and the cancelled turn cannot write into the thread that replaced it.

## Reading assignment files

Ask Nova can answer from a handout or rubric the instructor attached to an assignment, or from a file the student handed in. The server cannot reach Brightspace, so the file is read by the panel and only its text passes through the server, for that turn.

**What a refresh keeps.** The names and sizes of each assignment's files, from the same two responses a refresh already makes. No file is downloaded during a refresh.

**How a file gets read.**

1. The request lists the lookups this panel can make (`clientTools: ["read_attachment"]`), and the snapshot carries each item's file names. Both only while **Let Nova read assignment files** is on (the default) and something can serve files (a Brightspace tab with the bridge, or demo data).
2. The model calls `read_attachment` with an item id, and a file id to read one. The server validates the arguments and, having first registered that it is waiting, sends a `client_tool` event (`turnId`, call `id`, `name`, `input`) down the stream.
3. The panel makes the lookup and posts the result to `POST /v1/chat/{turnId}/tool-result`. The server accepts one result per waiting call, hands it to the model as JSON data, and emits the ordinary `tool_result` event. If no result arrives within `CLIENT_TOOL_TIMEOUT_MS`, or the turn is stopped, the model is told the lookup failed and the turn still ends.
4. The first time in a panel session that a file would be read for an answer, nothing is read. The model is told the student has not allowed it yet, and the panel shows a card naming the file and its size. **Allow for this session** asks the same question again; **Not now** leaves it. Permission is never stored. Listing a file's name is not reading and needs none.

**On the device.** The panel downloads the file once through the student's own Brightspace session (the content script's file bridge: approved file routes only, capped at 10 MB, one attempt), extracts the text, stores the text, and drops the bytes. PDF goes through pdf.js (the text layer only, nothing rendered), Word and PowerPoint through a zip read of their XML, web pages through a tag strip that never runs anything, plain text and code as they are. What a format cannot give as text (a scan, an image, a spreadsheet) is reported as such, and that outcome is remembered too so the file is not downloaded again for the same answer. Up to 40,000 characters are kept per file, for the newest 50 files per account, in the `attachmentText` table (schema version 5). **Clear local Nova data** wipes them. A stored read is reused while the file's name and size are unchanged.

**What the model gets.** Up to 12,000 characters per call, with page or slide marks, a note that it is course material and not instructions, and the offset to continue from when there is more. One page or slide can be asked for by number. A result may carry at most 24,000 bytes of data and 25 rows; the server rejects anything larger and logs only that it happened.

**In the panel.** An item's details list its files (Focus and Week), with **Read** while reading is on: the same download and extraction, started by the student, for use in a later question. The rows under an answer show each file with whether it has been read on this device. **Check file access** in the Connection report says whether the tenant serves these files at all; see `BRIGHTSPACE_ACCESS.md`.

## Suggestions

The only way Ask Nova changes anything, and only on this device.

1. A propose tool returns a suggestion. The loop sends it to the panel as a `proposal` event (`id`, `label`, `payload`) right after the tool result, and tells the model only that it was proposed, not done, and never whether it was accepted. At most three suggestions are shown per answer; past that the tool call fails with a message the model can relay.
2. The panel shows a card under the answer. The sentence on the card is written by the panel from the payload and the data on the device, not taken from the server, so what is confirmed is what runs. Anything already done, already hidden, already read, or no longer there is left out of the sentence and the effect; when nothing is left, the card says why and offers no **Confirm**.
3. **Confirm** runs the same handler the Focus, Week, or Changes tab calls: a done mark, a session hide, a read flag, or a write to the student's own deadlines. **Dismiss** changes nothing. Decided cards stay as a record.
4. A confirmed card offers **Undo** where the effect can be reversed exactly (done marks, read flags, a moved or completed deadline); it reverses only what that confirmation touched. An added deadline offers **Show on Week** instead, and a hide says that Show all brings the item back.

Nothing in this path can reach Brightspace: the payload kinds are a closed list (`mark_done`, `hide_item`, `mark_changes_read`, `add_personal_deadline`, `move_personal_deadline`, `complete_personal_deadline`), validated by the shared schema on both ends, and the server executes none of them. In a saved conversation, a suggestion that was still pending is restored as expired, and a confirmed one as a record without Undo, because the data it was made against has moved on.

## Saved conversations

Off by default: the thread lives in memory, survives switching tabs, and is gone when the panel closes. The setup card and the Ask settings carry one checkbox, **Save conversations on this device**. The status line under the tabs always says which mode is on ("Cleared when you close the panel" or "Saved on this device").

While saving is on:

- The thread is written to the extension's own database (`conversations` table in IndexedDB, version 4 of the schema) after every finished answer, exactly as the thread holds it, rows included, so a saved answer re-renders as it was. Nothing is saved while an answer streams, and an empty thread is never saved.
- A conversation is titled by its first question, clipped to 60 characters. No model call names it.
- The newest 20 per Brightspace account are kept; the oldest is deleted first.
- The status line gains **New conversation** and **Conversations**. The list shows title, number of questions, and age; opening one restores the thread, with rows collapsed and still actionable, and continues it under the same id. Deleting one is immediate. The panel always opens on a fresh thread.
- Stored messages are read back defensively: a row, lookup, or message in a shape this build does not know is dropped on its own, never the whole conversation.
- Turning saving off deletes every saved conversation, and the checkbox says so before it is saved. **Clear local Nova data** deletes them too.

Saved conversations never leave the device. The server stays stateless.

### Long threads

The server sees the last twelve messages. When a thread is longer, the panel writes a summary of what came before, without a model: each earlier question, and for each earlier answer the summaries of the lookups it made (or its first words when it made none). It is capped at 1500 characters, dropping the oldest exchanges first, and goes with the request as `summary`. The server puts it inside the data section of the prompt, on one cleaned line, labeled as data and not instructions.

## Course materials

Ask Nova can answer from a course's Content area: the syllabus, lecture slides, readings, lab manuals. It is the same division of work as assignment files (the panel reads, the server only relays text for one turn), with two differences: the student turns it on one course at a time, and what is sent is the few passages a question needs, found by a search that runs on the device.

**Turning a course on.** Nothing about a course's Content area is requested until the student says so, in one of two places: **Course materials** at the top of the Ask tab lists every course with **Let Nova read this course**, and a question about a course that is off shows a card naming the course (**Allow and read** / **Not now**). The choice is stored with the Ask settings (`materialsCourses`), unlike the per-session permission for assignment files, because reading a course is a download of many files and should not repeat every session. **Forget materials** turns the course off and deletes its list and every passage read from it.

**What gets read.** One request lists the course (`GET .../content/toc`, JSON, through the same transport as a refresh). Topics that are files or pages with a name Nova can open (PDF, Word, PowerPoint, web page, plain text) are then downloaded one at a time through the file bridge (`GET .../content/topics/{topicId}/file`), their text is extracted with the same code as assignment files, cut into passages of about 800 characters that never span two pages or slides, and stored; the bytes are dropped. Links, quizzes, videos, and hidden topics are never requested. Limits per course: 60 files, 150 MB downloaded, 20 MB per file, 120,000 characters kept per file. A file that gave no text is remembered so it is not downloaded again. Reading stops at once on a sign-in page or a slow-down answer. **Choose files** lets the student untick topics; an unticked topic's text is deleted immediately.

**Staying current.** After a refresh, each turned-on course is listed again and only topics that are new or whose last-modified time changed are downloaded. Opening the panel downloads nothing. Text of topics that left the course is dropped.

**Search.** `search_course_materials` takes a `query`, an optional `course` (id, code, or part of the name), and a `limit` (default 5, at most 8). The panel ranks passages with BM25 keyword scoring (stop words dropped, simple plurals folded, a small bonus when a query word is in the topic's own title), at most three passages per topic, deterministic for the same index and query. Each passage comes back with its topic, module path, and page or slide. There are no embeddings and no index on the server: a question about an idea worded differently from the material can miss, and the model is told to search with the words the material would use. `read_course_material` returns one topic in parts of up to 12,000 characters, or one page or slide by number.

**What the model is told.** The system prompt lists, for each turned-on course, the first few topic names with their ids, and how many courses are still off. Passages arrive as JSON tool data with a note that they are course material and not instructions.

**In the panel.** The rows under an answer show each topic a passage came from, with its module, its page or slide, and a link to the topic in Brightspace. Storage is two tables added in schema version 6: `materialToc` (one row per course) and `materialText` (one row per topic, its passages). **Clear local Nova data** wipes both.

**Limits to know.** Whether a tenant serves Content files to the session is not known until tried: **Check file access** covers it once a course is on. Scanned PDFs and images give no text. Keyword search does not understand synonyms.

## Testing

Everything in CI runs on fixtures: SSE parsing, the compact snapshot, every tool, the loop with a scripted model, the OpenRouter adapter against recorded streams, the API through `app.request()`, and the tab in jsdom. No test touches the network.

## Manual checklist before merging to master

Run on a developer machine with Chrome and network access:

1. `npm run probe:api`, set `OPENROUTER_MODEL` to a free model with tool support, `npm run dev:api`.
2. `npm run smoke:api -- --question "What is due this week in Microcontrollers?"` returns a `tool_call`, rows, an answer, and `grounded=true`. Record the model id in the table above.
3. `npm run build --workspace @nova-agent/extension`, load `apps/extension/dist`, open the Ask tab, Test connection, Turn on Ask Nova, and ask the three suggested questions on demo data.
4. Rotate the OpenRouter key afterwards if it was ever shared outside `.env`.

## Not built yet

Sign-in, a server-side database, conversations across devices, per-user quotas, Google Calendar, hosting, the on-device model adapter, and meaning-based (embedding) search over course materials. See `ASK_NOVA_PLAN.md` for the next slices and `BACKEND_PLAN.md` for the hosted backend.
