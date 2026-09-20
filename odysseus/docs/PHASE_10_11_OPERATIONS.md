# Phases 10–11 Operations

This delivery introduces organization-scoped multi-machine routing and a policy-governed orchestration DAG. It does not grant an adapter capabilities it has not advertised: routing reads each online gateway's `system.inventory`, and high-risk work excludes adapters with `approvalInterception: 'unsupported'`.

## Phase 10: organizations and routing

- `POST /api/v1/organizations` creates an organization and its owner membership.
- `POST /api/v1/organizations/:id/members` adds a member; owner or admin required.
- `PATCH /api/v1/projects/:id/organization` assigns a user-owned project to an organization. Send no `organizationId` to remove that assignment.
- `GET /api/v1/organizations/:id/dashboard` aggregates organization projects, sessions, online gateway state, recent routing decisions, orchestration runs, and organization-budget usage.
- `POST /api/v1/routing/preview` accepts `projectId`, `taskKind`, optional `requiredAgentId`, and a strategy (`least_loaded`, `capability_first`, `lowest_risk`, or `lowest_cost`).
- `POST /api/v1/sessions` may omit `deviceId`; the same router selects an eligible online gateway. Supplying `deviceId` preserves explicit placement.

Gateway inventory is fetched live before a route is selected and persisted as last-known device inventory for diagnostics. A route decision is retained with its alternatives and reasons.

## Phase 11: risk, budgets, and orchestration

- `POST /api/v1/risk/assess` returns an explainable score and contributors for a project/task prompt. Policy remains the final authority.
- `POST /api/v1/budgets` creates a session, project, or organization token/USD budget. Organization budgets require owner or admin. `GET /api/v1/budgets?scope=organization&scopeId=...` returns current use and threshold state.
- Completion metrics are recorded against session, project, and organization. Before starting an orchestration step, the organization budget is checked.
- `POST /api/v1/orchestrations` accepts an organization project and a DAG of steps (`id`, `title`, `taskKind`, `prompt`, `dependsOn`, optional `requiredAgentId`). Independent ready steps start in parallel; dependent steps wait for completed parents.
- `GET /api/v1/orchestrations/:id` reads the durable run. `POST /api/v1/orchestrations/:id/advance` reconciles it after session state changes.

Every orchestration step receives a separate session, routing decision, risk assessment, policy evaluation, and audit-compatible approval. If policy requires approval, the session is kept in `waiting_for_approval`; approving its normal approval endpoint dispatches the deferred `session.start` and advances the DAG. A denial never starts the child session.

Cost enforcement is intentionally conservative: present adapters provide token metrics at completion, so those metrics are recorded then; future adapters can report the same metric earlier to make the existing governor enforce a running-session budget sooner. No provider-specific cost estimate is invented.
