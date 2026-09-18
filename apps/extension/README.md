# Nova Agent extension

Chrome Manifest V3 extension. Requires Chrome 116 or later.

## Build and load

```bash
npm install
npm run build --workspace @nova-agent/extension
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`.

- Visit `https://brightspace.villanova.edu` while signed in. A small Nova Orb appears bottom-right; click it (or the toolbar icon) to open Mission Control in the side panel.
- On first run choose **Connect to Brightspace** to run the read-only feasibility probe, or **Explore with demo data**.

## Look and themes

The panel follows the **Field** direction: one Villanova-blue field at the top carries the tab's single headline (the next move, the shape of the week, what changed), the counts, and the tabs; everything below is a plain list on white. A sun/moon switch in the field flips between the light theme (default) and a separately composed dark theme; the choice persists. Tokens live in `src/sidepanel/styles.css` as semantic custom properties (`--nova-ink`, `--nova-field`, `--nova-overdue`, course slots `--course-0..7`). Type is Hanken Grotesk, self-hosted from `public/fonts/`.

Design decisions were made with [Impeccable](https://impeccable.style): `PRODUCT.md` holds product truth, `apps/extension/.impeccable/surfaces/src-sidepanel.md` holds the direction contract, and `DESIGN.md` records the built system. Run the detector with `.claude/skills/impeccable/scripts/impeccable detect src` from this directory.

## Picking a day on the Week tab

The seven-day strip in the field is tappable. Selecting a day shows only what is due that day, with a headline for that day; tapping it again, or **Show all days**, returns to the whole week. Nothing selected is the default and shows every day.

## Collapsing sections

Each deadline section (Overdue, Today, Tomorrow, This week, Later, Completed) collapses on its own, and a **Collapse all** / **Expand all** control above the list does all six at once. Both are remembered between opens.

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

Ask Nova is off until the student turns it on in the tab. The setup card states what is sent (a compact copy of course data: titles, dates, statuses, links), where (the Nova API address the student enters), and what never leaves the device (cookies, raw responses, announcement text, the student's name). Once on, the field offers three suggested questions, the thread streams answers with the lookups Nova made, and matching rows render like Focus and Changes rows. Stop replaces Send while an answer streams. The conversation lives for the session only and survives switching tabs. See [docs/ASK_NOVA.md](../../docs/ASK_NOVA.md) for running the API.

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
