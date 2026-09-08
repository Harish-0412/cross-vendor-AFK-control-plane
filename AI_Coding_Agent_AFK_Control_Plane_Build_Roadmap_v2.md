# AI Coding Agent AFK Control Plane
## Enhanced Build Roadmap — Free & Open-Source Edition (v2)

**Document type:** Canonical engineering execution plan, revised
**Project:** Vendor-Neutral AFK Control Plane for Cross-Vendor AI Coding Agents
**Base document:** `AI_Coding_Agent_AFK_Control_Plane_Build_Roadmap.md` (v1)
**What changed in v2:** every tool, service, and dependency in the plan has been re-selected so the project can be built and *kept running* on $0/month — using free and open-source software plus AWS's **Always Free** tier only, with zero paid subscriptions. Architecture has also been hardened in several places the v1 plan left implicit. Full source-controlled Word spec: **[Executive_Summary_Enhanced.docx](./docs/Executive_Summary_Enhanced.docx)**.

---

## 0. What v1 Got Right, and What v2 Changes

v1's phase sequencing, dependency graph, and "don't build the dashboard first" discipline are sound and are **preserved as-is** in this revision — that ordering logic doesn't depend on which vendor you deploy to. Three things change:

1. **Every tool in the stack is re-picked for zero recurring cost.** Where v1 said "OIDC-compatible identity provider," "managed container platform," or "managed identity provider" without naming one, v2 names free-forever options and flags the one or two things (domain registration, native iOS distribution) that realistically cannot be $0.
2. **The AWS layer is re-architected around AWS's *Always Free* services specifically**, not the old "12 months free" EC2/RDS assumption — because that assumption is no longer safe for new AWS accounts (see §1.4).
3. **Four architecture upgrades are added** that v1 left as future work: a durable message broker (free, self-hosted), Merkle/hash-chained audit with independent verification tooling, supply-chain artifact signing (keyless, free), and a full free observability stack (metrics/logs/traces). These are described in §2 and threaded through the phases in §5.

---

## 1. Free & Open-Source Technology Stack

## 1.1 Full substitution table

