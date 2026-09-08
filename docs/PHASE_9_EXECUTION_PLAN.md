# Phase 9 — Git, Diff Review and Project Workspaces: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 9
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents
**Target Milestone:** M9 (A user can review what a real agent actually changed, run tests against it, and approve a commit/PR — every git write gated through the same Policy Engine that gates everything else)
**Depends on:** Phase 8 (a real adapter's `collectDiff()` returning real `git diff` output — Phase 9 has nothing meaningful to review without this), Phase 5 (Policy Engine — `git.commit`/`git.push` are already declared capabilities in that plan; this phase is the first place they're actually exercised for real), Phase 4 (Diff Review screen — built in that phase against fixture data, this phase is what makes it real)
**Status:** Planning

---

## 1. Executive Direction & Scope

The roadmap's goal statement draws a sharp, useful distinction: *"Turn agent supervision into a useful development workflow."* Everything through Phase 8 proves the architecture can safely run and observe an arbitrary agent. Phase 9 is where that stops being merely safe and starts being **useful for the actual job** — shipping code. A user who can watch an agent work, approve its risky actions, and verify secrets didn't leak, but who then has to `git log`/`git diff`/`git push` by hand on the actual machine to see what happened, hasn't been given a development workflow — they've been given a very safe way to watch someone else type.

### 1.1 What already exists, and the two real gaps

| Roadmap requirement (§13) | Status |
|---|---|
| §13.1 Git: `status`, `diff` | ✅ **Already implemented, read-only**, in `gateway/core/src/project-manager.ts` — `safeGitExec()` (a hardened `execFile('git', ...)` wrapper, never shell-interpolated) already extracts current branch, default branch, last commit hash/timestamp during project registration. |
| §13.1 Git: `branch`, `commit`, `push`, `pull request` (write operations) | ❌ **Do not exist anywhere.** `safeGitExec` is `private` — no write path has ever been built, by design (nothing before this phase has needed to *change* a repository, only observe one). |
| §13.2 Review flow: collect diff → summarize → run tests → show review → approve | 🟡 **Collect diff exists as of Phase 8.** Summarize can reuse Phase 7's structured event-aggregation pattern (`summary-generator.ts`) directly. Run tests, show review, and the approve-gated commit/PR action are new. |
| §13.3 Project dashboard | 🟡 **All the underlying data already exists** (`ProjectManager`, Phase 5's `PolicyStore`, session history via `SessionRepository`) — this is an aggregation/API-surface task, not a new data-modeling task. |
| §13.4 GitHub: OAuth, repo selection, branch creation, commit, push, PR creation, narrowly-scoped tokens | ❌ **Does not exist.** Genuinely new integration surface — the one part of this phase that isn't primarily "connect things that already exist." |

**The reframe:** Phase 9 has exactly two genuinely new pieces of engineering — **git write operations** (§3) and **GitHub OAuth/PR integration** (§5) — and two aggregation/connection tasks over data that's already there — **the review flow** (§4) and **the project dashboard** (§6). Sizing effort accordingly matters: don't let the dashboard, which is mostly plumbing, consume the same care budget as the git-write path, which is the one place in this entire phase capable of doing real, hard-to-undo damage to a user's repository if built carelessly.

---

## 2. Core Architectural Decisions for Phase 9

### 2.1 Every git write is a `Capability`, evaluated by Phase 5's Policy Engine, with no exceptions — this is the phase's one non-negotiable rule

The roadmap's own §13.1 text ends with three words that carry the entire security posture of this phase: **"subject to policy."** `git.commit` and `git.push` are not new capabilities this phase invents — they are **already enumerated** in Phase 5's own capability list (`docs/PHASE_5_EXECUTION_PLAN.md §3.1`), which means the Policy Engine, the deny-override floor, and the audit log were all designed with this phase's existence already in mind. The one new capability this phase must add to that closed set is `git.branch_create` (creating a branch is lower-risk than committing to one, but still a repository mutation an agent shouldn't be able to perform silently under a `supervised` trust profile).

