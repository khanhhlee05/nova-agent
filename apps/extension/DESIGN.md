---
name: Nova Mission Control
description: A Chrome side panel where one Villanova-blue field states what a student needs to know and a plain list follows.
colors:
  field-blue: "#1d5fd1"
  field-blue-dark: "#163f8f"
  field-ink: "#ffffff"
  field-muted: "#dfe9ff"
  field-chip: "rgba(255, 255, 255, 0.16)"
  field-rule: "rgba(255, 255, 255, 0.22)"
  accent: "#1d5fd1"
  accent-ink: "#ffffff"
  accent-soft: "#e3ecff"
  overdue-coral: "#c2281f"
  overdue-soft: "#fde8e6"
  today-amber: "#946000"
  today-soft: "#fff1cf"
  done-green: "#1f7a4d"
  done-soft: "#dcf3e6"
  ink: "#0f1420"
  muted: "#5a6272"
  faint: "#6a7383"
  rule: "#e9ecf1"
  rule-strong: "#d5dae3"
  bg: "#ffffff"
  surface: "#f3f5f9"
  surface-raised: "#ffffff"
  surface-hover: "#e9ecf1"
  course-0: "#1d5fd1"
  course-1: "#188a4f"
  course-2: "#c2591b"
  course-3: "#a3338a"
  course-4: "#0e7c86"
  course-5: "#6d4c9f"
  course-6: "#c02f5c"
  course-7: "#4b6a1f"
typography:
  display:
    fontFamily: "Hanken Grotesk, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Hanken Grotesk, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "Hanken Grotesk, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.45
  body:
    fontFamily: "Hanken Grotesk, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tabular-nums"
  label:
    fontFamily: "Hanken Grotesk, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
  caption:
    fontFamily: "Hanken Grotesk, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.45
  wordmark:
    fontFamily: "Hanken Grotesk, Helvetica Neue, Arial, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 800
    letterSpacing: "0.08em"
rounded:
  sm: "8px"
  md: "10px"
  pill: "9px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  gutter: "20px"
components:
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.surface}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-ghost-hover:
    backgroundColor: "{colors.accent-soft}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.overdue-coral}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  button-danger-hover:
    backgroundColor: "{colors.overdue-soft}"
  button-on-field:
    backgroundColor: "{colors.field-ink}"
    textColor: "{colors.field-blue}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "38px"
  button-sm:
    padding: "0 10px"
    height: "30px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    size: "36px"
  icon-button-hover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
  tab-trigger:
    backgroundColor: "transparent"
    textColor: "{colors.field-muted}"
    rounded: "8px 8px 0 0"
    padding: "0 14px"
    height: "38px"
  tab-trigger-active:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
  count-pill:
    backgroundColor: "{colors.field-ink}"
    textColor: "{colors.field-blue}"
    rounded: "{rounded.pill}"
    padding: "0 5px"
    height: "18px"
  select-trigger:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  overlay-surface:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "14px"
  menu-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "40px"
  tooltip:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bg}"
    rounded: "6px"
    padding: "5px 8px"
  banner:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  task-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "10px 0"
    height: "56px"
---

# Design System: Nova Mission Control

## Overview

**Creative North Star: "The Field"**

One Villanova-blue field owns the top of the panel and states, per tab, the single thing the student needs to know: a 26 px headline, one sentence, one white button, a counts strip. Everything beneath the field is a plain list on white, separated by hairlines, with course color reduced to an 8 px dot. The panel is 380 to 440 px wide and sits beside Brightspace in a lit room; it earns a ten-second glance and does not compete with the LMS.

The world is bright by default. Light is the composed scene and dark is a second composition with its own swatches (deeper field blue, near-black ground, lifted accent) rather than an inversion. Every semantic role has a value in both themes, chosen so text pairs pass WCAG AA on both grounds; the switch is a persisted preference applied as `data-theme` on the document root so portaled layers inherit it.

The build refuses the four-tile summary, the labeled next-move card, and decorated rows. Emphasis comes from weight (400 to 800 in one family) and from the three state hues reserved for overdue, today, and done, never from boxes, tints, or badges around list content.

**Key Characteristics:**
- One blue field at the top; plain hairline list below.
- Light default, separately composed dark; both AA.
- Hanken Grotesk only, weights 400 to 800, tabular numerals everywhere.
- Coral, amber, green appear only as overdue, today, done.
- Course identity is an 8 px dot painted from one of eight theme-aware slots.
- 8 px control radius, 10 px overlay radius, hairline rules.
- Flat in flow; the single shadow belongs to floating layers.

## Colors

Villanova blue as a solid field over a white or near-black ground, with three state hues held in reserve and everything else drawn in neutral ink.

