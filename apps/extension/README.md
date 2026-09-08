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

## Preview harness

```bash
npm run dev:extension
```

Opens a Vite server at `http://localhost:5174/preview.html?scenario=ready`. Scenarios: `ready`, `changes`, `week`, `fixture`, `first-run`, `loading`, `partial`, `session-expired`, `stale`, `offline`, `permission-required`, `empty`. Add `&tab=focus|week|changes` and `&now=<ISO>` to pin the tab and clock.

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
