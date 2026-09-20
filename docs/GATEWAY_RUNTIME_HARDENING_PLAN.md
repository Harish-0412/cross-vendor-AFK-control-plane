# Gateway Runtime Hardening Plan

**Scope:** Defects 1–3 of the Chapter 1 audit — the gateway entrypoint, the Control Plane connection, and the adapter registry. This document takes each from "works" to "production-grade", grounded in patterns proven in high-value open-source projects.

**Status of the baseline.** A minimal fix for all three landed already and is proven by `scripts/smoke-core-loop.ts` (11/11). This document is about the *second* pass: the architecture that makes them survive bad networks, partial failures, hostile shutdown timing, and a growing adapter roster.

| # | Defect | Baseline fix (done) | This document |
|---|--------|---------------------|---------------|
| 1 | Entrypoint was a bare WS keepalive | Composition root builds a real `GatewayImpl` | Lifecycle state machine, supervision, signal semantics, drain budget, preflight |
| 2 | `controlPlaneUrl: ''` hardcoded | `GatewayOptions.controlPlane` threaded through | Layered config, connection supervisor, HA connections, backoff policy, health gating |
| 3 | Only the mock adapter registered | `registerAdapter()` at the composition root | Manifest discovery, capability negotiation, detection cache, circuit breaker |

---

## 0. The principle behind all three

All three defects share one root cause: **the gateway had no owner of its own lifecycle.** `GatewayImpl` was a library — it could do everything and started nothing. The entrypoint was a script that knew how to hold a socket open but nothing about what the socket was for.

The fix for all three is the same shape: introduce an explicit **supervisor** that owns state transitions, and make every subsystem a *supervised child* with a declared restart policy, rather than a thing that either works or silently doesn't. This is the Erlang/OTP supervision-tree idea, and it maps cleanly onto a Node process.

The three subsystems below become the three children:

```
GatewayRuntime (supervisor)
├── TunnelSupervisor      (restart: permanent, backoff)   ← defect 2
├── AdapterRegistry       (restart: transient, per-adapter circuit)  ← defect 3
└── SessionSupervisor     (restart: temporary — never auto-restart a user's session)
```

The critical OTP insight to borrow is **restart intensity**: a child that crashes more than N times in T seconds escalates to the parent instead of restarting forever. Without it, "auto-reconnect" becomes an infinite crash loop that looks healthy in logs and burns CPU. This is the single most valuable idea in this document.

---

## 1. Defect 1 — The gateway entrypoint

### What was wrong

`scripts/start-gateway.ts` opened a WebSocket, sent heartbeats, and acknowledged every command without executing it. It never constructed `GatewayImpl`. The 811-line gateway core and 1194-line tunnel client — both complete and tested — were dead code from the entrypoint's perspective.

### Why the baseline fix isn't enough

The current entrypoint constructs the gateway and connects. But it still has no answer for:

- **Partial startup.** If adapter registration throws halfway, we're connected to the cloud advertising a device that can't run anything.
- **Shutdown timing.** `SIGINT` calls `gateway.shutdown(true)`, which aborts in-flight sessions. A developer pressing Ctrl+C mid-refactor loses the agent's work with no chance to finish.
- **Crash recovery.** If the tunnel supervisor dies, the process stays alive as a zombie: no tunnel, no error, exit code 0.
- **Diagnosis.** `console.log` with a timestamp is not something you can grep in an incident.

### The advanced design

#### 1.1 An explicit lifecycle state machine

Replace implicit startup ordering with a declared machine. Every state transition is logged and observable, and the process's exit code is derived from the state it died in.

```
                  ┌──────────┐
                  │ starting │
                  └────┬─────┘
                       ▼
                 ┌───────────┐  preflight fails
                 │ preflight ├──────────────► fatal (exit 78: EX_CONFIG)
                 └────┬──────┘
                      ▼
                 ┌─────────┐
                 │ local   │  adapters registered, API server up,
                 │ ready   │  NO tunnel yet — gateway is usable locally
                 └────┬────┘
                      ▼
              ┌───────────────┐  auth rejected (non-retryable)
              │  connecting   ├──────────────► fatal (exit 77: EX_NOPERM)
              └────┬──────────┘
                   ▼
              ┌─────────┐   tunnel lost    ┌──────────────┐
              │ online  │ ───────────────► │  degraded    │
              │         │ ◄─────────────── │ (local-only) │
              └────┬────┘   reconnected    └──────┬───────┘
                   │                              │ restart intensity exceeded
                   ▼                              ▼
              ┌──────────┐                    fatal (exit 75: EX_TEMPFAIL)
              │ draining │ ◄─── SIGTERM
              └────┬─────┘
                   ▼
              ┌─────────┐
              │ stopped │  exit 0
              └─────────┘
```

