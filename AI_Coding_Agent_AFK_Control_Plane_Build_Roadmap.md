# AI Coding Agent AFK Control Plane
## Phase-by-Phase Product & Engineering Build Roadmap

**Document type:** Canonical engineering execution plan  
**Project:** Vendor-Neutral AFK Control Plane for Cross-Vendor AI Coding Agents  
**Purpose:** Convert the final project specification into an ordered, implementation-ready build flow  
**Primary outcome:** A developer can leave a local computer running, allow a coding agent to work inside a controlled environment, and safely supervise, guide, approve, review, and recover the work from a mobile browser or web application.

---

# 0. Executive Direction

## 0.1 The product we are actually building

We are **not** building another IDE, another AI coding model, or a simple remote desktop.

We are building **the Kubernetes/control-plane layer for AI coding agents** — a vendor-neutral governance and operating layer that makes agents interchangeable execution engines under unified control.

The product has four major zones:

```text
                     PHONE / WEB
                          |
                    HTTPS / WebSocket
                          |
                          v
              +-------------------------+
              |     CLOUD CONTROL PLANE |
              |                         |
              | Auth                    |
              | Device Management       |
              | Tasks / Sessions        |
              | Policy Engine           |
              | Approvals               |
              | Notifications           |
              | Audit                   |
              | Integrations             |
              +-----------+-------------+
                          |
              +-----------+-------------+
              |  ORCHESTRATION &        |
              |  GOVERNANCE SERVICES    |
              |                         |
              | Agent Router            |
              | Multi-Agent Orchestrator|
              | Risk Engine             |
              | Agent Firewall          |
              | Cost/Token Governor     |
              | Agent Reputation System |
              | Universal Agent Memory  |
              | Automated Verification  |
              | Policy-as-Code          |
              | Agent Marketplace       |
              | Task Scheduler          |
              | Compliance Evidence     |
              | Cross-Agent Benchmarking|
              | Human Approval Intelligence|
              +-----------+-------------+
                          |
                  Secure outbound link
                          |
                          v
              +-------------------------+
              |    LOCAL AGENT GATEWAY  |
              |                         |
              | Gateway Core             |
              | Adapter Manager          |
              | Sandbox Manager          |
              | Policy Enforcement       |
              | Redaction Proxy          |
              | Checkpoints              |
              | Health                   |
              +-----------+-------------+
                          |
          +---------------+---------------+
          |               |               |
          v               v               v
       OpenCode          Codex        Future Agents
          |               |               |
          +---------------+---------------+
                          |
                          v
                 Project Workspace
```

The key architectural insight: **agents become interchangeable execution engines.**

When a user says "Fix this production bug," the control plane decides:

- Which agent should handle it (Claude for implementation, Codex for security review, OpenCode for tests)
- Which model/provider to use
- What permissions the agent gets
- What files it can access
- What network destinations it can reach
- What actions require approval
- How much compute/token budget it can consume
- Whether another agent should review the work
- Whether the final change satisfies organizational policy

This turns the project into an **agent-neutral execution marketplace** — "Bring your own agent. We govern the work."

---

# 1. The Build Philosophy

## 1.1 Build in this order

The most important sequencing decision is:

```text
Security boundary
      ↓
Local Gateway
      ↓
One deterministic/mock agent
      ↓
One real agent adapter
      ↓
Secure remote connection
      ↓
Cloud control plane
      ↓
Mobile/web supervision
      ↓
Approvals + policy
      ↓
AFK mode + notifications
      ↓
Second agent
      ↓
Git/review
      ↓
Reliability + production hardening
      ↓
Agent Router + Multi-Agent Orchestration
      ↓
Risk Engine + Agent Firewall
      ↓
Cost/Token Governor + Reputation System
      ↓
Universal Memory + Verification Service
      ↓
Policy-as-Code + Marketplace
      ↓
Compliance + Benchmarking
```

Do **not** start by building a beautiful dashboard.

Do **not** start by integrating five agents.

Do **not** start with native Android/iOS apps.

Do **not** start with multi-agent orchestration.

The final specification itself recommends validating isolation and the Gateway foundation before expanding compatibility, and explicitly warns that a large unreliable compatibility list is less valuable than a small number of well-tested adapters.

## 1.2 The strategic pivot

Once the core control plane is stable, the product's differentiation shifts from "remote control for coding agents" to "intelligent orchestration and governance for all agents."

The new priority order after core stabilization:

1. **Agent Router** — automatically choose the right agent for each task (highest strategic value)
2. **Multi-Agent Orchestration** — coordinate specialized agents as teams (killer feature potential)
3. **Risk Engine** — score every action by danger level, not just allow/deny
4. **Agent Firewall** — control network egress per session with deny-by-default
5. **Cost/Token Governor** — budget enforcement and anomaly detection
6. **Agent Reputation System** — track success rates across agents and tasks
7. **Universal Agent Memory** — shared knowledge so agents learn from each other
8. **Automated Verification Service** — post-task validation, test running, coverage checks
9. **Policy-as-Code** — programmable policies in YAML/Rego
10. **Agent Marketplace/Registry** — discoverable, version-pinned agents with capability metadata

---

# 2. The Critical Path

## 2.1 Dependency graph

```text
PHASE 0
Research + environment + integration spikes
        |
        v
PHASE 1
Gateway core + sandbox + local agent lifecycle
        |
        +---------------------+
        |                     |
        v                     v
PHASE 2                  PHASE 3
Device identity          Control Plane foundation
+ secure transport       + API + DB + realtime
        |                     |
        +----------+----------+
                   |
                   v
PHASE 4
Web/mobile control UI
                   |
                   v
PHASE 5
Policy + approvals + audit + redaction
                   |
                   v
PHASE 6
AFK mode + attention + notifications
                   |
                   v
PHASE 7
Second production adapter
                   |
                   v
PHASE 8
Multi-machine + Git + review
                   |
                   v
PHASE 9
Reliability + observability + security
+ installers + release engineering
                   |
                   v
PHASE 10
Private beta / production launch
                   |
                   v
PHASE 11+
Advanced orchestration / enterprise
```

## 2.2 What blocks everything else

The true critical path is:

```text
Sandbox
   ↓
Gateway
   ↓
Agent Adapter
   ↓
Authenticated Device
   ↓
Secure Relay
   ↓
Session Model
   ↓
Realtime Events
   ↓
Remote Control
   ↓
Policy / Approval
   ↓
AFK
```

Everything else should attach to this path.

---

# 3. Product Milestones

| Milestone | What it proves |
|---|---|
| M0 | We can safely isolate an agent |
| M1 | One local agent can be normalized behind our Gateway |
| M2 | A trusted phone/browser can connect to one workstation |
| M3 | A user can remotely start/control/stop a real session |
| M4 | Sensitive actions can be intercepted and approved |
| M5 | A developer can go AFK and receive only meaningful alerts |
| M6 | Two different agents work through the same abstraction |
| M7 | Multiple machines/projects work reliably |
| M8 | The product survives failure, reconnect, security, and release tests |
| M9 | Private beta users can install and use it without engineering help |
| M10 | Production launch |

