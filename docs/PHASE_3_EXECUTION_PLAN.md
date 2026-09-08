# Phase 3 — Cloud Control Plane Foundation: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 3  
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents  
**Target Milestone:** M3 (A user can remotely start, monitor, approve, and cancel agent sessions on a local workstation from a phone or web browser)  
**Status:** In Progress / Planning  

---

## 1. Executive Direction & Scope

Phase 1 and Phase 2 delivered the complete **Local Agent Gateway** running on the developer workstation, including sandbox isolation, process lifecycle management, Ed25519 device identity, out-of-band SAS pairing, and the secure outbound WebSocket tunnel client.

The goal of **Phase 3** is to build the **Cloud Control Plane**: the cloud-hosted central hub that developer workstations (Gateways) connect to via outbound encrypted tunnels, and that mobile browsers and web clients connect to via HTTPS and WebSockets.

This is the foundation for Freebuff's core value proposition: **"Bring your own agent. We govern the work."** The control plane makes agents interchangeable execution engines under unified governance.

```
┌────────────────────────────────────────────────────────────────────────┐
│                          PHONE / WEB APP (PWA)                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTPS (REST) + WSS (Realtime Events)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       CLOUD CONTROL PLANE SERVICE                      │
│                                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │ Auth & Users │  │Device Registry│ │Sessions & Tasks│ │ Approvals  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘  │
│         │                 │                 │                │         │
│  ┌──────┴─────────────────┴─────────────────┴────────────────┴──────┐  │
│  │                 Real-time Tunnel Relay (WebSocket)                │  │
│  │         (Session Multiplexer, Message Broker, Acks & Replay)      │  │
│  └────────────────────────────────┬─────────────────────────────────┘  │
│                                   │                                    │
│       ┌───────────────────────────┴───────────────────────────┐        │
│       │ PostgreSQL / SQLite (Entities) + Redis / Event Bus     │        │
│       └───────────────────────────────────────────────────────┘        │
└───────────────────────────────────▲────────────────────────────────────┘
                                    │ Outbound Encrypted Tunnel (WSS)
                                    │ (Initiated by Workstation)
┌───────────────────────────────────┴────────────────────────────────────┐
│                  LOCAL AGENT GATEWAY (Workstation)                     │
│   (Identity dev_... | Sandbox | Agent Adapters | Local Workspace)      │
└────────────────────────────────────────────────────────────────────────┘
```

### The Strategic Vision

Phase 3 builds the foundation. Future phases will add the orchestration and governance services that differentiate Freebuff from competitors:

| Service | Phase | Value |
|---|---|---|
| Agent Router | Post-MVP | Automatically route tasks to best agent |
| Multi-Agent Orchestration | Post-MVP | Coordinate agent teams |
| Risk Engine | Post-MVP | Score actions by danger level |
| Agent Firewall | Post-MVP | Per-session network policies |
| Cost/Token Governor | Post-MVP | Budget enforcement |
| Agent Reputation System | Post-MVP | Track agent performance |
| Universal Agent Memory | Post-MVP | Shared knowledge layer |
| Automated Verification | Post-MVP | Post-task validation |
| Policy-as-Code | Post-MVP | Programmable policies |
| Agent Marketplace | Post-MVP | Discoverable adapters |

But first, we need the core control plane that makes all of this possible.

---

## 2. Core Architectural Decisions for Phase 3

1. **Architecture Style — Modular Monolith First**:
   - Implemented as a clean, modular TypeScript service in `control-plane/`.
   - Distinct domain modules (`auth`, `devices`, `sessions`, `tunnel`, `approvals`, `events`) sharing a single process and database during development and MVP.
   - Avoids microservice overhead while strictly preserving bounded contexts so services can be split or moved to serverless later.
2. **Dual-Mode Data Layer (Zero-Friction Dev + Production Scale)**:
   - Built on a clean repository abstraction.
   - **Local Dev Mode**: In-Memory / SQLite persistence with zero external service dependencies—boots in under 2 seconds.
   - **Production Mode**: PostgreSQL schema (Docker Compose or AWS RDS/Neon/Supabase) with transactional isolation.