**`degraded` is the important state.** Today, losing the tunnel means the gateway is useless. It shouldn't. A gateway with no cloud connection can still run local sessions through its own API server and queue events for replay — `TunnelClient` already has the queue (`maxQueueSize: 10000`) and the reconciliation provider interface. `degraded` makes that a first-class, reportable condition instead of an invisible one.

#### 1.2 Signal semantics, taken from Buildkite

Buildkite's agent has the clearest signal contract in this space, and it costs almost nothing to adopt:

| Signal | Meaning | Odysseus behaviour |
|--------|---------|--------------------|
| `SIGTERM` | Graceful disconnect **after** finishing current work | Stop accepting new sessions, let in-flight sessions run to completion within the drain budget, then disconnect |
| `SIGQUIT` | Forceful disconnect, cancel current work | Abort sessions immediately, flush audit events, exit |
| `SIGINT` (Ctrl+C) | Interactive: first press = `SIGTERM`, second press within 5s = `SIGQUIT` | Prints "press Ctrl+C again to force-quit N running sessions" |

The double-Ctrl+C pattern matters because the human at the terminal is the one who knows whether the agent's half-finished refactor is worth waiting for. Silently killing it is a data-loss bug wearing a UX costume.

Adopt Buildkite's two-timer structure as well:
- `cancel-signal-timeout` (default 10s): how long an adapter's child process gets after `SIGTERM` before `SIGKILL`.
- `cancel-cleanup-timeout` (default 5s): extra time *after* the process dies to flush logs, diffs and audit events. Without this, the last and most diagnostically valuable events are exactly the ones that get lost.

#### 1.3 Drain semantics

Three admission phases, borrowed from the drain-budget model:

| Phase | New sessions | In-flight sessions | Tunnel |
|-------|-------------|--------------------|--------|
| `online` | admitted | running | connected |
| `draining` | **rejected** (`503`, `Retry-After`) | allowed to finish, budget `drainBudgetMs` (default 120s) | connected, still forwarding events |
| `aborting` | rejected | cooperatively aborted via `abortSession` | connected until last event flushed |
| `stopped` | — | — | closed |

The tunnel stays up through `draining` and `aborting`. Tearing the tunnel down first is the mistake that loses the final events — the very events that tell the user why their session ended.

Crucially, the Control Plane must be **told** the gateway is draining, so the router stops selecting it. `AgentRouter` already routes on live inventory; add a `gateway.draining` event so routing reacts within one heartbeat rather than after a 10-second command timeout. This is precisely the gap the GitHub Actions runner has and that operators complain about — there is no event-driven "this runner is done" signal, so everyone polls. We have an event stream. We should use it.

#### 1.4 Preflight checks

Fail loudly at startup, not mysteriously at first use. Run before `local ready`:

