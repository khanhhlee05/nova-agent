# Nova Agent

> An unofficial academic assistant for Villanova students.

Nova Agent is a Chrome extension and academic planning system built on top of D2L Brightspace. It helps students answer:

1. What changed?
2. What matters next?
3. What should I do about it?

## MVP

- Mission Control dashboard
- "Since Your Last Visit" change feed
- Assignments, quizzes, and announcements
- Deterministic priority and study planning
- Bounded agent tools
- Local-first browser-session authentication
- ICS calendar export

## Repository model

- `main` is the integration branch. Pull requests and pushes run CI.
- `master` is the production branch. Merges to `master` deploy the public demo to GitHub Pages.

## Applications

- `apps/web`: public landing page and static Mission Control demo
- `apps/extension`: Chrome Manifest V3 extension scaffold
- `apps/api`: future agent API scaffold

## Packages

- `packages/brightspace`: Brightspace client and data access
- `packages/core`: normalized academic models and snapshot logic
- `packages/planner`: deterministic prioritization and scheduling
- `packages/agent`: bounded agent tool definitions

## Development

```bash
npm install
npm run dev
npm run check
```

The initial smoke test intentionally always passes while the project foundation is being established.

## Inspiration

- [Brightspace MCP Server](https://github.com/RohanMuppa/brightspace-mcp-server)
- [BetterCanvas task extension](https://github.com/UseBetterCanvas/canvas-task-extension)
- [D2L Developer Platform](https://docs.valence.desire2learn.com/)

## Status

Early MVP scaffolding. Do not use with real student data yet.