3. **Transport Protocol Compatibility**:
   - Exactly matches `@freebuff/protocol` and `@freebuff/tunnel` message envelopes (`TunnelMessage`, `EventEnvelope`, `CommandEnvelope`).
   - The Gateway already knows how to connect, authenticate with its Ed25519 key, queue messages, and reconcile sequences. Phase 3 implements the server counterpart.
4. **Outbound-Only Invariant**:
   - The Gateway **never** opens an inbound listening port to the internet.
   - The Control Plane accepts incoming WebSocket connections from Gateways, performs cryptographic authentication, and multiplexes commands to the Gateway and events to the Web client.

---

## 3. Detailed Subphases

Phase 3 is broken down into **7 sequential subphases**:

```
Subphase 3.1: Service Skeleton & Data Layer
      │
Subphase 3.2: Authentication & User Management
      │
Subphase 3.3: Device Registry & Pairing Handshake Relay
      │
Subphase 3.4: WebSocket Tunnel Server & Event Multiplexer
      │
Subphase 3.5: Task & Session Management APIs
      │
Subphase 3.6: Approvals & Interactive Decision Relay
      │
Subphase 3.7: End-to-End Verification Suite
```

---

### Subphase 3.1: Control Plane Service Skeleton & Data Layer

**Goal:** Establish the `control-plane/` service repository, HTTP server, configuration management, and database models.

#### Key Deliverables:
- **Service Root:** `control-plane/` workspace linked to `@freebuff/protocol` and `@freebuff/schemas`.
- **HTTP/WebSocket Framework:** Fastify HTTP server with `@fastify/websocket` / `ws` for high-throughput, low-latency duplex streaming.
- **Database Schema & Models:**
  - `users`: User identity, password hash / OIDC sub, email, role, created_at.
  - `devices`: Device ID (`dev_...`), user_id, public_key_jwk, fingerprint (hex + words), friendly_name, platform, status (`unpaired`, `trusted`, `revoked`), last_seen_at.
  - `pairing_sessions`: Pairing code (`XXXX-XXXX`), user_id, device_id, expires_at, status, confirmed_fingerprint.
  - `sessions`: Session ID, device_id, user_id, agent_id, project_root, state (`initializing`, `running`, `paused`, `waiting_for_approval`, `completed`, `failed`, `cancelled`), started_at, completed_at.
  - `events`: Monotonic sequence, session_id, device_id, event_type, payload (JSON), occurred_at.
  - `approvals`: Approval ID, session_id, action_type, description, status (`pending`, `approved`, `rejected`, `timeout`), requested_at, responded_at.
- **Repository Abstraction:**
  - `UserRepository`, `DeviceRepository`, `SessionRepository`, `EventRepository`, `ApprovalRepository`.
  - Memory/SQLite driver for zero-dependency local dev and tests; Postgres driver for production.

---

### Subphase 3.2: Authentication & User Management

**Goal:** Secure the Control Plane with modern authentication, issuing JWTs for API access and WebSocket authentication.

#### Key Deliverables:
- **Endpoints:**
  - `POST /api/v1/auth/register`: Create user account with email & password.
  - `POST /api/v1/auth/login`: Authenticate and issue signed JWT access token and refresh token.
  - `GET /api/v1/auth/me`: Fetch authenticated user profile and connected device count.
  - `POST /api/v1/auth/logout`: Revoke active session token.
- **Auth Middleware:**
  - JWT verification plugin validating `Bearer <token>` headers on REST routes and `?token=` query parameters on WebSocket connections.

---

### Subphase 3.3: Device Registry & Pairing Handshake Relay

**Goal:** Allow users to pair their workstation Gateway with their web account using the 8-character pairing code and SAS fingerprint confirmation.