---

# 4. Phase 0 — Product, Technical and Integration Validation

## Goal

Remove the highest-risk unknowns before committing to implementation details.

## Why this comes first

The project depends on external coding agents whose capabilities and interfaces vary. The final specification requires adapter-based integration and explicitly says that agent capabilities must be declared rather than assumed.

## Tasks

### 0.1 Validate the target agents

For each candidate agent, document:

- installation method
- CLI availability
- headless behavior
- local HTTP/API availability
- session model
- event model
- input mechanism
- process lifecycle
- approval behavior
- output streaming
- cancellation
- diff accessibility
- license/terms relevant to integration
- version stability
- platform support

Create:

```text
docs/agent-compatibility/
  opencode.md
  codex.md
  claude.md
  antigravity.md
  compatibility-matrix.md
```

### 0.2 Build a disposable integration harness

Create a small program that can:

```text
detect agent
start agent
send prompt
capture output
send follow-up
stop agent
record exit code
```

Do this **outside** the production Gateway first.

### 0.3 Sandbox spike

Prove:

- filesystem restriction
- process isolation
- CPU/memory limits
- process termination
- network deny-by-default
- explicit project root
- cleanup after crash
- no access to host secrets

### 0.4 Transport spike

Test:

- outbound-only Gateway connection
- WebSocket reliability
- reconnect
- duplicate messages
- message ordering
- authentication
- expired credentials

### 0.5 Data-handling spike

Prove that:

```text
agent output
terminal output
diffs
errors
events
```

can pass through a redaction layer before leaving the machine.

## Components

- integration harness
- sandbox prototype
- gateway prototype
- test control server
- mock agent
- local event format
- basic compatibility matrix

## Definition of Done

- At least one real agent has been started and controlled programmatically.
- A mock agent can simulate all important session states.
- Sandbox boundaries have been demonstrated.
- Outbound-only networking has been demonstrated.
- Reconnect behavior is understood.
- Secret redaction has deterministic tests.
- All major unknowns are documented.

## Do NOT build yet

- mobile application
- multi-agent orchestration
- enterprise SSO
- billing
- native apps
- Kubernetes
- production cloud architecture

## Deliverables

- technical spike report
- agent compatibility matrix
- threat assumptions
- initial architecture ADRs
- sandbox proof of concept
- mock agent

---

# 5. Phase 1 — Local Agent Gateway Foundation

## Goal

Build the trusted local runtime that will eventually sit between the developer’s machine and every remote command.

## Why now

The Gateway is the most important architectural component. It is the final local enforcement boundary and must not be bypassed by the remote client.

## Architecture

```text
agent-gateway
|
+-- gateway-core
+-- adapter-manager
+-- sandbox-manager
+-- policy-client
+-- redaction-proxy
+-- checkpoint-store
+-- tunnel-client
+-- health-module
```

## 5.1 Gateway Core

Implement:

```text
detect()
listAgents()
listProjects()
createSession()
getSession()
stopSession()
sendInput()
getStatus()
shutdown()
```

Maintain an internal session registry:

```text
Session
  id
  project
  adapter
  state
  processId
  startTime
  sandboxId
  sequenceNumber
```

## 5.2 Adapter Manager

Define the versioned contract:

```text
installOrDetect()
validateEnvironment()
startSession(sessionConfig)
sendMessage(sessionId, message)
streamEvents(sessionId)
requestApproval(sessionId, action)
abortSession(sessionId, reason)
collectDiff(sessionId)
getStatus(sessionId)
cleanupSession(sessionId)
```

Do not allow vendor-specific behavior to leak into Gateway Core.

## 5.3 Mock Agent Adapter

The mock agent is essential.

It should generate:

```text
started
planning
message
tool_call
file_changed
approval_required
completed
failed
cancelled
```

This gives deterministic tests for the whole system.

## 5.4 Project Scoping

Every session must have:

```text
project root
repository
branch
workspace
writable paths
network capabilities
```

Never trust an arbitrary path coming from the remote interface.

## 5.5 Local API

Initially bind to:

```text
127.0.0.1
```

Only.

Implement authentication even locally.

## 5.6 Checkpoint Store

Store:

```text
last received sequence
last sent sequence
session state
event offsets
reconnect state
```

## Definition of Done

A local developer can run:

```text
Gateway
  ↓
Mock Agent
  ↓
Sandbox
```

and:

1. discover the mock agent
2. select a project
3. start a session
4. send a prompt
5. stream events
6. stop the session
7. verify cleanup
8. restart Gateway
9. inspect recovery state

## Security gate

The Gateway must refuse:

- out-of-scope filesystem paths
- privileged commands
- unauthorized network access
- unknown session IDs
- invalid local requests

## Do NOT build yet

- public Internet exposure
- cloud UI
- GitHub integration
- native mobile app
- production installers

---

# 6. Phase 2 — Device Identity, Pairing and Secure Transport

## Goal

Connect the Gateway to the remote Control Plane without opening an inbound Internet port on the developer’s workstation.

## Why now

The fundamental user story is:

```text
computer at home
       ↕
internet
       ↕
phone
```

The machine should make outbound connections.

## 6.1 Device identity

Gateway generates:

```text
private key
public key
device ID
device fingerprint
```

The private key remains local.

## 6.2 Pairing

Preferred flow:

```text
Gateway
  ↓
one-time code / QR
  ↓
User logs in on phone
  ↓
User confirms displayed fingerprint
  ↓
Device becomes trusted
```

## 6.3 Certificates

Implement:

- short-lived device certificates
- rotation
- revocation
- expiry
- active session invalidation after revocation

## 6.4 Secure channel

Start with:

```text
TLS + authenticated WebSocket
```

The workstation should initiate the connection.

## 6.5 Reconnect

Implement:

```text
CONNECTED
DISCONNECTED
RECONNECTING
DEGRADED
RECONCILING
CONNECTED
```

When reconnecting:

1. compare sequence numbers
2. identify missing events
3. replay durable events
4. restore session status
5. reconcile approvals
6. mark unrecoverable data explicitly

## Definition of Done

A developer can:

1. install Gateway
2. see a pairing code
3. pair from browser
4. verify fingerprint
5. establish authenticated tunnel
6. remotely disconnect it
7. reconnect it
8. revoke it
9. prove revoked device cannot reconnect

## Do NOT build yet

- multi-machine management
- team accounts
- advanced notification channels
- production deployment clusters

---

# 7. Phase 3 — Cloud Control Plane Foundation

## Goal