**Concretely:** the new git-write module (§3) is a **pure command executor** — it has no opinion about whether an action is allowed. Every call into it is preceded, unconditionally, by a call to the same `PolicyEngineService.evaluate()` (Phase 5) every other risky action already goes through. There is no "git operations are special and get their own gate" — they go through the *same* gate, because a second gate is a second thing that can be forgotten, misconfigured, or drift out of sync with the first.

### 2.2 The git-write module lives in the Gateway, not the Control Plane — repositories live on the developer's machine

Consistent with every prior phase's placement logic (redaction runs where the secret originates; sandboxing runs where the process executes), git write operations run **on the Gateway**, against the actual local clone in the session's `projectRoot`. The Control Plane's role is exactly what it already is for every other command: receive the API call, run the Phase 5 policy check, and — only on `ALLOW` or a granted `REQUIRE_APPROVAL` — forward a `git.commit`/`git.push`/`git.branch_create` command down the tunnel via the **already-existing** `tunnelServer.sendCommandToDevice` mechanism, the same one every session-control action (`prompt`/`pause`/`resume`/`cancel`) already uses. Phase 9 adds new command *types* to that existing dispatch mechanism; it does not add a new dispatch mechanism.

### 2.3 `safeGitExec` is promoted, not duplicated

`ProjectManager`'s `safeGitExec` (`gateway/core/src/project-manager.ts:379`) is exactly the right primitive for every write operation this phase needs — a hardened, `execFile`-based (never shell-interpolated, so no command-injection surface from a branch name or commit message containing shell metacharacters), timeout-bounded git invocation. It is currently `private` to `ProjectManager`. Phase 9 promotes it to a small shared utility:

```
gateway/core/src/git/
├── git-exec.ts          # promoted safeGitExec, now exported and reusable
└── git-operations.ts     # NEW — branch/commit/push, built on git-exec.ts
```

`ProjectManager` is refactored to import from `git-exec.ts` rather than defining its own private copy — this is the same "one writer, everyone else calls in" discipline already applied to the audit log (Phase 5) and the revocation-notification path (Phase 2), now applied to "the one place that shells out to git."

### 2.4 Test execution is adapter-scoped, not a new Gateway-wide capability

The review flow's "run tests" step (§13.2) is not a new kind of thing — it's **the agent adapter running a command inside the session's existing sandbox**, using the exact same `process.exec` capability (Phase 5) and sandbox isolation (Phase 1) any other agent-initiated command already uses. The only Phase-9-specific piece is that the *review flow orchestrator* (§4) is the one deciding to trigger it, as a scripted step in the review pipeline, rather than the agent deciding to run tests on its own initiative mid-task (which it can already do, unrelated to this phase). No new sandbox capability, no new command type — just a new *caller* of capabilities that already exist.

---

## 3. Detailed Subphases — Git Write Operations

### Subphase 9.1 — Promote `git-exec.ts`, build `git-operations.ts`

**Work:**
```ts
// gateway/core/src/git/git-operations.ts
export interface GitOperations {
  createBranch(projectRoot: string, name: string, fromRef?: string): Promise<GitOperationResult>;
  commit(projectRoot: string, message: string, files?: string[]): Promise<GitOperationResult>;
  push(projectRoot: string, remote: string, branch: string, force?: boolean): Promise<GitOperationResult>;
  status(projectRoot: string): Promise<GitStatus>;   // thin wrapper, reuses existing read path
}
```

Every method is a direct `git-exec.ts` call with careful, allowlist-based argument construction (branch names and commit messages are **data**, passed as discrete `execFile` arguments, never concatenated into a shell string — this is already how `safeGitExec` works, and Phase 9 must not regress that property by, e.g., building a `git commit -m "${message}"` string anywhere). `force: true` on `push` is itself flagged: a force-push is explicitly named in the project's own README security checklist as one of the permission/gate-test-required, deny-override-relevant actions ("protected-branch force-push") — Subphase 9.2 makes sure this isn't just a parameter, but a distinctly higher risk classification.