#### The Complete Pairing Sequence:
```text
Workstation Gateway          Cloud Control Plane            Mobile/Web UI
       │                              │                           │
       ├─ Generate 8-char code ───────┤                           │
       │  (e.g. "T55Q-Y3D2")          │                           │
       │  and fingerprint             │                           │
       │                              │                           │
       │                              │<── Enter code "T55Q-Y3D2"─┤
       │                              │    (POST /devices/pair)   │
       │                              ├─ Lookup pairing code ─────┤
       │                              │  Return device details    │
       │                              │  and fingerprint words ──>│
       │                              │                           │
       │                              │                     [User verifies]
       │                              │                     [fingerprint words]
       │                              │                           │
       │                              │<── Confirm Match ─────────┤
       │                              │    (POST /devices/confirm)│
       │<── Pairing Approved ─────────┤                           │
       │    Issue Device Token        ├─ Status: Trusted ────────>│
```

#### Key Deliverables:
- **Endpoints:**
  - `GET /api/v1/devices`: List all paired devices for current user with live online/offline indicator.
  - `GET /api/v1/devices/:id`: Detailed device view (platform, agent types available, active sessions).
  - `POST /api/v1/devices/pair`: Submit the 8-character pairing code from the gateway; returns the device's public fingerprint for confirmation.
  - `POST /api/v1/devices/confirm`: User confirms that the SAS fingerprint on the mobile screen matches the terminal; marks device as `trusted`.
  - `DELETE /api/v1/devices/:id`: Revoke device trust and immediately terminate tunnel session.

---

### Subphase 3.4: Real-time Tunnel Server & Message Broker

**Goal:** Implement the WebSocket server accepting persistent connections from developer workstations and multiplexing messages between web users and gateways.

#### Key Deliverables:
- **Gateway Tunnel Endpoint (`/ws/tunnel`):**
  - Authenticates the connecting Gateway via signed auth challenge or device bearer token.
  - Registers active connection in `ConnectionRegistry` with heartbeat monitoring (30-second ping/pong).
  - Handles incoming `TunnelMessage` types:
    - `auth`: Initial cryptographic handshake.
    - `event`: Gateway emitting agent output, status changes, and metrics. Persisted to `events` table and forwarded to active web subscribers.
    - `ack`: Gateway acknowledging receipt of commands.
    - `heartbeat`: Updating device `last_seen_at` and system resource stats (CPU, RAM).
    - `reconciliation_request`: Handling gap recovery after temporary network drops.
- **Web Client WebSocket Endpoint (`/ws/client`):**
  - Authenticates browser clients via JWT.
  - Subscribes client to specific session events (`session:<id>`) or user notifications (`user:<id>`).
  - Broadcasts streaming events in real time with zero polling.
- **Pub/Sub Event Bus:**
  - In-memory event emitter for local dev; Redis Pub/Sub adapter ready for multi-node deployments.

---

### Subphase 3.5: Task & Session Management APIs

**Goal:** Expose RESTful and WebSocket endpoints enabling users to create, view, message, and terminate agent sessions running on their workstations.

#### Key Deliverables:
- **Endpoints:**
  - `POST /api/v1/sessions`: Create and launch a new agent session on a specified device.
    - Sends `session.start` command across the tunnel to the Gateway.
  - `GET /api/v1/sessions`: List sessions with filtering by device, state, or date.
  - `GET /api/v1/sessions/:id`: Get detailed session status, token counts, and execution metrics.
  - `POST /api/v1/sessions/:id/prompt`: Send prompt or follow-up instruction to an active agent.
    - Sends `session.message` command across the tunnel.
  - `POST /api/v1/sessions/:id/pause` & `resume`: Pause/resume session execution.
  - `POST /api/v1/sessions/:id/cancel`: Force stop or abort an active session.
    - Sends `session.stop` command with `force: true` to trigger sandbox teardown.
  - `GET /api/v1/sessions/:id/events`: Retrieve historical event replay log (for reconnecting clients).
  - `GET /api/v1/sessions/:id/diff`: Retrieve current git workspace diff generated by the agent.

---

### Subphase 3.6: Approvals & Interactive Decision Relay

**Goal:** Build the cloud interception layer for protected agent operations, enabling remote approval or rejection from a mobile phone.