- Device identity loads and the private key signs a test payload
- Control Plane URL parses and is `ws://`/`wss://`
- Every configured project root exists, is a directory, and is writable
- At least one adapter registered (warn, don't fail — mock is always there)
- Node version satisfies `engines`
- Clock sanity: local time within a few minutes of the Control Plane's `serverTimestamp` (signed handshakes and cert expiry are time-sensitive; skew produces auth failures whose error messages point nowhere near the cause)

Exit `78 (EX_CONFIG)` on failure with a specific remedy line per check.

#### 1.5 Structured logging

Replace `console.log(\`[${ts}] ...\`)` with JSON lines to stdout and human-readable to a TTY:

```json
{"ts":"2026-09-20T13:15:40.631Z","level":"info","event":"tunnel.state_change",
 "from":"connecting","to":"connected","deviceId":"dev_9c4a…","attempt":1}
```

Every log line gets `deviceId`, and session-scoped lines get `sessionId`. This is the difference between "the tunnel was flaky" and "the tunnel reconnected 14 times in 3 minutes, all with code 1006, all after exactly 20s".

---

## 2. Defect 2 — Control Plane connection

### What was wrong

`controlPlaneUrl: ''` was hardcoded with the comment `// Not connected yet; Phase 2`. Phase 2 shipped; the line didn't. There was no `GatewayOptions` field to thread a URL through, so a correctly-constructed `GatewayImpl` could never dial home.

Worse, `openWebSocket()` had a stub: with no WebSocket implementation supplied it called `simulateConnection()` and reported itself **connected**. A false green in the one place you least want one.

### Why the baseline fix isn't enough

`controlPlane.url` now threads through and the tunnel genuinely connects. What's still missing is everything that makes a long-lived connection survive a real network.

#### 2.1 Configuration layering

One env var (`CONTROL_PLANE_WS`) is not a configuration system. Adopt the Viper/Cobra precedence order, which is the de-facto standard and what every ops person already expects:

```
CLI flag  >  environment variable  >  config file  >  built-in default
```

Concretely:

```
--control-plane-url wss://…       # highest
ODYSSEUS_CONTROL_PLANE_URL=…
~/.odysseus/config.yaml           # controlPlane.url
ws://localhost:4000/ws/tunnel     # default
```

`mergeGatewayOptions()` already merges layered partials and validates via Zod — it is exactly the right shape, it just needs a CLI-flag layer and a config-file loader on top. Validation stays where it is: **one schema, validated once, at the boundary.** Note that `ControlPlaneConfigSchema` already rejects a non-`ws://`/`wss://` URL, which turns a class of silent misconfiguration into a startup error.

Secrets (`authToken`) must be loadable from a file path (`authTokenFile`) rather than only an env var, so they don't leak into process listings or shell history.

#### 2.2 A connection supervisor, not a connection

**This is the highest-value idea to steal.** `cloudflared` does not open *a* tunnel connection — it opens **four**, to at least two distinct data centres, and supports up to 25 replicas (100 connections) per tunnel. Losing one connection is a non-event; the other three carry traffic while it re-dials.

Odysseus has a single socket. Any blip is a full outage for that device, and during reconnection every command to that device fails with "device offline".

Proposed: `TunnelSupervisor` owning `N` (default 2, configurable to 4) `TunnelClient` instances.

- **Registration:** the Control Plane's `ConnectionRegistry` currently maps `deviceId → one socket`. It becomes `deviceId → Set<connection>`, with `isDeviceOnline()` true when *any* connection is live.
- **Command dispatch:** `sendCommandToDevice` picks a healthy connection (round-robin, or least-in-flight). This also removes a subtle head-of-line-blocking problem: one slow command currently delays every other command to that device.
- **Event forwarding:** events go out on any one connection. The envelope already carries `sequence`, and the reconciliation provider already handles gaps, so ordering is recoverable per-session without pinning to a socket.
- **Deduplication:** the Control Plane must make `events.append` idempotent on `(sessionId, sequence)`. With multiple connections and replay, duplicate delivery becomes normal rather than exceptional. **This is a prerequisite, not an optimisation** — do it before enabling N>1.

Start at N=2. It gets ~90% of the availability benefit at a fraction of the complexity of 4, and it forces the deduplication and multi-connection registry work that N=4 would need anyway.

#### 2.3 Backoff policy, taken from NATS

`TunnelClient` has `reconnectBaseMs: 1000`, `reconnectMaxMs: 30000`, `maxReconnectAttempts: 10`. Three problems:

**No jitter.** A Control Plane restart makes every gateway in the fleet reconnect in lockstep, producing a thundering herd that can prevent the CP from ever becoming healthy. NATS's approach is the reference: a base wait plus a random jitter, and notably the jitter is *larger for TLS links* (up to 1s vs 100ms) because a TLS handshake is expensive and you want retries spread wider. Since Odysseus is `wss://` in production, use the wider jitter. The `nats` CLI's own policy is a good default: start at 500ms, grow to a 20s cap, each step randomised between 0.5× and 1.5× its value.

**The attempt budget is global, not per-endpoint.** NATS tracks attempts *per server in the pool*, drops a server that exhausts its budget, and resets a server's count on successful connect. Odysseus should do the same once it supports multiple Control Plane endpoints, and should reset the counter on a *healthy* connection rather than merely a connected one.

**`maxReconnectAttempts: 10` is wrong for a long-lived daemon.** Ten attempts at a 30s cap is roughly five minutes, after which the gateway gives up permanently. A laptop that closes its lid for lunch comes back dead. NATS's guidance is explicit: for a long-lived service you want unlimited retries (`-1`). Default to unlimited, with restart-intensity escalation (§0) as the real safety valve.

**Health-gated backoff reset.** Reset the backoff only after the connection has been *healthy* for a period (e.g. 10s of successful heartbeats), not immediately on `open`. Without this, a connection that dies 200ms after opening resets the backoff every time and produces a tight reconnect loop that reads as "connected" in metrics.

#### 2.4 Kill the simulation stub

`openWebSocket()`'s fallback to `simulateConnection()` when no WebSocket implementation is set must become a thrown error. Tests that rely on it should inject a mock explicitly. A transport that silently pretends to work is a landmine.

#### 2.5 Failure taxonomy

Not all disconnects are equal, and treating them alike is why reconnect logic goes wrong:

| Class | Examples | Policy |
|-------|----------|--------|
| **Transient network** | 1006, ECONNRESET, DNS failure | Retry with backoff, unlimited |
| **Server-initiated** | `disconnect` frame with `willReconnect: true` | Honour the server's `retryAfterMs` |
| **Auth retryable** | `DEVICE_NOT_TRUSTED` (pairing pending) | Retry slowly (30s+); the human has to approve in the UI |
| **Auth fatal** | `DEVICE_REVOKED` | **Stop. Exit 77.** Never retry. Wipe cached policy. |
| **Protocol** | Version mismatch | Stop, log the required version, exit 78 |

Note the audit finding here: the Control Plane currently returns `DEVICE_NOT_TRUSTED` for a revoked device (one of the 10 known-failing tests in `pairing.test.ts`). Under this taxonomy that bug becomes security-relevant — a revoked device is told it is merely unpaired, which is classified *retryable*, so it retries forever instead of shutting down. **Fix the Control Plane bug as part of this work.**

---

## 3. Defect 3 — Adapter registry

### What was wrong

`this.agents.register(createMockAdapter())` was the entire adapter roster at runtime. The OpenCode and Antigravity adapters existed as packages but nothing ever constructed them.

This defect is larger than it looks: `AgentRouter` (Phase 10–11) already queries devices via `system.inventory` and routes by capability, checking `capabilities.approvalInterception` and sorting by `capability_first`. **The entire routing and orchestration layer was routing across a fleet whose every member reported exactly one agent: the mock.** Fixing registration is what switches the Phase 10–11 work on.

### Why the baseline fix isn't enough

`registerAdapter()` at the composition root is the right *architecture* — core doesn't grow a dependency per vendor. But the current probing is a hardcoded array with a `try/catch`, which means:

- Adding an adapter requires editing the entrypoint
- A broken adapter is indistinguishable from an absent one
- Detection runs eagerly at startup, so a hung `opencode --version` blocks boot
- Nothing reacts when an adapter starts failing at runtime

#### 3.1 Manifest-based discovery, taken from Packer

Packer discovers plugins by **filesystem convention plus a naming contract** that encodes the API version in the filename:

```
packer-plugin-<name>_<version>_<api_version>_<os>_<arch>
```

with a two-phase load: explicitly-required plugins first (which take precedence), then optimistic discovery of the rest.

Adapt this. Each adapter package ships an `odysseus-adapter.json` manifest:

```json
{
  "id": "opencode",
  "name": "OpenCode",
  "entry": "./dist/index.js",
  "export": "OpenCodeAdapter",
  "protocolVersion": "1.x",
  "platforms": ["linux", "darwin", "win32"],
  "detect": { "command": "opencode", "versionFlag": "--version", "timeoutMs": 3000 }
}
```

The registry discovers manifests from three sources, in precedence order:

1. **Explicitly configured** — `adapters: [{ id, path }]` in config (always wins, always an error if it fails to load)
2. **Workspace packages** — `gateway/adapters/*/odysseus-adapter.json`
3. **User-installed** — `~/.odysseus/adapters/*/odysseus-adapter.json`

Adding an adapter becomes "drop in a directory", and a *required* adapter that fails to load is a startup error rather than a silent skip — the distinction Packer draws and the one the current `try/catch` loses.

#### 3.2 Protocol version handshake, taken from hashicorp/go-plugin

`go-plugin` refuses to load a plugin whose handshake doesn't match, which is why Terraform can evolve its provider API without silently corrupting behaviour in the field. The `AgentAdapter` interface has 14 required methods; adding a 15th silently breaks every out-of-tree adapter with a `TypeError` at the worst possible moment — mid-session.

Add `ODYSSEUS_ADAPTER_PROTOCOL = 1` and a manifest `protocolVersion` range. On load: check the range, and structurally verify every required method exists before registering. Reject with a precise message naming the missing methods. Cheap to implement, and it converts a class of runtime explosion into a startup diagnostic.

#### 3.3 Capability negotiation, taken from LSP and MCP

This is the pattern Odysseus is **closest to already having** and gets the least value from today.

LSP and MCP both work by having each side *declare* its feature set up front, and then treating undeclared features as unavailable rather than discovering that at call time. MCP's rule is explicit: implemented features must be advertised, and invoking an unadvertised capability is a protocol error.

Odysseus already has `AgentCapabilities` with ten fields (`sessionCreation`, `promptDelivery`, `streaming`, `cancellation`, `diffCollection`, `approvalInterception`, `checkpointRecovery`, `multiTurn`, `fileOperations`, `toolExecution`) on a three-level scale (`supported` / `partial` / `unsupported`). `AgentRouter` reads them. What's missing is **enforcement**:

1. **Pre-flight validation.** `createSession` should reject a config requesting `approvalMode: 'ask'` against an adapter whose `approvalInterception` is `unsupported` — *before* starting the process, with a message naming the adapter and the capability. Today the session starts and the approval silently never fires, which is a governance failure in a product whose entire premise is governed autonomy.
2. **Degradation contracts.** `partial` needs defined semantics per capability, documented in one table, not decided ad hoc per adapter.
3. **Surface capabilities to the UI.** The session view should grey out "Request approval" for an adapter that can't intercept, rather than offering a button that does nothing.

**This is the single most under-exploited asset in the codebase.** The type exists, the router reads it, and nothing enforces it.

#### 3.4 Detection cache and lazy construction

`AgentManager` already has TTL caching with in-flight deduplication (`pendingDetection`) — good. Two changes:

- **Lazy construction.** Build the adapter instance on first use, not at registration. Registration should only read the manifest. A machine with six adapters installed shouldn't spawn six `--version` probes at boot.
- **Bounded detection.** Every `installOrDetect()` gets a hard timeout (manifest `detect.timeoutMs`). A hung CLI currently hangs startup; with lazy construction it hangs only the first session for that adapter, and with a timeout it hangs nothing.

#### 3.5 Per-adapter circuit breaker

An adapter whose CLI is broken should not be retried on every session. Give each adapter a circuit:

| State | Behaviour |
|-------|-----------|
| `closed` | Normal. Failures increment a counter. |
| `open` | After 3 consecutive `startSession` failures: reject immediately, report `health: unhealthy`, exclude from routing. |
| `half-open` | After a cooldown (60s, exponential to 15min), allow one trial session. Success closes; failure re-opens with a longer cooldown. |

Feed the circuit state into `AgentInfo.health`, which `system.inventory` already returns and `AgentRouter` already consumes — so a broken adapter drops out of fleet routing automatically. The wiring for this already exists end to end; only the circuit itself is missing.

This is the OTP restart-intensity idea (§0) applied per-adapter: bounded retries with escalation, instead of unbounded retries that look like progress.

---

## 4. What to integrate, and from where

| Source | Pattern | Verdict | Where it lands |
|--------|---------|---------|----------------|
| **Erlang/OTP** `supervisor` | Supervision tree; restart intensity (max N restarts in T seconds → escalate) | **Adopt the concept**, not the runtime | `GatewayRuntime`; per-adapter circuit |
| **cloudflared** | 4 concurrent HA connections to ≥2 datacentres; losing one is a non-event | **Adopt, scaled to N=2** | `TunnelSupervisor`; `ConnectionRegistry` → set-valued |
| **NATS clients** | Jitter (wider for TLS); per-server attempt budget; unlimited retries for long-lived services; custom delay callback | **Adopt wholesale** — the most mature reconnect model surveyed | `TunnelClient` backoff policy |
| **Buildkite agent** | `SIGTERM` = graceful, `SIGQUIT` = forceful; `cancel-signal-timeout` + `cancel-cleanup-timeout` | **Adopt wholesale** — clearest signal contract in the category | Entrypoint signal handlers |
| **GitHub Actions runner** | *Anti-pattern:* no event-driven "runner is done" signal forces operators to poll three sources of truth | **Avoid** — emit `gateway.draining` on the event stream | Drain protocol |
| **hashicorp/go-plugin** | Handshake config; refuse to load on protocol mismatch | **Adopt the handshake**, not the RPC model (our adapters are in-process) | `ODYSSEUS_ADAPTER_PROTOCOL` |
| **Packer** | Plugin naming/manifest convention; two-phase load with required-plugins precedence | **Adopt the two-phase model** | Adapter discovery |
| **LSP / MCP** | Capability declaration at init; invoking an unadvertised capability is a protocol error | **Adopt the enforcement rule** — we already have the types | `createSession` validation; UI |
| **Viper / Cobra** | flags > env > file > defaults | **Adopt the precedence order** | `mergeGatewayOptions` + CLI/file layers |
| **Terraform providers** | Out-of-tree plugins with version constraints | **Defer** — revisit when third parties write adapters | — |
| **go-plugin RPC / subprocess isolation** | Each plugin in its own process | **Reject for now** — adapters already spawn their own CLI subprocesses; a second boundary buys little and costs a lot | — |

---

## 5. Implementation plan

Ordered so each step is independently shippable and independently verifiable.

**PR 1 — Lifecycle & signals** *(defect 1)*
`GatewayRuntime` state machine, `SIGTERM`/`SIGQUIT`/double-`SIGINT`, drain budget with admission phases, preflight checks, sysexits-style exit codes, structured JSON logging.
*Verify:* start → SIGTERM with a running session → session completes, then exit 0. SIGQUIT → aborts, still flushes final events.

**PR 2 — Event-driven drain** *(defect 1 ↔ Control Plane)*
`gateway.draining` event; `AgentRouter` excludes draining devices; `503 + Retry-After` on new sessions while draining.
*Verify:* drain a device with two online; router sends all new work to the other within one heartbeat.

**PR 3 — Config layering** *(defect 2)*
CLI flag layer + `~/.odysseus/config.yaml` loader on top of `mergeGatewayOptions`; `authTokenFile`; `--print-config` to dump the resolved, redacted result.
*Verify:* precedence table asserted end to end, all four layers.

**PR 4 — Backoff & failure taxonomy** *(defect 2)*
Jitter (TLS-wide), unlimited retries by default, health-gated reset, per-endpoint attempt budget, failure classification, **remove `simulateConnection()`**. Fix the Control Plane's `DEVICE_REVOKED` misreport.
*Verify:* kill the CP mid-session → gateway enters `degraded`, queues events, reconnects, replays. Revoke a device → gateway exits 77 and does not retry.

**PR 5 — Event idempotency** *(prerequisite for PR 6)*
`events.append` idempotent on `(sessionId, sequence)`.
*Verify:* replaying a duplicate event batch leaves the count unchanged.

**PR 6 — Connection supervisor** *(defect 2)*
`TunnelSupervisor` with N=2; `ConnectionRegistry` becomes set-valued; `sendCommandToDevice` picks a healthy connection.
*Verify:* kill one of two connections mid-session → zero command failures, zero event loss.

**PR 7 — Adapter manifests & handshake** *(defect 3)*
`odysseus-adapter.json`, three-source discovery with precedence, protocol-version check, structural interface verification, lazy construction, bounded detection.
*Verify:* a manifest with a bad protocol version is rejected by name at startup; a required adapter failing to load is fatal; an optional one is a warning.

**PR 8 — Capability enforcement & circuit breaker** *(defect 3)*
Reject sessions requesting unsupported capabilities; document `partial` semantics; per-adapter circuit feeding `AgentInfo.health`; surface capabilities to the UI.
*Verify:* `approvalMode: 'ask'` against an adapter with `approvalInterception: 'unsupported'` is rejected pre-flight with a named reason. Three consecutive failures open the circuit and drop the adapter from routing.

---

## 6. Acceptance criteria

The work is done when all of these hold, verified by extending `scripts/smoke-core-loop.ts` into a scenario suite:

| Scenario | Expected |
|----------|----------|
| Control Plane restarts mid-session | Gateway → `degraded`, queues events, reconnects with jitter, replays; **no event loss, no duplicates** |
| One of two connections killed | Zero observable impact |
| `SIGTERM` with a running session | Session completes, final events delivered, exit 0 |
| Second `SIGINT` within 5s | Immediate abort, audit events still flushed |
| Device revoked while online | Gateway exits 77, does not retry, cached policy wiped |
| Adapter CLI removed mid-run | Circuit opens after 3 failures; adapter drops from routing; others unaffected |
| Session requests an unsupported capability | Rejected pre-flight with adapter + capability named |
| 50 gateways reconnect simultaneously | Attempts spread by jitter; no thundering-herd spike at the CP |
| Config set at all four layers | Flag wins, then env, then file, then default |
| Clock skew of 10 minutes | Preflight fails with a clock-skew message, not an opaque auth error |

---

## 7. Non-goals

- **Out-of-process adapter isolation.** Adapters already spawn their own CLI subprocesses; a second isolation boundary adds significant cost for little gain. Revisit if untrusted third-party adapters become a real scenario.
- **Third-party adapter distribution** (registries, signing, OCI). The manifest format is designed to allow it later; building it now is premature.
- **Replacing the transport.** `TunnelClient` is sound. Every change here is policy and supervision *around* it, not a rewrite of it.
- **>2 connections initially.** N=2 forces the hard work (dedup, set-valued registry) at a fraction of the complexity. Raising it later is a config change.

---

## 8. Open questions

1. **Multiple Control Plane endpoints.** The NATS per-server budget model assumes a pool. Is a self-hosted Odysseus expected to run multiple CP endpoints, or is a single URL with DNS failover sufficient? This decides whether `controlPlane.url` becomes `controlPlane.urls`.
2. **Drain budget default.** 120s is a guess. What is the realistic p95 duration of an agent turn?
3. **`partial` capability semantics.** Needs a per-capability definition table before enforcement can be meaningful — otherwise `partial` just means "we didn't decide".
4. **Local-only mode.** Should `degraded` permit *new* local sessions via the gateway's own API server, or only allow in-flight ones to finish? This is a product decision about what an offline gateway is for.

---

## Appendix — Sources

- [Erlang/OTP supervisor behaviour](https://www.erlang.org/doc/apps/stdlib/supervisor.html) — restart strategies, restart intensity
- [Cloudflare Tunnel availability and failover](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/) — 4 connections, ≥2 datacentres, 25 replicas
- [NATS reconnection](https://docs.nats.io/learn/resilient-clients/reconnection) — jitter, per-server budgets, unlimited retries for long-lived services
- [Buildkite agent lifecycle](https://buildkite.com/docs/agent/lifecycle) — `SIGTERM`/`SIGQUIT`, cancel-signal and cancel-cleanup timeouts
- [hashicorp/go-plugin](https://github.com/hashicorp/go-plugin) — handshake configuration
- [Packer plugin loading](https://developer.hashicorp.com/packer/docs/plugins/creation/plugin-load-spec) — naming convention, two-phase discovery
- [MCP architecture — capability negotiation](https://modelcontextprotocol.io/specification/2026-07-28/architecture/index) — declare-then-enforce
- [LSP specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — capability flags
- [Viper/Cobra configuration precedence](https://cobra.dev/docs/tutorials/12-factor-app/) — flags > env > file > defaults
- [Self-hosted GitHub Actions runners](https://mergify.com/blog/vms-or-docker-for-self-hosted-github-actions-runners) — the polling anti-pattern to avoid
