# Nova Agent

> An unofficial academic assistant for Villanova students.

Nova Agent is a Chrome extension and academic planning system built on top of D2L Brightspace. It helps students answer:

1. What changed?
2. What matters next?
3. What should I do about it?

## MVP

Implemented in the first vertical slice (features A–D):

- **Brightspace connection**: allowlisted read-only routes, version discovery, pagination, bounded retries, rate limiting, session detection, Zod validation, and a feasibility probe. Fixture mode is always available and clearly labeled.
- **Mission Control**: Chrome side panel with Focus, Week, and Changes tabs, launched from a Nova Orb injected into Brightspace.
- **Since Your Last Visit**: local snapshots and a semantic diff that avoids false positives and duplicate events.
- **Priority engine**: deterministic, explainable scoring in `packages/planner`.
- **Ask Nova**: a chat tab over the same data, answered by a small Node API that calls an OpenRouter model with read-only tools. It honors done marks and personal deadlines, builds study plans, suggests local actions that wait for a confirmation, can save conversations on the device, and can read assignment files and a course's Content area on the device when the student allows it. Off until the student turns it on. See [docs/ASK_NOVA.md](docs/ASK_NOVA.md).

Ask Nova also streams its answers, checks dates, points, and quotations against the data, and answers its own suggested questions on the device when the server cannot. The API can also run for a class instead of one person: with `AUTH_MODE=google` students sign in with Google and use is counted per student (see **Hosted mode** in [docs/ASK_NOVA.md](docs/ASK_NOVA.md)). Saved conversations can follow a signed-in student to another device when they choose that. Not built: Google Calendar sync and a live deployment. See [docs/ASK_NOVA_PLAN.md](docs/ASK_NOVA_PLAN.md) and [docs/BACKEND_PLAN.md](docs/BACKEND_PLAN.md). 

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/BRIGHTSPACE_ACCESS.md](docs/BRIGHTSPACE_ACCESS.md) for the data flow and the authentication outcome. The privacy policy is in [PRIVACY.md](PRIVACY.md).

## Branch and release model

- `main` is the integration branch. Pull requests and pushes run CI.
- `master` is the production branch. Merges to `master` deploy the public demo to GitHub Pages.

## Applications

- `apps/web`: public landing page and static Mission Control demo
- `apps/extension`: Chrome Manifest V3 extension (Nova Orb, side panel, local database). See [apps/extension/README.md](apps/extension/README.md).
- `apps/api`: Node + Hono chat API for Ask Nova. Holds the model key, stores nothing.

## Packages

- `packages/brightspace`: Brightspace routes, transports, client, normalization, and probe
- `packages/core`: canonical academic models, deadline buckets, snapshots, and semantic diff
- `packages/planner`: deterministic priority score and explanations
- `packages/agent`: compact snapshot, read-only tools, the agent loop, and model adapters
- `packages/protocol`: Zod schemas shared by the extension and the API (compact snapshot, chat request, events, SSE parser)

## Run it locally

Requirements: Node 22 or later, npm, and Chrome 116 or later.

```bash
git clone https://github.com/khanhhlee05/nova-agent.git
cd nova-agent
npm install
```

### 1. Try the side panel in a browser tab (no Chrome setup)

```bash
npm run dev:extension
```

Open `http://127.0.0.1:5174/preview.html?scenario=ready&tab=focus`. This preview harness renders the real side panel against fictional demo data with a stub host, so nothing touches Brightspace. Useful query parameters: `scenario=ready|changes|week|ask|empty|stale|offline|session-expired`, `tab=focus|week|changes|ask`, `theme=dark`, `mode=demo`.

### 2. Install the extension in Chrome

Build it:

```bash
npm run build --workspace @nova-agent/extension
```

Then load it:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `apps/extension/dist` folder.
4. Pin Nova Agent in the toolbar.

Open any page on `https://brightspace.villanova.edu` while signed in. A small Nova Orb appears bottom-right; click it (or the toolbar icon) to open Mission Control in the side panel. On first run choose **Explore with demo data** to look around, or **Connect to Brightspace** to run the read-only feasibility probe against your own courses.

After pulling new code, rebuild with the same command, then click the reload arrow on the Nova Agent card in `chrome://extensions` and reopen the side panel. Local data (snapshots, done marks, your own deadlines) upgrades in place. If anything looks stale, use the panel menu's **Clear local data** and pick a data source again.

To share a build without the Chrome Web Store, zip `apps/extension/dist`; the recipient unzips it and loads it the same way.

### 3. Ask Nova (optional)

The Ask tab needs the small API running on this machine and an OpenRouter key.

```bash
cp apps/api/.env.example apps/api/.env   # then put your key in OPENROUTER_API_KEY
npm run dev:api                          # listens on 127.0.0.1:8787
```

In the panel, open the Ask tab, read the statement of what is sent, and turn it on. Keep the extension and the API on the same commit so they agree on the snapshot format. Details, environment variables, and a manual checklist are in [docs/ASK_NOVA.md](docs/ASK_NOVA.md).

### 4. Checks

```bash
npm run check            # lint, typecheck, tests, build
npm test                 # tests only
npm run dev              # public landing page (apps/web)
```

## Inspiration

- [Brightspace MCP Server](https://github.com/RohanMuppa/brightspace-mcp-server)
- [BetterCanvas task extension](https://github.com/UseBetterCanvas/canvas-task-extension)
- [D2L Developer Platform](https://docs.valence.desire2learn.com/)

## Status

First vertical slice plus Ask Nova slice 1. Live Brightspace access on the Villanova tenant is not yet verified; see [docs/BRIGHTSPACE_ACCESS.md](docs/BRIGHTSPACE_ACCESS.md). Demo mode works everywhere. Nothing leaves the device unless Ask Nova is turned on. Once it is on, every question sends a compact copy of the course data on the device (course names, item titles, due dates, statuses, announcement titles, links) to the Nova API, which forwards it to the model provider and keeps it in memory for that request only.
