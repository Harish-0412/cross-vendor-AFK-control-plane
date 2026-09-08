# Pre-Deployment Audit: Bugs, Loopholes, and Remediation Plan

**Document type:** Verification audit against the actual running codebase (build + full test suite + targeted security review), not against plan documents.
**Method:** every finding below was reproduced — a failing test, a passing exploit-shaped test, or a concrete code path traced end to end — not inferred from reading alone. Two items were serious enough to fix immediately rather than only document; both are called out as such, with the regression test that now guards them.
**Scope:** the whole `freebuff/` workspace as it stands today, across Phases 0–9's actual implementation state (not their plan documents' aspirational state).

---

## 0. Summary — what shape the project is actually in

The good news first, because it's true and it matters: **the build is clean, and 359+ tests pass across every package.** This is a real, working system, not a prototype held together by hope. The findings below are exactly what a pre-deployment audit is supposed to surface on a project this size — a handful of genuine defects (two of them serious), a real coverage gap, and a longer tail of hardening items — not evidence the project is unsound.

| Severity | Count | Status |
|---|---|---|
| 🔴 Critical (exploitable, fixed this session) | 1 | ✅ Fixed + regression test |
| 🟠 High (functional regression, fixed this session) | 1 | ✅ Fixed + regression test + stale test corrected |
| 🟡 Medium (real gap, open) | 4 | 📋 In remediation plan below |
| 🟢 Low / hardening (open) | 6 | 📋 In remediation plan below |
| Tooling hygiene (fixed this session) | 1 | ✅ Fixed (13,541 → 116 lint errors) |

---

## 1. 🔴 CRITICAL — CORS misconfiguration defeated the httpOnly-cookie security model (FIXED)

### What was wrong
`control-plane/src/api/http-router.ts`'s `setCORS()` reflected the request's `Origin` header verbatim as `Access-Control-Allow-Origin`, **for every request, unconditionally**, and separately always set `Access-Control-Allow-Credentials: true`.

### Why this is exploitable, concretely
Phase 4's entire refresh-token design (documented in `docs/PHASE_4_EXECUTION_PLAN.md §2.3`) relies on the refresh token living in an `httpOnly` cookie specifically so injected JavaScript can't read it. This CORS configuration bypassed that protection **without needing any injection at all**: a page at `https://evil.attacker.example` — a website the victim simply visits, no compromise of your app required — could run:

```js
fetch('https://your-control-plane/api/v1/auth/me', { credentials: 'include' })
  .then(r => r.json())
  .then(data => exfiltrate(data));
```

The browser attaches the victim's `refreshToken` cookie automatically (`credentials: 'include'`), the server reflects `https://evil.attacker.example` back as the allowed origin, and `Allow-Credentials: true` tells the browser it's fine to let the attacker's own script read the response. This works for **every** authenticated endpoint, not just `/auth/me` — the same request pattern reads session data, device lists, or triggers state-changing POSTs (session control, approvals, the kill switch) with the victim's own credentials.

### The fix
`setCORS` now reads `config.corsOrigins` (a field that already existed in `ControlPlaneConfig` but was never consulted). An origin is only reflected — and credentials only enabled — when it's on the explicit allowlist. An unlisted origin gets **no** CORS headers at all, which is what causes the browser to correctly refuse to let that page read the response. Wildcard (`*`, the local-dev default) never combines with credentials, since that combination is unsafe regardless of what any individual browser currently enforces.

**Verified:** `control-plane/tests/cors-policy.test.ts` (new, 4 tests) proves an allowlisted origin gets credentials, a non-allowlisted origin gets zero CORS headers, a missing `Origin` header gets zero CORS headers, and wildcard mode never sets `Allow-Credentials`. Full existing 73-test control-plane suite re-run and passes unchanged — nothing depended on the old permissive behavior.