Create the minimum cloud system capable of representing users, devices, agents, tasks, sessions, and events.

## Architecture

Start as a **modular monolith**, not microservices.

Logical modules:

```text
/api
/auth
/devices
/agents
/projects
/tasks
/sessions
/events
/policy
/approvals
/audit
/notifications
/integrations
```

The final specification explicitly recommends logical service boundaries while allowing an initial modular-monolith implementation.

## Recommended initial stack

### Frontend

```text
Next.js
React
TypeScript
PWA
Tailwind CSS
```

### Backend

```text
Node.js
TypeScript
Fastify or NestJS
WebSocket
```

### Database

```text
PostgreSQL
```

### Ephemeral coordination

```text
Redis
```

Do not add Kafka/NATS/Kubernetes at this stage unless an actual scaling requirement appears.

## 7.1 Authentication

Start with:

```text
OIDC-compatible identity provider
MFA
secure sessions
session revocation
```

Later:

```text
passkeys
enterprise SSO
SCIM
```

## 7.2 Database entities

Initial entities:

```text
User
Organization
Membership
Device
DeviceCertificate
Agent
Adapter
Project
Workspace
Task
Session
Event
Approval
Policy
AuditEvent
Notification
Integration
```

## 7.3 Session model

```text
Task
  |
  +-- Session
        |
        +-- Agent
        +-- Device
        +-- Project
        +-- Events
        +-- Approvals
        +-- Artifacts
```

## 7.4 API conventions

Use:

```text
REST for CRUD
WebSocket for realtime events
```

Representative endpoints:

```http
GET    /api/v1/devices
POST   /api/v1/devices/pair
DELETE /api/v1/devices/:id

GET    /api/v1/agents
GET    /api/v1/projects

POST   /api/v1/sessions
GET    /api/v1/sessions/:id
POST   /api/v1/sessions/:id/message
POST   /api/v1/sessions/:id/cancel

GET    /api/v1/sessions/:id/events
GET    /api/v1/sessions/:id/diff

GET    /api/v1/approvals
POST   /api/v1/approvals/:id/approve
POST   /api/v1/approvals/:id/reject
```

## 7.5 Event envelope

Use a normalized envelope:

```json
{
  "event_id": "evt_...",
  "event_type": "session.output",
  "event_version": 1,
  "session_id": "sess_...",
  "device_id": "dev_...",
  "sequence": 1042,
  "occurred_at": "2026-08-31T10:00:00Z",
  "correlation_id": "corr_...",
  "payload": {}
}
```

All important commands should have:

```text
command_id
idempotency_key
correlation_id
sequence expectations
acknowledgement
```

## Definition of Done

A test client can:

```text
authenticate
  ↓
list device
  ↓
list agent
  ↓
create session
  ↓
send task
  ↓
receive event
  ↓
cancel session
```

through the real Control Plane.

---

# 8. Phase 4 — Mobile-First Web Control Center

## Goal

Make the central user workflow work from a phone without requiring a desktop IDE.

## Product principle

The mobile UI should be **decision-oriented**, not a miniature IDE.

The user mainly needs to answer:

```text
What is happening?
Is it safe?
Does it need me?
What changed?
What should I do?
```

## 8.1 Screens

### Home

```text
Machines
Running Agents
Needs Attention
Recently Completed
```

### Machine

```text
Online/offline
CPU/memory
Gateway version
Agents
Active sessions
```

### Agent

```text
State
Current project
Current task
Capabilities
Actions
```

### Task

```text
Goal
Progress
Timeline
Current state
Recent output
```

### Live session

```text
Compact logs
Agent messages
Milestones
Warnings
Actions
```

### Approval

```text
What is requested?
Why?
What resource does it affect?
What policy triggered it?
What happens if approved?

[DENY]
[APPROVE]
```

### Diff review

```text
Files changed
Summary
Patch
Tests
Risk indicators
Commit/PR action
```

## 8.2 Realtime behavior

The UI receives:

```text
session.created
session.status_changed
session.message
session.output
session.approval_required
session.completed
session.failed
device.connected
device.disconnected
```

## 8.3 PWA

Initial mobile delivery:

```text
Responsive web
+
PWA installability
+
push notifications where supported
```

Native mobile apps are later.

## Definition of Done

From a phone:

1. sign in
2. see workstation
3. see agent
4. start a session
5. send a message
6. watch live progress
7. stop it
8. reconnect and see consistent state

## Do NOT build yet

- complex code editor
- full terminal emulator
- advanced analytics
- native Android/iOS
- collaborative multi-user review

---

# 9. Phase 5 — Policy Engine, Approvals and Audit

## Goal

Turn remote control into **safe remote control**.

## Why this phase is mandatory

An AI coding agent can modify files, execute commands, access networks, and potentially interact with secrets or infrastructure. The final specification treats sandboxing, policy enforcement, redaction, immutable approval floors, and audit integrity as architectural requirements.

## 9.1 Capability model

Capabilities include:

```text
filesystem.read
filesystem.write
filesystem.delete
process.exec
network.access
package.install
git.commit
git.push
deployment.execute
secret.read
```

Agents declare what they support.

## 9.2 Risk classes

Example:

```text
LOW
  read files
  run tests
  format code

MEDIUM
  edit source
  install dependency
  create commit

HIGH
  push branch
  modify infrastructure
  access protected network

CRITICAL
  production deployment
  destructive data operations
```

Exact classification must remain policy-configurable.

## 9.3 Policy decision

Return:

```json
{
  "decision": "APPROVAL_REQUIRED",
  "reason": "Git push is protected by AFK policy",
  "required_role": "owner",
  "policy_version": "p_17",
  "expires_at": "...",
  "matched_rules": ["afk.git.push"]
}
```

## 9.4 Mandatory deny floor

No autonomous profile may override:

```text
production deployment
destructive infrastructure actions
security-critical operations
```

without the required human approval.

## 9.5 Approval workflow

```text
Agent requests action
       ↓
Policy Engine
       ↓
ALLOW / DENY / APPROVAL
       ↓
Approval created
       ↓
User receives request
       ↓
Approve / Reject
       ↓
First valid decision wins
       ↓
Gateway verifies decision
       ↓
Action proceeds or remains blocked
```

## 9.6 Audit

Audit events should include:

```text
actor
device
session
action
decision
policy version
timestamp
sequence
previous hash
current hash
```

Use append-only application semantics and hash chaining.

## Definition of Done

Test all of:

- allowed action
- denied action
- approval-required action
- expired approval
- duplicate approval
- simultaneous approvals
- revoked device approval
- policy change after request
- deny-override action

## Do NOT build yet

- full enterprise policy designer
- SIEM marketplace
- custom policy programming language

---

# 10. Phase 6 — Secret Redaction + Data Boundary

## Goal

Prevent accidental transmission and storage of credentials and sensitive machine data.

