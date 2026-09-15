---
version: 1
slug: "src-sidepanel"
primary_target: "src/sidepanel"
related_targets: []
---

# Mission Control side panel

Scope: the Chrome side panel (Focus, Week, Changes) and its states. Visitor mode: Operate. Audience: Villanova undergraduates glancing between classes, laptop, daytime, Brightspace open beside the panel. Task: know what is due, what changed, what to do first, in ten seconds. Constraints: 380 to 440 px wide, React + Radix + plain CSS, WCAG AA, light default with a composed dark theme, Villanova blue binding. Untouched: data flow, sync, storage, dismissals, keyboard and aria behavior.

## Direction contract

THESIS: One blue field owns the top of the panel and states, per tab, the single thing the student needs to know; everything beneath it is a plain list. Refuses the four-tile summary, the labeled next-move card, and decorated rows.

OWN-WORLD: Villanova blue field (light #1d5fd1, dark #163f8f) over white or near-black (#0f1218). Hanken Grotesk only, 400 to 800. Hairline rules, 8 px radii, course color as an 8 px dot, coral/amber/green only for overdue, today, done. Tabs sit on the field's lower edge as one white tab.

STORY: Glance, read the field's headline, press its one button, scan the list.

FIRST VIEWPORT: Wordmark, freshness, theme switch, refresh; field with a 26 px headline, one sentence, white primary button plus priority number, counts strip; tabs; course filter; the Overdue section begins.

FORM: Field, position 1 of 7 on the ordered list, pinned by the owner; seed key b7981692 (assigned index 5 yielded to the pin; roll ran degraded, no challengers).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.
