# Odysseus — Vendor-Neutral AFK Control Plane for AI Coding Agents

**One-line pitch:** Start an AI coding agent on your workstation, walk away, and supervise, approve, or stop it from your phone — with a mandatory sandbox, end-to-end encrypted pairing, a server-side policy engine that no client can talk its way around, and a real-time web/mobile control center that works from any browser.

**Tagline:** *"Bring your own agent. We govern the work."*

> **Document status:** Written 2026-09-08 against the actual source tree through Phase 9 and the completed frontend implementation. Where something is designed but not yet live, it is stated explicitly.

---

## Table of Contents

1. [What problem this solves](#1-what-problem-this-solves)
2. [The shape of the system](#2-the-shape-of-the-system)
3. [Services and components — what is actually built](#3-services-and-components--what-is-actually-built)
4. [Feature inventory](#4-feature-inventory)
5. [The frontend control center](#5-the-frontend-control-center)
6. [How Odysseus orchestrates different AI coding agents](#6-how-odysseus-orchestrates-different-ai-coding-agents)
7. [A concrete end-to-end walkthrough](#7-a-concrete-end-to-end-walkthrough)
8. [Security model](#8-security-model)
9. [Tech stack and cost](#9-tech-stack-and-cost)
10. [Phase-by-phase build history](#10-phase-by-phase-build-history)
11. [API surface reference](#11-api-surface-reference)
12. [What is next](#12-what-is-next)

---

## 1. What problem this solves

AI coding agents — Claude Code, OpenCode, Antigravity, Codex, Cursor, and whatever ships next month — are now capable enough that the right move is often "give it a task and check back later." But every one of these tools ships as a standalone, vendor-specific CLI or IDE plugin with no shared way to:

- Run it somewhere you are not watching it
- Stop it from doing something dangerous while you are not watching
- Get notified the instant it needs a human decision, from any device
- Prove afterward exactly what it did, who approved what, and when
- Switch to a different agent model without rewriting your entire workflow

Odysseus is the layer that sits underneath **any** of those agents and delivers all five properties, without asking you to trust the agent vendor with that responsibility, and without locking you into one agent forever.

The guiding product principle: **one agent at a time, fully governed**. Not a multi-agent orchestrator, not a cloud sandbox you cannot audit — a transparent, on-premises process governor that happens to relay through a cloud relay you control.

---

## 2. The shape of the system

Three cooperating pieces. None can do its job without the others. None trusts the others more than the architecture requires.

```
┌─────────────────────────────────────────────────────────────┐
│               PHONE / BROWSER (PWA / Web App)                │
│  Dashboard · Sessions · Approvals · Devices · Audit · Policy │
│  Projects · Integrations · Budgets · Routing · Settings      │
└──────────────────────────┬──────────────────────────────────┘
                           │  HTTPS (REST) + WSS (live events)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   CLOUD CONTROL PLANE                         │
│  Auth · Device Registry · Sessions · Policy Engine           │
│  Approvals · Audit Log · Realtime Relay · GitHub OAuth        │
│  Secret Redaction · Budget Enforcement · Project Management   │
└──────────────────────────┬──────────────────────────────────┘
                           │  WSS — Gateway dials OUT, never accepts inbound
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              LOCAL AGENT GATEWAY  (your machine)              │
│  Sandbox · Adapter (Claude Code / OpenCode / Antigravity …)  │
│  Device Identity · Local Policy Cache · Checkpoints          │
│  Secret Redaction · Git Operations · AFK Orchestrator         │
└─────────────────────────────────────────────────────────────┘
```

**Why the Gateway never accepts inbound connections:** it is the process running arbitrary AI-generated shell commands. An open port on the most likely-to-be-compromised component is unacceptable. The Gateway always dials out, the same direction a browser opens a website — nothing has to punch a hole in a firewall.

**Why the Control Plane is not just peer-to-peer:** the phone and the laptop are almost never on the same network. NAT traversal for one-off developer machines is a support nightmare. The Control Plane is the one routable point both sides can always reach, and it is where trust decisions must live — not because it is convenient, but because a Gateway that could approve its own high-risk actions would be trivially bypassable.

---

## 3. Services and components — what is actually built

### 3.1 Local Agent Gateway (`odysseus/gateway/`)

| Module | What it does |
|---|---|
| **`core`** | The orchestrator — session registry, project manager, the local HTTP API, the event bus wiring everything together |
| **`identity`** | Generates and stores the machine's Ed25519 keypair on first run; derives the human-readable word-fingerprint used for out-of-band pairing verification |
| **`pairing`** | The pairing-code state machine — rate-limited, TTL-bounded, walks a new device from `idle` through `awaiting_user_input`, `awaiting_fingerprint_confirm`, `awaiting_certificate`, to `paired` |
| **`certificate`** | A self-contained X.509 certificate authority that issues, chains, and revokes device certificates so a paired Gateway can prove its identity on reconnect without repeating the pairing flow |
| **`reconciliation`** | Gap detection and event-log replay for tunnel drops — "the WiFi blinked" never means "the session state is now wrong" |
| **`sandbox`** | Per-platform process isolation: Linux namespaces + cgroups, macOS Seatbelt, Windows Job Objects. Three configurable profiles (strict / standard / permissive) controlling filesystem access, network, CPU, and memory |
| **`tunnel`** | The outbound WebSocket client to the Control Plane with exponential-backoff reconnect, jitter, and a message-queue for durability across brief disconnects |
| **`checkpoint`** | Session-state snapshot and restore so a killed or crashed gateway session can resume instead of vanish |
| **`health`** | CPU/memory heartbeat published up the tunnel; injectable `resourceUsageProvider` for test isolation |
| **`policy`** | A local, signed cache of the active policy version (TTL-bounded, advisory only — the Control Plane is always authoritative for recorded decisions) |
| **`redaction`** | Phase 6 — 50+ patterns covering AWS credentials, API keys, JWTs, private keys, connection strings, and more. Inserted at the `wireAdapterEvents` chokepoint so every byte of adapter output is scrubbed before it leaves the process. Sub-2 s/MB on large outputs. |
| **`adapters/mock`** | Reference adapter — a fully scripted fake agent used for testing every layer above without a real model or API key |
| **`adapters/opencode`** | Phase 8 — real OpenCode adapter with a production-quality output parser built from live captured NDJSON fixtures |

### 3.2 Cloud Control Plane (`odysseus/control-plane/`)

| Module | What it does |
|---|---|
| **`api/http-router`** | The REST surface: auth, devices, sessions, approvals, events, projects, integrations, budgets, routing, organization, settings/notifications |
| **`auth`** | JWT issuance (access + refresh pair, httpOnly Secure refresh cookie), password hashing, Firebase Auth verification, role sourcing from database (not token claims) |
| **`auth/rate-limiter`** | Sliding-window counter: 5 login attempts / 15 min (keyed IP+email), 10 register attempts / hour (keyed IP) |
| **`db/memory-store`** | In-memory repository for tests and local dev |
| **`db/firestore-store`** | Cloud Firestore repository for production deployments |
| **`tunnel/tunnel-server`** | Gateway-facing WebSocket endpoint — authenticates by device certificate, relays commands down, receives events up |
| **`tunnel/client-server`** | Browser/phone-facing WebSocket endpoint — authenticates by JWT, handles `subscribe_session`/`subscribe_device`, fans out events to all subscribers |
| **`tunnel/connection-registry`** | In-memory map of who is connected right now on both sides |
| **`policy/policy-engine-service`** | Authoritative policy evaluation — the only call that actually blocks or allows a recorded decision |
| **`policy/policy-store`** | Rule and version CRUD |
| **`policy/approval-workflow`** | Approval state machine (pending → granted/denied/timeout/superseded), duplicate-decision deduplication, mid-flight device revocation auto-deny |
| **`policy/audit-log`** | Hash-chained append-only audit log with a standalone chain-verifier script |
| **`integrations/github`** | Phase 9 GitHub OAuth (minimal scopes: `repo`, `read:org`), credential storage encrypted with AES-256-GCM |

### 3.3 Shared packages (`odysseus/packages/`)

| Package | What it does |
|---|---|
| **`protocol`** | Every type that crosses a wire — `EventEnvelope`, `SessionState`, `ApprovalAction`, `SandboxConfig`, `TrustProfile`, capability strings, and more. Both sides import from here; neither hand-rolls its own copy |
| **`schemas`** | Zod runtime validation matching every protocol type, for anything arriving from outside the process |
| **`config`** | Shared defaults, environment-variable handling, and merge logic |
| **`policy-engine`** | The actual decision algorithm — pure, synchronous, zero I/O — imported by both `gateway/policy` (advisory) and `control-plane/src/policy` (authoritative), so the two sides can never silently disagree. Includes a hardcoded deny-override floor that no authored rule can weaken. |

### 3.4 Frontend control center (`frontend/`)

| Area | Pages / Components |
|---|---|
| **Auth** | `/login`, `/register` — Firebase Auth, silent token refresh, redirect preservation |
| **Primary** | `/dashboard`, `/devices`, `/sessions`, `/approvals` |
| **Workspace** | `/projects` (list + register), `/projects/[id]` (tabs: PRs with diff viewer, active sessions, history), `/integrations` (GitHub/GitLab/Bitbucket OAuth), `/organization` (team management + invite) |
| **Intelligence** | `/budgets` (spend summary + budget limits + progress bars), `/routing` (routing rules + dry-run simulator) |
| **Governance** | `/audit`, `/policy`, `/settings`, `/settings/notifications` |
| **Layout** | `Sidebar` (4 groups), `Header` (dark/light toggle, kill switch, connection status), `MobileNav` (4 fixed tabs + "More" bottom sheet) |
| **Components** | `DiffViewer` (unified patch parser with line numbers and syntax-colored hunks), `KillSwitch`, `ThemeProvider` |

---

## 4. Feature inventory

### Identity and trust

- Ed25519 device keys generated and held locally — the private key never leaves the machine
- Out-of-band word-fingerprint pairing so a machine-in-the-middle substitution is visible to the human
- X.509 certificate issuance and revocation — a stolen or compromised machine can be cut off instantly
- Certificate verification checked against Node's own `X509Certificate` API (not just encoder self-consistency)

### Process isolation

- Mandatory sandboxing via Docker or native OS primitives — the Gateway will not run an agent unsandboxed outside an explicitly-logged dev mode
- Three tunable profiles: strict (no network, read-only filesystem), standard (controlled writes), permissive (for agents that need broader access)
- Zero inbound ports on the Gateway, always

### Reliability

- Durable, replayable event log — a dropped connection mid-session loses no history
- Exponential-backoff reconnect with jitter on both tunnel legs
- Session checkpoint/resume: a crashed Gateway session is not a dead session

### Governance (the core of the project)

- A closed set of declared agent **capabilities** (`filesystem.write`, `process.exec`, `git.push`, `deployment.execute`, `secret.read`, `git.commit`, `git.branch`, and more) — not free-form strings an agent could invent to dodge a rule
- Risk classification: LOW / MEDIUM / HIGH / CRITICAL, with a sensible default for every known capability
- **Hardcoded deny-override floor** — `production/**` deployments, `.git` directory deletion, `.env` reads — that no authored policy version, however permissive, can weaken. Evaluated before any user-authored rule, every time.
- Server-side policy evaluation as the only authority for recorded decisions; the Gateway's local policy cache is a speed advisory only
- Approval workflow: pending → granted/denied/timeout/superseded, with first-valid-wins atomic deduplication, mid-flight device revocation auto-denial, and policy-change-between-request-and-decision handled correctly
- Hash-chained, append-only audit log with a standalone verifier

### AFK mode (Phase 7)

- Trust profiles per device/session: `supervised` (approve everything), `trusted-afk` (auto-approve LOW/MEDIUM), `read-only` (no writes), `locked` (nothing runs), `default`
- Attention engine: detects when there is no active human subscriber and applies the AFK profile automatically
- Kill switch accessible from the header on every page — instantly locks the active session
- "While you were away" summary delivered on reconnect
- Escalation: session paused and notification pushed if a CRITICAL action arrives in AFK mode

### Secret redaction (Phase 6)

- Installed at the adapter output chokepoint — every byte the AI agent writes is scrubbed before it leaves the Gateway process
- 50+ patterns: AWS access/secret keys, GitHub/GitLab tokens, npm/PyPI tokens, GCP service-account JSON, RSA/EC private keys, JWTs, bcrypt hashes, Stripe keys, Twilio SIDs, database connection strings, and more
- Streaming-safe — does not buffer the entire output before redacting
- `[REDACTED:aws_access_key]`-style replacement preserves log readability

### Git operations and project review (Phase 9)

- `git.branch`, `git.commit`, `git.push`, `git.merge`, `git.rebase` — all policy-gated HIGH-risk capabilities
- AI-generated diffs presented in the Diff Viewer before the human approves the push
- GitHub OAuth integration for project registration
- Review pipeline: agent proposes → diff collected → PR draft created → human reviews in web UI → approve runs the push → audit entry written

### Budget and routing (Phase 9 / Intelligence)

- Per-session token spend tracking against per-budget limits (daily / weekly / monthly)
- Automatic session pause or hard stop when a budget is exceeded
- Routing rules: declarative matcher expressions map (capability, riskClass, agentId) to a target model
- Dry-run simulator in the web UI — test a routing decision without executing anything

---

## 5. The frontend control center

### Architecture

The frontend is a **Next.js 15 App Router** application, mobile-first and installable as a PWA. It is not a native iOS/Android app (deferred until there is a product worth the Apple Developer Program cost). PWA gets install-to-homescreen on both platforms, Web Push without an app-store review cycle, and full browser access with no install at all.

**State management:** Zustand for all shared state — no React Query, no Redux. One singleton `realtimeClient` WebSocket that is established once on first authenticated load and never torn down while the session is active.

**Auth:** access token held in memory only (never `localStorage`). Refresh token in an `httpOnly; Secure` cookie the JavaScript layer cannot read. Silent refresh fires automatically on any 401 before propagating the error to the UI.

**Data fetching pattern:** `apiClient.get<T>()` calls in `useEffect`, mirroring the `KillSwitch.tsx` reference component. No custom hooks wrapping fetch — each page owns its own loading state.

### Navigation structure

**Sidebar (desktop, fixed 64px-wide)**

```
— PRIMARY —
  Dashboard
  Devices
  Sessions
  Approvals

— WORKSPACE —
  Projects
  Integrations
  Organization

— INTELLIGENCE —
  Budgets
  Routing

— GOVERNANCE —
  Audit Log
  Policy
  Settings
```

**Mobile nav (bottom bar, fixed)**

Four fixed tabs: Home, Devices, Sessions, Approvals — plus a fifth "More" tab that opens a bottom-sheet grid containing the remaining 8 items (Projects, Integrations, Organization, Budgets, Routing, Audit Log, Policy, Settings).

**Header (sticky, every page)**

Contains: mobile logo, desktop version badge, kill-switch button, WebSocket connection status badge (Connected / Connecting / Offline), dark/light mode toggle, user info, logout button.

### Pages

| Page | What it shows |
|---|---|
| `/dashboard` | Live overview: active sessions, pending approvals, device health, recent audit events |
| `/devices` | All paired devices, online/offline status, trust profile, last seen, revoke action |
| `/sessions` | All agent sessions, filter by status/device/adapter, tap to view live output |
| `/approvals` | Pending approvals with capability, risk class, agent context, approve/deny |
| `/projects` | Registered git repositories — card grid, register modal, open PRs badge |
| `/projects/[id]` | Tabs: Pull Requests (list + diff viewer + approve/reject), Active Sessions, History |
| `/integrations` | GitHub, GitLab, Bitbucket — OAuth connect/disconnect, scope display |
| `/organization` | Team members list, role (admin/operator/viewer), invite modal, remove |
| `/budgets` | Spend summary cards (total, daily average, top models) + budget list with progress bars, add modal |
| `/routing` | Active routing rules ordered by priority + dry-run simulator with result card |
| `/audit` | Hash-chained audit log, filter by actor/capability/decision, export |
| `/policy` | Active policy version, rule editor, version history, publish |
| `/settings` | Account, push notifications, notification preferences link, danger zone |
| `/settings/notifications` | Per-event notification toggles (push + email) for every event type |

### Diff viewer component

`components/diff-viewer.tsx` — parses unified patch format (the standard output of `git diff`) into a three-column table: old line number, new line number, line content. Color-coded rows: green for additions, red for removals, neutral for context, blue for hunk headers. Scrollable to a configurable max height. Used in `/projects/[id]` for PR review.

### Dark/light mode

`next-themes` with `attribute="class"` and `defaultTheme="dark"`. Root layout wraps the app in `<ThemeProvider>`. The Header toggle button is SSR-safe (rendered only after `mounted = true` to avoid hydration mismatch). The Sun/Moon icon reflects the current resolved theme, not just the stored preference.

---

## 6. How Odysseus orchestrates different AI coding agents

### The adapter contract

Every supported agent implements the same `AgentAdapter` interface. The Gateway core is written against this interface and never against a specific vendor's CLI flags or output format:

```typescript
interface AgentAdapter {
  installOrDetect(): Promise<AgentInstallationResult>;
  validateEnvironment(): Promise<AgentValidationResult>;
  startSession(config: SessionConfig): Promise<string>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream;
  requestApproval(sessionId: string, action: ApprovalAction): Promise<{ approved: boolean }>;
  abortSession(sessionId: string, reason: string, force?: boolean): Promise<void>;
  pauseSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  checkpoint(sessionId: string): Promise<SessionCheckpoint>;
  restore(sessionId: string, checkpoint: SessionCheckpoint): Promise<void>;
  collectDiff(sessionId: string): Promise<string>;
  getState(sessionId: string): Promise<SessionState>;
}
```

Adding a new agent requires writing one adapter that wraps that vendor's CLI and translates its output into this shape. Nothing in the sandbox, the tunnel, the policy engine, or the UI changes.

### Normalization

Whatever a real agent prints — a JSON stream, log lines, a completion callback — the adapter translates it into the fixed `EventType` union from `@odysseus/protocol`: `session.started`, `session.output`, `session.tool_call`, `session.tool_result`, `session.file_changed`, `session.approval_required`, `session.completed`, `session.failed`, and so on.

This is why the same policy engine, the same live session view, and the same audit log work identically for every adapter — none of them ever see the vendor's native format.

### Compatibility matrix

| Agent | Fit | Reason |
|---|---|---|
| **Antigravity** | Excellent | Local-first, built-in sandbox, daemon mode, webhook approvals — architecturally closest to what Odysseus needs |
| **OpenCode** | Good | Open source, solid JSON CLI output, released and actively maintained. First real production adapter (Phase 8). |
| **Claude Code** | Acceptable | Excellent model quality. Proprietary and requires payment. Planned after it is generally available. |
| **Codex** | Poor | Cloud-only execution. Violates the local-first sandboxing guarantee. Deliberate non-goal. |
| **Mock Agent** | Perfect for testing | Deterministic, zero dependencies. Every layer of the system has been tested against this first. |

### What "orchestration" means here

The Gateway's `AgentManager` holds a registry of installed adapters. When a session starts you pick one. From that point, every action the chosen agent proposes flows through the identical pipeline regardless of vendor:

```
Agent output
  → Adapter normalization
  → Secret redaction (Phase 6)
  → AFK trust-profile check (Phase 7)
  → Policy evaluation (advisory at Gateway, authoritative at Control Plane)
  → Sandbox execution
  → Normalized EventEnvelope
  → Tunnel
  → Control Plane
  → Web/phone UI
```

Multi-agent orchestration (multiple agents collaborating on one task) is explicitly post-MVP. Today's orchestration is: one agent at a time, fully governed.

---

## 7. A concrete end-to-end walkthrough

1. You install the Gateway on your development machine and start it. It generates an Ed25519 keypair (stored locally, private key never leaves), then prints a pairing code and a 12-word fingerprint.

2. You open the Odysseus Control Center in a browser (or install it to your phone home screen). You log in.

3. You go to **Devices → Pair New Device**, enter the pairing code, and the Control Plane's pairing endpoint responds. It sends you back the word fingerprint it received from the Gateway.

4. You compare the fingerprint the browser shows to the fingerprint the terminal printed. If they match, you click "Confirm." If a man-in-the-middle had substituted its own key, the fingerprints would differ — you would see it.

5. The Control Plane's certificate authority issues the Gateway a device certificate. From here, reconnecting is automatic — no pairing flow repeated.

6. From the Projects page, you register a git repository. You connect GitHub via OAuth (minimal scopes: `repo`, `read:org`).

7. From Sessions, you start a new session: pick the registered project, pick the OpenCode adapter, type a task description.

8. The Gateway spins up a sandboxed OpenCode process. Every tool call, file edit, and terminal output is redacted of secrets, normalized into `EventEnvelope`s, and streamed up the tunnel to the Control Plane.

9. Your browser, subscribed to that session via WebSocket, sees output in real time. No polling.

10. The agent proposes `git push origin main`. That is a HIGH-risk capability. The Policy Engine on the Control Plane evaluates it against the active policy version (and the hardcoded deny floor). No rule allows it unconditionally, so the decision is `REQUIRE_APPROVAL`. An `ApprovalRecord` is created.

11. The event `session.approval_required` is pushed down to your browser. You see: what it wants to push, the diff of changed files in the Diff Viewer, why the policy flagged it, and the risk classification.

12. You tap **Approve**. The approval record is written to the hash-chained audit log. The decision flows back down the tunnel. The sandboxed process runs `git push`. A draft PR is created on GitHub.

13. The PR appears in the Projects → [your project] → Pull Requests tab, ready for review or further action.

14. If your connection had dropped between steps 9 and 12, the reconciliation engine would have replayed missed events the moment the Gateway reconnected. Nothing silently vanishes.

---

## 8. Security model

| Question | Answer |
|---|---|
| Can the Gateway be reached from the internet? | No — zero inbound ports, always |
| Can an agent do something dangerous without your knowledge? | No for HIGH/CRITICAL capabilities — they block pending a Control Plane decision |
| Can a compromised Gateway grant itself permission? | No — the Gateway's policy check is advisory. The Control Plane's evaluation is the recorded authority. |
| Can a policy author accidentally allow a production deploy? | No — the deny-override floor is hardcoded in source (`packages/policy-engine/src/deny-floor.ts`), evaluated before any authored rule, regardless of policy version |
| What happens if the network drops and the agent wants to run a CRITICAL action? | The session enters `failed`. The action does not run. Fail-closed. |
| Can someone tamper with the audit log undetected? | No — the log is hash-chained. A standalone verifier script identifies the exact index of a break. |
| What happens the instant a device is revoked? | Every pending approval for that device is immediately superseded and denied — not left dangling. |
| Are secrets in agent output safe? | Yes — the redaction layer at the adapter output chokepoint scrubs all known secret patterns before any byte leaves the Gateway process. |
| Is the auth token readable by injected JavaScript? | No — access token is in-memory only, refresh token is in an `httpOnly; Secure` cookie. |
| Are CORS credentials given to untrusted origins? | No — the Control Plane reads an explicit `CORS_ORIGINS` allowlist. Wildcard mode never enables `Allow-Credentials`. |
| Is the user's role read from the auth token? | No — roles are read from the database (`users.findById`) on every verified request. A promoted token cannot impersonate a higher role. |

---

## 9. Tech stack and cost

### Languages and frameworks

| Layer | Technology |
|---|---|
| All backend | TypeScript, Node.js 20+, native `crypto`/`http`/`ws` — no heavy frameworks |
| Monorepo | pnpm workspaces |
| Tests | Vitest |
| Frontend | Next.js 15 (App Router), Tailwind CSS, shadcn/ui, Zustand, next-themes |
| Database | In-memory (dev/test), Cloud Firestore (production) |
| Auth | Firebase Auth (client) + Firebase Admin SDK (server) |
| Certificates | Node.js native `X509Certificate` API — no external CA library |
| Tunnel | WebSocket (`ws` library) with custom reconnect logic |

### Intended production cost

The stack is deliberately chosen to run at **$0/month** indefinitely:

- **Compute:** Firebase Functions (always-free tier) or self-hosted Node on a $0 free-tier VPS
- **Database:** Cloud Firestore (1 GiB free), or Postgres on Neon/Supabase free tier
- **Auth:** Firebase Auth (free up to 10,000 MAU)
- **Push notifications:** Web Push / VAPID (no cost)
- **CI/CD:** GitHub Actions (free for public repos and 2,000 min/month private)
- **TLS:** Let's Encrypt

The only non-free line items deferred past MVP:
- A real domain name (~$12/year)
- Apple Developer Program ($99/year) — deferred until native iOS is worth building

---

## 10. Phase-by-phase build history

| Phase | Name | Status | What was built |
|---|---|---|---|
| **Phase 0** | Validation spikes | Complete | Redaction spike (50+ patterns, sub-2 s/MB), reconciliation spike, basic event-bus proof |
| **Phase 1** | Local Agent Gateway | Complete | `core`, `identity`, `pairing`, `certificate`, `reconciliation`, `sandbox`, `tunnel`, `checkpoint`, `health`, mock adapter |
| **Phase 2** | Device identity and pairing | Complete | Ed25519 keygen, word-fingerprint derivation, X.509 CA, pairing state machine, rate limiter, QR payload |
| **Phase 3** | Cloud Control Plane — baseline | Complete | Auth (JWT + refresh cookie), device registry, session CRUD, events relay, both tunnel servers, connection registry |
| **Phase 4** | Web Control Center — foundation | Complete | Next.js App Router shell, Firebase Auth integration, Zustand stores, `apiClient` with silent refresh, `realtimeClient` WebSocket singleton, dashboard, devices, sessions, approvals pages |
| **Phase 5** | Policy Engine, Approvals, Audit | Complete | `packages/policy-engine` (pure evaluator + deny floor), `gateway/policy` (advisory cache), `control-plane/policy` (authoritative service + approval workflow + hash-chained audit log) |
| **Phase 6** | Secret redaction | Complete | Redaction spike promoted to `gateway/redaction` package, inserted at `wireAdapterEvents` chokepoint, 50+ patterns, streaming-safe, test coverage with live adapter fixtures |
| **Phase 7** | AFK mode | Complete | Trust profiles, attention engine, kill switch (header button), push notification delivery, escalation on CRITICAL in AFK mode, "while you were away" summaries |
| **Phase 8** | Real production adapters | Complete | OpenCode adapter with production NDJSON output parser, live captured test fixtures, `AgentCapabilities` honesty matrix, `approvalInterception: 'unsupported'` flag |
| **Phase 9** | Git write ops and project review | Complete | Policy-gated git operations (branch/commit/push/merge/rebase), GitHub OAuth integration (minimal scopes), diff collection, PR creation, project dashboard |
| **Phase 10** | Frontend control center — full | Complete | Sidebar restructure (4 groups), Header dark/light toggle, MobileNav "More" bottom sheet, diff viewer component, 7 new pages: /projects, /projects/[id], /integrations, /organization, /budgets, /routing, /settings/notifications |

### Pre-deployment audit fixes (all resolved before Phase 10)

| Finding | Severity | Fix |
|---|---|---|
| CORS reflected-origin + unconditional Allow-Credentials | Critical | Explicit `CORS_ORIGINS` allowlist; wildcard never enables credentials |
| Policy Engine deny-floor logic inversion | High | Restructured floor-entry matching; resource-scoped entries correctly require a resource argument |
| Health module flaky tests | Medium | Injectable `resourceUsageProvider` so tests do not read live OS metrics |
| Gateway policy cache stale-after-failed-refresh | Medium | All return paths re-check `isCacheFresh()` before returning cached data |
| Auth role from JWT claim (not DB) | Medium | Role now sourced from `db.users.findById()` on every verified request |
| Rate limiting absent on auth endpoints | Medium | Sliding-window `AuthRateLimiter` on `/login` (IP+email) and `/register` (IP) |
| Refresh cookie missing `Secure` attribute | Low | `secureCookies: boolean` config field, derived from `NODE_ENV === 'production'` |
| Dead `require()` call in policy-store | Low | Removed unused `PolicyStore.evaluate()` method with its CJS `require` in ESM context |

---

## 11. API surface reference

All endpoints are under `/api/v1`. All authenticated endpoints require `Authorization: Bearer <access-token>`.

### Auth

| Method | Path | Description |
|---|---|---|
| POST | `/auth/login` | Email + password → access token + refresh cookie |
| POST | `/auth/register` | Create account |
| POST | `/auth/refresh` | Rotate access token using refresh cookie |
| POST | `/auth/logout` | Invalidate refresh token |
| GET | `/auth/me` | Current user profile |

### Devices

| Method | Path | Description |
|---|---|---|
| GET | `/devices` | List all paired devices |
| GET | `/devices/:id` | One device |
| PATCH | `/devices/:id` | Update trust profile |
| DELETE | `/devices/:id` | Revoke device (auto-denies all pending approvals) |
| POST | `/pairing/start` | Begin pairing — returns code + fingerprint |
| POST | `/pairing/confirm` | Confirm fingerprint match — issues certificate |

### Sessions

| Method | Path | Description |
|---|---|---|
| GET | `/sessions` | List sessions (filter: status, deviceId, adapterId) |
| POST | `/sessions` | Start new session |
| GET | `/sessions/:id` | Session detail + event history |
| POST | `/sessions/:id/prompt` | Send a message to the agent |
| POST | `/sessions/:id/pause` | Pause session |
| POST | `/sessions/:id/resume` | Resume paused session |
| POST | `/sessions/:id/cancel` | Abort session |
| GET | `/sessions/:id/diff` | Collected file diff for review |
| GET | `/sessions/events` | Server-Sent Events stream (all subscribed events) |

### Approvals

| Method | Path | Description |
|---|---|---|
| GET | `/approvals` | List approvals (filter: status, sessionId, deviceId) |
| GET | `/approvals/:id` | One approval record |
| POST | `/approvals/:id/decision` | Grant or deny (`{ decision: 'granted' | 'denied', note? }`) |

### Policy

| Method | Path | Description |
|---|---|---|
| GET | `/policy/versions` | All policy versions |
| GET | `/policy/versions/:id` | One version with full rule set |
| POST | `/policy/versions` | Create new draft version |
| POST | `/policy/versions/:id/publish` | Make a version active |
| POST | `/policy/evaluate` | Evaluate a capability against the active policy (dry run) |

### Audit

| Method | Path | Description |
|---|---|---|
| GET | `/audit` | Audit log (paginated, filter by actor/capability/decision) |
| GET | `/audit/:id` | One record with hash and chain proof |
| GET | `/audit/verify` | Verify chain integrity from genesis to current head |

### Projects

| Method | Path | Description |
|---|---|---|
| GET | `/projects` | List registered projects |
| POST | `/projects` | Register a git repository |
| GET | `/projects/:id` | Project detail |
| GET | `/projects/:id/pull-requests` | PRs for this project |
| POST | `/projects/:id/pull-requests/:prId/approve` | Approve and merge |
| POST | `/projects/:id/pull-requests/:prId/reject` | Reject and close |
| GET | `/projects/:id/sessions` | Active sessions attached to this project |

### Integrations

| Method | Path | Description |
|---|---|---|
| GET | `/integrations` | All connected provider integrations |
| GET | `/integrations/github/oauth/start` | Begin GitHub OAuth — returns redirect URL |
| GET | `/integrations/github/oauth/callback` | OAuth callback (set in GitHub App settings) |
| DELETE | `/integrations/:provider` | Disconnect a provider |

### Budgets

| Method | Path | Description |
|---|---|---|
| GET | `/budgets` | All configured budgets |
| POST | `/budgets` | Create a budget |
| GET | `/budgets/summary` | Aggregate spend summary (total, daily average, top models) |
| PATCH | `/budgets/:id` | Update limit or period |
| DELETE | `/budgets/:id` | Remove a budget |

### Routing

| Method | Path | Description |
|---|---|---|
| GET | `/routing/rules` | All routing rules ordered by priority |
| POST | `/routing/rules` | Create a rule |
| PATCH | `/routing/rules/:id` | Update a rule |
| DELETE | `/routing/rules/:id` | Remove a rule |
| POST | `/routing/dry-run` | Simulate which rule and model would be selected |

### Organization

| Method | Path | Description |
|---|---|---|
| GET | `/organization/members` | Team member list |
| POST | `/organization/invitations` | Invite a member by email |
| PATCH | `/organization/members/:id` | Change role |
| DELETE | `/organization/members/:id` | Remove member |

### Settings

| Method | Path | Description |
|---|---|---|
| PATCH | `/settings/profile` | Update name / password |
| GET | `/settings/notifications` | Notification preferences |
| PATCH | `/settings/notifications` | Update preferences |
| POST | `/settings/push/subscribe` | Register Web Push subscription |
| DELETE | `/settings/push/unsubscribe` | Remove push subscription |

---

## 12. What is next

In dependency order:

1. **Deploy** — wire the Control Plane to a real Firestore project, configure VAPID keys and GitHub OAuth credentials, deploy the frontend to Vercel or a similar host
2. **End-to-end test with a real agent** — run OpenCode under the Gateway against a real repository; file any adapter edge cases discovered
3. **Phase 11 — Observability** — structured logging, Prometheus/OpenTelemetry metrics export, health-check dashboards
4. **Phase 12 — Packaging** — publish the Gateway as a standalone installer (an `npx odysseus-gateway` one-liner) so early users can try it without cloning the monorepo
5. **Phase 13 — Beta** — onboard the first external users, instrument signup funnel, file the issues that real usage surfaces
6. **Claude Code and Antigravity adapters** — once the OpenCode adapter is proven in production, the other two high-fit agents in the compatibility matrix
7. **Native iOS/Android** — with a proven web product, the Apple Developer Program cost becomes justified

Everything through Phase 10 already does the full job this document describes — govern any AI coding agent, from any device, with a complete audit trail and a security model that does not rely on trusting the agent.