**Definition of done:** unit tests against a real, disposable local git repo fixture (created fresh per test, in a temp directory — no network, no real remote) proving `createBranch`/`commit` work correctly and that a commit message or branch name containing shell metacharacters (`; rm -rf /`, `$(whoami)`, etc.) is passed through literally as data and never executed.

### Subphase 9.2 — Policy integration: `git.commit`, `git.push`, `git.branch_create`

**Work:** add `git.branch_create` to the `Capability` closed set (Phase 5's `packages/protocol/src/types/policy.ts`) alongside the already-existing `git.commit`/`git.push`. Add default risk classes: `git.branch_create` → LOW (or MEDIUM if `resourcePattern` matches a protected-branch naming convention like `release/*`), `git.commit` → MEDIUM (as the roadmap's own §9.2 example table already lists it), `git.push` → HIGH (also already the roadmap's own example — literally the worked example in Phase 5's plan, `"Git push is protected by AFK policy"`).

**Critical wiring point:** the Control Plane's new git-command HTTP handlers (§3, Subphase 9.3) call `policyService.evaluate({capability: 'git.push', ...})` — **exactly the same call signature** every other Phase-5-gated action uses — *before* calling `tunnelServer.sendCommandToDevice`. If the decision is `REQUIRE_APPROVAL`, an `ApprovalRecord` is created through the **existing** `ApprovalWorkflow` (Phase 5) — a git push waiting on approval is not a new kind of pending state, it's the same `pending` approval status the whole system already knows how to expire, escalate (Phase 7), and audit.

**Force-push, specifically:** add a deny-floor entry (Phase 5's `deny-floor.ts`) for `{ capability: 'git.push', resourcePattern: 'main' | 'master', force: true }` (extending the floor's match shape with a `force` flag specific to this capability) — a force-push to a default branch is denied unconditionally, matching the README's own explicit security requirement, not left to policy-author discretion the way an ordinary push is.

