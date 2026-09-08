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

## Collapsing sections

Each deadline section (Overdue, Today, Tomorrow, This week, Later, Completed) collapses on its own, and a **Collapse all** / **Expand all** control above the list does all six at once. Both are remembered between opens.

## Hiding things for a session

Every task row, week entry, change event, Next move card, and notice banner has a **Hide until next refresh** control. Hidden things leave every view at once, including the summary counts, the Next move card, the week agenda, and the unread badge. A bar under the tabs shows how many things are hidden and offers **Show all**.

Dismissals are deliberately not persisted:

- Closing the side panel forgets them.
- Pressing **Refresh**, or any automatic refresh that brings a new snapshot, restores everything.

This keeps the student in control of what they look at right now while guaranteeing the panel always returns to what Brightspace actually says.

## Preview harness

```bash
npm run dev:extension
```

Opens a Vite server at `http://localhost:5174/preview.html?scenario=ready`. Scenarios: `ready`, `changes`, `week`, `fixture`, `first-run`, `loading`, `partial`, `session-expired`, `stale`, `offline`, `permission-required`, `empty`. Add `&tab=focus|week|changes`, `&theme=light|dark`, and `&now=<ISO>` to pin the tab, theme, and clock.

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
