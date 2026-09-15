# Mission Control UI revamp: Field

Implementation plan for the side panel redesign chosen through Impeccable's direction round. Product truth lives in `PRODUCT.md`; the direction contract lives in `apps/extension/.impeccable/surfaces/src-sidepanel.md`. This document is the build sequence.

## Goal

Replace the panel's visual world (dark navy, cards, rails, rings, glows) with **Field**: one Villanova-blue field at the top of the panel that states, per tab, the single thing the student needs to know, over plain lists in a bright default theme with a composed dark theme the student can switch to.

Everything that is not visual stays exactly as it is: sync, storage, change detection, priority, session dismissals, keyboard and screen-reader behavior, the message protocol, and tests of behavior.

## Non-goals

- No new features. Same three tabs, same states, same actions.
- No design-system library or Tailwind. Plain CSS custom properties, Radix primitives, Lucide icons, as today.
- No change to `apps/web` in this branch (a follow-up can reuse the tokens).

## Design decisions (from the contract)

| Decision | Value |
|---|---|
| Color strategy | Committed: the blue field owns the top third; the rest is white or near-black with black or white type. Blue appears nowhere else except links and the unread mark. |
| Light theme | `--bg #ffffff`, `--ink #0f1420`, `--muted #5a6272`, `--rule #e9ecf1`, `--field #1d5fd1`, `--field-ink #ffffff`, `--field-muted #dfe9ff`, `--chip #f3f5f9` |
| Dark theme | `--bg #0f1218`, `--ink #eef1f6`, `--muted #98a2b3`, `--rule #232833`, `--field #163f8f`, `--field-ink #ffffff`, `--field-muted #c7d8ff`, `--chip #1a1f29` |
| Semantic | overdue `#c2281f` / `#ff8a80`, today `#946000` / `#f2c14e`, done `#1f7a4d` / `#6fd39a`; course colors as 8 px dots, one hue set per theme |
| Type | Hanken Grotesk 400/500/600/700/800, self-hosted; fixed rem scale 12.5, 13, 14, 15, 26; tabular numerals for times and counts |
| Shape | 8 px radii on controls, 1 px hairline rules between rows, no card-in-card, no colored edges, no rings, no gradients, no glow |
| Tabs | Sit on the field's lower edge; the active tab is a white tab merging into the list area |
| Motion | One authored moment: the field's headline crossfades on tab change and after a refresh (180 ms, ease-out). Everything else instant. Reduced motion disables it. |
| Theme switch | Sun/moon segmented control in the field's top row. Persisted preference `theme: "light" \| "dark"`. Light is the default per the use scene. |

Contrast targets (verified during the build with computed values): every text pair 4.5:1 or better, controls and icons 3:1 or better, in both themes.

## Workstreams

### 1. Tokens and theme switch
- `styles.css`: replace the `:root` block with semantic roles for light, a `[data-theme="dark"]` block for dark. Delete the old `--nova-*` names once nothing references them.
- `MissionControl.tsx` / `App.tsx`: `theme` joins `UiPreferences`; the root element carries `data-theme`; `color-scheme` follows it.
- Theme browser surfaces: `::selection`, focus ring, caret, scrollbar colors from the palette.
- Tests: theme preference persists and the root attribute follows it.

### 2. Type
- Self-host Hanken Grotesk (OFL) as woff2 under `apps/extension/public/fonts/`, `@font-face` with `font-display: swap` and a metric-compatible fallback stack.
- Apply the fixed scale; tabular numerals on times, counts, and scores.

### 3. Focus tab
- New `FieldHeader` component: top row (wordmark, freshness, theme switch, refresh, menu), a hero slot, the counts strip, and the tab row.
- Focus hero: "Do this first · Course", 26 px headline, one plain-language sentence built from the existing reasons, white primary button, priority number with "why?".
- Summary chips become the counts strip inside the field. Next move card is removed; its "why this score" expands the row in the list as today.
- Deadline sections become plain lists with hairline rules; course dot, title, course · time; kind icon in a chip; hide and expand controls unchanged in behavior.

### 4. Week tab
- Hero: week range, a headline derived from the data ("Eight deadlines, Thursday is the crunch" is computed: busiest day and count), a seven-day strip with today as a white pill and course dots.
- Agenda: day label column, time column, title, course dot; submitted items struck through with a green "Submitted"; empty days say so in a sentence.
- Popover details keep the current content in the new styling.

### 5. Changes tab
- Hero: "Since your last visit · N ago", a headline summarizing the batch (moved / added / submitted / posted counts), "Mark all read" as the white button, unread count.
- Signal rows: icon chip, verb · course, body with old → new values, "Detected … · Open", read toggle, hide. Unread is a bold verb and a blue dot, never an edge.

### 6. States, banners, menu, orb
- Banners lose colored edges and tinted gradients; tone comes from the icon and a single-word lead. Dismiss stays.
- First-run, skeleton, empty, stale, partial, offline, expired, permission, demo, hidden bar: re-styled in the world, same copy and controls.
- Menu, dialogs, tooltips, select: restyled to the same radii and rules.
- Nova Orb (content script): flat blue disc with a white core and a plain badge, no glow.

### 7. Verification and finish
- `npm run check` (lint, typecheck, tests, build).
- `impeccable detect --json apps/extension/src` with zero findings, or each remaining one explained.
- Screenshots of every state in both themes into `docs/screenshots/` via the preview harness.
- Impeccable finish review (its reviewer agent) against the direction contract; fix batch; one confirmation round.
- Impeccable documenter writes `DESIGN.md` from the built world.
- Pull request into `main` with before/after screenshots.

## Sequence and commits

1. `feat(extension): semantic theme tokens and light/dark switch`
2. `feat(extension): self-hosted Hanken Grotesk and type scale`
3. `feat(extension): Field header and Focus tab`
4. `feat(extension): Week tab in Field`
5. `feat(extension): Changes tab in Field`
6. `feat(extension): states, banners, menu, and orb in Field`
7. `docs: screenshots, DESIGN.md, and revamp notes`

Each step keeps `npm run check` green. Steps 3 to 5 are the bulk of the work.

## Decisions taken

- **Font hosting**: Hanken Grotesk is self-hosted (latin subset, variable 400 to 800, 35 KB woff2) with a metric-friendly fallback stack.
- **Scope**: the orb is restyled in this branch; `apps/web` is left for a follow-up.
- **Kicker rule**: the mockup's "Do this first · Course" line above the headline was a kicker, which Impeccable bans; in the build it sits below the headline as a meta line.

## Status

All seven steps are implemented on `feature/revamp-ui`. The Impeccable detector reports zero findings over `apps/extension/src`; the finish review ran two rounds (eight material fixes, then three regressions) and closed with a ship disposition on the scored items; `apps/extension/DESIGN.md` records the built system; screenshots of every state in both themes live in `docs/screenshots/`.

## Risks

- Vertical space: the field is tall. Mitigation: the hero collapses to headline-only when the list is scrolled (a later polish step if needed, not in the first cut).
- Course colors need two sets (light and dark) that stay distinguishable; verify with the four demo courses plus four more.
- Tests assert copy and roles; some labels change ("Next move" heading becomes the field headline). Update tests alongside each step, never after.