## 10.1 Outbound data path

```text
Agent Output
     ↓
Event Normalizer
     ↓
Secret Redaction Proxy
     ↓
Data Classification
     ↓
Encryption
     ↓
Tunnel
```

## 10.2 Redact

Potential patterns:

```text
API keys
bearer tokens
private keys
passwords
connection strings
cloud credentials
configured secret paths
```

Replace with stable placeholders:

```text
[REDACTED_SECRET]
```

## 10.3 Block by default

Do not transmit:

```text
.env
credential stores
SSH private keys
raw environment dumps
files outside project scope
```

unless explicitly supported and approved by policy.

## Definition of Done

Create a test corpus containing:

- fake cloud keys
- fake JWTs
- fake passwords
- private-key blocks
- database connection strings
- secrets encoded in logs

Prove:

```text
raw secret never reaches cloud event payload
```

within the tested threat model.

## Important limitation

Redaction is a defense layer, not a mathematical guarantee that every possible secret representation is detected. Therefore the system should minimize transmitted data in addition to redaction.

---

# 11. Phase 7 — AFK Mode

## Goal

Allow a user to intentionally hand off work to the agent while preserving safety and control.

## 11.1 Trust profiles

### Interactive

Human actively supervising.

### AFK

Human is away.

Typical permissions:

```text
read/write project
run tests
limited package install
create commit
```

Protected actions remain approval-gated.

### Restricted

Only low-risk operations.

### Locked

Observation only.

## 11.2 Attention Engine

Not every event should create a notification.

```text
normal output       → dashboard
milestone           → dashboard / optional notification
task complete       → notification
task failed         → high priority
approval required   → high priority
security event      → critical
```

## 11.3 "While you were away"

Generate a compact summary:

```text
While you were away

✓ Fixed 3 tests
✓ Modified 6 files
✓ Added 8 tests
⚠ Dependency install required approval
✓ Working tree clean
```

## 11.4 Escalation

Example:

```text
Approval created
     ↓
Push notification
     ↓
No response
     ↓
Reminder
     ↓
Optional email/Slack
     ↓
Timeout
     ↓
Session remains paused or applies fallback policy
```

## 11.5 Kill switch

Always visible:

```text
STOP ALL
```

The kill switch must be treated as a safety operation rather than a convenience button.

## Definition of Done

A user can:

1. start task
2. activate AFK profile
3. lock the screen
4. receive no unnecessary notifications
5. receive approval request
6. approve remotely
7. receive completion summary
8. stop the agent remotely

---

# 12. Phase 8 — First Real Production Adapter

## Goal

Prove that the architecture works across vendor boundaries.

## Recommended sequence

Start with the agent that gives us the cleanest supported local control surface.

OpenCode is an attractive first reference because its architecture provides a server/client model and protocol surface.

The second adapter should be selected only after a fresh compatibility validation.

## Adapter package

```text
packages/
  adapters/
    opencode/
    <second-agent>/
```

Each adapter provides:

```text
metadata()
capabilities()
installOrDetect()
validateEnvironment()
startSession()
sendMessage()
streamEvents()
requestApproval()
abortSession()
collectDiff()
getStatus()
cleanupSession()
```

## Compatibility declaration

Example:

```json
{
  "agent": "example-agent",
  "version": "x.y",
  "capabilities": {
    "session_creation": true,
    "prompt_delivery": true,
    "streaming": true,
    "cancellation": true,
    "diff_collection": true,
    "approval_interception": false
  }
}
```

## Graceful degradation

If an agent cannot support a feature:

```text
Supported
Partially supported
Unsupported
```

must be visible to the user.

Never fake a capability.

## Definition of Done

Two different agents can run through the same:

```text
Device
Project
Session
Task
Event
Approval
Audit
```

model without changing Gateway Core.

---

# 13. Phase 9 — Git, Diff Review and Project Workspaces

## Goal

Turn agent supervision into a useful development workflow.

## 13.1 Git

Implement:

```text
branch
status
diff
commit
push
pull request
```

subject to policy.

## 13.2 Review flow

```text
Task complete
   ↓
Collect diff
   ↓
Summarize changes
   ↓
Run tests
   ↓
Show review
   ↓
User approves commit/PR
```

## 13.3 Project dashboard

```text
Project
 ├── repository
 ├── workspace
 ├── default branch
 ├── policies
 ├── agent preferences
 ├── active sessions
 └── history
```

## 13.4 GitHub

First integration:

```text
OAuth
repository selection
branch creation
commit
push
PR creation
```

Scope tokens narrowly.

---

# 14. Phase 10 — Multi-Machine Support

## Goal

Allow one account to control:

```text
Home PC
Laptop
Workstation
Cloud VM
```

## UI

```text
MACHINES

🟢 Home PC
🟢 Laptop
🔴 Workstation
🟢 Dev VM
```

Each machine shows:

```text
Gateway version
online status
resources
active agents
active sessions
last seen
trust state
```

## Security

Device permissions must be independently revocable.

Do not treat:

```text
user authenticated
```

as equivalent to:

```text
every device trusted forever
```

## Definition of Done

A single user can:

- pair multiple machines
- run sessions on separate machines
- revoke one machine
- continue using others

---

# 15. Phase 11 — Reliability and Reconciliation

## Goal

Make the product survive real-world failure.

## Failure scenarios

Test:

```text
phone loses connection
PC loses Internet
Gateway crashes
agent crashes
agent hangs
cloud restarts
WebSocket reconnects
duplicate command
duplicate event
out-of-order event
clock skew
certificate expires
approval expires
machine sleeps
machine wakes
```

## 15.1 Event delivery

Use:

```text
at-least-once delivery
+
idempotency
+
sequence numbers
+
acknowledgements
+
reconciliation
```

## 15.2 Durable vs ephemeral

### Durable

```text
approval decision
task completion
failure
audit event
commit event
security event
```

### Ephemeral

```text
typing
presence pulse
temporary UI state
```

## 15.3 Recovery algorithm

```text
reconnect
   ↓
authenticate
   ↓
send last-known sequence
   ↓
server identifies gap
   ↓
replay durable events
   ↓
Gateway reports local truth
   ↓
reconcile
   ↓
mark session consistent
```

## Definition of Done

A resilience test suite demonstrates that a session remains understandable and recoverable after controlled network and process failures.

---

# 16. Phase 12 — Observability

## Goal

Understand the system before users discover failures.

## Logs

Use structured JSON logs.

Every important operation gets:

```text
trace_id
correlation_id
request_id
session_id
device_id
user_id / tenant ID where appropriate
```

Never put secrets into logs.

## Metrics

Track:

```text
session start success rate
agent startup failure rate
command-to-gateway latency
approval latency
approval timeout rate
reconnect frequency
event delivery delay
duplicate event rate
sandbox failures
redaction detections
device disconnect rate
audit-chain verification failures
```