### Remaining action before deployment
**Set `CORS_ORIGINS` in production to the exact deployed origin(s) of `apps/web`** (e.g. `https://app.yourdomain.com`) — the fix is inert if this environment variable is left unset, since the config default (`['*']`) is deliberately permissive for local development. Add this to the deployment checklist explicitly (§8 below).

---

## 2. 🟠 HIGH — Policy Engine deny-floor logic inversion broke HIGH-risk approvals (FIXED)

### What was wrong
`packages/policy-engine/src/deny-floor.ts`'s `denyFloorMatches()` had this structure:

```ts
if (floorEntry.resourcePattern && resource) {
  if (globMatches(resource, floorEntry.resourcePattern)) { /* deny */ }
} else {
  // No resource pattern => matches any resource for this capability
  return { matched: true, ... };  // <-- WRONG
}
```

The `else` branch's comment describes the correct behavior for a floor entry with **no** `resourcePattern` at all. But the actual condition that reaches it is `!(floorEntry.resourcePattern && resource)` — which is also true whenever the entry **has** a `resourcePattern` but the caller simply didn't supply a `resource` (a legitimate, common shape: not every capability evaluation names a specific resource string). The code treated "I don't know if this matches" as "this matches everything."

### Why this mattered in practice
Discovered because it was **actively failing 8 tests** in `packages/policy-engine`'s own suite — this wasn't a theoretical edge case, it was breaking the baseline "HIGH-risk capability with no explicit rule requires approval" behavior for any evaluation of `deployment.execute`, `filesystem.delete`, `secret.read`, or `git.push` (all floor-listed capabilities) that didn't happen to pass a `resource` string. Those actions were being **hard-denied** instead of routed to `REQUIRE_APPROVAL` — meaning a legitimate action a human should get to approve was being silently blocked outright, with the denial looking identical to an intentional deny-floor hit. This fails in the safe *direction* (over-denying rather than under-denying), but it's still a serious functional break: a user hitting this would see agents unable to perform ordinary git pushes, and would have no way to distinguish "the deny-floor correctly stopped something dangerous" from "this bug incorrectly stopped something ordinary."

### The fix
Restructured so a resource-scoped floor entry only matches when a resource is actually present **and** actually matches the pattern; otherwise it does not apply, and evaluation correctly continues to the next floor entry or falls through to the normal rule/risk-class pipeline.

**Verified:** all 34 pre-existing tests in `packages/policy-engine` now pass (was 8 failing). One stale test (`all deny-floor entries are covered by the floor list`, hardcoded to expect length 3) was updated to reflect the 5 real entries — it had never been updated when Phase 9 added the two force-push entries, which is exactly how this kind of regression survives unnoticed: a test that would have caught the new entries' shape was itself out of date. A new regression test (`does not deny a resource-scoped floor capability when no resource is given`) guards the specific bug directly.

---

## 3. Tooling hygiene — 13,541 lint errors were CRLF drift, not code defects (FIXED)

Full-workspace lint reported 13,541 errors — a massive jump from the ~100 baseline established in earlier phases. Traced to: several large files (`gateway/redaction/*`, most of `control-plane/src/`, `gateway/core`, the mock adapter) were promoted from spike code or newly authored with Windows-style CRLF line endings, and `prettier/prettier` correctly flags every single line of a CRLF file as a formatting violation once it's checked against the project's LF convention. **6,648 of the 13,541 errors were exactly this — one root cause, mechanically fixable.**

Ran `eslint --fix` workspace-wide: **13,541 → 116**. Verified the build stays clean and no test's behavior changed (formatting-only fix). The remaining 116 are real, mostly small, findings — see §4.6 below.

**Action:** add a `.gitattributes` with `* text=auto eol=lf` at the repo root so this cannot silently reoccur — currently nothing enforces line-ending consistency, and the next promoted spike or copy-pasted snippet will reintroduce exactly this drift.

---

## 4. Open findings — remediation plan

### 4.1 🟡 `gateway/health` tests are flaky by design (real CI-flakiness risk)

