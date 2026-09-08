# Freebuff — Vendor-Neutral AFK Control Plane for AI Coding Agents

**One-line pitch:** Start an AI coding agent on your workstation, walk away, and supervise, approve, or stop it from your phone — with a mandatory sandbox, end-to-end encrypted pairing, and a server-side policy engine that no client can talk its way around.

**Tagline used internally:** *"Bring your own agent. We govern the work."*

> **Document status:** written 2026-09-08 against the actual source tree, not the plan documents. Where something is designed but not yet building/passing tests, this file says so explicitly rather than rounding up.

---

## Table of Contents

1. [What problem this solves](#1-what-problem-this-solves)
2. [The shape of the system](#2-the-shape-of-the-system)
3. [Services and components — what's actually built](#3-services-and-components--whats-actually-built)
4. [Feature inventory](#4-feature-inventory)
5. [How the mobile/web app actually works](#5-how-the-mobileweb-app-actually-works)
6. [How this orchestrates different AI coding agents ("vibe coding" tools)](#6-how-this-orchestrates-different-ai-coding-agents-vibe-coding-tools)
7. [A concrete end-to-end walkthrough](#7-a-concrete-end-to-end-walkthrough)
8. [Security model, in one table](#8-security-model-in-one-table)
9. [Tech stack and cost](#9-tech-stack-and-cost)
10. [Current build status — the honest version](#10-current-build-status--the-honest-version)
11. [What's next](#11-whats-next)

---

## 1. What problem this solves

AI coding agents (Claude Code, Codex, OpenCode, Antigravity, Cursor, and whatever ships next month) are good enough now that the useful move is often "give it a task and check back in twenty minutes" rather than watching every token. But every one of these tools ships as a **standalone, vendor-specific CLI or IDE plugin** with no shared way to:

- run it somewhere you're not staring at,
- stop it from doing something dangerous while you're not staring at it,
- get pinged the instant it needs a human, from whatever device is in your pocket,
- prove afterward exactly what it did and who approved what.

Freebuff is the layer that sits underneath **any** of those agents and gives you all four, without asking you to trust the agent vendor with that responsibility, and without locking you into one agent forever.

---

## 2. The shape of the system

Three cooperating pieces, none of which can do its job without the others, and — this matters — **no piece the other two implicitly trust more than the architecture requires**:

```
┌───────────────────────────┐
│   PHONE / BROWSER (PWA)    │   You. Supervising, approving, watching.
└─────────────┬───────────────┘
              │ HTTPS (REST) + WSS (live events)
              ▼
┌────────────────────────────────────────────────────┐
│              CLOUD CONTROL PLANE                     │
│  Auth · Device Registry · Sessions · Policy Engine   │
│  Approvals · Audit Log · Realtime Relay              │
└─────────────┬─────────────────────────────────────────┘
              │ WSS — Gateway dials OUT, never accepts inbound
              ▼
┌────────────────────────────────────────────────────┐
│           LOCAL AGENT GATEWAY (your machine)         │
│  Sandbox · Adapter (Claude Code / OpenCode / …)      │
│  Device Identity · Local Policy Cache · Checkpoints  │
└────────────────────────────────────────────────────┘
```

**Why the Gateway never accepts inbound connections:** it's the one running arbitrary AI-generated shell commands. Giving it an open port would mean the thing most likely to be compromised (an agent doing something unexpected) is also the thing reachable from the internet. Instead it always initiates outward, the same direction a browser opens to any website — nothing has to punch a hole in your home firewall.

**Why the Control Plane exists at all, instead of the phone talking straight to your laptop:** your phone and your laptop are almost never on the same network, and even when they are, NAT traversal for one-off developer machines is a support nightmare. The Control Plane is the one thing both sides can always reach, and — separately — it's where the trust decisions actually have to live (§8).

---

## 3. Services and components — what's actually built

This is an inventory of real code, organized by which of the three boxes above it lives in.

### 3.1 Local Agent Gateway (`freebuff/gateway/`)

| Module | What it does |
|---|---|
| **`core`** | The orchestrator — session registry, project manager, the HTTP API a local UI could hit, the event bus wiring every other module together |
| **`identity`** | Generates and stores this machine's Ed25519 keypair; computes the human-readable fingerprint ("display brush erase light option...") used for out-of-band pairing verification |
| **`pairing`** | The pairing-code state machine, rate-limited, that walks a new device from "unpaired" to "trusted" |
| **`certificate`** | A self-contained X.509 certificate authority — issues, chains, and revokes device certificates so a paired Gateway can prove who it is without re-doing the pairing dance every connection |
| **`reconciliation`** | Gap detection and durable event replay for when the tunnel drops mid-session — so "the WiFi blinked" never means "the session state is now a lie" |
| **`sandbox`** | Per-platform process isolation (Linux namespaces/cgroups, macOS Seatbelt, Windows Job Objects) — three configurable profiles (strict/standard/permissive) controlling filesystem, network, CPU, and memory |
| **`tunnel`** | The outbound WebSocket client to the Control Plane, with exponential-backoff reconnect and message-queue durability |
| **`checkpoint`** | Session-state persistence so a killed/crashed session can resume rather than vanish |
| **`health`** | Heartbeat, CPU/memory reporting up the tunnel |
| **`policy`** | *(Phase 5)* A local, signed cache of the active policy version, used for fast advisory checks — deliberately **not** the final word (§8) |
| **`adapters/mock`** | The reference adapter — a fully scripted fake agent used for testing every layer above without needing a real model or API key |

### 3.2 Cloud Control Plane (`freebuff/control-plane/`)

| Module | What it does |
|---|---|
| **`api/http-router`** | The REST surface: auth, devices, sessions (create/prompt/pause/resume/cancel/diff), approvals, events |
| **`auth`** | JWT issuance (access + refresh pair) and password hashing |
| **`db`** | A repository abstraction with a swappable backend — in-memory for tests/local dev, Firestore for a real deployment, Postgres path documented for self-hosting |
| **`tunnel/tunnel-server`** | The Gateway-facing WebSocket endpoint — authenticates devices by cert, relays commands down, receives events up, tracks online/offline status |
| **`tunnel/client-server`** | The phone/browser-facing WebSocket endpoint — authenticates by JWT, handles `subscribe_session`/`subscribe_device`, fans out events to whoever's subscribed |
| **`tunnel/connection-registry`** | The in-memory map of who's connected right now, on both sides, so an event knows who to reach |
| **`policy`** *(Phase 5)* | `policy-engine-service` (the authoritative evaluation call), `policy-store` (rule/version CRUD), `approval-workflow` (the approval state machine — pending/granted/denied/timeout/superseded), `audit-log` (the hash-chained write path) |

### 3.3 Shared packages (`freebuff/packages/`)

| Package | What it does |
|---|---|
| **`protocol`** | Every type that crosses a wire — `EventEnvelope`, `SessionState`, `ApprovalAction`, `SandboxConfig`, etc. Both the Gateway and the Control Plane import from here; neither is allowed to hand-roll its own copy |
| **`schemas`** | Zod runtime validation matching the protocol types, for anything arriving from outside the process |
| **`config`** | Shared defaults and environment-variable handling |
| **`policy-engine`** *(Phase 5)* | The actual decision algorithm — pure, synchronous, zero I/O — imported by *both* `gateway/policy` and `control-plane/src/policy` so the two sides can never silently disagree about what a policy says |

### 3.4 Apps

| App | Status |
|---|---|
| **`frontend/`** | A Next.js marketing/landing site ("SmartConnect") — public-facing, not authenticated, not part of the control loop |
| **`apps/web/`** (the actual mobile-first control center) | **Designed, not yet built** — see [docs/PHASE_4_EXECUTION_PLAN.md](docs/PHASE_4_EXECUTION_PLAN.md) for the full architecture |

---

## 4. Feature inventory

Grouped by what each feature actually buys you:

**Identity & trust**
- Ed25519 device keys generated and held locally — the private key never leaves your machine
- Out-of-band pairing (word-fingerprint comparison) so a machine-in-the-middle can't substitute its own key silently
- X.509 certificate issuance and revocation, so a stolen/compromised laptop can be cut off instantly
- Certificate verification checked against Node's own `X509Certificate` API — not just the encoder's self-consistency (this was a real bug found and fixed)

**Isolation**
- Mandatory sandboxing (Docker/native OS primitives) — the Gateway refuses to run an agent unsandboxed except in an explicit, loudly-logged dev-only mode
- Three tunable profiles trading off strictness vs. capability (strict / standard / permissive)
- Zero inbound ports on the Gateway, ever

**Reliability**
- Durable, replayable event log — a dropped connection mid-session doesn't lose history
- Exponential-backoff reconnect with jitter, on both the Gateway↔Cloud and (planned) Cloud↔Client legs
- Checkpoint/resume so a crashed session isn't a dead session

**Governance — the core of the project**
- A closed set of declared agent **capabilities** (`filesystem.write`, `process.exec`, `git.push`, `deployment.execute`, `secret.read`, …), not free-form strings an agent could invent to dodge a rule
- Risk classification (LOW/MEDIUM/HIGH/CRITICAL) with a real default even before you write a single custom rule
- A **hardcoded deny-override floor** — `production/**` deploys, `.git` deletion, `.env` reads — that no authored policy, however permissive, can weaken
- Server-side policy evaluation as the actual authority; the Gateway's local copy is an advisory speed optimization only, never the final word
- Approval workflow with real edge cases handled: expiry, duplicate/simultaneous decisions (first valid one wins, atomically), a mid-flight device revocation auto-denying anything pending, and policy changing between request and decision
- Hash-chained, append-only audit log, plus a standalone verifier script that can prove on any given day whether the chain has been tampered with

**Vendor neutrality**
- One `AgentAdapter` interface; the rest of the system (sandbox, tunnel, policy, UI) never knows or cares which agent CLI is underneath
- A researched, documented compatibility matrix scoring five real candidate agents against the platform's own requirements (§6)

**Redaction** *(designed, spiked, not yet wired into the live pipeline — Phase 6)*
- 50+ patterns for API keys, AWS credentials, private keys, JWTs, connection strings, already proven in `spikes/redaction` with sub-2s/MB performance

---

## 5. How the mobile/web app actually works

*(Describing the designed architecture from [docs/PHASE_4_EXECUTION_PLAN.md](docs/PHASE_4_EXECUTION_PLAN.md) — the control-plane API it consumes is already live; the app itself hasn't been built yet.)*

It's a **Progressive Web App**, not a native app (native iOS/Android is explicitly deferred — a $99/yr Apple Developer Program membership is the one line item in this whole project that isn't genuinely free, so it waits until there's a product worth paying for). PWA gets you:

- Install-to-homescreen on both iOS and Android from one codebase
- Push notifications (Web Push/VAPID) without needing an app store review cycle
- Works in any modern browser with zero install at all, if you'd rather not

**The five questions every screen is designed to answer, and nothing more** — this is a deliberate, stated product principle, not an accident of scope: *What is happening? Is it safe? Does it need me? What changed? What should I do?* It is explicitly **not a mobile IDE** — no code editor, no terminal emulator on the phone.

**Screens:** Home (machines / running agents / needs-attention / recently-completed), Machine (one workstation's status), Agent (one adapter's capabilities and current task), Live Session (streamed output, milestones, pause/resume/cancel), Approval (what's being asked, why, what triggered it, approve/deny), Diff Review (files changed, patch, risk indicators, commit action).

**Realtime:** the app opens its own WebSocket to the Control Plane's client-facing endpoint, authenticates with its JWT, and sends `subscribe_session`/`subscribe_device` messages. From then on, every `session.output`, `session.approval_required`, `session.completed`, etc. event the Gateway sends up the tunnel gets pushed straight down to the phone — no polling. If the phone's connection drops (goes into a tunnel, screen locks on cellular), it reconnects with backoff and **re-subscribes automatically**, then does one normal `GET` to catch up on missed state — deliberately not trying to replay individual missed WebSocket frames itself, because that correctness already lives in the durable event log one layer down.

**Auth:** access token held in memory only (never `localStorage` — this app embeds a diff viewer and a markdown renderer, both real XSS surface); refresh token in an `httpOnly` cookie the JavaScript can't read even if something did get injected.

---

## 6. How this orchestrates different AI coding agents ("vibe coding" tools)

This is the actual mechanism, not just the claim of "vendor neutrality":

### 6.1 The adapter contract

Every supported agent implements the same interface — the Gateway core is written against this interface and **never** against a specific vendor's CLI flags or output format:

```ts
interface AgentAdapter {
  installOrDetect(): Promise<AgentInstallationResult>;
  validateEnvironment(): Promise<AgentValidationResult>;
  startSession(config: SessionConfig): Promise<string>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream;
  requestApproval(sessionId: string, action: ApprovalAction): Promise<{approved: boolean}>;
  abortSession(sessionId: string, reason: string, force?: boolean): Promise<void>;
  // ...pause / resume / checkpoint / collectDiff / getState, all vendor-agnostic
}
```

To add a new agent, you write **one adapter** that wraps that vendor's own CLI or API and translates its output into this shape. Nothing in the sandbox, the tunnel, the policy engine, or the future web UI changes. This is the same discipline that made Kubernetes work for arbitrary container images instead of one blessed runtime — Freebuff applies it to AI coding agents instead of containers.

### 6.2 Normalization: every agent's chatter becomes the same event vocabulary

Whatever an agent actually prints — a JSON stream, log lines, a completion callback — the adapter translates it into `@freebuff/protocol`'s fixed `EventType` union: `session.started`, `session.output`, `session.tool_call`, `session.tool_result`, `session.file_changed`, `session.approval_required`, `session.completed`, `session.failed`, etc. This is why the *same* Live Session screen, the *same* Policy Engine, and the *same* audit log work identically whether the agent underneath is Claude Code or OpenCode — they never see the vendor's native format, only the normalized envelope.

### 6.3 Real research, not a hand-wave — the compatibility matrix

Five candidates were actually evaluated against the platform's own requirements (local execution, sandboxing, daemon mode, checkpoint/resume, JSON event streaming) — see [docs/agent-compatibility/compatibility-matrix.md](docs/agent-compatibility/compatibility-matrix.md):

| Agent | Fit | Why |
|---|---|---|
| **Antigravity** | ✅ Excellent | Local-first, built-in sandbox, daemon mode, webhook approvals — architecturally the closest match |
| **OpenCode** | ✅ Good | Open source, released today, solid JSON CLI — the pragmatic first real integration (Phase 8) |
| **Claude Code** | ⚠️ Acceptable | Great model quality, but proprietary and paid — planned for once it's GA |
| **Codex** | ❌ Poor | Cloud-only execution, which violates this project's local-first sandboxing guarantee outright — a deliberate non-goal, not an oversight |
| **Mock Agent** | ✅ Perfect for testing | Deterministic, zero dependencies — this is what every layer of the system above has actually been tested against so far |

### 6.4 Orchestration = one Gateway, many adapters, one governing pipeline

Concretely, "orchestration" here means: the Gateway's `AgentManager` holds a registry of installed adapters; when you start a session you pick which one; from that point every action the chosen agent proposes flows through the **identical** pipeline regardless of vendor — sandbox → (Phase 5) policy evaluation → execution → normalized event → tunnel → Control Plane → your phone. Multi-agent orchestration (running several agents in coordination on one task) is explicitly **Phase 17, post-MVP** — today's orchestration is "one agent at a time, fully governed," not yet "many agents collaborating."

---

## 7. A concrete end-to-end walkthrough

1. You install the Gateway on your dev machine, run it, and it prints a pairing code plus a word-fingerprint.
2. You open the Control Center on your phone, enter the code, and confirm the fingerprint **matches** what the Gateway printed — this is the moment a machine-in-the-middle attack would be visible, because the two fingerprints wouldn't match.
3. The Control Plane's CA issues your Gateway a device certificate. From now on it reconnects without repeating pairing.
4. From your phone, you start a session: pick a project, pick an adapter (say, OpenCode), type a task.
5. The Gateway spins up a sandboxed OpenCode process. Every tool call, file edit, and message it produces gets normalized into `EventEnvelope`s and streamed up the tunnel.
6. Your phone, subscribed to that session, sees it live — no refresh.
7. The agent wants to run `git push`. That's a HIGH-risk capability. The Policy Engine (Control Plane, authoritative) evaluates it, finds no rule saying otherwise, and returns `REQUIRE_APPROVAL`. An `ApprovalRecord` is created and pushed to your phone as `session.approval_required`.
8. You get the push notification, open the app, see *what* it wants to push, *why* policy flagged it, and tap Approve.
9. The decision flows back down the tunnel; the Gateway's sandboxed process is allowed to proceed; every step of this — the proposal, the policy decision, your approval — is written to the hash-chained audit log.
10. If your WiFi had dropped between steps 6 and 9, the Gateway's reconciliation engine would have replayed whatever the Control Plane missed the moment it reconnected — nothing silently vanishes.

---

## 8. Security model, in one table

| Question | Answer |
|---|---|
| Can the Gateway be reached from the internet? | No — zero inbound ports, ever |
| Can an agent do something dangerous without you knowing? | No for HIGH/CRITICAL actions — they block until the Control Plane (not the Gateway) decides |
| Can a compromised/patched Gateway grant itself permission? | No — the Gateway's policy check is advisory only; the Control Plane's evaluation is the one that's ever actually recorded or enforced for high-risk actions |
| Can a policy author accidentally (or deliberately) allow a production deploy? | No — the deny-override floor is hardcoded in source, reviewed by PR, and evaluated before any authored rule regardless of policy version |
| What happens if the network is down and the agent wants to do something CRITICAL? | It fails closed — the session ends in `failed`, the action does not run |
| Can someone tamper with the audit log after the fact without it being detectable? | No — it's hash-chained, and a standalone verifier script can prove a break at the exact index it occurred |
| What happens the instant a device is revoked? | Every pending approval for that device is immediately superseded and denied — not left dangling |

---

## 9. Tech stack and cost

TypeScript everywhere, pnpm workspaces, Vitest for tests, Node's native `crypto`/`http`/`ws` rather than heavy frameworks. The whole stack is deliberately chosen to run at **$0/month** — self-hosted Postgres/Redis or AWS's genuinely-always-free tier (Lambda, DynamoDB, SNS/SQS, API Gateway, Cognito Lite), Let's Encrypt for TLS, GitHub Actions for CI, Sigstore/cosign for release signing. The only two line items that are honestly not free: a real domain name (~$10-15/yr) and, only once native iOS ships, the Apple Developer Program ($99/yr) — both deliberately deferred past MVP. Full breakdown in [AI_Coding_Agent_AFK_Control_Plane_Build_Roadmap_v2.md](AI_Coding_Agent_AFK_Control_Plane_Build_Roadmap_v2.md).

---

## 10. Current build status — the honest version

- **Phases 0–3** (validation spikes, local Gateway, device identity/pairing, cloud control plane): built, committed, and verified — full workspace test suite passing at last verification.
- **Phase 5** (Policy Engine, Approvals, Audit): the architecture described in §3.2/§3.3/§4 above has been implemented — `packages/policy-engine`, `gateway/policy`, and `control-plane/src/policy` all exist with the deny-floor, evaluation pipeline, and approval-workflow state machine described here. **As of this document, the workspace does not currently compile cleanly** (`tsc --build` reports errors in the new policy-engine package — mismatched optional-property types and a couple of unused imports). This is normal in-progress state for a large phase, not a design problem; it needs a build-fixing pass before it can be called verified, the same way Phase 3 needed one before it was.
- **Phase 4** (the actual mobile/web control center): fully designed (§5, and the linked execution plan), zero lines of app code written yet.
- **Phases 6–18**: not started; described only in the roadmap documents.

---

## 11. What's next

In dependency order: finish making Phase 5 build and pass its test suite → build Phase 4's actual PWA against the now-governed session pipeline → Phase 6 (wire the already-proven redaction spike into the live pipeline) → Phase 7 (AFK push notifications, the feature the project is named for) → Phase 8 (swap the mock adapter for a real one — OpenCode first, per §6.3). Everything past that (multi-machine, observability, packaging, beta) is scaling and hardening a product that, at the end of Phase 8, already does the whole job this document describes.