**Definition of done:** a policy-engine test proving `git.push` with `force: true` against `main` is denied regardless of any authored rule (mirroring Phase 5's own §9 test #9, "deny-override action," applied to this phase's specific new floor entry); a second test proving an ordinary `git.push` correctly resolves to `REQUIRE_APPROVAL` under a `supervised` profile and `ALLOW` under `trusted-afk` for a rule scoped to that profile (reusing Phase 7's trust-profile machinery directly).

### Subphase 9.3 — Control Plane API surface

**Work:** new endpoints, following the exact existing pattern (`segments`-based routing already established in `HttpRouter`):

```
POST /api/v1/sessions/:id/git/branch    { name, fromRef? }
POST /api/v1/sessions/:id/git/commit    { message, files? }
POST /api/v1/sessions/:id/git/push      { remote, branch, force? }
GET  /api/v1/sessions/:id/git/status
```

Each POST handler: read the session's `projectId`/`trustProfile`, call `policyService.evaluate(...)`, and either forward the command via `tunnelServer.sendCommandToDevice` (on `ALLOW`) or create a pending approval and return `202` with the approval id (on `REQUIRE_APPROVAL`) — structurally identical to how the existing `prompt`/`pause`/`resume` handlers already branch on tunnel delivery, extended with the one additional policy-check step Phase 5 introduced for the first time in this phase's git context.

**Definition of done:** an integration test proving the full loop — `POST .../git/push` on a HIGH-risk push returns `202` + an approval id, approving it (existing Phase 5 decision endpoint) causes the push command to actually reach the Gateway (verified via the mock tunnel infrastructure already proven in `control-plane/tests/tunnel.test.ts`), and the audit log (Phase 5) contains both the policy decision and the approval decision as separate, correctly-sequenced `AuditEvent`s.

---

## 4. Detailed Subphases — Review Flow

### Subphase 9.4 — Review flow orchestration

**Work:** a new Control Plane module implementing the roadmap's exact §13.2 sequence as an explicit, inspectable pipeline (not an implicit chain of side effects scattered across handlers):

```
control-plane/src/review/
└── review-orchestrator.ts
```

```ts
interface ReviewFlow {
  // 1. Task complete  -> triggered by an incoming session.completed event
  // 2. Collect diff    -> tunnelServer.sendCommandToDevice('session.diff_collection', ...)
  //                       (ALREADY EXISTING, Phase 3/8 — reused verbatim)
  // 3. Summarize changes -> Phase 7's summary-generator.ts, REUSED, not reimplemented —
  //                       it already turns StoredEvents into a structured summary;
  //                       a diff is just one more input to fold into that same output shape
  // 4. Run tests       -> adapter.sendMessage(sessionId, testCommand) or a dedicated
  //                       'session.run_tests' command type, itself just process.exec
  //                       under the hood (§2.4) — results arrive as normal session.tool_result
  // 5. Show review     -> GET /api/v1/sessions/:id/review — bundles diff + summary + test
  //                       results into one payload for Phase 4's Diff Review screen
  // 6. User approves commit/PR -> Subphase 9.1-9.3's git operations, or Subphase 9.5's PR flow
  runReviewFlow(sessionId: string): Promise<ReviewBundle>;
}
```

**Why this is a pipeline object and not just four sequential handler calls:** step 4 (run tests) can fail, and a failed test run should be a visible, first-class fact in the review bundle ("⚠ 2 of 14 tests failed") rather than silently blocking the flow or being conflated with a policy denial — these are different kinds of "no" (one is "the code doesn't work," the other is "you're not allowed to do this yet") and Phase 4's UI needs to be able to tell them apart, which requires the orchestrator to model them as distinct outcomes rather than collapsing everything into a single boolean.

**Definition of done:** given a fixture session with a real diff (Phase 8), a synthetic test command that's scripted to fail one of three tests, verify `runReviewFlow` returns a bundle whose `testResults` clearly shows the partial failure, whose `summary` reflects it (reusing Phase 7's exact aggregation logic — this is also the concrete test that Phase 7's summary generator is genuinely reusable, not just similar in shape), and whose `diff` field matches Subphase 8.4's real `git diff` output byte-for-byte.

### Subphase 9.5 — GitHub integration

**Work:** the one genuinely new external integration in this phase, scoped narrowly per the roadmap's own explicit instruction ("Scope tokens narrowly"):

```
control-plane/src/integrations/github/
├── oauth.ts           # standard OAuth 2.0 authorization-code flow
├── github-client.ts    # thin wrapper over GitHub's REST API — repo list, branch create,
│                        # commit (via the same push path, §3, once the remote is GitHub),
│                        # PR creation
└── token-store.ts      # encrypted-at-rest token storage, scoped per-user
```

- **OAuth scopes requested: `repo` only where a public/private repo needs read+write, never `admin:org`, `delete_repo`, or any scope broader than what commit/push/PR creation actually requires.** This is the literal meaning of "scope tokens narrowly" — stated here as a concrete, checkable constraint (the exact scope string list, reviewed against GitHub's own documented minimal-scope guidance) rather than a principle to remember later.
- **PR creation is a new capability**, `git.pull_request_create`, added to Phase 5's closed set alongside `git.branch_create` — default risk class MEDIUM (creating a PR doesn't touch protected branches directly, but does make the agent's work externally visible, which is a real, if moderate, action).
- **The GitHub token itself is exactly the kind of thing Phase 6's redaction pipeline exists to protect** — it must never appear in a `session.output` event, a checkpoint, or an audit log entry. Store it only in `token-store.ts`, referenced by an opaque id everywhere else in the system, the same pattern any credential-bearing system uses (never pass the secret itself through logging-adjacent code paths — pass a handle to it).

**Definition of done:** an OAuth flow test (using GitHub's own documented sandbox/test-app pattern, not a real production GitHub App during CI), a repo-selection + branch-creation + commit + push + PR-creation happy-path integration test against a disposable test repository, and — the one non-negotiable security test for this subphase — a test proving that requesting a repo-scope OAuth token does **not** grant (and the app never requests) any scope beyond what's actually exercised by the four operations above.

---

## 5. Detailed Subphases — Project Dashboard

### Subphase 9.6 — Dashboard aggregation API

**Work:** the roadmap's §13.3 tree is a read-only aggregation over data that already exists in four different places — this subphase's entire job is one new endpoint that assembles them, not new storage:

```
GET /api/v1/projects/:id/dashboard
  {
    repository: { ... },       // from ProjectManager's existing git introspection
    workspace: { root, ... },  // from ProjectManager
    defaultBranch: "...",       // from ProjectManager
    policies: [...],            // from Phase 5's PolicyStore, filtered by projectId
    agentPreferences: {...},    // NEW — the one genuinely new piece: a small per-project
                                 // config (preferred adapter, default trust profile — Phase 7's
                                 // DeviceRecord.defaultTrustProfile, scoped per-project instead)
    activeSessions: [...],      // from SessionRepository.listByUser, filtered by projectId
    history: [...],             // from SessionRepository + Phase 5's AuditLog, paginated
  }
```

**Definition of done:** given a project with two active sessions, one completed session, and one custom policy rule scoped to it, the dashboard endpoint returns all four correctly assembled and correctly filtered to that project — the actual engineering content of this subphase is almost entirely in getting the filtering right (nothing here should ever leak another project's sessions or policies into this response), not in inventing new data.

---

## 6. Directory Structure for Phase 9

```
freebuff/
├── gateway/core/src/
│   └── git/
│       ├── git-exec.ts          # promoted from project-manager.ts
│       └── git-operations.ts    # NEW
├── control-plane/src/
│   ├── review/
│   │   └── review-orchestrator.ts
│   └── integrations/
│       └── github/
│           ├── oauth.ts
│           ├── github-client.ts
│           └── token-store.ts
└── packages/protocol/src/types/
    └── policy.ts                # +git.branch_create, +git.pull_request_create capabilities
```

---

## 7. Phase 9 Definition of Done

- [ ] `git-exec.ts` promoted and shared; `ProjectManager` refactored to use it, zero behavior change to its existing read-only introspection (regression-tested against its existing test suite).
- [ ] `GitOperations.createBranch/commit/push` implemented, argument-injection-safe (tested with adversarial branch/message input), and — critically — **every call gated by Phase 5's Policy Engine with no bypass path.**
- [ ] Force-push to a default branch is denied by the deny-override floor, unconditionally, matching the README's explicit security requirement.
- [ ] The four new git HTTP endpoints correctly branch on policy decision (ALLOW → forward; REQUIRE_APPROVAL → pending approval + 202), reusing Phase 5's existing approval/audit machinery without a parallel path.
- [ ] The review-flow pipeline runs end-to-end: task complete → real diff (Phase 8) → summary (Phase 7's generator, reused) → test results (clearly distinguished from policy denial) → a review bundle Phase 4's Diff Review screen can render without modification to that screen's existing contract.
- [ ] GitHub OAuth requests only the minimum scope the four supported operations require, verified by an explicit test, not just code review.
- [ ] GitHub tokens never appear in any event, checkpoint, or audit entry — verified against Phase 6's redaction/classification pipeline.
- [ ] The project dashboard endpoint correctly aggregates and correctly isolates per-project data with no cross-project leakage.

## 8. Do NOT Build Yet

- GitLab/Bitbucket integration — GitHub first, per the roadmap's own explicit sequencing ("First integration: ... GitHub"); other providers are real future work, not this phase's job
- Merge-conflict resolution UI or automated rebase/merge strategies — this phase reviews and ships a single agent's linear changes; conflict resolution is a materially harder problem better scoped once real usage shows it's actually needed
- A visual git graph/history browser — the dashboard's `history` field is data for Phase 4 to render simply (a list), not a git-log visualization tool
- Multi-repository / monorepo cross-project dashboards — one project, one repository, per this phase; aggregating across projects is Phase 10 (Multi-Machine)-adjacent territory, not this phase's