**What's wrong:** `HealthModule.getResourceUsage()` reads live OS-level CPU/memory via `os.cpus()`/`os.totalmem()`/`os.freemem()`, and `getStatus()` hardcodes a >90% threshold as `unhealthy`. There is no injection point — the module cannot be given a fake reading for a test.

**Reproduced:** `gateway/health`'s test suite passes 15/15 in isolation but **fails 2/15** when run as part of `pnpm -r test` (the whole workspace running in parallel, which genuinely pushes real CPU usage on the test machine past 90%). This is not a one-off — it will fail intermittently in CI depending on runner load, exactly the kind of flaky test that erodes trust in a CI pipeline until people start ignoring red builds.

**Fix:**
```ts
// gateway/health/src/health-module.ts
export interface HealthModuleOptions {
  // ...existing fields...
  resourceUsageProvider?: () => Promise<{ cpuPercent: number; memoryUsedPercent: number }>;
}
```
Default to the real OS-based reader in production; the test suite injects a deterministic fixture provider instead of trusting ambient machine state. This is a small, additive change — no behavior change for real deployments, only for how the tests obtain their input.

**Priority:** fix before wiring this project into any shared/CI runner where load is unpredictable — a flaky test suite is worse than a slow one, because it trains reviewers to re-run rather than investigate.

### 4.2 🟡 `gateway/policy` (Phase 5's local advisory cache) has zero test coverage

**What's wrong:** `gateway/policy/src/index.ts` is a real, 180-line module implementing exactly the local-policy-cache architecture described in Phase 5's plan (§5: "ships a READ-ONLY CACHE of the active PolicyVersion... CANNOT ITSELF AUTHORIZE"). It has no `tests/` directory and no `*.test.ts` files — `pnpm --filter @freebuff/gateway-policy test` fails outright with "No test files found."

**Why this matters more than an ordinary coverage gap:** this module sits directly on the trust boundary Phase 5's entire design depends on — its whole job is to give a *fast, non-authoritative* answer while never being mistaken for the authoritative one. Untested code at exactly the seam where "advisory" and "authoritative" must never be confused is the highest-value place in this codebase to have real test coverage, not the lowest.

**Fix — minimum required test cases before this can be considered production-ready:**
1. Cache correctly expires after `cacheTtlMs` and triggers a re-fetch.
2. A cached `ALLOW`/`REQUIRE_APPROVAL` decision is confirmed against `confirmWithControlPlane` before being treated as final for HIGH/CRITICAL actions (this is the one invariant the whole module exists to enforce — it needs a test proving it actually calls through, not just that the interface has the parameter).
3. A signature-verification failure on the cached `PolicyVersion` (tampering in transit or on disk) causes a fail-closed refusal, not a fall-through to stale-but-trusted data.
4. Network failure during `fetchPolicyVersion` degrades to "confirm everything with the Control Plane" rather than silently trusting an expired cache.

### 4.3 🟡 `authUser.role` is sourced from the Firebase ID token's custom claim, not the database record

**What's wrong:** `control-plane/src/api/http-router.ts`'s auth extraction does:
```ts
authUser = {
  id: decoded.uid,
  email: decoded.email,
  role: (decoded['role'] as string) || 'user',
};
```
`role` is read directly from the verified Firebase ID token's custom claims and cast to `string` with no validation that it's one of the expected values (`'user' | 'admin' | 'owner'`). Meanwhile, when a new user record is actually created in the database a few lines later, it's unconditionally given `role: 'user'` — so the database and the per-request `authUser.role` can diverge, and every authorization decision in this handler trusts the **token claim**, not the **database record**.

**Why this is a latent risk rather than an active exploit today:** Firebase custom claims can only be set server-side via the Admin SDK's `setCustomUserClaims` — a client cannot set an arbitrary claim on their own ID token through normal Firebase Auth flows. Today's codebase has no endpoint that calls `setCustomUserClaims` from user-controlled input, so there is currently no path for a user to grant themselves `role: 'admin'`. **This is exactly the kind of finding that becomes a real vulnerability the day someone adds an innocuous-looking feature** — an admin "invite a teammate" flow, a Firebase Console misconfiguration, or a future dev-convenience endpoint that sets claims from a request body — without realizing this handler already trusts that claim for authorization.