| Layer (v1 said) | v2 pick | Cost | Notes |
|---|---|---|---|
| Identity provider (unnamed "OIDC IdP") | **Keycloak** (self-hosted, Apache 2.0) *or* **AWS Cognito, Lite tier** | $0 | Cognito Lite/Essentials: 10,000 MAU free **indefinitely**, not just 12 months. Keycloak: unlimited users, self-hosted, MFA and OIDC/SAML built in. |
| Relational DB | **PostgreSQL** self-hosted (Docker) for dev/local-first prod; **DynamoDB** for the AWS-native always-free path | $0 | RDS Postgres is only free for a limited window (see §1.4) — don't depend on it as your permanent store. |
| Ephemeral store / cache | **Redis** self-hosted (Docker) | $0 | No AWS free tier covers ElastiCache indefinitely; self-host it in the same Compose stack as Postgres. |
| Durable message broker (new — see §2.1) | **NATS + JetStream** self-hosted, or **SQS + SNS** (AWS) | $0 | SQS: 1M requests/month always free. SNS: 1M publishes/month always free. Both forever, no account-age dependency. |
| Object/artifact storage | **MinIO** self-hosted (S3-compatible) *or* **AWS S3** | $0 | S3 itself is only unambiguously "always free" pre-2025-07-15 accounts; new accounts should treat S3 as credit-funded and keep usage minimal, or just self-host MinIO. |
| Push notifications | **Web Push (VAPID)** for the PWA (free, no vendor); **Firebase Cloud Messaging** for Android (free, no paid tier exists); **AWS SNS Mobile Push** (1M/month always free) | $0 | Apple Push Notification service itself is free to use, but it requires an Apple Developer Program membership — see §1.3 for why native iOS is deferred. |
| TLS certificates | **Let's Encrypt** via Caddy/Traefik; **AWS Certificate Manager** (free when attached to an AWS load balancer/CloudFront) | $0 | Never pay for a TLS cert for this project. |
| CI/CD | **GitHub Actions** (unlimited minutes on public repos; 2,000 min/month free on private repos) | $0 | Sufficient for lint/test/build/sign on every PR. |
| Container registry | **GitHub Container Registry** (free for public images) *or* **Amazon ECR** (500 MB-month storage always free) | $0 | |
| Secrets management | **SOPS + age** (git-native encrypted secrets, fully free) | $0 | Skip AWS Secrets Manager — it bills per secret per month, which is a real recurring cost. |
| Artifact / release signing (new — see §2.3) | **Sigstore / cosign** (keyless OIDC-based signing) | $0 | Free, no CA to buy, no yearly code-signing certificate. |
| Metrics | **Prometheus** self-hosted, or **CloudWatch** (10 custom metrics / 10 alarms / 1M API requests, always free) | $0 | |
| Dashboards | **Grafana OSS** self-hosted | $0 | |
| Logs | **Grafana Loki** self-hosted | $0 | |
| Tracing | **Grafana Tempo** or **Jaeger**, self-hosted (both support OpenTelemetry) | $0 | |
| Error tracking | **Sentry, self-hosted OSS edition** (or GlitchTip, a lighter free Sentry-compatible alternative) | $0 | Do not use Sentry's paid SaaS tier. |
| Secret / dependency scanning | **gitleaks**, **Trivy**, **Semgrep Community**, **OWASP Dependency-Check** | $0 | Wire all four into CI as required checks. |
| Load/perf testing | **k6** (OSS) or **Locust** | $0 | |
| Domain name | *(no free option that looks professional)* | **~$10–15/yr** | The one line item that is realistically not $0 — see §1.3. |
| Native iOS distribution | *(requires Apple Developer Program)* | **$99/yr, deferred** | Ship PWA + Android first; add native iOS only once the product is validated (matches v1's own "don't build native apps first" guidance). |

## 1.2 Why self-host Postgres/Redis instead of "just use managed AWS"

v1's own Phase 3 already recommends *not* reaching for Kubernetes or heavy managed infra before it's needed. v2 takes that one step further: RDS and ElastiCache are genuinely useful, but neither is free forever, and starting the project depending on the wrong thing being free is worse than not using it at all. Self-hosted Postgres + Redis in Docker Compose:

- costs $0 on a laptop, a spare machine, or a single AWS EC2 instance during whatever free-compute window your account has,
- is exactly what the v1 plan already specified functionally (a modular monolith backed by Postgres and Redis),
- and is trivially portable — the same Compose stack is your local dev environment *and* your low-traffic production environment.

## 1.3 The two things that are honestly not free

Be upfront about this rather than promising an impossible $0 in every category:

1. **A domain name (~$10–15/year).** You can avoid this with a free subdomain (e.g., a `.eu.org` or DuckDNS-style dynamic subdomain), but a project you intend other developers to trust and pair devices against is worth the cost of a real domain. This is a one-time-per-year cost, not a subscription to any part of *this* product's stack.
2. **Apple Developer Program ($99/year), only when you ship a native iOS app.** APNs itself doesn't charge per notification, but Apple requires program membership to sign and distribute an iOS build. v1 already deprioritizes native mobile until after the PWA proves the product — v2 makes that deferral explicit and cost-motivated: **ship the PWA and Android (via FCM, free) first; add iOS only once the roadmap reaches Phase 14 packaging, and only as a deliberate, budgeted decision.**

Everything else in this document — compute, database, auth, messaging, notifications (Android + web), TLS, CI/CD, observability, security scanning, and artifact signing — has a genuine $0 path.

## 1.4 Important: how AWS's free tier actually works in 2026 (read this before you architect anything)

AWS changed its free-tier structure for accounts created after **2025-07-15**. This materially affects how you should architect the AWS-hosted portion of this project:

- **New accounts** get a **Free Plan**: roughly $100–200 in credits, usable for **six months**, after which the account is either upgraded to paid billing or **closed automatically** if you don't act. EC2, RDS, and S3 free usage on a new account is funded from that shrinking credit pool, not a guaranteed 12-month allowance.
- **Legacy accounts** (created before 2025-07-15) keep the older 12-month free tier for EC2 (750 hrs/month t2/t3.micro), RDS (750 hrs/month db.t2/t3.micro), and S3 (5 GB + limited requests).
- **Always Free** services are unaffected by either of the above and never expire, on any account: **AWS Lambda** (1M requests + 400,000 GB-seconds/month), **DynamoDB** (25 GB storage + 25 read/write capacity units, ~200M requests/month), **Amazon SNS** (1M publishes/month), **Amazon SQS** (1M requests/month), **CloudWatch** (10 custom metrics, 10 alarms, 1M API requests/month), **API Gateway** (1M calls/month), **CloudFront** (1 TB data transfer out/month), and **Cognito Lite/Essentials** (10,000 MAU/month).

**Architectural conclusion for this project:** don't design the AWS-hosted Control Plane around EC2 + RDS as the permanent home, because on a new account that stops being free after six months with no warning grace period. Instead:

- **If you're on a legacy (pre-2025-07-15) AWS account:** the original v1 plan's "single EC2 instance running Docker Compose with Postgres + Redis" is safe for 12 months, after which you should either migrate off EC2/RDS or accept a small ongoing bill (a single t3.micro/RDS db.t3.micro pair typically runs well under $30/month after free tier — still not "free," so plan to migrate before then if $0/month is a hard requirement).
- **If you're on a new (post-2025-07-15) account, or want a true $0-forever guarantee regardless of account age:** build the Control Plane on the **Always Free serverless stack** — API Gateway (REST + WebSocket) → Lambda → DynamoDB, with SNS/SQS for the message broker and event fan-out. This is described as "Path B" in §2.4 below.
- **Either way:** self-hosting Postgres/Redis on your own hardware (a home server, a spare machine, a free-tier VM you fully control) sidesteps this problem entirely and is what v2 recommends for Phases 0–8, before any cloud deployment decision has to be made at all.

---

## 2. Architecture Upgrades Over v1

These four additions sit on top of v1's architecture (Gateway ↔ Control Plane, adapters, sandbox, redaction, policy engine, audit) without changing its shape. Each is free.

### 2.1 Durable message broker between Gateway and Control Plane

v1 specifies "WebSocket" as the transport but doesn't name a durability mechanism beyond sequence numbers. v2 adds an explicit broker layer so at-least-once delivery, replay, and backpressure aren't reinvented ad hoc:

- **Self-hosted path:** NATS with JetStream (Apache 2.0, single static binary, built-in persistence and replay) sits between the API/WebSocket Gateway and the Policy Engine / Audit Service.
- **AWS-native path:** SNS (fan-out) + SQS (durable per-consumer queues) replace NATS one-for-one — both Always Free, no account-age risk.

Either way, the event envelope defined in v1 §7.5 (`event_id`, `sequence`, `correlation_id`, etc.) is unchanged — only the transport underneath it gains real durability guarantees instead of relying on the WebSocket connection alone.

### 2.2 Hash-chained audit with independent verification

v1 specifies hash-chained audit events. v2 adds the missing operational half: a small, free, standalone **chain verifier** (a script, not a service) that recomputes the hash chain from the raw audit table/stream and flags any break. Run it:

- on a schedule (a free GitHub Actions cron job hitting a read replica or export), and
- on demand from an admin CLI command.

This turns "tamper-evident" from a property of the write path into something you can actually *prove* on any given day, at zero cost.

### 2.3 Supply-chain signing for Gateway and adapter releases

v1 requires signed Gateway releases and signed adapter packages but doesn't name a mechanism. v2 uses **Sigstore/cosign**: keyless signing backed by your CI provider's OIDC identity (GitHub Actions has this built in). Every Gateway binary and adapter package gets:

- a cosign signature published alongside the release,
- a build provenance attestation (SLSA-style),

verified automatically by the installer before anything is executed. No certificate authority, no yearly code-signing fee, no private key to protect.

### 2.4 AWS Always-Free serverless topology (Path B)

For teams that want the Control Plane to be provably $0/month forever, regardless of AWS account age:

```text
                         WEB / MOBILE (PWA)
                                |
                     API Gateway (REST + WebSocket)
                        [Always Free: 1M calls/mo]
                                |
                +---------------+----------------+
                |               |                |
                v               v                v
            Lambda           Lambda           Lambda
          (Auth glue,      (Session/Task     (Policy Engine,
           Cognito-backed)   API handlers)     Approval logic)
          [Always Free:    [Always Free:      [Always Free:
           1M req/mo]        1M req/mo]         1M req/mo]
                |               |                |
                +---------------+----------------+
                                |
                    +-----------+-----------+
                    |                       |
                    v                       v
               DynamoDB                 SNS + SQS
          (users, devices,          (event fan-out,
           sessions, audit —          durable delivery
           single-table design)       to Gateways)
          [Always Free:             [Always Free:
           25GB + 25 RCU/WCU]         1M publishes/mo
                                       + 1M requests/mo]
                                |
                    Outbound tunnel (Gateway-initiated)
                                |
                                v
                       LOCAL AGENT GATEWAY
                    (unchanged from v1/§7 of the
                     enhanced Word spec)
```

This path trades some of Postgres's relational convenience for a single-table DynamoDB design (well-documented pattern: partition key = entity type + ID, sort key = related-entity prefix, GSIs for the handful of query patterns you actually need — sessions-by-user, events-by-session, approvals-by-status). It is the only AWS-only topology in this document with **zero dependency on any 6-month or 12-month free-tier clock.**

---

## 3. Repository Structure v2

Adds infra-as-code and secrets handling to v1's layout; everything else is unchanged.

```text
agent-control-plane/
|
+-- apps/
|   +-- web/                      # PWA — mobile-first control center
|   +-- admin/
|
+-- gateway/
|   +-- core/
|   +-- adapters/
|   |   +-- mock/
|   |   +-- opencode/
|   |   +-- codex/
|   |   +-- future/
|   +-- sandbox/
|   +-- redaction/
|   +-- policy/
|   +-- tunnel/                   # NATS/JetStream or SQS client
|   +-- checkpoints/
|   +-- health/
|
+-- services/                     # modular monolith (self-hosted path)
|   +-- api/
|   +-- auth/                     # Keycloak config, OR Cognito glue
|   +-- policy/
|   +-- audit/                    # + standalone chain-verifier CLI
|   +-- notifications/            # web push + FCM + SNS mobile push
|   +-- integrations/
|
+-- serverless/                   # NEW — AWS Always-Free path (optional)
|   +-- functions/
|   |   +-- auth/
|   |   +-- sessions/
|   |   +-- policy/
|   |   +-- audit/
|   +-- dynamodb/
|   |   +-- table-design.md
|   +-- iac/                      # Terraform or AWS CDK, Always-Free-only resources
|
+-- packages/
|   +-- protocol/
|   +-- schemas/
|   +-- events/
|   +-- ui/
|   +-- config/
|
+-- db/
|   +-- migrations/                # Postgres path
|   +-- seeds/
|
+-- infra/
|   +-- docker/                    # Postgres, Redis, NATS, Keycloak, Grafana stack, MinIO
|   +-- terraform-aws-free/        # Always-Free-only AWS resources
|   +-- secrets/                   # SOPS + age encrypted secrets, no plaintext ever committed
|
+-- observability/                 # NEW
|   +-- prometheus/
|   +-- grafana/
|   +-- loki/
|   +-- tempo/
|
+-- tests/
|   +-- unit/
|   +-- integration/
|   +-- contract/
|   +-- resilience/
|   +-- security/
|   +-- performance/
|
+-- docs/
|   +-- architecture/
|   +-- adr/
|   +-- agent-compatibility/
|   +-- threat-model/
|   +-- runbooks/
|   +-- Executive_Summary_Enhanced.docx     # <-- full spec, linked from top of this file
|
+-- scripts/
|   +-- verify-audit-chain.ts      # NEW — free, standalone hash-chain verifier
|
+-- .github/
|   +-- workflows/                 # lint, test, build, cosign sign, deploy
|
+-- README.md
```

---

## 4. Phase-by-Phase Build Plan v2

Same phase numbers and gating logic as v1 — each phase below only calls out **what's new or free-resource-specific**. Where v1's tasks and Definition of Done are unchanged, they aren't repeated in full; read this alongside v1 or the Word spec for complete task lists.

### Phase 0 — Validation Spikes
**Free-resource notes:** everything in this phase is local-machine-only by design (integration harness, sandbox spike, mock agent) — genuinely $0 with no cloud dependency at all. No change needed from v1.
**Architecture upgrade:** add a cosign-signing dry run to the spike list — prove your CI can sign a dummy artifact before you build anything that needs to be trusted later.
**Cost:** $0.

### Phase 1 — Local Agent Gateway Foundation
**Free-resource notes:** unchanged from v1 — this phase runs entirely on the developer's machine.
**Architecture upgrade:** wire the checkpoint store to write through the same durable-event envelope you'll use for NATS/SQS later, even though there's no remote broker yet — this avoids a rewrite in Phase 2.
**Cost:** $0.

### Phase 2 — Device Identity, Pairing and Secure Transport
**Free-resource notes:** device keys are generated locally (no cost). For the Control Plane side of pairing, use Keycloak (self-hosted) or Cognito Lite (10,000 MAU free) for the user-identity half of the flow; device certificates themselves are just application-level key material, not an AWS ACM cost.
**Architecture upgrade:** none beyond v1 — the out-of-band fingerprint step from the enhanced Word spec (§8.1) is unchanged and free by nature.
**Cost:** $0.

### Phase 3 — Cloud Control Plane Foundation
**Free-resource notes:** this is the phase where the Path A vs. Path B decision from §1.4 gets made.
- **Path A (self-hosted modular monolith):** Postgres + Redis in Docker Compose, running on your own hardware or a single AWS free-compute instance while it lasts. Matches v1's stack exactly (Node.js/TypeScript, Fastify/NestJS, Postgres, Redis).
- **Path B (AWS Always-Free serverless):** API Gateway + Lambda + DynamoDB + SNS/SQS, per §2.4. More upfront modeling work (single-table DynamoDB design), zero ongoing cost risk.
Most teams should **start on Path A locally** (it's what v1 already recommends, and it's free wherever you run it) and treat Path B as the migration target only if/when you need a public cloud deployment with a $0-forever guarantee.
**Cost:** $0 either way, with the account-age caveats from §1.4 if you deploy Path A to AWS instead of your own hardware.

### Phase 4 — Mobile-First Web Control Center
**Free-resource notes:** ship as a **PWA only** in this phase — no App Store, no Play Store fee for a PWA, no Apple Developer Program needed yet. Push notifications via Web Push (VAPID), which is a W3C standard requiring no vendor account at all.
**Cost:** $0.

### Phase 5 — Policy Engine, Approvals and Audit
**Free-resource notes:** no paid dependency in v1's design here — policy rules and approval state live in your own DB (Postgres or DynamoDB per Phase 3's choice).
**Architecture upgrade:** wire in the standalone hash-chain verifier from §2.2 as part of this phase's Definition of Done, not as a later add-on — "tamper-evident" should be provable from day one of the audit table existing.
**Cost:** $0.

