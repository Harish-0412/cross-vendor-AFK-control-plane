# Phase 5 — Policy Engine, Approvals and Audit: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 5
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents
**Target Milestone:** M5 (No agent action classified as HIGH/CRITICAL risk can execute without a server-side policy decision that the Gateway cannot forge, bypass, or roll back — and every decision is provable after the fact)
**Depends on:** Phase 3 (Cloud Control Plane, verified) and Phase 4 (Web Control Center, for the Approval screen's consumer contract)
**Status:** Planning — **this is the security core of the entire product.**

---

## 1. Why This Phase Is the Product, Not a Feature

Every other phase in this project could be described, uncharitably but not inaccurately, as "a remote desktop for AI agents." What makes Freebuff a *governance* product rather than a convenience product is Phase 5. Read the project's own tagline back: **"Bring your own agent. We govern the work."** Everything up to this phase — pairing, sandboxing, the tunnel, the PWA — is plumbing that makes governance *possible*. Phase 5 is where governance actually *happens*.

This has a direct architectural consequence that must be stated before any design decision below: **the Policy Engine's trust boundary is the Control Plane, not the Gateway.** The Gateway runs on a developer's own workstation. A developer can read its source, patch its binary, run a debugger against it, or simply not run it at all and hand-craft tunnel messages themselves. Any policy check that lives *only* in the Gateway is a check the person the policy exists to constrain can trivially remove. This is not a hypothetical — it is exactly the threat model the base specification's §9.2 (referenced in the repo's own README security checklist) already names: *"The deny-override list is enforced in the Policy Engine, server-side — never trust a client-side check alone."*

Everything in this plan follows from that one sentence.

---

## 2. Current State: What Already Exists, and the Gap

Verified against the actual codebase (not the plan documents) before writing this:

| Piece | Status |
|---|---|
| `ApprovalAction { id, type, riskLevel, description, details, timeoutMs }` | ✅ Already typed in `@freebuff/protocol` (`packages/protocol/src/types/commands.ts:112`) — `riskLevel` already matches the roadmap's LOW/MEDIUM/HIGH/CRITICAL scale exactly |
| `AgentAdapter.requestApproval(sessionId, action)` / `submitApprovalDecision(...)` | ✅ Interface exists; the mock adapter implements it (self-declared — the adapter decides for itself when to ask) |
| `ApprovalRecord` (control plane) | ✅ Exists (`control-plane/src/types.ts:71`) — `status: pending\|granted\|denied\|timeout`, tied to session/device/user |
| `POST /sessions/:id/approvals/:id/decision` | ✅ Implemented and tested (Phase 3) |
| `session.approval_required` / `_granted` / `_denied` events | ✅ Already in the `EventType` union |
| `PolicyViolationPayload { policyId, policyName, severity, description, blocked }` | ✅ Already typed (`packages/protocol/src/types/events.ts:149`) — **unused by any code today** |
| `PolicyEngineMetrics { approvalsRequested, approvalsGranted, approvalsDenied, cacheHits, cacheMisses, latencyP50Ms, latencyP95Ms }` | ✅ Already typed — **no engine exists to produce these metrics** |
| **An actual Policy Engine that decides ALLOW / DENY / APPROVAL_REQUIRED** | ❌ **Does not exist anywhere in the codebase.** |
| **A server-side deny-override floor that cannot be bypassed** | ❌ **Does not exist.** Today, whether an action requires approval is entirely up to what the adapter itself chooses to call `requestApproval` for. A malicious or buggy adapter can simply never call it. |
| **Hash-chained, tamper-evident audit log** | ❌ **Does not exist.** `StoredEvent` (Phase 3) is an append-only event log, but it is not hash-chained and nothing verifies it. |

**The gap, stated plainly:** the system today has a fully-working *approval mechanism* (request → user decides → session unblocks) but **no actual policy** deciding when that mechanism must fire, and **no independent proof** that a decision, once made, wasn't tampered with afterward. Phase 5 builds both. This is a large, and large is the correct size for the phase the project's own README calls out four separate non-negotiable security requirements against.

---

## 3. Domain Model