## Tracing

Trace:

```text
phone request
 ↓
API
 ↓
authorization
 ↓
policy
 ↓
broker
 ↓
Gateway
 ↓
adapter
 ↓
agent
 ↓
event
 ↓
audit
```

## Alerts

Alert on:

```text
sandbox failures
certificate anomalies
cross-tenant access patterns
audit failure
broker backlog
repeated Gateway failures
schema violations
unusual authorization failures
```

---

# 17. Phase 13 — Production Security Hardening

## Goal

Make the system defensible as a real production security product.

## Required controls

### Identity

- MFA
- secure sessions
- device revocation
- short-lived certificates
- key rotation

### Authorization

- tenant isolation
- role-based access
- project scope
- capability checks
- deny-override rules

### Runtime

- sandbox
- least privilege
- network deny-by-default
- resource limits
- no privileged agent process

### Data

- encryption in transit
- encrypted storage
- secret redaction
- retention controls
- sensitive-path blocking

### Supply chain

- signed Gateway releases
- signed adapter packages
- version pinning
- rollback protection
- checksum/integrity verification

### Security testing

Test:

```text
prompt injection
command injection
sandbox escape
secret leakage
pairing attack
stolen session token
stolen phone
device revocation
tenant isolation
adapter compromise
malicious update
replay attack
```

---

# 18. Phase 14 — Cross-Platform Gateway Packaging

## Goal

Make the Gateway installable by normal developers.

## Targets

```text
Windows
macOS
Linux
```

## Installer requirements

```text
download
install
pair
start background service
upgrade
rollback
uninstall
clean up
```

## Update security

Only install:

```text
signed
integrity-verified
non-downgrade
approved
```

releases.

## Distribution options

Later support:

```text
Homebrew
apt
Chocolatey
native installers
```

## Definition of Done

A new developer can move from zero to:

```text
installed Gateway
  ↓
paired device
  ↓
running agent
```

without reading internal developer documentation.

---

# 19. Phase 15 — CI/CD and Release Engineering

## Branch strategy

Recommended:

```text
main
  ├── feature/*
  ├── fix/*
  └── security/*
```

Protect `main`.

Every merge requires:

```text
lint
typecheck
unit tests
integration tests
contract tests
security checks
build
```

## Release flow

```text
Pull Request
    ↓
CI
    ↓
Review
    ↓
Merge
    ↓
Staging
    ↓
Security / resilience tests
    ↓
Canary
    ↓
Production
```

## Gateway release

```text
build
 ↓
sign
 ↓
publish
 ↓
verify signature
 ↓
install
 ↓
health check
```

---

# 20. Phase 16 — Private Beta

## Goal

Validate the actual problem, not only the software.

## Beta user scenario

Give developers a simple assignment:

> Start an agent on your workstation, leave the machine, monitor from your phone, respond to one approval request, and review the resulting diff.

## Observe

Measure:

```text
Can they pair successfully?
Do they understand agent state?
Do notifications arrive?
Do approval cards make sense?
Can they read a diff on a phone?
Do they trust AFK mode?
Do they understand what leaves the machine?
What happens when connectivity fails?
```

## Beta exit criteria

Do not expand agent integrations simply because more integrations are requested.

First prove:

```text
reliability
safety
clarity
repeat usage
```

---

# 21. Phase 17 — Agent Router & Multi-Agent Orchestration

## This is a later phase

Do not implement this in MVP.

## The strategic upgrade

This phase transforms the product from "remote control for coding agents" to "the Kubernetes/control-plane layer for AI coding agents." The key insight: **agents become interchangeable execution engines.**

## 21.1 Agent Router

### Problem

Developers today choose agents manually: "I'll use Claude" or "I'll use Codex." But different agents excel at different things.

### Solution

The Agent Router automatically selects the best agent(s) for each task based on:

```text
Task Complexity
Security Sensitivity
Repository Size
Required Tools
Latency Requirement
Budget
Agent Availability
Historical Success Rate
```

### Example routing decision

Task: "Refactor authentication and add comprehensive tests."

```text
Claude → implementation
Codex → security review
OpenCode → test generation
```

### Configurable routing policies

Administrators define routing rules:

```yaml
routing:
  security_tasks:
    preferred_agent: codex

  frontend_tasks:
    preferred_agent: claude

  cheap_tasks:
    preferred_agent: opencode

  high_risk_tasks:
    strategy: multi_agent_review
```

## 21.2 Multi-Agent Orchestration

### The killer feature

Instead of `User → Agent`, support:

```text
User
 │
 ▼
Planner Agent
 │
 ├──► Coding Agent
 ├──► Test Agent
 ├──► Security Agent
 └──► Review Agent
            │
            ▼
        Final Gate
```

### Example: "Implement OAuth login"

The platform automatically creates:

- **Agent A**: Architecture + implementation
- **Agent B**: Security review
- **Agent C**: Tests
- **Agent D**: Code review

Then the control plane aggregates:

```text
Implementation confidence: 91%
Security confidence: 96%
Test confidence: 88%

Final decision → Human approval
```

Now you aren't just controlling agents. You're controlling **agent teams**.

## 21.3 Risk Engine

### Problem

The Policy Engine answers "Is this action allowed?" But it should also answer "How dangerous is this action?"

### Solution

Score every action:

```text
git status              → Risk: 0.01
npm install            → Risk: 0.15
git push               → Risk: 0.52
rm -rf                 → Risk: 0.89
production deploy      → Risk: 0.97
```

### Uses

- Dynamic approval thresholds (higher risk = stricter approval)
- Cost allocation (risky tasks cost more to supervise)
- Agent selection (risky tasks → more capable agent)
- Alert prioritization (high-risk actions get immediate attention)

## 21.4 Agent Firewall

### Problem

Agents need network access for package installs, API calls, and dependency downloads — but shouldn't exfiltrate data or reach internal systems.

### Solution

Per-session network policies:

```yaml
firewall:
  default: deny-all
  allow:
    - registry.npmjs.org
    - pypi.org
    - github.com
  block:
    - internal.corp.net
    - *.prod.internal
  inspect:
    - data exfiltration patterns
    - credential transmission
```

## 21.5 Cost/Token Governor

### Problem

Different agents and models have different costs. Without governance, a single runaway session can consume a large budget.

### Solution

Budget enforcement per:

- Task
- Session
- Agent/provider
- Project
- Organization
- Time window (hourly/daily/monthly)

Features:

- Token/compute limits per session
- Cost anomaly detection
- Budget alerts and automatic pause
- Cost attribution to projects/teams
- Cost forecasting based on task complexity

## 21.6 Agent Reputation System

### Problem

How do you know which agent is best for which task?

### Solution

Track and aggregate:

