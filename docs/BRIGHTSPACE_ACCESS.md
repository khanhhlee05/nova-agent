# Brightspace access: feasibility and authorization

## The constraint

D2L documents OAuth 2 bearer tokens as the supported authentication for Valence API routes. A logged-in browser holds D2L session cookies, but cookies are not a documented or guaranteed way to call `/d2l/api/...`. Nova Agent therefore treats same-origin session requests as a tenant-specific feasibility test, never as an assumption.

## Phase 0 probe (implemented)

`runFeasibilityProbe` in `packages/brightspace/src/probe.ts` issues three read-only requests through the content-script bridge while the student is signed in:

1. `GET /d2l/api/versions/`
2. `GET /d2l/api/lp/{version}/users/whoami`
3. `GET /d2l/api/lp/{version}/enrollments/myenrollments/?isActive=true&canAccess=true`

It records only:

- HTTP status
- response content type
- whether the body parsed as JSON
- the field *shape* (key names and value types, never values)
- whether the shape matched the expected schema
- the selected LP and LE versions
- the number of active enrollments (a count only)

The report is stored under the `feasibility` table and viewable from the panel menu as **Connection report**. Cookies are never read, copied, logged, or forwarded.

### Verdicts

| Verdict | Meaning | Panel state |
|---|---|---|
| `live-ok` | All three routes returned valid JSON | Live mode enabled, first sync runs |
| `authorization-required` | A route answered 401, redirected to login, or returned HTML | "Connection requires authorization"; demo mode remains available |
| `permission-denied` | A route returned 403 | Same as above |
| `unreachable` | No Brightspace tab, timeout, or network failure | "Brightspace is unreachable" with retry |
| `unsupported` | Unexpected shape or no supported LP/LE version | "Refresh failed" with details |

## Result on the Villanova tenant

**Not verified.** The development environment for this pull request cannot reach `brightspace.villanova.edu` at all (the sandbox egress proxy rejects the CONNECT, so even the unauthenticated `/d2l/api/versions/` route could not be observed). No student session was available either.

What this means for the branch:

- Fixture mode is the default and is labeled **Demo data** everywhere. Nothing fake is ever presented as live.
- Live mode is only enabled after the probe returns `live-ok` on the student's own machine.
- If the probe fails, the panel shows the authorization-required state and keeps the full UI usable with demo data.

To run the probe yourself: load the unpacked extension, sign in at `https://brightspace.villanova.edu`, open the side panel, and click **Connect to Brightspace**. Then open **Connection report** from the panel menu. The report contains no personal data and is safe to paste into an issue.

## Minimum read-only access required

Routes used by features A–D:

| Route | Purpose |
|---|---|
| `GET /d2l/api/versions/` | Version discovery (unauthenticated) |
| `GET /d2l/api/lp/{v}/users/whoami` | Current user id for stable keys |
| `GET /d2l/api/lp/{v}/enrollments/myenrollments/` | Active, accessible course offerings |
| `GET /d2l/api/le/{v}/{orgUnitId}/dropbox/folders/` | Assignments |
| `GET /d2l/api/le/{v}/{orgUnitId}/dropbox/folders/{folderId}/submissions/mysubmissions/` | The student's own submission status (optional; `unknown` when refused) |
| `GET /d2l/api/le/{v}/{orgUnitId}/quizzes/` | Quizzes |
| `GET /d2l/api/le/{v}/{orgUnitId}/news/` | Announcements |

OAuth 2 scopes that cover them: `core:*:*`, `enrollment:orgunit:read`, `dropbox:folders:read`, `quizzing:quizzes:read`, `news:access:read`. Both lists are exported from `packages/brightspace` as `REQUIRED_READ_ONLY_ROUTES` and `REQUIRED_OAUTH_SCOPES`.

Deliberately not used: quiz attempt routes (unreliable for learners, so quiz status is always `unknown`), calendar routes, any page scraping, and any undocumented endpoint.

## Next step if authorization is required

1. Register Nova Agent as an OAuth 2 application with Villanova UNIT / D2L with the scopes above and a redirect URI on the extension origin.
2. Implement an `OAuthTransport` that satisfies the existing `BrightspaceTransport` interface (`getJson(path, schema)`) and attaches `Authorization: Bearer <token>`. Tokens would live in `chrome.storage.session`, never in IndexedDB.
3. Swap the transport in `defaultTransportFactory` for live mode. Nothing in `packages/core`, `packages/planner`, or the UI changes.

## Request behavior (for reviewers)

- `Accept: application/json`, 10-second `AbortController` timeout per request.
- Course-detail concurrency of 3.
- `429` honors `Retry-After` exactly (seconds or HTTP date). Missing `Retry-After` surfaces a `rate-limited` error.
- Network failures and `5xx` retry at most three times with exponential backoff and jitter. `401`, `403`, `404`, and validation failures never retry.
- Login redirects and HTML bodies map to `session-expired`, not parse errors.
- `404` on an optional per-course resource becomes a non-blocking warning. A failed course never invalidates successful ones. Session expiry, an unsupported API version, or an unrecoverable rate limit aborts the whole sync.
- Pagination follows `PagingInfo.Bookmark`/`HasMoreItems` and `Next`/`Objects`, stops on a repeated bookmark or URL, and caps at 50 pages. `Next` URLs must match the tenant origin and start with `/d2l/api/`.