This is the vocabulary the rest of the plan is written in. Get this right first — everything downstream (schema, API, tests) is a direct consequence of these definitions.

### 3.1 Capability
A named, discrete thing an agent can attempt to do. Capabilities are **declared by adapters** (an adapter says "I am capable of `process.exec`"), matching the roadmap's capability list:

```
filesystem.read | filesystem.write | filesystem.delete
process.exec
network.access
package.install
git.commit | git.push
deployment.execute
secret.read
```

**Architecture decision:** capabilities are a closed, versioned enum in `@freebuff/protocol` (`packages/protocol/src/types/policy.ts`, new file), not a free-form string. A policy engine that matches against arbitrary strings from an untrusted adapter is a policy engine an adapter can bypass by simply naming its action something the rules don't match. Every adapter declares its capability subset at `installOrDetect()` time (already a method on the interface); the Policy Engine only ever evaluates against this closed set.

### 3.2 Risk Class
A capability's *default* severity — LOW / MEDIUM / HIGH / CRITICAL, exactly as scoped in the roadmap and already present as `ApprovalAction.riskLevel`. Risk class is **policy-configurable per rule** (a rule can escalate `git.push` from HIGH to CRITICAL for a specific project), but every capability has a **built-in default** so a project with zero custom policy is still safe by default — this is what makes the deny-floor meaningful even before a user ever writes a rule.

### 3.3 Trust Profile
A named bundle of default behavior a user assigns to a device or session — e.g. `supervised` (everything MEDIUM+ requires approval), `trusted-afk` (only HIGH+ requires approval, for AFK Mode per Phase 7), `read-only` (any WRITE-class capability is denied outright, no approval possible), and `locked` (observation only: every capability, including LOW-risk reads, is denied). Trust profiles are **not** an escape hatch from the deny floor (§3.5) — they tune everything *below* it.

### 3.4 Policy Rule
The atomic, declarative unit of policy:

```typescript
interface PolicyRule {
  id: string;                    // 'afk.git.push', stable, referenced in decisions
  description: string;
  match: {
    capability?: Capability;               // omit = matches all capabilities
    riskClass?: RiskClass;
    resourcePattern?: string;              // glob, matched against action.details.resource
    projectId?: string;                    // scope to one project/workspace
    trustProfile?: TrustProfile;
  };
  effect: 'allow' | 'deny' | 'require_approval';
  requiredRole?: 'owner' | 'admin';        // only meaningful when effect === 'require_approval'
  priority: number;                        // higher wins; ties broken by rule specificity (§4.2)
}
```

No custom policy programming language, per the roadmap's own "Do NOT build yet" list. This is a **match-and-effect table**, not a scripting engine — deliberately, because a Turing-complete policy DSL is both a Phase-18-Enterprise-scale feature and its own class of security bug (policy code that can be crafted to always evaluate `allow`).

### 3.5 The Deny-Override Floor (the one thing no policy version can weaken)

A **hardcoded, versioned-in-source, not-database-editable** list, evaluated *before* any user-authored `PolicyRule` is even consulted:

```typescript
// control-plane/src/policy/deny-floor.ts
export const DENY_OVERRIDE_FLOOR: ReadonlyArray<{ capability: Capability; resourcePattern?: string }> = [
  { capability: 'deployment.execute', resourcePattern: 'production/**' },
  { capability: 'filesystem.delete', resourcePattern: '**/.git/**' },      // no agent force-rewrites git history
  { capability: 'secret.read', resourcePattern: '**/.env*' },
  // extend deliberately; this list is a code review, not a config change
];
```

This is the literal implementation of the README's "deny-override list ... cannot be bypassed by any trust profile." It lives in a source file, changing it requires a PR and a code review (not a database write an admin API could make), and — critically — **it is evaluated identically regardless of which `PolicyVersion` is active** (§3.6). No policy version, however constructed, can produce `allow` for something the floor denies. This is enforced structurally in §4.1's evaluation order, not by convention.

