# Phase 8 — First Real Production Adapter: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 8
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents
**Target Milestone:** M8 (Two independently-built, real, non-mock agent CLIs run through the identical Device→Project→Session→Task→Event→Approval→Audit pipeline, with zero changes to Gateway Core between them)
**Depends on:** Phase 1 (Gateway Core, `AgentAdapter` interface), Phase 5 (Policy Engine — a real adapter is the first thing whose declared capabilities get evaluated against genuine, not scripted, risk), Phase 6 (Redaction — a real adapter is the first thing whose *actual* output, not a scripted fixture, needs to survive the redaction pipeline)
**Status:** Planning

---

## 1. Executive Direction & Scope

Every phase before this one has been tested against the mock adapter — a fully scripted fake that behaves exactly as its scenario file says it will. That's correct and deliberate (Phase 0's own framing: the mock agent is "perfect for testing... not a real agent"), but it also means **nothing in this codebase has yet been proven against an adapter whose behavior wasn't written by the same team that wrote the thing testing it.** Phase 8's entire purpose is that proof. The roadmap's goal statement is exact: *"Prove that the architecture works across vendor boundaries."* Not "add a feature" — prove a claim the previous seven phases have been making on credit.

### 1.1 What's already built, and what Phase 8 actually needs to add

This phase benefits enormously from a fact worth stating plainly before any design work: **the type system already contains, field-for-field, the exact compatibility-declaration model the roadmap asks for.**

| Roadmap requirement (§12) | Status |
|---|---|
| Adapter methods: `metadata / installOrDetect / validateEnvironment / startSession / sendMessage / streamEvents / requestApproval / abortSession / collectDiff / getState (roadmap: getStatus) / cleanupSession` | ✅ **Already the exact `AgentAdapter` interface** in `@freebuff/protocol` (`packages/protocol/src/types/commands.ts:82-107`) — including `sendInput`, `submitApprovalDecision`, and optional `pauseSession`/`resumeSession`/`checkpointSession`/`shutdown` the roadmap doesn't even ask for but the interface already supports |
| Compatibility declaration with `session_creation / prompt_delivery / streaming / cancellation / diff_collection / approval_interception` flags | ✅ **Already `AgentCapabilities`** (`packages/protocol/src/types/agent.ts:3-14`) — plus four more fields the roadmap's example doesn't list (`checkpointRecovery`, `multiTurn`, `fileOperations`, `toolExecution`) |
| "Supported / Partially supported / Unsupported" — never fake a capability | ✅ **Already `CapabilityLevel = 'supported' \| 'partial' \| 'unsupported'`** (`packages/protocol/src/types/agent.ts:1`) — the type makes faking a capability a type error, not just a code-review concern: there is no fourth value meaning "claim supported without actually supporting it" |
| Two agents run through the same Device/Project/Session/Task/Event/Approval/Audit model with zero Gateway Core changes | 🟡 **The model exists and is adapter-agnostic today** (Gateway Core has never once branched on which adapter is running — verified by inspection of `gateway/core/src/gateway.ts` and `agent-manager.ts`, neither of which contains adapter-specific logic). What's missing is simply **a second adapter to prove it with** — the mock adapter is the first; this phase's whole job is being honest that a second, real one behaves identically from Gateway Core's point of view. |

**The reframe this produces:** Phase 8 is not "design an adapter contract" — that's done, and done well; every gap the roadmap describes is already closed at the type level. Phase 8 is **"write two honest implementations of a contract that already exists, against two real CLIs that were never consulted while the contract was designed."** That's a genuinely different, narrower, and more testable kind of work than the roadmap's framing might suggest, and the plan below is sized accordingly — most of the engineering risk in this phase is in the *adapters themselves* (subprocess management, output parsing, the inevitable places a real CLI doesn't quite match what the interface expected), not in inventing new platform capability.

### 1.2 One correction to the roadmap's own suggested layout

