# Architecture

Nova Agent is local-first: the extension reads approved Brightspace data through the student's active browser session. Academic data is normalized before it reaches the dashboard, planner, or bounded agent tools.

## Boundaries

- `BrightspaceClient`: HTTP, versions, pagination, retry, and session errors
- `StudentDataService`: Brightspace queries and normalization
- `StudentStateEngine`: snapshots and meaningful change detection
- `PlannerEngine`: deterministic priority and scheduling
- `Agent tools`: validated, minimal access to normalized results

Session cookies and Villanova credentials must never be sent to the agent API.