### 3.6 Policy Version
Every change to the rule set is a new immutable, timestamped `PolicyVersion` (`p_17`, matching the roadmap's own example decision payload). Rules are never edited in place — a "change" is authoring a new version that supersedes the old one. This is what makes "policy change after request" (a required test case, §9) a well-defined scenario rather than a race condition: an approval request captures the `policyVersion` active at request time, and re-validates against the **current** version at decision time (§7.3) — if the two disagree in a way that matters, the decision path has an explicit rule for it, not undefined behavior.

### 3.7 Approval Request / Decision (extends existing `ApprovalRecord`)
The existing `ApprovalRecord` gains the fields the Policy Engine needs to produce and the roadmap's decision payload already specifies:

```typescript
interface ApprovalRecord {
  // ...existing fields unchanged...
  policyVersion: string;          // NEW — snapshot at request time
  matchedRules: string[];         // NEW — rule ids that led to require_approval
  requiredRole: 'owner' | 'admin' | undefined; // NEW
  expiresAt: Date;                // NEW — was implicit; now explicit and enforced
}
```

Purely additive to the existing type and its DB repository — no migration of existing data shape beyond adding nullable/defaulted columns.

### 3.8 Audit Event
Distinct from `StoredEvent` (Phase 3's session event log, which is operational/functional data). An `AuditEvent` is specifically a **security-relevant decision record**: every policy evaluation (not just ones that required approval — allowed and denied decisions are audited too, since "the policy silently allowed something" is exactly the fact a post-incident review needs), every approval decision, every device pairing/revocation. See §8 for the full schema.

---

## 4. The Policy Evaluation Pipeline

This is the core algorithm. It runs **once per proposed action**, server-side, and produces exactly one of three outcomes.

### 4.1 Evaluation order (fixed, not configurable — this order *is* the security guarantee)

```
1. DENY-OVERRIDE FLOOR (§3.5)
     match? ──yes──▶ DENY (terminal, no rule can override)
     │no
     ▼
2. DEVICE STATUS CHECK
     device revoked/suspended? ──yes──▶ DENY (terminal — a revoked device gets
     │no                                 nothing, regardless of what it asks for)
     ▼
3. USER-AUTHORED POLICY RULES (current PolicyVersion)
     Rules matching this (capability, riskClass, resourcePattern, projectId,
     trustProfile) are collected, sorted by (priority desc, specificity desc —
     see §4.2), and the highest-ranked rule's effect wins.
     No matching rule? ──▶ fall through to step 4
     ▼
4. RISK-CLASS DEFAULT (no explicit rule matched)
     locked profile ──▶ DENY (terminal for every risk class; observation only)
     LOW      ──▶ ALLOW
     MEDIUM   ──▶ ALLOW   (configurable per trust profile — a 'supervised'
                            profile promotes MEDIUM to require_approval)
     HIGH     ──▶ REQUIRE_APPROVAL
     CRITICAL ──▶ REQUIRE_APPROVAL, requiredRole: 'owner'
```

**This function is pure and synchronous** given (action, device, activePolicyVersion) as input — no I/O inside the decision logic itself, only in loading the inputs beforehand. This matters for two reasons: it is trivially unit-testable (§9 lists the required cases, all of which become direct function calls with no mocking needed), and it means the same function can run in two places with byte-identical results (§6).

### 4.2 Specificity tiebreaking

When two rules have equal `priority`, the more specific one wins, where specificity is the count of non-omitted `match` fields (a rule matching `{capability, resourcePattern, projectId}` beats one matching only `{capability}`). This mirrors CSS specificity and is a well-understood pattern for rule-matching systems — reinventing a different tiebreak convention here would be needless novelty in the one place novelty is least welcome.

### 4.3 Decision payload (matches the roadmap's own example exactly)

```json
{
  "decision": "APPROVAL_REQUIRED",
  "reason": "Git push is protected by AFK policy",
  "required_role": "owner",
  "policy_version": "p_17",
  "expires_at": "2026-09-07T18:30:00Z",
  "matched_rules": ["afk.git.push"]
}
```

---

## 5. Where This Runs: Two Enforcement Points, One Source of Truth

This is the second load-bearing architecture decision, and it resolves a real tension: the Gateway is where actions physically execute (inside the sandbox, on the user's machine), but the Gateway is *not* the trust boundary (§1). The resolution is **defense in depth with an explicit, asymmetric trust relationship**:

```
┌─────────────────────────────────────────────────────────────┐
│  GATEWAY (local, fast, works offline — but ADVISORY ONLY)    │
│                                                               │
│  New module: gateway/policy/                                 │
│  - Ships a READ-ONLY CACHE of the active PolicyVersion,       │
│    pulled from the Control Plane over the tunnel and signed   │
│    by it (so the Gateway can verify it hasn't been tampered   │
│    with in transit or on disk).                                │
│  - Runs the SAME evaluation function (§4.1) as the Control    │
│    Plane, from a package shared by both:                      │
│    packages/policy-engine/ (new — pure logic, zero I/O,        │
│    imported by both gateway/policy and control-plane/policy). │
│  - Gives the agent adapter a fast local answer so a HIGH-risk │
│    action isn't attempted at all if it's locally known to      │
│    require approval — good UX, saves a round trip, and lets   │
│    AFK Mode (Phase 7) work with brief network blips.           │
│  - CANNOT ITSELF AUTHORIZE. Its ALLOW is a local optimization  │
│    hint, never the final word. It CAN locally enforce a DENY   │
│    early (no reason to even attempt something the floor        │
│    forbids), but every ALLOW and every APPROVAL_REQUIRED must  │
│    still be confirmed against the Control Plane before the     │
│    sandboxed action is permitted to run for HIGH/CRITICAL       │
│    actions. MEDIUM/LOW actions may proceed on the local ALLOW   │
│    alone when the tunnel is down (see §5.1) — this is the       │
│    explicit, bounded trade-off AFK Mode requires.               │
└───────────────────────────┬───────────────────────────────────┘
                            │ tunnel (existing, Phase 1/2)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  CONTROL PLANE (source of truth, cannot be bypassed)          │
│                                                               │
│  New module: control-plane/src/policy/                        │
│  - Owns the PolicyVersion table — the only writer.             │
│  - Runs the identical evaluation function from                 │
│    packages/policy-engine/ against the current version.        │
│  - This is the evaluation whose result is actually recorded    │
│    in the audit log (§8) and actually gates whether a           │
│    HIGH/CRITICAL command is forwarded down the tunnel to the    │
│    Gateway (via the existing tunnelServer.sendCommandToDevice   │
│    path, Phase 3) or blocked at the API layer entirely.         │
└─────────────────────────────────────────────────────────────┘
```

### 5.1 The AFK/offline trade-off, made explicit rather than accidental

A genuinely hard problem: AFK Mode's entire premise is that the user isn't watching, and Phase 2's reconciliation engine already handles the Gateway operating through network blips. What happens if the tunnel is down *and* the agent proposes a HIGH-risk action?

**Decision, stated so it can be challenged in review rather than discovered in an incident:** HIGH/CRITICAL actions **block and wait for the tunnel to recover**, up to the approval's `expiresAt` (§3.7), then fail closed (the action does not run; the session surfaces `session.failed` with reason `policy_check_unreachable`). This is a deliberate product trade-off — an agent that occasionally stalls on a bad action rather than running it unsupervised is the correct failure mode for a governance product. LOW/MEDIUM actions proceed on the Gateway's local cached policy, since the local cache is signed and no more than one policy-refresh-interval stale (default 5 minutes — configurable), and their risk is bounded by definition.

---

## 6. `packages/policy-engine` — Shared Pure Logic

New workspace package, structured exactly like `packages/protocol`/`packages/schemas` (which already exist and are proven):

```
packages/policy-engine/
├── src/
│   ├── evaluate.ts        # The §4.1 function. Pure: (action, context, policyVersion) => Decision
│   ├── deny-floor.ts       # §3.5 — the hardcoded floor
│   ├── specificity.ts      # §4.2 tiebreak logic
│   ├── risk-defaults.ts    # §4.1 step 4 defaults, per TrustProfile
│   └── index.ts
├── tests/
│   └── evaluate.test.ts    # Every case in §9, as direct unit tests — no server needed
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**Why a shared package rather than duplicating the function:** if the Gateway's copy and the Control Plane's copy of "what does this policy version say about this action" can ever disagree, the entire two-tier model in §5 collapses into two independently-wrong systems instead of one system checked twice. A single package, versioned and tested once, imported by both, is the only way to make "runs the same evaluation in two places" a guarantee rather than an aspiration. This exactly mirrors why `@freebuff/protocol` already exists as a shared package between Gateway and Control Plane — Phase 5 is applying a pattern the codebase has already validated twice.

---

## 7. Control-Plane Module Layout

```
freebuff/control-plane/src/policy/
├── policy-store.ts         # CRUD for PolicyRule/PolicyVersion (Postgres in prod,
│                           # MemoryDatabase in dev — extends the existing IDatabase
│                           # pattern from db/types.ts rather than inventing a new one)
├── policy-engine-service.ts # Wraps packages/policy-engine's evaluate() with I/O:
│                            # loads current PolicyVersion, device status, resolves
│                            # the decision, and is the ONLY caller of evaluate()
│                            # on the control-plane side
├── approval-workflow.ts     # §7.3 — the state machine
└── policy.schema.ts         # zod schemas for the API request/response bodies,
                              # added to @freebuff/schemas alongside the existing
                              # command/device/event/session schemas
```

### 7.1 New HTTP endpoints (extending `HttpRouter`, same file/pattern as existing routes)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/policy/versions` | List policy versions (admin/owner only) |
| `GET` | `/api/v1/policy/versions/current` | The active version + its rules |
| `POST` | `/api/v1/policy/versions` | Author a new version (creates, does not mutate) — owner-only |
| `POST` | `/api/v1/policy/versions/:id/activate` | Make a version current (atomic swap) |
| `POST` | `/api/v1/policy/evaluate` | **Internal-only** (Gateway→Control-Plane, authenticated via device cert same as tunnel auth) — used by the Gateway's local advisory check to confirm before executing MEDIUM+ actions when online |
| `GET` | `/api/v1/audit` | Paginated, filterable audit log query (§8.4) |
| `GET` | `/api/v1/audit/verify` | Triggers the standalone chain verifier (§8.3), returns pass/fail + first broken link if any |

Approval endpoints (`GET/POST .../approvals/...`) already exist from Phase 3 and are **extended, not replaced** — the decision endpoint now runs through `approval-workflow.ts` (§7.3) instead of directly mutating the record.

**Approval decision endpoint extension — voice feedback field:**

The existing `POST /api/v1/approvals/:id/decision` endpoint is extended with an optional `feedback` field:

```typescript
// Existing body (unchanged)
interface ApprovalDecisionRequest {
  approved: boolean;
  reason?: string;
}

// Extended body (new optional field)
interface ApprovalDecisionRequest {
  approved: boolean;
  reason?: string;
  feedback?: string;  // NEW — corrective instruction when denying, sent as session.message
}
```

**Behavior when `feedback` is present and `approved === false`:**
1. The existing CAS-and-record-the-denial logic runs first (unchanged)
2. After the denial is persisted, the `feedback` text is dispatched to the session as a `session.message` command via the same path `POST /sessions/:id/prompt` uses
3. This is NOT a new decision status — it is `denied` with a side effect
4. The `feedback` field is ignored when `approved === true` (no voice feedback on approval)

**Why this belongs in the approval workflow, not as a separate endpoint:** the corrective instruction is causally tied to the denial — it only makes sense *because* the action was rejected. Routing it through the same decision call keeps the operation atomic and the audit trail coherent (one audit event for the denial, with the feedback captured in the event's metadata).

### 7.2 Where the evaluation actually gets invoked

Two call sites, both new:

1. **Session command dispatch** (extending the existing `POST /sessions/:id/{prompt,pause,resume,...}` handlers and the `session.approval_required` event handler in `tunnel-server.ts`): before forwarding a HIGH/CRITICAL command to a Gateway, or immediately on receiving an adapter-initiated approval request, call `policyEngineService.evaluate(...)`. The result **replaces** trusting the adapter's self-declared `riskLevel` outright — the adapter proposes, the Policy Engine disposes.
2. **Gateway-initiated internal evaluate call** (`POST /api/v1/policy/evaluate`, §7.1) for the local-cache-refresh path in §5.

### 7.3 Approval workflow state machine

```
                  ┌──────────┐
    evaluate() ──▶│ pending  │
                  └────┬─────┘
         ┌─────────────┼─────────────────┬──────────────┐
         ▼             ▼                 ▼              ▼
    ┌─────────┐  ┌──────────┐    ┌──────────────┐  ┌───────────┐
    │ granted │  │  denied  │    │ timeout       │  │ superseded │
    └─────────┘  └──────────┘    │ (expiresAt    │  │ (device   │
                                 │  passed)      │  │  revoked  │
                                 └───────────────┘  │  mid-flight)│
                                                     └───────────┘
```

Required invariants, each directly answering a §9 test case:

- **First valid decision wins** (roadmap §9.5): the state transition from `pending` is a single atomic compare-and-swap on the record (`UPDATE ... WHERE status = 'pending'`, using the same optimistic-concurrency pattern any of the existing repositories would use) — a second decision arriving after the first (simultaneous approvals, e.g. two admins both tap Approve) is rejected with a 409, not silently overwritten.
- **Expired approval**: a background sweep (or lazy check-on-read — lazy is simpler and sufficient at this scale, matching the project's $0-infra bias) transitions `pending → timeout` once `expiresAt` passes; a decision attempt against an already-timed-out approval is rejected.
- **Revoked device approval**: `RevocationChecker` (Phase 2, already built and already exposes `onRevocation`) gets a **new listener registered in this phase**: on revocation, immediately transition every `pending` approval for that device to `superseded` and deny the underlying action. This is a direct, small integration into existing Phase 2 code (`gateway/certificate/src/revocation.ts`'s `RevocationStore.onRevocation`), not new infrastructure.
- **Policy change after request** (§9): the decision handler re-evaluates the action against the **current** policy version at decision time, not just at request time. If the current version would now `deny` where the requested version said `require_approval`, the approval is auto-denied with reason `policy_superseded` rather than left pending for a human to grant something policy no longer permits. If the current version now says `allow`, the pending approval is **left as-is** (a human already has it queued; approving it is harmless, and auto-resolving it out from under a reviewer who has it open is worse UX than a redundant tap).
- **Denial with feedback dispatches as session.message** (new — Hackathon Feature B dependency): a denial carrying non-empty `feedback` additionally dispatches that text to the session as a `session.message` command via the same path `POST /sessions/:id/prompt` uses. This is NOT a new decision status — it is `denied` with a side effect. The state machine's existing five terminal states (`pending/granted/denied/timeout/superseded`) remain unchanged — no sixth "redirected" status is needed, which keeps §9's existing test matrix valid without additions. **Cross-reference:** this invariant has a hard dependency on `ApprovalWorkflow` holding a reference to `TunnelServer` (see §7.4 below for the constructor injection requirement).

---

### 7.4 ApprovalWorkflow constructor — TunnelServer injection (critical, non-obvious change)

**⚠️ This is NOT just adding a field — it changes the constructor signature that every existing test already calls.**

The current `ApprovalWorkflow` is constructed with only `db` (the database repository). To support the denial-with-feedback invariant (§7.3), it needs a reference to `TunnelServer` to dispatch the `session.message` command.

**Current constructor:**
```typescript
constructor(db: IDatabase) { ... }
```

**New constructor:**
```typescript
constructor(db: IDatabase, tunnelServer: TunnelServer) { ... }
```

**Impact on existing tests:**
- Every test that constructs `ApprovalWorkflow` must be updated to pass a `TunnelServer` instance (or a mock)
- This is a **breaking change to the test harness**, not just a feature addition
- The `TunnelServer` dependency should be injected via the constructor (not imported directly) to maintain testability
- A `MockTunnelServer` or `TunnelServerStub` should be added to the test utilities, implementing only the `sendCommandToDevice` method needed by the feedback dispatch

**Why constructor injection, not a setter or a direct import:**
- Constructor injection makes the dependency explicit and compile-time-enforced
- A setter would allow construction without the dependency, deferring the error to runtime
- A direct import would couple `ApprovalWorkflow` to the concrete `TunnelServer` class, making testing impossible without the full tunnel stack
- This matches the pattern `HttpRouter` already uses for its own `TunnelServer` dependency (constructor injection)

**Module layout table update:**

| Module | Dependencies |
|---|---|
| `policy-store.ts` | `IDatabase` |
| `policy-engine-service.ts` | `IDatabase`, `PolicyStore`, `packages/policy-engine` |
| `approval-workflow.ts` | `IDatabase`, `TunnelServer` (NEW — for feedback dispatch) |
| `audit-log.ts` | `IDatabase` |

---

## 8. Audit Subsystem

### 8.1 Schema

```typescript
interface AuditEvent {
  id: string;                 // aud_<uuid>
  sequence: number;            // monotonic, global (single writer — see §8.2)
  timestamp: Date;
  actor: { type: 'user' | 'device' | 'system'; id: string };
  sessionId?: string;
  deviceId?: string;
  action: string;              // capability or 'approval.decision' | 'device.paired' | ...
  decision: 'allow' | 'deny' | 'require_approval' | 'granted' | 'denied' | 'timeout';
  policyVersion?: string;
  matchedRules?: string[];
  previousHash: string;        // hex sha256 of the prior AuditEvent's canonical form
  hash: string;                // hex sha256(canonicalize(this event, excluding `hash`) + previousHash)
}
```

### 8.2 Write path — single-writer, append-only, hash-chained

**Architecture decision:** the audit log has exactly one writer path (`auditLog.append(entry)`), which internally serializes writes (an in-process mutex/queue — sufficient at this project's scale, avoiding a distributed-lock dependency that would contradict the $0-infra stance) so `sequence` and `previousHash` are never computed from a stale read. Every other module that needs to record something audit-worthy (`policy-engine-service`, `approval-workflow`, the pairing manager, the revocation store) calls this one function; **no module writes to the audit table directly.** This is the same "one writer, everyone else calls in" discipline the certificate revocation store (Phase 2) already uses for its own listener-notification path — Phase 5 extends a pattern rather than inventing one.

`hash = sha256(canonicalJSON({...entry, hash: undefined}) + previousHash)`. Canonical JSON (sorted keys, no whitespace variance) is required — hashing a JS object's default `JSON.stringify` output without sorted keys makes the hash chain fragile to incidental serialization differences across Node versions, which would produce false tamper alarms. Use a small, dependency-free canonicalizer (this is a ~20-line function; not worth a dependency).

### 8.3 Standalone chain verifier (per the v2 roadmap's §2.2, built now rather than deferred)

```
scripts/verify-audit-chain.ts
```

A free-standing script — not a service — that:
1. Reads the full audit log (paginated) via the database directly (or via `GET /api/v1/audit` with an admin token, for the CI/cron variant).
2. Recomputes each `hash` from `(entry, previousHash)` and compares.
3. Reports the first index where the recomputed hash diverges, or a clean pass.

Runs (a) in CI as a job against a fresh test log, (b) as a nightly GitHub Actions cron against production, and (c) on-demand via `GET /api/v1/audit/verify` (§7.1) for an in-app admin check. This turns "tamper-evident" from an aspiration in a comment into something provable on any given day — matching the v2 roadmap's own framing of this requirement.

### 8.4 Query API

`GET /api/v1/audit?sessionId=&deviceId=&actor=&decision=&from=&to=&cursor=` — paginated (cursor-based, matching the pattern React Query and the rest of this plan already assumes), owner/admin-only. This is what makes the audit log *usable*, not just theoretically tamper-evident — a log nobody can practically query is a log nobody will notice tampering in.

---

## 9. Definition of Done — Every Required Test Case, Made Concrete

The roadmap lists nine required scenarios. Each is given here as a specific, automatable test against `packages/policy-engine` (unit) or `control-plane` (integration), so "Definition of Done" is a checklist that runs in CI, not a prose claim:

| # | Scenario | Test |
|---|---|---|
| 1 | Allowed action | `evaluate()` on a LOW-risk capability with no matching rule → `ALLOW`, no approval created |
| 2 | Denied action | `evaluate()` against a deny-floor match (e.g. `deployment.execute` on `production/**`) → `DENY`, terminal, verified that a `require_approval`-effect rule with higher declared priority still loses to the floor |
| 3 | Approval-required action | HIGH-risk capability, no explicit rule → `REQUIRE_APPROVAL`, `ApprovalRecord` created with correct `policyVersion`/`matchedRules` |
| 4 | Expired approval | Create an approval with `expiresAt` in the past (or advance a fake clock past it), attempt a decision → rejected, record shows `status: 'timeout'` |
| 5 | Duplicate approval | Two decisions submitted concurrently for the same approval → exactly one succeeds (200), the other gets 409, verified via the CAS invariant in §7.3 |
| 6 | Simultaneous approvals | Same as #5, phrased as the roadmap's own wording — same test, confirming "first valid decision wins" holds under real concurrency (`Promise.all` of two decision calls in the test, not just sequential calls) |
| 7 | Revoked device approval | Pending approval exists; device gets revoked via the existing `RevocationChecker` → approval transitions to `superseded`, the underlying action is denied, verified end-to-end through the Phase 2 revocation listener integration (§7.3) |
| 8 | Policy change after request | Approval requested under version A (`require_approval`); before decision, version B activates and would `deny` the same action → approval auto-resolves to `denied`, reason `policy_superseded` |
| 9 | Deny-override action | Any `PolicyRule` authored with `effect: 'allow'` targeting something on the deny floor → floor still wins (this is really the same guarantee as #2, tested again from the *rule-authoring* side: prove that no combination of authored rules, however permissive, can produce a different outcome for a floor-covered action) |
| 10 | Denial with feedback delivers session.message | Deny an approval with `feedback: 'Use a different approach'` → verify the mock adapter's `sendMessage` is called with the feedback text as the message, end-to-end through the TunnelServer dispatch path (§7.3, §7.4) |

Additional, non-roadmap-listed but implied by §5's two-tier model:

| # | Scenario | Test |
|---|---|---|
| 10 | Gateway/Control-Plane evaluation parity | Given the same (action, policyVersion) fixture, `packages/policy-engine`'s `evaluate()` produces byte-identical output whether invoked from `gateway/policy` or `control-plane/src/policy` — this is a property test, not a scenario test, and is what makes §5's whole architecture trustworthy rather than merely plausible |
| 11 | Offline HIGH-risk action fails closed | Tunnel disconnected, agent proposes a HIGH-risk action past the local cache's staleness window → session ends in `failed`, reason `policy_check_unreachable`, **not** silently allowed (§5.1) |
| 12 | Audit chain integrity | `scripts/verify-audit-chain.ts` passes on an untouched log; a test that hand-edits one stored event's `description` field and reruns the verifier confirms it fails at exactly that index |

---

## 10. Do NOT Build Yet (per roadmap, reaffirmed)

- A full enterprise policy designer (a GUI rule builder) — Phase 5 ships an API and a data model; authoring happens via that API (or a minimal admin form in Phase 4's app, which is a small additive screen, not a "designer")
- SIEM marketplace / export integrations — Phase 18 (Enterprise), deliberately deferred
- A custom policy programming language — the match-and-effect table in §3.4 is the entire policy surface, by design
- Per-organization multi-tenant policy inheritance — single-user/single-org scope for this phase; the schema (§7, `policy-store.ts`) should not preclude it later, but building it now is scope creep against a phase that is already the largest in the roadmap

## 11. Summary: What "Phase 5 Done" Actually Buys the Project

Before Phase 5, "safe remote control" is a claim resting entirely on adapters behaving honestly. After Phase 5, it is a claim resting on: a hardcoded floor no policy can weaken, a decision made once in a trusted location and never re-decided by the thing being governed, a paper trail that can prove after the fact whether that held, and a test suite that exercises every way the trust boundary could concretely fail rather than every way it's supposed to succeed. That is the difference between a demo and a product whose name people would trust with `production/**`.