#### The Approval Workflow:
```text
Local Agent (Sandbox)         Gateway Core          Control Plane             Mobile PWA
        │                          │                      │                       │
        ├─ Attempt `rm -rf` ──────>│                      │                       │
        │                          ├─ Intercept ─────────>│                       │
        │                          │  Emit approval.req   │                       │
        │                          │                      ├─ Push Notification ──>│
        │                          │                      │  Show Diff & Action   │
        │                          │                      │                       │
        │                          │                      │<── User clicks Approve┤
        │                          │                      │    (POST /approvals)  │
        │                          │<─ Approval Decision ─┤                       │
        │<─ Permit execution ──────┤   (decision: granted)│                       │
```

#### Key Deliverables:
- **Endpoints:**
  - `GET /api/v1/sessions/:id/approvals`: List pending and historical approval requests.
  - `POST /api/v1/sessions/:id/approvals/:approvalId/decision`: Submit user decision (`granted` or `denied`) with optional feedback reason.
- **Relay Logic:**
  - Translates decision into `ApprovalDecisionCommand` and pushes it through the tunnel to the Gateway.
  - Updates approval status in database and broadcasts resolution event to all connected web clients.

---

### Subphase 3.7: End-to-End Verification Suite

**Goal:** Implement automated integration tests proving the entire loop works end-to-end without mocking the network layer.

#### Key Deliverables:
- **Integration Test Scenarios (`control-plane/tests/integration/`):**
  1. `auth.test.ts`: User registration, token issuance, token expiration, unauthorized rejection.
  2. `pairing.test.ts`: Simulate Gateway generating code -> Web client submitting code -> Verifying SAS fingerprint -> Confirming device paired.
  3. `tunnel.test.ts`: Gateway connecting to Control Plane WebSocket -> Sending heartbeats -> Handling disconnect & reconnect.
  4. `session-lifecycle.test.ts`: Web client calls `POST /sessions` -> Control plane sends `session.start` to Gateway -> Gateway's MockAdapter executes -> Events stream back to Web client -> Session completes.
  5. `approval-flow.test.ts`: MockAdapter requests approval -> Control Plane stores pending approval -> Web client approves -> MockAdapter resumes.

---

## 4. Directory Structure for Phase 3

```text
control-plane/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts                   # Server entrypoint (HTTP + WSS bootstrap)
│   ├── app.ts                     # Fastify application setup & plugins
│   ├── config/                    # Server configuration & env validation
│   ├── db/
│   │   ├── index.ts               # Database connection & repository factory
│   │   ├── schema.ts              # Database tables & entity interfaces
│   │   └── repositories/          # User, Device, Session, Event, Approval repos
│   ├── modules/
│   │   ├── auth/                  # JWT auth, user registration, login routes
│   │   ├── devices/               # Device registry, pairing verification routes
│   │   ├── sessions/              # Session CRUD, prompt sending, cancel routes
│   │   ├── approvals/             # Approval decision routes & relay
│   │   └── tunnel/                # WebSocket tunnel server & message broker
│   │       ├── tunnel-server.ts   # Gateway WebSocket connection handler
│   │       ├── client-server.ts   # Web/Mobile WebSocket connection handler
│   │       ├── connection-registry.ts # Active sockets & heartbeat tracking
│   │       └── router.ts          # Command/event bidirectional routing
│   └── utils/
│       ├── logger.ts              # Structured Pino logger
│       └── errors.ts              # Standardized API error responses
└── tests/
    ├── unit/                      # Route and controller unit tests
    └── integration/               # Full Gateway ↔ Control Plane ↔ Client tests
```

---

## 5. Phase 3 Definition of Done (DoD)

Phase 3 is considered **Complete** when the following criteria are verified:
- [ ] Control Plane server boots cleanly locally on port 4000.
- [ ] Web client can register and log in, receiving a valid JWT.
- [ ] Local Agent Gateway (`@freebuff/core`) can establish an outbound tunnel to the Control Plane WebSocket server.
- [ ] User can pair a device from the Web UI using the 8-character pairing code and confirm matching SAS fingerprint words.
- [ ] User can start a session from the Web UI on the paired device running the Mock Adapter.
- [ ] Agent streaming events are received in real time over the client WebSocket connection.
- [ ] An approval request emitted by the agent appears in the Web UI, and the user's approve/deny decision is transmitted back to the Gateway.
- [ ] All unit and integration tests pass with zero errors.