### Phase 6 — Secret Redaction + Data Boundary
**Free-resource notes:** entirely local pattern-matching logic; no external service required. Use open pattern sets (e.g., publicly maintained secret-detection regex/entropy rulesets used by gitleaks) as your starting redaction ruleset rather than a paid DLP API.
**Cost:** $0.

### Phase 7 — AFK Mode
**Free-resource notes:** notification channels are Web Push (free) and, once you add Android, Firebase Cloud Messaging (free, unlimited, no paid FCM tier exists). SNS Mobile Push is a fine AWS-native alternative fan-out layer, also Always Free.
**Cost:** $0.

### Phase 8 — First Real Production Adapter
**Free-resource notes:** unchanged from v1 — this is local integration work against the chosen agent's own (free) CLI/binary.
**Architecture upgrade:** every adapter package built from this phase onward gets a cosign signature (§2.3) as part of its release process, not retrofitted later.
**Cost:** $0.

### Phase 9 — Git, Diff Review and Project Workspaces
**Free-resource notes:** GitHub's own OAuth apps and API are free to register and use at this scale. No paid Git host required — GitHub, GitLab.com, and Bitbucket all offer free tiers sufficient for this integration.
**Cost:** $0.

### Phase 10 — Multi-Machine Support
**Free-resource notes:** pure application logic (device table + permission checks); no new infrastructure.
**Cost:** $0.