- Success rate per task type
- Failure modes and patterns
- Cost efficiency (outcome per dollar)
- Completion time
- Quality metrics (test coverage, lint pass rate, review findings)
- User satisfaction signals

This feeds the Agent Router and helps administrators make informed agent selection decisions.

## 21.7 Universal Agent Memory

### Problem

Each agent session starts fresh. Knowledge doesn't persist across agents.

### Solution

A shared knowledge layer:

- Codebase context that any agent can access
- Learned patterns and conventions
- Previously solved problems and their solutions
- Project-specific knowledge (build commands, test patterns, deployment steps)
- Cross-agent learnings (what worked, what didn't)

## 21.8 Automated Verification Service

### Problem

How do you know the agent's work is correct?

### Solution

Post-task verification:

- Run test suites automatically
- Check code coverage
- Validate against task requirements
- Lint and style checks
- Security scanning
- Performance regression checks
- Cross-agent verification (another agent reviews the work)

## 21.9 Policy-as-Code

### Problem

Policies are currently declarative configurations. Complex governance needs programmable policies.

### Solution

Policy definitions in:

- YAML for simple rules
- Rego (Open Policy Agent) for complex logic
- WebAssembly plugins for custom policy logic

Examples:

```yaml
policies:
  - name: security-review-required
    condition: task.type == "security" and task.risk_score > 0.7
    action: require_multi_agent_review
    agents:
      - codex
      - claude

  - name: budget-enforcement
    condition: session.estimated_cost > project.daily_budget
    action: require_approval

  - name: protected-branches
    condition: git.push.target in protected_branches
    action: deny_without_approval
    deny_fallback: true  # cannot be overridden
```

## 21.10 Agent Marketplace/Registry

### Problem

Adding new agents requires manual integration work.

### Solution

A registry of agents with:

- Capability declarations
- Version pinning and hash verification
- Compatibility metadata
- Usage documentation
- Community ratings and reviews
- One-click adapter installation

## 21.11 Task Scheduler

Schedule tasks:

- Cron-based (e.g., "run tests every hour")
- Event-driven (e.g., "on push to main, run security review")
- Manual with scheduled start
- Recurring maintenance tasks

Each scheduled task inherits policies, budgets, and agent routing rules.

## 21.12 Incident/Recovery Service

- Checkpoint-based session recovery
- Automatic rollback on verification failure
- Incident summary generation
- Post-incident analysis
- Session replay for debugging

## 21.13 Compliance Evidence Engine

Auto-generate evidence packages for:

- SOC2
- ISO27001
- Internal audits
- Security reviews

Evidence includes:

- Audit trail exports
- Policy enforcement records
- Approval logs
- Agent activity summaries
- Sandbox isolation proofs

## 21.14 Cross-Agent Benchmarking

Compare agent performance on standardized tasks:

- Implementation speed
- Code quality
- Test coverage achieved
- Cost efficiency
- Security findings caught

Helps with:

- Agent selection decisions
- Capacity planning
- Cost optimization
- Vendor evaluation

## 21.15 Human Approval Intelligence

Smart approval management:

- Route approvals to the right approver based on expertise
- Batch similar approvals
- Suggest approval/denial based on policy and history
- Escalation policies for urgent items
- Approval fatigue reduction (smart notification timing)

## Architecture

```text
                   ORCHESTRATOR
                        |
          +-------------+-------------+
          |             |             |
          v             v             v
      Planner       Coding        Testing
       Agent         Agent         Agent
          |             |             |
          +-------------+-------------+
                        |
                        v
                   Review
                        |
                        v
                   Gate
```

## Critical safety principle

Orchestration must never become an uncontrolled privilege multiplier.

Each spawned agent still receives:

```text
project scope
capabilities
network permissions
secrets
resource limits
trust profile
```

---

# 22. Phase 18 — Enterprise

Add only after the core product is stable.

## Features

```text
SSO
SCIM
group roles
organization policies
team approvals
audit export
SIEM integration
self-hosted Control Plane
hardware-backed authentication
advanced compliance
```

The final specification identifies these as later-stage capabilities.

---

# 23. Recommended Repository Structure

```text
agent-control-plane/
|
+-- apps/
|   +-- web/
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
|   +-- tunnel/
|   +-- checkpoints/
|   +-- health/
|
+-- services/
|   +-- api/
|   +-- auth/
|   +-- policy/
|   +-- audit/
|   +-- notifications/
|   +-- integrations/
|
+-- packages/
|   +-- protocol/
|   +-- schemas/
|   +-- events/
|   +-- ui/
|   +-- config/
|
+-- db/
|   +-- migrations/
|   +-- seeds/
|
+-- infra/
|   +-- docker/
|   +-- terraform/
|   +-- deployment/
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
|
+-- scripts/
|
+-- .github/
|   +-- workflows/
|
+-- README.md
```

---

# 24. Initial Database Model

Minimum:

```text
users
organizations
memberships
devices
device_certificates
adapters
agents
projects
workspaces
tasks
sessions
events
approvals
policies
audit_events
notifications
integrations
```

Relationships:

```text
Organization
  |
  +-- Users
  |
  +-- Projects
  |
  +-- Devices
  |
  +-- Policies
       |
       +-- Sessions
              |
              +-- Agent
              +-- Workspace
              +-- Events
              +-- Approvals
              +-- Audit
```

---

# 25. Initial P0 / P1 / P2 / P3 Backlog

## P0 — Must build

```text
Gateway core
Sandbox
Mock adapter
One real adapter
Session model
Device identity
Secure pairing
Outbound connection
Authentication
Realtime events
Task creation
Task cancellation
Mobile-responsive dashboard
Policy engine
Approval flow
Secret redaction
Audit trail
Reconnect/reconciliation
Basic observability
```

## P1 — Build after core

```text
Second adapter
GitHub
Diff review
AFK profiles
Push notifications
Multi-machine
Project workspaces
Signed updates
Cross-platform installers
Performance testing
Security testing
```

## P2 — Later

```text
GitLab
Bitbucket
Slack
Teams
IDE extensions
Analytics
scheduled tasks
webhooks
enhanced review comments
native mobile apps
self-hosted deployment
```

## P3 — Future research

```text
multi-agent orchestration
sub-agent spawning
agent marketplace
autonomous project management
advanced policy intelligence
cost optimization
agent reputation/scoring
cross-machine orchestration
```

---

# 26. Technology Stack — Recommended Order

## Start simple

### Local

```text
Node.js / TypeScript
or Rust if the team is comfortable with systems programming
```

Recommendation for a small team:

**TypeScript first**, because the Control Plane and Gateway protocol can share types and schemas.

### Web

```text
Next.js
React
TypeScript
PWA
```

### API

```text
Fastify
Zod
OpenAPI
WebSocket
```

### Database

```text
PostgreSQL
```

### Realtime / coordination

```text
Redis
```

### Authentication

```text
OIDC-compatible IdP
MFA
```

### Deployment

Start with:

```text
managed container platform
managed PostgreSQL
managed Redis
managed identity provider
```

Only introduce Kubernetes when operational needs justify it.

### Observability

```text
OpenTelemetry
structured logs
metrics
distributed tracing
```

---

# 27. Local Development Setup

## Step 1

Install:

```text
Node.js
pnpm
Docker
Git
```

## Step 2

Start infrastructure:

```text
PostgreSQL
Redis
```

## Step 3

Start Control Plane.

## Step 4

Start Gateway locally.

## Step 5

Start Mock Agent.

## Step 6

Open web app.

## Step 7

Pair local Gateway.

## Step 8

Run:

```text
Mock task
 ↓
live events
 ↓
approval
 ↓
completion
 ↓
audit
```

## Step 9

Only after this works, connect a real agent.

---

# 28. Testing Strategy

Testing is part of the product, not a finishing stage.

## Unit tests

```text
policy
state machine
adapter
serialization
redaction
audit hash
authorization
```

## Contract tests

```text
Gateway ↔ Control Plane
Adapter ↔ normalized protocol
Web ↔ API
```

## Integration tests

```text
Gateway
+
Control Plane
+
DB
+
Redis
+
Sandbox
+
Mock Agent
```

## Approval tests

```text
approval
timeout
escalation
duplicate decision
deny override
```

## Resilience tests

```text
network loss
reconnect
Gateway restart
agent crash
duplicate events
delayed events
```

## Security tests

```text
prompt injection
command injection
sandbox escape
pairing attack
credential leakage
tenant isolation
replay
```

## Performance tests

```text
concurrent sessions
event streaming
sandbox resource consumption
broker throughput
mobile latency
```

## Usability tests

```text
one-handed approval
reading logs
reading diffs
notification clarity
pairing clarity
```

---

# 29. Demo Flow

The product should be demonstrated as a story.

## Demo 1 — Local Gateway

```text
Start Gateway
↓
Detect agent
↓
Launch sandbox
↓
Run task
↓
Show local isolation
```

## Demo 2 — First Phone Demo

```text
Open phone
↓
Pair workstation
↓
Select project
↓
Start task
↓
Watch progress
```

## Demo 3 — AFK Demo

```text
Start task
↓
Enable AFK mode
↓
Leave computer
↓
Agent continues
↓
Phone receives approval
↓
Approve
↓
Agent continues
↓
Completion notification
```

## Demo 4 — Security Demo

Show:

```text
Agent tries protected action
↓
Policy blocks it
↓
Approval request
↓
User rejects
↓
Action never executes
↓
Audit record
```

## Demo 5 — Cross-Agent Demo

```text
Same dashboard
      |
+-----+------+
|            |
Agent A    Agent B
```

Same:

```text
task
session
events
policy
audit
review
```

## Demo 6 — Failure Recovery

```text
agent running
↓
disable network
↓
restore network
↓
reconcile
↓
continue
```

---

# 30. First 30 / 60 / 90 Days

## Days 1–30 — Technical foundation

### Build

```text
repository
protocol
schemas
mock agent
Gateway core
sandbox proof
first adapter spike
local event stream
```

### Outcome

A real agent can execute a controlled task locally.

### Do not chase

```text
UI polish
multiple agents
native app
orchestration
```

---

## Days 31–60 — Remote control

### Build

```text
device identity
pairing
secure tunnel
Control Plane
PostgreSQL
WebSocket
session/task APIs
mobile dashboard
```

### Outcome

A developer can control one local coding agent from a phone.

---

## Days 61–90 — Safety + AFK

### Build

```text
policy
approval
redaction
audit
AFK profile
attention engine
notifications
reconnect
second agent spike
```

### Outcome

A developer can safely leave a real agent working while AFK.

That is the **core product proof**.

---

# 31. What We Should Explicitly NOT Build in the First Version

Avoid these until the core loop is proven:

```text
Full remote desktop
Full mobile terminal
Native mobile apps
Five+ agents
Multi-agent orchestration
Cloud execution of source code
Enterprise SSO
Billing
Marketplace
Complex analytics
Kubernetes-first architecture
AI-generated policy engine
Automatic production deployment
```

The main trap is trying to build the final vision before proving the core control loop.

---

# 32. Critical Engineering Spikes

These are mandatory decisions to validate.

## Spike A — Sandbox

Question:

> Can we reliably isolate agent filesystem/process/network access on supported platforms?

## Spike B — Agent adapter

Question:

> Can we reliably control the chosen agent without screen scraping?

## Spike C — Realtime transport

Question:

> Can we recover from network interruption without losing important task state?

## Spike D — Approval interception

Question:

> Can we actually observe protected operations before they execute?

## Spike E — Redaction

Question:

> How much sensitive information can be reliably prevented from leaving the machine?

## Spike F — Cross-platform

Question:

> Can the same Gateway architecture provide an equivalent security boundary on Windows, macOS, and Linux?

The final specification specifically warns against claiming identical isolation across operating systems without validating the platform-specific implementation.

---

# 33. UX Rules

## Rule 1

The homepage answers:

> What needs my attention?

## Rule 2

Every dangerous action explains:

```text
what
why
where
which policy
risk
who can approve
```

## Rule 3

Do not flood phones with agent logs.

## Rule 4

Summaries should be useful without hiding the underlying evidence.

## Rule 5

Every remote action should have a visible state:

```text
sent
received
executing
completed
failed
expired
rejected
```

## Rule 6

Never pretend an unsupported agent capability is supported.

---

# 34. Product Metrics

## Activation

```text
time from signup to paired Gateway
time from pairing to first task
```

## Reliability

```text
task start success
agent crash rate
reconnect success
event loss rate
```

## Safety

```text
blocked dangerous actions
approval precision
redaction detections
security incidents
```

## UX

```text
approval completion time
notification usefulness
mobile task completion
diff review completion
```

## Product value

```text
AFK sessions per user
hours of supervised agent work
tasks completed remotely
returning users
```

---

# 35. Common Traps

## Trap 1 — Building remote desktop

Why wrong:

The user does not need the entire workstation on the phone.

Build:

```text
intent
state
events
decisions
review
```

instead.

## Trap 2 — Integrating everything immediately

Why wrong:

Agents expose different control surfaces.

Build a strong adapter contract first.

## Trap 3 — Putting the agent in the cloud

Why wrong:

It increases infrastructure cost and changes the privacy/security model.

The project’s core design is local-first execution.

## Trap 4 — Security later

Why wrong:

The Gateway becomes a remote-execution bridge.

Sandboxing, redaction, approval floors, revocation, and audit integrity must be foundational.

## Trap 5 — Microservices too early

Why wrong:

The MVP needs product velocity.

Use a modular monolith with explicit service boundaries.

## Trap 6 — Event streaming without durability

Why wrong:

Network interruptions will create confusing state.

Use sequence numbers, acknowledgements, idempotency, and reconciliation.

---

# 36. Recommended Final Architecture

```text
                           USER
                            |
                    +-------+-------+
                    |               |
                  WEB             MOBILE
                    |               |
                    +-------+-------+
                            |
                    HTTPS / WebSocket
                            |
                            v
                +-------------------------+
                |     CONTROL PLANE      |
                |                         |
                | API / Realtime          |
                | Authentication          |
                | Device Management       |
                | Task/Session Store      |
                | Policy Engine           |
                | Approval Service        |
                | Audit Service           |
                | Notification Service    |
                | Integration Service     |
                +-----------+-------------+
                            |
                     Secure Relay
                            |
                            v
                +-------------------------+
                |      LOCAL GATEWAY      |
                |                         |
                | Gateway Core             |
                | Adapter Manager          |
                | Sandbox Manager          |
                | Policy Enforcement       |
                | Redaction                |
                | Checkpoint Store         |
                | Tunnel Client            |
                +-----------+-------------+
                            |
                +-----------+-----------+
                |           |           |
                v           v           v
             Agent A     Agent B     Agent C
                |           |           |
                +-----------+-----------+
                            |
                       Sandbox
                            |
                       Workspace
                            |
                          Git
```

---

# 37. Final Ordered Build Checklist

This is the sequence to follow.

## Foundation

- [ ] Create monorepo
- [ ] Define normalized protocol
- [ ] Define event envelope
- [ ] Define session state machine
- [ ] Define adapter contract
- [ ] Build mock agent
- [ ] Validate first real agent integration
- [ ] Build sandbox spike

## Gateway

- [ ] Gateway core
- [ ] Local configuration
- [ ] Agent discovery
- [ ] Project discovery
- [ ] Session lifecycle
- [ ] Adapter manager
- [ ] Sandbox manager
- [ ] Local API
- [ ] Checkpoint store
- [ ] Health module

## Security

- [ ] Device keys
- [ ] Fingerprint
- [ ] Pairing
- [ ] Short-lived credentials
- [ ] Revocation
- [ ] Secure tunnel
- [ ] Redaction
- [ ] Default-deny network
- [ ] Resource limits
- [ ] Audit format

## Control Plane

- [ ] Authentication
- [ ] Device API
- [ ] Agent API
- [ ] Project API
- [ ] Task API
- [ ] Session API
- [ ] Event storage
- [ ] WebSocket
- [ ] Reconnect/reconciliation

## Web/Mobile

- [ ] Login
- [ ] Pair device
- [ ] Machine list
- [ ] Agent list
- [ ] Task list
- [ ] Task detail
- [ ] Live session
- [ ] Send message
- [ ] Stop session
- [ ] Completion view

## Safety

- [ ] Capability model
- [ ] Risk classification
- [ ] Policy engine
- [ ] Approval request
- [ ] Approval UI
- [ ] Timeout
- [ ] Deny override
- [ ] First-writer-wins
- [ ] Hash-chained audit

## AFK

- [ ] AFK profile
- [ ] Restricted permissions
- [ ] Attention engine
- [ ] Push notifications
- [ ] Escalation
- [ ] "while you were away" summary
- [ ] Kill switch

## Integrations

- [ ] First production adapter
- [ ] Second production adapter
- [ ] Diff capture
- [ ] Git status
- [ ] Commit
- [ ] Push
- [ ] GitHub PR

## Reliability

- [ ] Event idempotency
- [ ] Sequence numbers
- [ ] Ack handling
- [ ] Reconnect
- [ ] Gateway restart recovery
- [ ] Agent crash handling
- [ ] Offline/degraded state
- [ ] Backup
- [ ] Restore

## Production

- [ ] Structured logging
- [ ] Metrics
- [ ] Tracing
- [ ] Alerts
- [ ] Security tests
- [ ] Resilience tests
- [ ] Performance tests
- [ ] Signed releases
- [ ] Installer
- [ ] Upgrade
- [ ] Rollback
- [ ] Documentation
- [ ] Incident response
- [ ] Private beta

---

# 38. The One-Sentence Build Strategy

> **First make one AI coding agent run safely inside a local Gateway; then make that Gateway remotely reachable through a trusted control plane; then make the remote experience excellent on a phone; then add approvals, AFK autonomy, and auditability; only after that expand to more agents, machines, integrations, and orchestration.**

---

# 39. Final Product Evolution

```text
STAGE 1
"Run an agent safely."

        ↓

STAGE 2
"Control the agent remotely."

        ↓

STAGE 3
"Supervise the agent safely."

        ↓

STAGE 4
"Let the agent work while I am AFK."

        ↓

STAGE 5
"Control many agents and machines."

        ↓

STAGE 6
"Coordinate agents."

        ↓

STAGE 7
"Operate an AI software-development fleet."
```

The final specification supports this direction: its central design is a Local Agent Gateway plus Cloud Control Plane, with local execution, per-session sandboxing, default-deny egress, secret redaction, policy enforcement, approvals, reconnect reconciliation, device revocation, and tamper-evident auditing as core architectural requirements. It explicitly recommends proving secure pairing, isolated execution, real-time supervision, approval control, diff review, Git integration, and auditability before expanding into scheduling, broad integrations, native applications, and multi-agent coordination.

---

# 40. Source Basis

This roadmap is derived from the project's final specification:

**Vendor-Neutral AFK Control Plane for Cross-Vendor AI Coding Agents — Enhanced Project Definition, Architecture, Services, Security, and Implementation Blueprint**

Key source-backed principles used in this roadmap include:

- Local Agent Gateway + Cloud Control Plane architecture
- local-first execution
- per-session sandboxing
- default-deny network egress
- secret redaction
- versioned adapter contract
- secure outbound-only workstation connectivity
- device pairing and revocation
- approval and policy enforcement
- reconnect reconciliation
- hash-chained audit
- staged MVP and later multi-agent orchestration

The roadmap deliberately converts those requirements into an implementation sequence rather than repeating the descriptive specification.

---

# 41. Immediate Next Action

Start with **Phase 0 and Phase 1 only**.

The first tangible engineering target should be:

```text
Developer PC
    |
    v
Agent Gateway
    |
    v
Sandbox
    |
    v
Mock Agent
    |
    v
Real Agent
```

The first demo is **not** the mobile dashboard.

The first demo is:

> **"I can start a real coding agent through my Gateway, prove that its project/filesystem/network access is constrained, observe normalized events, stop it, and cleanly recover its session state."**

Once that works, build the secure remote path.

Then the phone interface.

Then AFK.

Then additional agents.

Then production hardening.

Then orchestration.

That ordering minimizes rework and directly follows the architecture and sequencing principles established in the final project specification.