### Primary
- **Field Blue** (`field-blue`, dark `#163f8f`): the field surface itself, text selection, the ink of on-field buttons and count pills. On the field, text is Field Ink (white) or Field Muted (pale blue); controls on the field use Field Chip (16% white) for hover and Field Rule (22% white) for hairlines.
- **Accent** (dark `#7aa7ff`, ink `#0b1a3a`, soft `#1a2a4d`): the same blue below the field, used for links, ghost buttons, the primary button, the progress bar, the active tab's count pill, the today label in the agenda, and info icons. Accent Soft is the ghost hover wash.

### Secondary
- **Overdue Coral** (dark `#ff8a80`, soft dark `#3a1c1a`): overdue section headings, overdue due-dates, the critical banner border, danger buttons and menu items.
- **Today Amber** (dark `#f2c14e`, soft dark `#3a2e10`): today section heading, today due-dates, in-progress status icon.
- **Done Green** (dark `#6fd39a`, soft dark `#173626`): done section heading, submitted or completed status icons, the "Submitted" label, success banners, the active state of a toggled icon button.

### Tertiary
- **Course slots 0 to 7**: a course keeps its slot and each theme paints the slot with a swatch tuned for that ground (dark: `#7aa7ff`, `#6fd39a`, `#f0a06c`, `#f28fd6`, `#5fd3dd`, `#b79cf0`, `#ff8fb0`, `#b8d96a`). Slots appear only as 8 px dots in rows, 5 px dots on the today pill of the week strip, and dots in the course filter.

### Neutral
- **Ink** (dark `#eef1f6`): primary text, tooltip ground.
- **Muted** (dark `#98a2b3`): secondary text, metadata, section counts, done titles, icon-button rest color.
- **Faint** (dark `#8b95a5`): chevrons, empty-state icons, strikethrough lines, arrows in diffs.
- **Rule** (dark `#232833`) and **Rule Strong** (dark `#323a49`): hairlines between rows and the borders of buttons, overlays, and dashed empty states.
- **Background** (dark `#0f1218`), **Surface** (dark `#1a1f29`), **Surface Raised** (dark `#161b24`), **Surface Hover** (dark `#232a37`): the page, the hover and inset wash, the floating-layer ground.

### Named Rules
**The Three Hues Rule.** Coral, amber, and green mean overdue, today, and done. They color a heading, a date, an icon, or a border; they never fill a row or a card, and they never appear for any other reason.
**The Composed Dark Rule.** Dark is not light inverted. Every role gets a second swatch chosen on the dark ground (field deepens to `#163f8f`, accent lifts to `#7aa7ff` with dark ink), and course slots are re-painted so all eight stay distinguishable.
**The Dot Rule.** Course color is an 8 px dot beside the course name and nothing else. No tinted rows, no colored borders, no course-colored text.

## Typography

**Display Font:** Hanken Grotesk (self-hosted variable, 400 to 800; fallback Helvetica Neue, Arial, system-ui)
**Body Font:** Hanken Grotesk (same file)
**Label/Mono Font:** none; numerals are tabular by default across the body

**Character:** one grotesk carrying the whole panel, from the 800-weight headline down to 12 px metadata. Hierarchy is weight and size, never a second family or uppercase tracking.

### Hierarchy
- **Display** (800, 26 px, 1.15, -0.02 em, balanced wrap): the field headline, one per tab; the item title on Focus, a computed sentence on Week and Changes.
- **Headline** (700, 15 px, 1.3): section triggers (Overdue, Today, Tomorrow, This week), feed-group labels, detail headings. Section headlines take the state hue.
- **Title** (600, 15 px; 14.5 px in agenda rows): task and event titles, single line with ellipsis.
- **Body** (400, 14 px, 1.45): the field sentence (max 60 ch), signal bodies, banner copy, first-run steps.
- **Label** (600, 13 px): hero meta line, tab labels (700 when active), select trigger, time column, disclosure links; counts strip numbers are 800 at 15 px.
- **Caption** (500, 12.5 px; 12 px in agenda and feed meta): row sub-lines, freshness, progress line, hidden bar; muted color.
- **Wordmark** (800, 16 px, 0.08 em): NOVA on the field, the only tracked text in the panel.

### Named Rules
**The One Face Rule.** Hanken Grotesk is the only family. Weight carries hierarchy; there is no display serif, no monospace label style, no system UI face.
**The Tabular Rule.** Numerals are tabular everywhere (`font-variant-numeric: tabular-nums` on body), so counts, dates, times, and scores align without a mono font.

## Layout