### Phase 11 — Reliability and Reconciliation
**Free-resource notes:** unchanged from v1's algorithm. If you're on Path B (§2.4), SQS's built-in visibility timeout and dead-letter queues give you retry/redelivery semantics for free instead of hand-rolling them.
**Cost:** $0.

### Phase 12 — Observability
**Free-resource notes:** replace any implied paid APM with the free stack: **Prometheus + Grafana + Loki + Tempo**, all self-hosted via the same Docker Compose stack as your DB. If you're fully on Path B, CloudWatch's Always Free tier (10 custom metrics, 10 alarms, 1M API requests/month) covers a genuinely useful baseline before you'd need anything paid.
**Architecture upgrade:** OpenTelemetry SDKs in both Gateway and Control Plane from this phase onward, exporting to whichever backend (Tempo or CloudWatch) you chose — this keeps you backend-agnostic if you switch paths later.
**Cost:** $0.

### Phase 13 — Production Security Hardening
**Free-resource notes:** every control in v1's list has a free implementation:
| Control | Free tool |
|---|---|
| Signed releases | cosign (§2.3) |
| Dependency/secret scanning | Trivy, gitleaks, Semgrep Community |
| Sandbox/container isolation | Docker/OCI runtime + seccomp/AppArmor profiles (all free, OS-level) |
| Security test automation | OWASP ZAP (DAST), Semgrep (SAST) |
**Cost:** $0.

