# Nova Agent extension

Chrome Manifest V3 extension. Requires Chrome 116 or later.

## Build and load

```bash
npm install
npm run build --workspace @nova-agent/extension
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`. After pulling new code, run the build again and click the reload arrow on the extension's card; local data upgrades in place. The root README has the full local setup, including the preview harness (`npm run dev:extension`, then `http://127.0.0.1:5174/preview.html`) and the Ask Nova API.

- Visit `https://brightspace.villanova.edu` while signed in. A small Nova Orb appears bottom-right; click it (or the toolbar icon) to open Mission Control in the side panel.
- On first run choose **Connect to Brightspace** to run the read-only feasibility probe, or **Explore with demo data**.

## Look and themes

The panel follows the **Field** direction: one Villanova-blue field at the top carries the tab's single headline (the next move, the shape of the week, what changed), the counts, and the tabs; everything below is a plain list on white. A sun/moon switch in the field flips between the light theme (default) and a separately composed dark theme; the choice persists. Tokens live in `src/sidepanel/styles.css` as semantic custom properties (`--nova-ink`, `--nova-field`, `--nova-overdue`, course slots `--course-0..7`). Type is Hanken Grotesk, self-hosted from `public/fonts/`.

Design decisions were made with [Impeccable](https://impeccable.style): `PRODUCT.md` holds product truth, `apps/extension/.impeccable/surfaces/src-sidepanel.md` holds the direction contract, and `DESIGN.md` records the built system. Run the detector with `.claude/skills/impeccable/scripts/impeccable detect src` from this directory.

## Picking a day on the Week tab

The seven-day strip in the field is tappable. Selecting a day shows only what is due that day, with a headline for that day; tapping it again, or **Show all days**, returns to the whole week. Nothing selected is the default and shows every day.

## Looking further ahead

Arrows above the strip page the Week tab seven days at a time, forward only, in rolling pages from today (the first page is the same "next 7 days" the Focus count strip uses). The forward arrow stops at the page holding the latest due date Nova knows about, so there are no empty weeks to scroll through; **Today** returns to the first page. Paging clears a picked day. The headline is rewritten for the page it shows ("Two deadlines Nov 7 to Nov 13 · 1 week ahead"). The position is not persisted: the tab always opens on the current week.

## How "Do this first" is chosen

A deterministic score from six parts (urgency, stakes, weight, momentum, crunch, effort), each read from fields Brightspace already returns. The details panel explains it in words and shows every part against its maximum. The formula is in `docs/PRIORITY.md`.

## Focus: one category at a time

Under the field, a category control shows **Overdue**, **Upcoming**, or **Completed**, one at a time, each with its count. The panel opens on Overdue when anything is overdue and on Upcoming otherwise, then remembers whatever the student last picked. Upcoming groups rows under Today (always shown, even when empty), Tomorrow, Later this week, Later, and No due date. Each group heading folds its rows; **Collapse all** / **Expand all** above the groups does them all at once, and the folded set is remembered between opens. "Why this first?" unfolds the group that holds the item. A toolbar above the list holds the course filter and a sort control (**Due date**, **Course**, **Recently updated**); sorting by anything other than due date flattens the groups into one list, with no folding. Only the list scrolls; the field, the category control, and the toolbar stay put. Rows that appear in the current change feed carry a **Changed** mark. The category and sort are remembered between opens.

Overdue shows the last two weeks. Anything overdue for longer is **long overdue**: instructors often leave such items open for months without updating them. Long overdue items are not counted in the Overdue number, never become the next move, and stay folded behind a **Show N long overdue items** line at the bottom of the Overdue list (or inside its empty state) until the student asks; the reveal lasts for the session. They are ordinary rows once shown, so one can be marked done or opened. The threshold is the `LONG_OVERDUE_AFTER_DAYS` constant in `packages/core`.

## Marking something done on this device

Every open row has a checkbox. Checking it records a mark in local storage only: Brightspace is never written to. A marked item leaves Overdue and Upcoming, the counts, the next move, and the Week agenda's active entries, and appears under Completed labeled **Marked done by you**, with its real Brightspace status still shown. Unchecking removes the mark. The mark is deleted automatically as soon as a refresh reports the item as submitted or completed, or no longer lists it. Items Brightspace already reports as done show a checked, disabled box. When Ask Nova is on, a mark goes with each question as one flag on the item, so an answer treats the item as done the same way the panel does.

## Your own deadlines (Week tab only)

Tap a day in the strip, then **Add your own deadline** (in the field, or at the top of that day's agenda). The dialog asks for a name, a time (11:59 PM by default), and an optional course; the day is the one you tapped. Your deadlines show only on the Week tab: in the agenda with a pen icon and an **Added by you** tag, and in the strip as a hollow dot. They are never on the Focus tab, never counted, and never the next move. When Ask Nova is on, their title, date, course, and done flag go with each question in a list of their own, kept apart from Brightspace items. A study plan added from Ask Nova lands here as the same kind of entry, tagged **Study plan** instead of **Added by you**; adding another plan replaces it. Tapping one opens its details with **Mark done**, **Edit**, and **Delete** (with Undo). They live in their own table on this device, are never part of a snapshot, produce no change events, and Refresh cannot touch them. **Clear local data** removes them, and says so.

## Hiding things for a session

Every task row, week entry, Next move card, and notice banner has a **Hide until next refresh** control. Hidden things leave every view at once, including the summary counts, the Next move card, and the week agenda. A bar under the tabs shows how many things are hidden and offers **Show all**.

Dismissals are deliberately not persisted:

- Closing the side panel forgets them.
- Pressing **Refresh**, or any automatic refresh that brings a new snapshot, restores everything.

This keeps the student in control of what they look at right now while guaranteeing the panel always returns to what Brightspace actually says.

## Changes: read and delete

A change is a one-off notice, so it behaves differently from a task:

- **Mark as read** keeps the change in the feed for the rest of this session. On the next refresh, anything read before that refresh leaves the feed, so the tab really is "since your last visit". Mark it unread again before the refresh to keep it.
- **Delete** removes the change from local storage immediately and permanently. It does not come back on the next refresh. Change detection compares consecutive snapshots, so the same change can only reappear if it genuinely happens again in Brightspace.

The unread badge only ever counts unread changes, so neither action can leave a stale count behind.

## Ask tab

Ask Nova is off until the student turns it on in the tab. The setup card states what is sent (a compact copy of course data: titles, dates, statuses, links, the items marked done on this device, and the deadlines added by hand), where (the Nova server address, prefilled with the local default and editable under Change), and what never leaves the device (cookies, raw responses, announcement text, the student's name). Once on, the field offers three suggested questions and a fourth drawn from the data, the thread streams answers with the lookups Nova made, and matching rows render like Focus and Changes rows with the same controls: mark done on this device, hide until the next refresh, mark a change read. Follow-up questions appear under the latest answer. With **Let Nova read assignment files** on, an item's details list its files with **Read**, and a question about a handout or rubric is answered from the file's text after one permission card per session; the file is opened on this device and only the text a question needs is sent. **Course materials** at the top of the tab lets Nova read a course's Content area (syllabus, slides, readings), one course at a time: the files are downloaded through the student's Brightspace session, their text is kept on this device as passages, a keyword search on the device finds the passages a question needs, and only those are sent. A question about a course that is off asks first. **Choose files** unticks topics and **Forget materials** deletes everything read from a course. When Nova suggests an action (marking work done, hiding it, marking changes read, adding or moving one of your own deadlines), it appears as a card that does nothing until **Confirm** is pressed. **Ask Nova about this** in an item's details, **Ask what this means** on a change, and **Ask why** on the next move write a question into the composer. The answer appears as it is written; Stop replaces Send while it streams, and a draft that fails the check against the data is replaced in place. If the Nova server cannot answer (unreachable, no key, busy, out of budget), the questions the panel suggests are still answered on this device from the same data, with a note saying so. Each answer can be rated with a thumb; ratings stay on this device and **Export ratings** in the Ask settings saves them as a file. The status line shows the tokens of the last answer and the server's use for the day against its limit. In the field, Up recalls the last question, and a slash pressed anywhere in the panel goes to it. When the Nova server is a shared one that asks for it, and the build's manifest includes the `identity` permission (it does not by default), the Ask settings show **Sign in with Google**, the address signed in with and the student's use for the day, **Sign out**, and **Delete my account**; the sign-in is kept on this device and sent only to that server. A signed-in student who saves conversations can also keep them on that server, so they follow to another device; turning that off deletes the copies there. By default the conversation lives for the session only and survives switching tabs. With **Save conversations on this device** ticked in the setup card or the Ask settings, the newest 20 are kept in the extension's database, listed under **Conversations**, and deleted when the option is turned off or local data is cleared. See [docs/ASK_NOVA.md](../../docs/ASK_NOVA.md) for running the API.

## Preview harness

```bash
npm run dev:extension
```

Opens a Vite server at `http://localhost:5174/preview.html?scenario=ready`. Scenarios: `ready`, `changes`, `week`, `ask`, `fixture`, `first-run`, `loading`, `partial`, `session-expired`, `stale`, `offline`, `permission-required`, `empty`. Add `&tab=focus|week|changes|ask`, `&theme=light|dark`, and `&now=<ISO>` to pin the tab, theme, and clock. The `ask` scenario answers with an in-process scripted model; add `&api=http://localhost:8787` to talk to a running Nova API instead.

## Layout

```
public/manifest.json      MV3 manifest (sidePanel + storage, Villanova host only)
sidepanel.html            Side panel entry
src/background.ts         Service worker: opens the panel on the orb's user gesture
src/content.ts            Nova Orb (Shadow DOM) + whitelisted same-origin fetch bridge
src/messaging/            Typed message union and Zod bridge schemas
src/platform/             ExtensionHost boundary (Chrome implementation + stub)
src/storage/              Dexie database and repositories (single-transaction saves, retention)
src/sync/                 Sync state machine and coordinator
src/sidepanel/            React UI: Focus, Week, Changes, states, design tokens
dev/                      Preview harness (not shipped)
```