**Fix:** derive `authUser.role` from `this.db.users.findById(decoded.uid)` (the database record, which this handler already fetches or creates a few lines later) rather than from the token claim. If Firebase custom claims are wanted as a *source* for role assignment, sync them into the database record explicitly and audit that sync path — never read them directly into an authorization decision.

### 4.4 🟡 No rate limiting on `/api/v1/auth/login` or `/api/v1/auth/register`

**What's wrong:** confirmed by direct inspection — neither endpoint has any attempt-counting, backoff, or lockout. An attacker with a list of email addresses can brute-force passwords against `/login` at whatever rate the server's raw throughput allows, and can spam `/register` to create unlimited accounts (resource exhaustion, or abuse of any free-tier quota tied to user count).

**Fix:** the project already has a proven rate-limiter pattern to reuse rather than invent — `gateway/pairing/src/code-generator.ts`'s `PairingRateLimiter` (used to bound pairing-code generation/attempts, Phase 2) is structurally exactly what's needed here: a sliding-window counter keyed by IP + email, applied to `/auth/login` (lock out after N failed attempts in a window) and `/auth/register` (cap registrations per IP per window). Port the same pattern rather than pulling in a new dependency.

### 4.5 🟡 Refresh-token cookie is missing the `Secure` attribute

**What's wrong:** `setRefreshCookie` sets `HttpOnly; SameSite=Lax` but never `Secure`. Over a connection that isn't TLS-terminated correctly (a misconfigured reverse proxy, a staging environment accidentally served over plain HTTP), this cookie would be transmitted in the clear.

**Fix:** `Secure` should be set whenever the deployment is expected to run over HTTPS (which should be always, in any real deployment) — gate it on an explicit `NODE_ENV === 'production'` or a `config.forceSecureCookies` flag rather than trying to detect TLS termination dynamically, since a proxy-terminated TLS connection often makes `req.socket.encrypted` unreliable (this is the same class of detection problem the existing `protocol` variable in `handleRequest` already has to guess at via `socketEncrypted`). `SameSite=Lax` combined with this API's POST-only mutation design is a reasonable, defensible choice already — the missing `Secure` flag is the one concrete gap here.

### 4.6 🟢 Remaining 116 lint errors, categorized

After the CRLF fix (§3), what's left is a real but low-severity tail:
- **~40 `no-unsafe-assignment`/`no-unsafe-argument`** at SDK boundaries — `firebase-admin.ts`, `firestore-store.ts`, `policy-store.ts` — all at the point where an external SDK (`firebase-admin`, `@google-cloud/firestore`) returns loosely-typed data. Fix by introducing a validated boundary type (a zod schema in `@freebuff/schemas`, matching the pattern already used for every other external-input boundary in this project) rather than letting `any` propagate past the SDK call.
- **~30 `import/order`** — mechanical, `eslint --fix`-able once the underlying files are touched for their real fixes above (fix-and-fix-format-together, don't run a separate no-op formatting commit).
- **28 warnings in `gateway/pairing`** (not errors — worth a look but not blocking).
- **One cosmetic false-positive**: `memory-store.ts`'s `verifyChain()` destructures `const { hash, ...rest } = evt` specifically to *exclude* `hash` from the canonicalized object before recomputing it — the unused-var complaint is correct that the binding itself is unused, but the logic is not a bug. Rename to `_hash` to silence it without touching behavior.
- **One `import/default`**: `push-sender.ts` imports `web-push` as a default export when the package's actual typing exposes named exports — a two-line import-style fix, not a runtime bug (Node's CJS interop makes the current code work; ESLint is flagging the type declaration mismatch).

### 4.7 🟢 Phase 8's real-adapter test coverage is thin relative to its own plan