### Phase 14 — Cross-Platform Gateway Packaging
**Free-resource notes:** OS-level installers (MSI/pkg/deb/rpm) can be built with free open-source tooling (e.g., electron-builder, or plain shell/systemd packaging if the Gateway isn't Electron-based). **Do not purchase a code-signing certificate yet** — cosign-signed, checksum-verified releases (§2.3) are sufficient for a beta; a paid OS-trusted code-signing certificate (Windows EV cert, Apple notarization) is a deliberate later decision once you have real users who need to skip OS security warnings, not an MVP requirement.
**Cost:** $0 for MVP/beta; a Windows/macOS trusted signing certificate is the realistic future paid item if you want to remove OS "unknown publisher" warnings — explicitly out of scope for this free-resource plan.

### Phase 15 — CI/CD and Release Engineering
**Free-resource notes:** GitHub Actions handles the entire pipeline (lint → test → build → sign → publish) within its free-tier minutes for a project this size. Use GHCR or ECR's Always-Free 500 MB for container images.
**Cost:** $0.

### Phase 16 — Private Beta
**Free-resource notes:** no infrastructure change; this is a process phase. If you're on Path B, your entire beta can run inside Always-Free limits (1M Lambda requests, 25 GB DynamoDB, 1M SNS/SQS operations) for a beta cohort well into the hundreds of active users.
**Cost:** $0.

### Phase 17 — Agent Router & Multi-Agent Orchestration *(post-MVP)*
This phase transforms the product from "remote control for coding agents" to "the Kubernetes/control-plane layer for AI coding agents." The key insight: **agents become interchangeable execution engines.**

**New services built in this phase:**

1. **Agent Router** — automatically selects the best agent(s) for each task based on task complexity, security sensitivity, budget, and historical success rates. Administrators define routing policies in YAML.

2. **Multi-Agent Orchestration** — coordinates specialized agents as teams (Planner → Coder → Tester → Reviewer) with confidence aggregation and final gates. Each spawned agent still receives scoped permissions; orchestration never becomes an uncontrolled privilege multiplier.

3. **Risk Engine** — scores every action by danger level (0.01 for `git status`, 0.97 for production deploy). Feeds dynamic approval thresholds, cost allocation, agent selection, and alert prioritization.

4. **Agent Firewall** — per-session network policies with deny-by-default, explicit allow lists, block lists, and data exfiltration detection.

5. **Cost/Token Governor** — budget enforcement per task/session/agent/project/organization with token limits, cost anomaly detection, and automatic pause on budget exhaustion.

6. **Agent Reputation System** — tracks success rates, failure modes, cost efficiency, completion time, and quality metrics per agent/provider across task types. Feeds the Agent Router.

7. **Universal Agent Memory** — shared knowledge layer so agents learn from each other's work: codebase context, learned patterns, previously solved problems, project-specific knowledge.

8. **Automated Verification Service** — post-task validation: run test suites, check coverage, validate against requirements, lint/style checks, security scanning, cross-agent verification.

9. **Policy-as-Code** — policy definitions in YAML (simple rules), Rego/OPA (complex logic), or WebAssembly plugins (custom logic). Example: "security tasks with risk > 0.7 require multi-agent review."

10. **Agent Marketplace/Registry** — discoverable agents with capability declarations, version pinning/hash verification, compatibility metadata, and one-click adapter installation.

11. **Task Scheduler** — cron-based and event-driven task scheduling with policy inheritance, agent routing, and budget enforcement.

12. **Incident/Recovery Service** — checkpoint-based session recovery, automatic rollback on verification failure, incident summary generation, session replay.

13. **Compliance Evidence Engine** — auto-generates evidence packages for SOC2, ISO27001, and internal audits: audit trail exports, policy enforcement records, approval logs, sandbox isolation proofs.

14. **Cross-Agent Benchmarking** — compares agent performance on standardized tasks for agent selection, capacity planning, cost optimization, and vendor evaluation.

15. **Human Approval Intelligence** — smart approval routing, batch similar approvals, suggest decisions based on policy/history, escalation policies, approval fatigue reduction.

**Infrastructure:**

- Durable message broker (NATS/JetStream or SQS/SNS) becomes essential here for multi-agent coordination and event fan-out.
- Additional DynamoDB tables or Postgres schemas for: routing_policies, agent_reputation, task_memory, verification_results, compliance_packages, benchmarks.
- If on Path B (AWS serverless): Lambda functions for router, orchestrator, risk engine, verification service. Event-driven via SNS/SQS.

**Cost:** $0 at moderate scale; the orchestration layer adds compute but stays within Always-Free limits for beta-scale usage. Monitor Lambda request volume and DynamoDB capacity as agent count and task volume grow.

### Phase 18 — Enterprise *(deliberately deferred, unchanged from v1)*
This is the one phase where "free-only" stops being the right constraint — SSO/SCIM, dedicated SIEM export, and self-hosted Control Plane support for enterprise customers are reasonable to build against paid infrastructure **once there's revenue to justify it.** Nothing here blocks the free MVP.

---

## 5. Cost Summary

| Item | Cost | When it applies |
|---|---|---|
| Compute, DB, cache, broker, auth, observability, CI/CD, signing, TLS | **$0** | Always, via the stack in §1.1 |
| Domain name | **~$10–15/year** | From the moment you want a real domain instead of a free subdomain |
| Apple Developer Program | **$99/year** | Only when you ship native iOS (deferred past MVP per §1.3) |
| Windows/macOS trusted code-signing cert | **Not included in this plan** | Only if/when you want to remove OS "unknown publisher" warnings — a post-beta decision |
| AWS beyond Always-Free limits | **$0 if you stay on Path B**, or standard AWS pricing if you outgrow Always-Free quotas | Monitor via AWS Budgets (also free) and set a $1 billing alarm from day one regardless of which path you choose |

**Practical recommendation:** set an AWS Budget alert at $1 on day one of creating any AWS account for this project, regardless of which path (A or B) you choose. It costs nothing and it's the single best protection against an accidental bill.

---

## 6. Change Log vs. v1

- Named concrete free/open-source tools everywhere v1 left a category unnamed (identity provider, container platform, observability, secrets management, code signing).
- Added the AWS 2025-07-15 free-tier structure change and its architectural consequences (§1.4) — this is the most important addition, since building on the old "12 months free EC2/RDS" assumption is no longer safe for new accounts.
- Added an AWS Always-Free serverless topology (§2.4, "Path B") as a $0-forever alternative to the self-hosted modular monolith, for teams that want zero exposure to account-age-dependent free tiers.
- Added a durable message broker (NATS/JetStream or SNS+SQS), a standalone audit hash-chain verifier, and Sigstore/cosign supply-chain signing as concrete, free implementations of things v1 specified only at the requirements level.
- Added a full free observability stack (Prometheus/Grafana/Loki/Tempo, or CloudWatch Always-Free) to Phase 12, which v1 described in terms of what to measure but not what to run.
- Added an explicit, honest cost table (§5) instead of an implied $0 everywhere — a domain name and, later, Apple's developer program are the only realistic paid items, and both are clearly scoped to when they apply.

---

## 7. Source Basis

This document revises `AI_Coding_Agent_AFK_Control_Plane_Build_Roadmap.md` (v1) and the enhanced project specification `Executive_Summary_Enhanced.docx`, under the added constraint: **no paid services or subscriptions anywhere in the stack, with AWS permitted only for cloud access and only within genuinely free usage.** All AWS free-tier claims in this document reflect the post-2025-07-15 Free Plan structure and AWS's currently published Always Free service list; verify current limits at `aws.amazon.com/free` before finalizing infrastructure decisions, since AWS revises these terms periodically.
