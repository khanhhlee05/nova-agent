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

Planned next: bounded agent tools, ICS export, study planning.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/BRIGHTSPACE_ACCESS.md](docs/BRIGHTSPACE_ACCESS.md) for the data flow and the authentication outcome.

## Branch and release model

- `main` is the integration branch. Pull requests and pushes run CI.
- `master` is the production branch. Merges to `master` deploy the public demo to GitHub Pages.

## Applications

- `apps/web`: public landing page and static Mission Control demo
- `apps/extension`: Chrome Manifest V3 extension (Nova Orb, side panel, local database). See [apps/extension/README.md](apps/extension/README.md).
- `apps/api`: future agent API scaffold

## Packages

- `packages/brightspace`: Brightspace routes, transports, client, normalization, and probe
- `packages/core`: canonical academic models, deadline buckets, snapshots, and semantic diff
- `packages/planner`: deterministic priority score and explanations
- `packages/agent`: bounded agent tool definitions

## Development

```bash
npm install
npm run dev              # public site
npm run dev:extension    # side panel preview harness
npm run check            # lint, typecheck, tests, build
```

Load the extension from `apps/extension/dist` after `npm run build`.

## Inspiration

- [Brightspace MCP Server](https://github.com/RohanMuppa/brightspace-mcp-server)
- [BetterCanvas task extension](https://github.com/UseBetterCanvas/canvas-task-extension)
- [D2L Developer Platform](https://docs.valence.desire2learn.com/)

## Status

First vertical slice. Live Brightspace access on the Villanova tenant is not yet verified; see [docs/BRIGHTSPACE_ACCESS.md](docs/BRIGHTSPACE_ACCESS.md). Demo mode works everywhere.