A single column, 320 px minimum, designed for 380 to 440 px. The field is sticky at the top (z-index 5) with 20 px side gutters and 12 px top padding; the field's own vertical rhythm is 16 px between blocks, and hairlines inside the field are 22% white. Tabs sit on the field's lower edge as one white tab (radius 8 px 8 px 0 0) that merges into the page. Content scrolls beneath with 12 px top and 20 px side padding, 32 px bottom; the filter row keeps the same 20 px gutter. At 360 px and under, every gutter drops to 16 px and the counts strip tightens from 18 px to 12 px gaps.

Spacing steps are 4, 8, 12, 16 (tokens) and a 20 px gutter. Lists are stacks of 56 px-minimum rows separated by 1 px hairlines, with no card padding; sections are separated by 4 px and section triggers are 44 px tall. The agenda is a two-column grid (56 px day label, fluid items) and event rows a three-column grid (68 px time, fluid title, icon). The signal feed is a three-column grid (32 px icon well, fluid body, aside). Detail panes use a 4 × 12 px definition grid.

## Elevation & Depth

Flat in flow, one shadow for layers that float. Depth on the page comes from the blue field against the white ground and from Surface (a cool light gray) as the hover and inset wash; rows and sections carry no background and no shadow. Menus, popovers, dialogs, the select list, and tooltips leave the plane and take the single shadow plus a Rule Strong border on a Surface Raised ground. In the light theme the theme switch's pressed thumb uses a 1 px lift so it reads as raised inside its track; on the field it drops the shadow and uses 92% white instead.

### Shadow Vocabulary
- **Floating layer** (`box-shadow: 0 6px 20px rgba(15, 20, 32, 0.12)`; dark `0 8px 24px rgba(0, 0, 0, 0.5)`): menus, popovers, dialogs, select content, tooltips.
- **Focus ring** (`box-shadow: 0 0 0 2px var(--nova-bg), 0 0 0 4px var(--nova-accent)`; on the field `0 0 0 2px var(--nova-field), 0 0 0 4px var(--nova-field-ink)`): every focus-visible control, with an 8 px radius.
- **Modal scrim** (`rgba(15, 20, 32, 0.45)`): behind dialogs.

### Named Rules
**The Floating-Only Rule.** Shadows belong to layers that leave the page (menus, popovers, dialogs, tooltips). Nothing in the scroll flow casts one.

## Shapes

Gently rounded controls (8 px) and slightly softer overlays (10 px), with hairline strokes. Buttons, icon buttons, select triggers, menu items, week-day pills, kind chips, skeletons, and focus rings share the 8 px radius; menus, popovers, dialogs, banners, and empty states take 10 px. Count pills are full-round (9 px on an 18 px height); course dots are 8 px circles; the progress bar is a 3 px line with 2 px corners; tooltips are the one 6 px corner. Borders are 1 px Rule or Rule Strong; empty states and the hidden-for-session bar use a 1 px dashed Rule Strong border. Tabs are the only asymmetric shape: 8 px on the top corners, square where they meet the page. The launcher orb on Brightspace pages is a 44 px circle.

## Components

### Buttons
Quiet, text-first, 36 px tall, 600 weight at 13.5 px, 6 px icon gap.
- **Shape:** gently rounded (8 px).
- **Secondary (default):** white ground, 1 px Rule Strong border, ink text; hover fills Surface.
- **Primary:** Accent fill, white text, no border; hover brightens 8%.
- **Ghost:** transparent, accent text; hover washes Accent Soft. The most common variant in the build (details, banners, first run).
- **Danger:** transparent with Rule Strong border and coral text; hover washes Overdue Soft.
- **On-field:** white fill, field-blue text, 38 px; hover dims 4%. One per field.
- **Small:** 30 px, 12.5 px, 10 px side padding.
- **Icon:** 36 px square (32 px small), transparent, muted glyph; hover Surface plus ink. On the field, Field Muted glyph, hover Field Chip. Active state (toggled) turns the glyph Done Green.
- **Focus:** two-ring focus shadow; disabled at 55% opacity.

### Chips
- **Count pill:** 18 px tall, white on field blue; on the active tab it flips to Accent on Accent Ink.
- **Kind chip:** a 32 px square holding a 16 px Lucide stroke icon (FileText for assignments, ListChecks for quizzes), muted; green when submitted or completed, amber when in progress.
- **Course dot:** 8 px circle painted from `var(--course-N)`.

