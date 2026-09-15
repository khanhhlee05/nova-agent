# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Villanova undergraduates checking Brightspace between classes: laptop, daytime, a lit room, the LMS open in a white tab beside the panel. The job is a ten-second glance that answers "what do I need to do, what changed, what first" without opening every course. Late-night sessions exist and get a dark theme, but the daytime glance is the primary scene.

## Product Purpose

Nova Agent is an unofficial, local-first academic assistant delivered as a Chrome side panel (Mission Control) launched from a small orb on Brightspace pages. It observes what changed in the student's courses, determines what matters, explains why, and links to the next action. Success is a student trusting the panel enough to stop re-checking every course page.

## Positioning

Deterministic and explainable: every number is derived from Brightspace data on the device, every priority carries its reasons in words, and nothing is sent to a server or a model. "Since your last visit" is a real diff of normalized snapshots, not a notification feed. The feasibility of live access is stated honestly (demo data is always labeled).

## Operating Context

- Chrome 116+, Manifest V3 side panel, 380 to 440 px wide, beside `brightspace.villanova.edu`.
- Data source: read-only Brightspace routes through the student's own session, or clearly labeled fictional demo data.
- Three views: Focus (workload and next move), Week (seven-day agenda), Changes (signal feed since last visit).
- States the UI must carry: first run, loading, ready, empty, stale, partial sync, offline, session expired, permission required, demo mode, hidden-for-session items.
- Refresh is explicit or on open when data is older than 15 minutes; no polling.

## Capabilities and Constraints

- Assignments and quizzes with due dates, statuses (including an honest `unknown`), points, course; announcements; change events with old and new values; a priority score from five named components.
- Course colors are assigned deterministically per course and must remain distinguishable in both themes.
- All actions keyboard reachable; tooltips on icon-only controls; `aria-live` announcements; `prefers-reduced-motion` respected.
- Stack: React 19, Radix primitives, Lucide icons, plain CSS with custom properties, Vite. No Tailwind, no design-system library.
- Quiz status is always unknown; quiz points are not loaded. Do not present either as known.
- Undecided: whether live Brightspace access works on the Villanova tenant (depends on an OAuth registration).

## Brand Commitments

- Name: Nova (Mission Control for the panel). Villanova blue is the binding brand color for the redesign (confirmed by the owner).
- Unofficial student project; the UI must not claim affiliation with Villanova University or D2L.
- Visual constraint volunteered by the owner for the redesign: clean and bright, with a light theme and a dark theme the student can switch between.

## Evidence on Hand

- Fictional demo tenant in `packages/brightspace/src/fixtures/demoTenant.ts` (courses, assignments, quizzes, announcements) used by every screenshot and test.
- Screenshots of every panel state in `docs/screenshots/`.
- No real student data, testimonials, or usage numbers exist; none may be invented.

## Product Principles

- Show what is true, label what is unknown, never dress demo data as live.
- Explain every ranking in words a student would say.
- Consistency across views: one filtered set feeds counts, lists, week, and changes.
- Local first: everything stays on the device and can be wiped in one action.
- Calm over loud: the panel earns a glance, it does not compete with the LMS.

## Accessibility & Inclusion

WCAG AA: 4.5:1 for text, 3:1 for controls and icons, visible focus, keyboard reachable, reduced motion honored. Confirmed sufficient by the owner.
