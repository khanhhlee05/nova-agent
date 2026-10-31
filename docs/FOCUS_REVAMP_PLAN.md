# Focus tab revamp: categories, one list, local done marks

Design and build plan for replacing the six collapsible deadline sections on the Focus tab with three categories over one scrollable list. Product truth stays in `PRODUCT.md`; the visual world stays Field (`docs/UI_REVAMP_PLAN.md`, `apps/extension/DESIGN.md`).

## Problem

The Focus tab stacked six collapsibles (Overdue, Today, Tomorrow, Later this week, Later with a No date subgroup, Completed). All six headers rendered even when empty, a heavy week ran to 20 or more rows inside two of them, every row carried three always-visible controls, the priority ranking was computed for every item but used only by the hero, and the student had to manage collapse state by hand.

## Principle

Pinned header and controls, one independently scrolling list. The panel is a Chrome side panel, so its size is the window's; the layout is designed for a 320 px minimum width and any height. No fixed popup dimensions.

## What the student sees

Field (unchanged structure): wordmark, freshness, theme, refresh, menu; the "Do this first" hero; a three-count strip; the main tabs.

- Count strip: Overdue, This week, New changes. Overdue opens the Overdue category on Focus, This week opens the Week tab, New changes opens the Changes tab.

Below the field, pinned (not scrolling):

- Category control: Overdue (n) · Upcoming (n) · Completed (n). One category is visible at a time. The Overdue label takes the overdue tone when its count is above zero.
- Toolbar: course filter and a sort control (Due date, Course, Recently updated).

Scrolling list:

- Overdue: flat, due date ascending by default (longest overdue first).
- Upcoming, sorted by due date: small group headings Today, Tomorrow, Later this week, Later, No due date. Today is always shown, with "Nothing due today." when empty; the other groups appear only when they have items. Sorted by course or recently updated: one flat list, no group headings.
- Completed: flat, newest due date first. Items Brightspace reports as submitted or completed, plus items the student marked done locally.
- Row: checkbox, title, course dot and name, due date (overdue and today tones), a "Changed" mark when a change event for the item is in the current feed, kind icon, details chevron. The row's hide control moves into the details panel; the hero keeps its own.
- Empty state per category, in a sentence.

## Local done marks

Brightspace is read-only, so the checkbox is a mark kept on this device.

- Table `localMarks` in IndexedDB: `{ key, scope, markedAt }`.
- A marked item leaves Overdue and Upcoming, the counts, the hero ranking, and the Week tab's active entries, and appears under Completed labeled "Marked done by you". Unchecking removes the mark.
- Brightspace truth wins: when a refresh reports the item as submitted or completed, or the item is gone from the snapshot, the mark is deleted. The status shown on the row and in details is always the Brightspace status; the mark is a separate label.
- An item Brightspace already reports as done shows a checked, disabled checkbox labeled "Submitted in Brightspace".
- Marks produce no change events and are not part of the Ask Nova snapshot. Ask answers from Brightspace data only.

## Long overdue

Instructors often leave items open for months after the due date. Overdue therefore means the last `LONG_OVERDUE_AFTER_DAYS` (14) days; older open items are "long overdue".

- The core bucket stays `overdue`, so the planner, the Ask tools, and the compact snapshot schema keep their contract. `isLongOverdue(item, now)` in `packages/core` decides; `buildDashboard` splits `buckets.overdue` into recent items and `dashboard.longOverdue`.
- Long overdue items are excluded from the ranking input (any overdue item takes the top urgency, so a months-old item would otherwise be "Do this first"), from `counts.overdue`, and from the category badge.
- Under Overdue, a "Show N long overdue items" line at the bottom of the list (or inside the empty state) reveals a "Long overdue" group with a one-line caption. Rows are ordinary rows. The reveal is React state, not a preference: every panel open starts folded.
- Ask Nova: the compact snapshot carries an optional `longOverdue` flag per item and an optional `counts.longOverdue`, both additive. The prompt's brief, `get_brief`, and the `overdue` range of `list_deadlines` exclude them and say how many were left out; a new `long-overdue` range lists them; explicit `from`/`to` windows include them.

## Sorting

- Due date: ascending in Overdue and Upcoming, descending in Completed; no due date last.
- Course: course name, then due date.
- Recently updated: the latest change event detected for the item in the current feed, then the item's `sourceUpdatedAt`, then `observedAt`; newest first.

## Preferences

`ui.preferences` gains `focusCategory` (`"overdue" | "upcoming" | "completed" | null`, where null means Overdue when there is anything overdue and Upcoming otherwise) and `sort` (`"due" | "course" | "updated"`). `collapsedSections` is dropped; stored records missing the new keys fall back to defaults.

## Out of scope for this slice

- Open Full Dashboard (a second extension page rendering the same app in a wide layout). The host already reaches the Brightspace tab from any extension page and the database is shared, so it is a layout task, planned as the next slice.
- Snooze or hide until a date. Session-only hide stays as it is.

## Files

- `apps/extension/src/storage/novaDb.ts`, `repositories.ts`: `localMarks` table, list and set helpers, pruning inside `saveSyncOutcome`.
- `apps/extension/src/sidepanel/model.ts`: local marks in `buildDashboard`, `changedAt` per item, category and sort helpers.
- `apps/extension/src/sidepanel/components/FocusList.tsx`, `FocusCategories.tsx`, `SortSelect.tsx`: new. `DeadlineSections.tsx`: removed.
- `apps/extension/src/sidepanel/MissionControl.tsx`, `App.tsx`, `components/CountsStrip.tsx`, `components/WeekView.tsx`, `styles.css`, `dev/preview.tsx`.
- Tests under `tests/ui` and `tests/unit`.

## Week tab paging

Rolling seven-day pages from today, forward only. `buildWeekDays(items, localDone, now, offset)` in `model.ts` builds any page from the dashboard's filtered items; `dashboard.week` is page 0, so the "one definition of this week" shared with the count strip and Ask Nova is untouched. `lastWeekOffset` bounds the forward arrow at the latest due date. The page offset is session state in `MissionControl`, cleared to 0 by the count strip's "This week" jump; paging clears the picked day. `weekHero` takes the page and writes the headline from that page's open items.