### Cards / Containers
The build has no cards for list content. Containers exist only as banners and empty states.
- **Banner:** 10 px radius, 1 px Rule border, 10 px 12 px padding, 13.5 px text with a 700 lead and muted body; the leading 16 px icon takes Accent (info), Ink (warn), Coral (critical, which also colors the border), or Green (success).
- **Empty state:** dashed Rule Strong border, 10 px radius, centered muted text with an ink lead and a faint icon, 28 px 16 px padding.
- **Overlays:** Surface Raised ground, 1 px Rule Strong border, 10 px radius, floating shadow, 140 ms fade; menu 6 px inset with 40 px items, popover 14 px inset at min(340 px, viewport - 24), dialog 18 px inset at min(360 px, viewport - 32) over a 45% ink scrim.

### Inputs / Fields
The only field control is the course filter select.
- **Style:** 32 px trigger, white ground, 1 px Rule border, 8 px radius, 13 px at 600, chevron trailing.
- **List:** floating overlay, 36 px items with a course dot, highlighted item on Surface, checked item at 700.
- **Focus:** the shared two-ring focus shadow.

### Navigation
Three tabs (Focus, Week, Changes) on the field's lower edge, 38 px tall, 14 px at 600 in Field Muted; hover to Field Ink; the active tab is the page color with ink text at 700 and top-only 8 px corners so it reads as one white tab joining the list. Above the tabs, the field top row carries the wordmark, freshness (12.5 px, Field Muted, pulsing while syncing), the theme switch, refresh, and an overflow menu, all 32 px controls.

### The Field
The signature. Sticky blue block with a 26 px 800 headline (balanced wrap), a 13 px 600 meta line in Field Muted, a 14 px sentence at 60 ch, then an actions row with the one on-field button and a 13 px muted secondary text-button (priority score, unread count). Below a 22% white hairline sits either the counts strip (four 13 px labels with 15 px 800 numbers, 18 px apart) or, on Week, the seven-day strip. The hero settles in with a 180 ms ease-out rise of 4 px; the headline text is computed per tab (item title, week summary, change summary).

### Week Strip
Seven equal columns on the field, each a column of 11 px day name (Field Muted), 16 px 800 date, and up to four 5 px dots at 75% white. Today is a white pill (8 px radius) with field-blue text and dots painted in course slots.

### Rows
Task rows: 56 px minimum, 10 px vertical padding, hairline below, title 15 px 600 single-line, sub-line 12.5 px muted holding the course dot and name and a due label that takes coral (overdue, 600) or amber (today, 600). The aside holds the kind chip, hide, and expand icon buttons at 2 px gaps. Done rows strike the title through in muted. Expanding a row reveals details with a 160 ms slide-down. Event rows and signal rows follow the same hairline grammar with their own grids (see Layout); the signal icon well is a 32 px Surface square whose glyph takes Accent, Coral, Ink, or Green by event kind.

### Launcher Orb
Outside the panel, on Brightspace pages: a 44 px field-blue circle with a 14 px white core, a `0 6px 16px rgba(15,20,32,0.28)` shadow, a white 18 px count badge bordered in field blue, a 1 px lift on hover, and a white outline plus blue halo on focus. It is light-only (it sits on Brightspace's own page, not on the panel's ground) and pulses its core while syncing.

## Do's and Don'ts

### Do:
- **Do** open every tab with the field: a 26 px 800 headline, one sentence at 60 ch, one white on-field button, then a hairline and a strip.
- **Do** build lists as hairline-separated rows (1 px Rule, 56 px minimum) with no background, no border box, and no shadow.
- **Do** show course identity as an 8 px dot painted from `var(--course-N)` so both themes keep the slot distinguishable.
- **Do** give every semantic color a light and a dark value and verify text pairs at 4.5:1 on both grounds before adding a role.
- **Do** use Lucide stroke icons at 14 to 16 px, muted at rest, colored only by state.
- **Do** keep motion to the hero settle-in (180 ms), 140 to 160 ms fades and slides for layers and disclosures, and utility pulses; all of it turns off under `prefers-reduced-motion`.
- **Do** use the two-ring focus shadow on every interactive control, swapping to field-blue plus white when the control sits on the field.

### Don't:
- **Don't** wrap list items in cards, tinted rows, or colored left borders; the field is the only colored block on the page.
- **Don't** use coral, amber, or green for anything other than overdue, today, and done, and never as a fill behind text.
- **Don't** derive the dark theme by inverting light values; compose it with the paired swatches (field `#163f8f`, accent `#7aa7ff`, ground `#0f1218`).
- **Don't** add a second typeface, a monospace label style, or uppercase tracked labels; the wordmark is the only tracked text.
- **Don't** cast shadows on in-flow surfaces; the floating shadow belongs to menus, popovers, dialogs, and tooltips only.
- **Don't** summarize with tiles or a labeled "next move" card above the list; the field headline already is the summary.
