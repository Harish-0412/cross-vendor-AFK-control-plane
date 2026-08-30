# Vendor-Neutral AFK Control Plane

A vendor-neutral remote control platform for AI coding agents (Claude Code, Codex, OpenCode, Cline, Cursor, Antigravity, …). Start a task at your desk, supervise and approve it from your phone — with a mandatory sandbox layer, encrypted device pairing, and a policy engine that no trust profile can bypass.

📄 **Full architecture, threat model, and implementation spec:** [Executive_Summary_Enhanced.docx](./docs/Executive_Summary_Enhanced.docx)
This README covers **building and running the project**. For the full design rationale, security fixes, and diagrams, read the doc above.

---

## Table of Contents

- [System Overview](#system-overview)
- [Repository Layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Building the Agent Gateway](#building-the-agent-gateway)
- [Building the Control Plane](#building-the-control-plane)
- [Environment Variables](#environment-variables)
- [Writing a New Agent Adapter](#writing-a-new-agent-adapter)
- [Running Tests](#running-tests)
- [Local Dev: End-to-End Flow](#local-dev-end-to-end-flow)
- [Security Requirements for Any Build](#security-requirements-for-any-build)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

---

## System Overview

Two deployable units, built and versioned independently:

| Component | Language/Runtime (suggested) | Runs where |
|---|---|---|
| **Agent Gateway** | Node.js or Go binary | Developer's local machine |
| **Control Plane** | Node.js/TypeScript or Go services + Postgres + Redis | Cloud (Docker/Kubernetes) |

```
Mobile/Web App  <--WSS-->  Control Plane  <--E2E encrypted tunnel-->  Agent Gateway  -->  Sandboxed Agent Process
```

See the full doc's Section 7 (Enhanced Architecture) and Section 8 (Feature Implementation) for the complete service breakdown and sequence diagrams before you start implementing.

---

## Repository Layout

Recommended monorepo structure — adjust paths in this README if yours differs:

```
.
├── gateway/                 # Local Agent Gateway
│   ├── src/
│   │   ├── adapters/        # One folder per supported agent (codex, claude-code, opencode, ...)
│   │   ├── sandbox/         # Container/isolation layer
│   │   ├── redaction/       # Secret redaction proxy
│   │   └── tunnel/          # Encrypted client to Control Plane
│   └── package.json
├── control-plane/           # Cloud services
│   ├── services/
│   │   ├── api-gateway/
│   │   ├── auth/
│   │   ├── kms/
│   │   ├── broker/
│   │   ├── policy-engine/
│   │   └── audit/
│   ├── infra/                # Docker Compose / Helm / Terraform
│   └── package.json
├── apps/
│   ├── web/                  # Web control UI
│   └── mobile/                # iOS/Android app
├── docs/
│   └── Executive_Summary_Enhanced.docx   # <-- full spec (this is what the link above points to)
└── README.md
```

---

## Prerequisites

- **Node.js** ≥ 20 (or Go ≥ 1.22 if you're building the Go variant)
- **Docker** — required for the sandbox/isolation layer; the Gateway will refuse to run agents without it unless `--dev-unsafe-no-sandbox` is explicitly set (local dev only, never for anything touching real credentials)
- **Postgres** ≥ 14 and **Redis** ≥ 7 (or `docker compose up` from `control-plane/infra`)
- **pnpm** or **npm** for JS workspaces
- A vendor CLI installed locally for whichever agent adapter you're testing (e.g. `codex`, `claude`, `opencode serve`)

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/<your-org>/afk-control-plane.git
cd afk-control-plane

# 2. Bring up local infra (Postgres, Redis, and a dev Control Plane)
cd control-plane
docker compose -f infra/docker-compose.dev.yml up -d
pnpm install
pnpm --filter api-gateway dev

# 3. In a second terminal, build and run the Gateway on your machine
cd ../gateway
pnpm install
pnpm build
pnpm start -- --control-plane ws://localhost:4000

# 4. Pair this machine from the dev web UI
cd ../apps/web
pnpm install
pnpm dev
# open http://localhost:3000, click "Pair a Device", follow the fingerprint-confirmation
# step described in the full spec (§8.1) before the device is trusted
```

---

## Building the Agent Gateway

```bash
cd gateway
pnpm install
pnpm build          # compiles TypeScript -> dist/
pnpm start           # runs the compiled Gateway
```

Key build flags:

| Flag | Purpose |
|---|---|
| `--control-plane <url>` | WebSocket URL of the Control Plane to tunnel to |
| `--sandbox-runtime docker\|podman` | Which container runtime isolates agent processes |
| `--adapters <list>` | Comma-separated adapters to load (`codex,claude-code,opencode`) |
| `--pair <code>` | One-time pairing code from the Control Plane UI |
| `--dev-unsafe-no-sandbox` | **Local dev only.** Skips sandboxing. Never use on a machine with real repos/secrets. |

The Gateway must **not** open inbound ports — it only makes outbound connections. If your build adds a listener, that's a regression against the spec (§9.2), not a feature.

---

## Building the Control Plane

```bash
cd control-plane
pnpm install
pnpm --filter api-gateway build
pnpm --filter auth build
pnpm --filter kms build
pnpm --filter broker build
pnpm --filter policy-engine build
pnpm --filter audit build

# run the full stack locally
docker compose -f infra/docker-compose.dev.yml up
```

Each service is independently deployable. When adding a new service, register it in `infra/docker-compose.dev.yml` and `infra/helm/` so `docker compose up` and the Helm chart stay in sync.

Database migrations:

```bash
cd control-plane
pnpm --filter api-gateway db:migrate
```

---

## Environment Variables

Create `control-plane/.env` and `gateway/.env` from the provided `.env.example` files. Minimum required to boot locally:

**`control-plane/.env`**
```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/afk_dev
REDIS_URL=redis://localhost:6379
OIDC_ISSUER_URL=...
OIDC_CLIENT_ID=...
KMS_SIGNING_KEY=...            # dev key only — rotate before any shared/staging use
AUDIT_HASH_CHAIN_SECRET=...
```

**`gateway/.env`**
```
CONTROL_PLANE_URL=ws://localhost:4000
GATEWAY_DEVICE_KEY_PATH=~/.afk/device.key   # auto-generated on first run if absent
```

Never commit real values for these — `.env` is gitignored; only `.env.example` should be tracked.

---

## Writing a New Agent Adapter

Every adapter implements the same interface so the Gateway core never needs to change:

```ts
// gateway/src/adapters/<agent-name>/index.ts
export interface AgentAdapter {
  startSession(task: TaskSpec): Promise<SessionHandle>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  requestApproval(action: ProtectedAction): Promise<ApprovalDecision>;
  abortSession(sessionId: string): Promise<void>;
}
```

Steps to add one:

1. Create `gateway/src/adapters/<agent-name>/`.
2. Implement `AgentAdapter` by wrapping the vendor's CLI or API (see `adapters/opencode` for an HTTP-API example, `adapters/codex` for a CLI-spawn example).
3. Pin the vendor binary/CLI to a specific, hash-verified version in `adapter.manifest.json` — unpinned adapters are rejected by the Gateway's supply-chain check (see full spec §6, §9.2).
4. Register the adapter in `gateway/src/adapters/registry.ts`.
5. Add adapter-specific tests under `gateway/test/adapters/<agent-name>/` using a mock CLI/API (don't hit the real vendor service in CI).

---

## Running Tests

```bash
# Gateway unit + adapter tests
cd gateway && pnpm test

# Control Plane unit tests
cd control-plane && pnpm test

# Full end-to-end flow (spins up Docker infra + a mock agent)
pnpm test:e2e
```

CI must pass, at minimum:
- Unit tests for every adapter and every Control Plane service
- **Permission/gate tests** — verifying the deny-override list (protected-branch force-push, credential export, infra-apply) cannot be bypassed by *any* trust profile
- Sandbox-escape regression tests
- Failover tests for the Reconnecting → Degraded → reconciliation path

Target: 80%+ coverage on `gateway/src` and `control-plane/services/*/src`.

---

## Local Dev: End-to-End Flow

1. Start Control Plane infra (`docker compose up`).
2. Start the Gateway, pair it via the web UI, confirm the printed fingerprint matches (do this even locally — it's the workflow you're testing).
3. From the web UI, start a session against a mock or real agent adapter.
4. Trigger a protected action (e.g. have the mock agent request `git push --force`) and confirm it surfaces as an approval request, not an auto-run.
5. Approve it, confirm the session completes and the audit log shows every step, hash-chained.

If step 4 ever auto-executes without a prompt, that's a build-blocking bug, not a UX nit — re-check `policy-engine` wiring before shipping.

---

## Security Requirements for Any Build

These are non-negotiable regardless of which pieces you're building (see full spec §6 and §9 for the reasoning):

- [ ] Agent processes never run outside the sandbox in anything but `--dev-unsafe-no-sandbox` local mode.
- [ ] Gateway opens zero inbound ports.
- [ ] Device pairing includes the out-of-band fingerprint confirmation step — don't skip it "for speed" in the UI.
- [ ] The deny-override list is enforced in the Policy Engine, server-side — never trust a client-side check alone.
- [ ] Secrets are redacted centrally (in the redaction proxy), not per-adapter.
- [ ] Audit events are hash-chained on write; there is no code path that updates a past audit row in place.
- [ ] Adapter binaries are pinned and signature/hash-verified before execution.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Gateway won't start without `--dev-unsafe-no-sandbox` | Docker/Podman isn't running or isn't reachable — sandboxing is mandatory by design |
| Pairing hangs at "waiting for fingerprint confirmation" | Check that the code printed in the Gateway terminal matches the web UI exactly before confirming |
| Approval requests never fire | `policy-engine` isn't wired into the session-execution path, or the protected-action matcher config is missing |
| Audit log query fails after a manual DB edit | Expected — the hash chain is intentionally tamper-evident; restore from the last good chain segment |

---

## Contributing

1. Fork and branch from `main`.
2. Follow the adapter/service structure above — new features should slot into an existing service rather than growing `api-gateway` into a monolith.
3. Any change touching the sandbox, pairing, policy engine, or audit chain needs a test proving the relevant security property in [Security Requirements](#security-requirements-for-any-build) still holds.
4. Open a PR referencing the relevant section of `docs/Executive_Summary_Enhanced.docx` if your change affects architecture or threat model.

---

## License

Add your license here.