The roadmap's §12 suggests `packages/adapters/opencode/`. The existing, already-established convention — used by the mock adapter, the only adapter that exists today — is `gateway/adapters/mock/`. New adapters should follow the **existing** convention (`gateway/adapters/opencode/`), not the roadmap's suggestion, because adapters are Gateway-side code (they run on the developer's machine, wrapping a local CLI), not shared cross-service packages the way `packages/protocol`/`packages/policy-engine` are. Deviating from the established directory shape here for no functional reason would be the kind of drift Phase 1–3's build-consistency work spent real effort eliminating.

---

## 2. Core Architectural Decisions for Phase 8

### 2.1 Agent selection, informed by the project's own prior research — not re-litigated here

`docs/agent-compatibility/compatibility-matrix.md` already ranks five candidates against this platform's specific requirements. Its own conclusion: **OpenCode first** (open source, released, a real JSON CLI, "Phase 8" listed as its own target phase in that document), **second adapter chosen only after a fresh compatibility validation** — which the roadmap's own §12 text says verbatim, meaning the roadmap and the compatibility research were already in agreement before this plan was written. This plan does not re-derive that choice; it builds the two adapters the prior research already pointed at.

- **Adapter 1 — OpenCode.** Confirmed choice, no re-validation needed — already researched, already the roadmap's own primary target.
- **Adapter 2 — chosen after re-running the compatibility check against whatever OpenCode's real integration teaches us about what actually matters.** The matrix currently ranks Antigravity second ("Excellent" fit — local-first, built-in sandbox, daemon mode) but flags a real gap: *"requires local LLM hardware."* Claude Code is ranked "Acceptable" but proprietary/paid/preview. **Do not pre-commit to Antigravity vs. Claude Code in this document** — Subphase 8.1 below includes the explicit re-validation step the roadmap requires, run with the benefit of hindsight from having just built one real adapter, which is exactly the sequencing the roadmap's own §12 text specifies ("The second adapter should be selected only after a fresh compatibility validation").

### 2.2 An adapter wraps a CLI; it does not reimplement one

The architectural temptation to avoid, explicitly: an adapter is a **thin translation layer** between a vendor's own process lifecycle/output format and `@freebuff/protocol`'s normalized shape — not a reimplementation of any part of what the vendor CLI already does. If OpenCode's CLI already handles conversation history, tool-call sequencing, or model selection internally, the adapter's job is to **observe and relay** that, via whatever the CLI exposes (stdout JSON stream, a local HTTP/RPC surface if OpenCode's server mode provides one — the compatibility matrix already notes OpenCode has "good JSON CLI"), never to duplicate that logic Gateway-side. An adapter that grows its own state machine mirroring the vendor CLI's internal one is an adapter that will silently drift from the real CLI's behavior the moment the vendor ships an update — exactly the vendor-lock-in-by-a-different-name this project's entire premise argues against.

### 2.3 Every gap between what the interface wants and what the real CLI provides is a `CapabilityLevel`, never a workaround

This is the single most important discipline in this phase, and it's worth being explicit about the failure mode it prevents. Suppose OpenCode's CLI has no native "pause mid-session" primitive. Two responses are available:

- **Wrong:** approximate pause by, e.g., silently buffering the agent's next output client-side and pretending the session is paused. This is exactly "faking a capability," which the roadmap's own §12 text forbids by name, and it's a worse outcome than admitting the gap — a user who thinks pause works and discovers under pressure that it doesn't has been actively misled, not just under-served.
- **Right:** `metadata().capabilities.pauseCapability` (if added — see §3.2) reports `'unsupported'`, `pauseSession` is simply omitted from the adapter (it's an optional interface method for exactly this reason), and Phase 4's UI (per its own plan's design, though the Pause button's disabled-state handling should be double-checked against this phase's real findings) grays out or hides the control rather than showing a button that lies about what pressing it does.

### 2.4 Real diff collection replaces the mock's fixture — the actual bridge to Phase 9

The mock adapter's `collectDiff()` (`gateway/adapters/mock/src/mock-adapter.ts:478`) returns a hardcoded fake unified-diff string describing a fictional `changes.md`. A real adapter's `collectDiff()` must return **actual `git diff` output** for whatever the agent actually changed in the project workspace — this is the first point in the whole roadmap where "diff review" (Phase 9) becomes reviewing something real rather than a fixture, and Phase 9's plan should be read as depending on this phase precisely here, not on anything else Phase 8 does.

---

## 3. Detailed Subphases

### Subphase 8.1 — Adapter 2 re-validation (do this first, cheaply, before committing engineering time)

Per §2.1, the roadmap explicitly requires re-running compatibility validation for the second adapter, and doing it *after* OpenCode work has started (not before) is deliberate — real integration work against one vendor CLI teaches things a desk review can't (e.g., "does this vendor's streaming output actually arrive in the shape their docs describe, under real network/process conditions"). This subphase is lightweight and desk-based:

**Work:** re-run the exact evaluation criteria `docs/agent-compatibility/compatibility-matrix.md` already used (local execution, sandboxing, daemon mode, session persistence, JSON event streaming) against the current state of Antigravity and Claude Code, informed by whatever Subphase 8.2 has surfaced by the time this runs. Produce `docs/agent-compatibility/adapter-2-decision.md` — a short, single-purpose addendum (not a rewrite of the existing matrix) recording the final choice and why, so the decision is traceable the same way every other architectural choice in this project has been.

**Definition of done:** a one-page decision record exists, naming Adapter 2 and citing which specific compatibility-matrix criteria drove the choice.

### Subphase 8.2 — `gateway/adapters/opencode`: scaffold and process lifecycle

**Work:**
```
gateway/adapters/opencode/
├── src/
│   ├── index.ts
│   ├── opencode-adapter.ts     # implements AgentAdapter
│   ├── process-manager.ts      # spawns/monitors the OpenCode CLI subprocess
│   ├── output-parser.ts        # translates OpenCode's native JSON stream into EventEnvelope
│   ├── capabilities.ts         # the honest AgentCapabilities declaration (§2.3)
│   └── types.ts                # OpenCode's own wire format, kept OUT of @freebuff/protocol
├── tests/
│   ├── opencode-adapter.test.ts       # against a scripted fake OpenCode binary (§3, below)
│   └── output-parser.test.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

**A hard rule on `types.ts`:** OpenCode's own JSON output shape is defined and used **only inside this package**. It never leaks into `@freebuff/protocol` or anywhere Gateway Core can see it — the entire point of the adapter boundary (§2.2) is that Gateway Core only ever sees `EventEnvelope`s, never a vendor's native format. A future contributor should be able to delete this entire package and Gateway Core should not need a single line changed elsewhere — this is the exact same containment test the hackathon-integration doc already applied to the Office Kit bridge, applied here to a vendor adapter instead of a hardware bridge, for the identical reason: an integration boundary that isn't actually contained isn't really a boundary.

**Process lifecycle, following the sandbox's already-proven pattern rather than inventing a new one:** OpenCode runs as a child process the adapter spawns through the **existing** `SandboxManager` (Phase 1), not a raw `child_process.spawn` the adapter manages itself — this is not new design, it's applying Phase 1's sandbox uniformly to the first real workload it will ever actually isolate (the mock adapter, being fake, never needed real isolation; this is the first adapter where the sandbox's guarantees matter for real).

**Definition of done:** `installOrDetect()` correctly finds (or reports the absence of) a real OpenCode binary on the test machine; `validateEnvironment()` checks OpenCode's actual minimum-version/config requirements; `startSession()` spawns it inside a sandbox and returns a real session id; `abortSession()` cleanly terminates it (verified: no orphaned process, matching the exact orphan-cleanup test discipline already proven in `spikes/sandbox`'s original test suite).

### Subphase 8.3 — Output normalization: OpenCode's native stream → `EventEnvelope`

**Work:** `output-parser.ts` translates whatever OpenCode's CLI actually emits (per the compatibility matrix, "good JSON CLI" — the exact shape needs confirming against the real, current CLI rather than assumed from the matrix's summary) into the fixed `EventType` vocabulary every other phase already consumes: a tool invocation becomes `session.tool_call`/`session.tool_result`, a file write becomes `session.file_changed`, a completion becomes `session.completed`. This is where Phase 6's redaction pipeline gets its first real test against non-scripted content — **the `RedactionProxy` (Phase 6) sits between this parser's output and everything downstream, unchanged, because it was built at the `wireAdapterEvents` chokepoint in Gateway Core, which by design does not know or care which adapter produced the event it's redacting.**

**Definition of done:** a captured-and-replayed real OpenCode session (run once against the real CLI, its raw output saved as a fixture, replayed deterministically in CI afterward — the same "record once, replay forever" pattern that keeps a test suite from depending on a live vendor CLI being installed and behaving identically on every CI run) produces the expected `EventEnvelope` sequence; and — reusing Phase 6's own reference fixture — a version of that captured session with a synthetic secret injected into a tool's output proves the secret is absent from the resulting events, exactly matching Phase 6's `leaky-output` scenario contract but against parsed-real-CLI-shaped data instead of the mock adapter's scripted shape.

### Subphase 8.4 — Approval interception and diff collection (the two hardest capabilities, treated with the honesty §2.3 demands)

**Approval interception:** whether OpenCode's CLI has any hook for "pause before this action, wait for an external decision" is the single biggest open question this phase has to answer empirically, not assume. Two real outcomes are both acceptable, and the difference between them must be visible in `AgentCapabilities.approvalInterception`:
- **If OpenCode supports it natively** (e.g., a `--confirm` flag or an interactive prompt the adapter can intercept via stdin): `approvalInterception: 'supported'`, and `requestApproval()` genuinely blocks the underlying process until Phase 5's policy engine (via the now-existing `TunnelServer.policyEvaluator` hook) returns a decision.
- **If it doesn't**: `approvalInterception: 'partial'` or `'unsupported'` (per whatever's actually true), and the adapter is honest that Phase 5's HIGH/CRITICAL-action blocking (the entire premise of the Policy Engine) **cannot be enforced mid-execution for this adapter** — only pre-execution (deny the session from starting a task that would need it) or post-hoc (audit that it happened, can't have prevented it). **This is not a failure of Phase 8** — it's exactly the kind of honest, visible degradation the roadmap demands, and it becomes a real, product-level finding: if OpenCode can't support true interception, that's a legitimate reason the compatibility matrix ranks it as the *first* integration to prove the architecture, not necessarily the *only* one a security-conscious user should run HIGH-risk unsupervised work against — which is exactly why Subphase 8.1's second-adapter validation matters as a genuine safety-relevant decision, not a checkbox.

**Diff collection:** `collectDiff()` shells out to `git diff` against the session's actual `projectRoot` (using the exact `safeGitExec`-style pattern already proven in `gateway/core/src/project-manager.ts`, reused rather than reimplemented) and returns the real unified diff — this directly replaces the mock's fixture and is the literal handoff point to Phase 9.

**Definition of done:** an integration test exercising a real OpenCode session that (a) makes at least one file change, verifying `collectDiff()` returns real, correct `git diff` output for that change, and (b) attempts one action at each declared risk level, verifying the adapter's actual behavior at each matches its own `AgentCapabilities` declaration exactly (if it claims `approvalInterception: 'unsupported'`, the test proves the action ran without blocking — proving the honesty of the declaration, not just its presence).

### Subphase 8.5 — Adapter 2 (per Subphase 8.1's decision), built to prove the contract generalizes

**Work:** repeat Subphases 8.2–8.4's structure for whichever agent Subphase 8.1 selects, in `gateway/adapters/<agent-2>/`. **Deliberately do not copy-paste OpenCode's `output-parser.ts` and edit it** — write it fresh against the second CLI's actual output shape. The entire point of this subphase is proving the *interface* generalizes, which a parser built by editing the first one would quietly undermine (you'd be testing "can I edit a parser," not "does the contract hold for an independently-shaped vendor format").

**Definition of done:** identical to Subphase 8.4's, run against Adapter 2, with one added assertion the roadmap states as the actual milestone: **the exact same Gateway Core code path — `wireAdapterEvents`, the session registry, the checkpoint store, the policy evaluator hook, the redaction proxy — handles both adapters with zero branching on which one is active.** This is checked concretely by running Gateway Core's existing integration test suite (`gateway/core/tests/integration/`) unchanged, once per adapter, and confirming it passes both times without a single adapter-specific conditional appearing anywhere in `gateway/core/src/`.

### Subphase 8.6 — Two-adapter end-to-end proof (the actual roadmap Definition of Done)

**Work:** one final test, deliberately positioned as the capstone rather than folded into the subphases above: start a session with OpenCode, run it through the full Device→Project→Session→Task→Event→Approval→Audit pipeline (pairing already established from Phase 2, a policy decision from Phase 5, redaction from Phase 6 verified in the loop, an audit trail entry recorded) — then do the **identical sequence** with Adapter 2, asserting the resulting `AuditEvent` records, `StoredEvent` shapes, and Control Plane API responses are structurally identical between the two runs (differing only in adapter-identifying fields like `agentId`, never in the shape of anything else).

**Definition of done:** this is, verbatim, the roadmap's own Phase 8 Definition of Done — reproduced here as an executable test, not a prose claim.

---

## 4. Directory Structure for Phase 8

```
freebuff/
├── gateway/adapters/
│   ├── mock/           # unchanged — remains the reference/test fixture adapter
│   ├── opencode/        # NEW — Subphase 8.2-8.4
│   └── <agent-2>/       # NEW — Subphase 8.5, name TBD per 8.1's decision
└── docs/agent-compatibility/
    └── adapter-2-decision.md   # NEW — Subphase 8.1's output
```

---

## 5. Phase 8 Definition of Done

- [ ] Adapter 2 selected via a documented, criteria-based re-validation (Subphase 8.1) — not assumed from this plan.
- [ ] `gateway/adapters/opencode` implements the full `AgentAdapter` interface against a real OpenCode installation, with an honest `AgentCapabilities` declaration — every `'unsupported'`/`'partial'` value backed by an actual tested limitation, not a guess.
- [ ] OpenCode's subprocess runs inside the existing `SandboxManager`, not a bespoke process-spawn path.
- [ ] A captured-and-replayed real OpenCode session fixture exists and is used in CI (no live-CLI dependency in the test suite itself).
- [ ] Phase 6's redaction pipeline is proven against real (captured, not scripted) adapter output, using the same `leaky-output`-style contract already established for the mock adapter.
- [ ] `collectDiff()` returns real `git diff` output — the literal handoff to Phase 9.
- [ ] Adapter 2 is built independently (not derived by editing OpenCode's parser) and passes Gateway Core's existing integration suite unchanged.
- [ ] **The capstone test**: identical Device→Project→Session→Task→Event→Approval→Audit sequences against both adapters produce structurally identical results, with zero adapter-specific branching anywhere in `gateway/core/src/`.

## 6. Do NOT Build Yet

- A third, fourth, or fifth adapter — two is the roadmap's own stated proof threshold; more adapters is real future work but not this phase's job
- Multi-agent orchestration (running Adapter 1 and Adapter 2 *together* on one task) — explicitly Phase 17, post-MVP
- An adapter marketplace / dynamic plugin loading — adapters remain first-party, built-and-shipped-with-the-Gateway code in this phase; a plugin system is a different, larger, and premature undertaking
- Vendor-specific UI (a "this is an OpenCode session" special screen in Phase 4) — the entire point of the normalized event model is that the UI never needs to know or care which adapter is running