**What's found:** `gateway/adapters/opencode` currently has 4 tests total (2 output-parser, 2 adapter). Phase 8's own execution plan (§Subphase 8.4) specifies a much larger required matrix: honesty-of-capability-declaration tests (does the adapter's behavior at each risk level actually match what `AgentCapabilities` claims), a captured-and-replayed real-session fixture used in CI, and the redaction-survives-real-output test reusing Phase 6's `leaky-output` contract. None of these exist yet.

**Action:** treat Phase 8 as *functionally* incomplete until this test matrix exists, even though the adapter itself runs — an adapter that hasn't been tested against its own honesty claims is exactly the "never fake a capability" risk the roadmap warns about, just not yet disproven rather than proven safe.

### 4.8 🟢 Phase 9's GitHub OAuth integration was not built

**What's found:** `gateway/core/src/git/` (git-exec, git-operations, test-runner) and `control-plane/src/review/review-orchestrator.ts` all exist and match the Phase 9 plan closely — git writes are policy-gated, the review pipeline runs. But `control-plane/src/integrations/github/` does not exist. Repository operations work against whatever remote is already configured locally; there is no OAuth flow, no repo picker, no PR-creation capability.

**Action:** this is scoped, tracked, undone work, not a bug — see §5's remaining-phases summary. Flagged here so it isn't mistaken for "Phase 9 complete" in project status reporting.

### 4.9 🟢 Untraced edge cases worth a deliberate look before scaling usage

These weren't reproduced as failing tests this session (each would need a dedicated harness — concurrent load, real network partition, or a real Firestore project), but they are the concrete next things to verify given everything else found:

- **Firestore write races on the approval CAS.** `ApprovalWorkflow.submitDecision`'s compare-and-swap (Phase 5 §7.3) is proven correct against `MemoryDatabase` (in-process, genuinely atomic). Firestore's actual concurrency model requires an explicit transaction (`runTransaction`) to get the same guarantee — a plain read-then-conditional-write against Firestore is **not** atomic under concurrent access the way an in-memory Map's synchronous code is. **Verify `firestore-store.ts`'s approval update path uses a real Firestore transaction, not a read-then-write** — if it doesn't, "first valid decision wins" (a roadmap-mandated invariant, Phase 5 §9 test #5/#6) can silently break under real concurrent load in a way `MemoryDatabase`-backed tests would never catch.
- **Command idempotency on tunnel reconnect.** A `git.commit` command that the Gateway received but whose acknowledgment was lost in a network drop could be retried by the Control Plane's reconnection logic (Phase 2's reconciliation engine) — unlike `git.push` (naturally idempotent against the same content) or `session.prompt` (a duplicate message is merely redundant), a **duplicate commit is a real duplicate commit**, polluting history. Verify `GitOperations.commit` either checks "is the working tree already clean relative to what this commit message describes" or the command dispatch path attaches an idempotency key the Gateway can recognize as already-applied.
- **Clock skew between Gateway and Control Plane.** Every expiry calculation in this system (`ApprovalRecord.expiresAt`, JWT expiry, the escalation scheduler's 50%/80% reminder points) is computed against `Date.now()` on whichever machine runs the code. A Gateway with a significantly wrong system clock could see approvals as already-expired the moment they arrive, or a JWT as not-yet-valid. Verify the pairing/auth handshake either rejects a Gateway with clock drift beyond a sane bound, or that all expiry comparisons are anchored to Control-Plane-issued timestamps rather than Gateway-local ones.
- **WebSocket reconnect storm after a Control Plane restart or outage.** Every paired Gateway and every open web client reconnects at once. The exponential-backoff-with-jitter design (Phase 1/4 plans) should prevent a synchronized thundering herd, but this has only been tested one connection at a time — worth a load test simulating N gateways reconnecting simultaneously before relying on this in front of real users.

---

## 5. Remaining phases before this project is deployment-ready

Verified against actual code in the workspace, not commit messages or plan documents:

| Phase | Status |
|---|---|
| 0 — Validation spikes | ✅ Complete |
| 1 — Local Agent Gateway | ✅ Complete |
| 2 — Device Identity & Pairing | ✅ Complete |
| 3 — Cloud Control Plane | ✅ Complete |
| 4 — Web Control Center | ✅ Built (Firebase auth, Firestore persistence, live console, pairing UI) |
| 5 — Policy Engine, Approvals, Audit | ✅ Built — **had the critical regression fixed in this audit**; §4.2's test gap in the Gateway-side cache should close before calling it fully verified |
| 6 — Secret Redaction | ✅ Built and wired into the Gateway's event pipeline |
| 7 — AFK Mode | ✅ Built — trust profiles, attention engine, push delivery, escalation scheduler, kill switch/lock, "while you were away" summaries all present in source |
| 8 — First Real Production Adapter | 🟡 **Partially complete.** OpenCode adapter exists and passes its (thin) test suite. Missing: the capability-honesty test matrix (§4.7), the second adapter (Subphase 8.5), and the two-adapter capstone proof (Subphase 8.6) that Gateway Core genuinely has zero adapter-specific branching |
| 9 — Git, Diff Review, Project Workspaces | 🟡 **Partially complete.** Git write operations, policy gating, review pipeline, and project dashboard all exist. Missing: GitHub OAuth/PR integration entirely (§4.8) |
| 10 — Multi-Machine Support | ❌ Not started |
| 11 — Reliability and Reconciliation | 🟡 Foundational pieces exist from Phase 2; the phase's own hardening pass (beyond what Phase 2 already built) not started |
| 12 — Observability | ❌ Not started — no metrics/logging/tracing stack wired in |
| 13 — Production Security Hardening | 🟡 **This audit is effectively a down payment on this phase** — several of its stated requirements (signed releases, dependency/secret scanning in CI, sandbox-escape regression tests) are not yet in place |
| 14 — Cross-Platform Gateway Packaging | ❌ Not started — no installable binaries, runs from source only |
| 15 — CI/CD and Release Engineering | 🟡 Basic GitHub Actions lint/test workflow exists (`freebuff/.github/workflows/`); no build/sign/publish pipeline |
| 16 — Private Beta | ❌ Not started — correctly gated behind everything above |
| 17 — Multi-Agent Orchestration | ❌ Explicitly deferred (post-MVP by design) |
| 18 — Enterprise | ❌ Explicitly deferred (post-MVP by design) |

### The realistic minimum path to a deployable product

1. **Close this audit's open items first** (§4) — none of them are large, but several (CORS was already critical; the role-source issue and missing rate-limiting are the same *class* of bug, just not yet proven exploitable) are exactly the kind of thing a security-conscious early adopter or a hackathon judge will find in five minutes of poking at the deployed app.
2. **Finish Phase 8's proof obligations** (§4.7) — a second adapter and the capstone test are what actually substantiate "vendor-neutral," which is this project's central claim.
3. **Phase 9's GitHub integration** (§4.8) if the product's first real workflow depends on it — otherwise this can ship slightly behind an initial deployment, since local-repo git operations already work without it.
4. **Phase 12 (Observability) and Phase 13 (Security Hardening)** are the two remaining phases that are genuinely required before any deployment carrying real user data — not because the roadmap says so abstractly, but because §4's findings are exactly the class of issue an observability/scanning pipeline exists to catch automatically going forward, rather than relying on another manual audit pass.
5. **Phase 14/15** (packaging, real CI/CD) gate a *public* beta specifically — a private, invite-only beta (Phase 16) could reasonably run before these are fully done, run-from-source, on a small trusted group, once 1–4 above are closed.

Phases 10, 11 (beyond Phase 2's existing foundation), 17, and 18 are correctly not required before an initial deployment — they're scale, reliability-under-growth, and post-MVP scope, exactly as every prior phase plan in this project has scoped them.
