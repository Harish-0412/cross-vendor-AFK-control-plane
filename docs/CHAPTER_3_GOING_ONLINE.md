# Chapter 3 — Going Online

**Goal:** from a phone on mobile data (or any network, anywhere), open a web page,
authenticate, and drive the AI coding agent running on your Windows workstation —
over a link that survives a screen lock, a tunnel change, and a cell handover.

**Status of the codebase as of `95179e2`:** the core loop works end to end, but it
only works on `localhost`. Nothing in this repository is deployed, deployable, or
safe to expose. This document is the gap list between those two states.

> **Progress note, 24 September 2026.** This document is a point-in-time gap
> analysis and is kept as written. Since then: **N0–N5 are done**, and N4.2's
> heartbeat, replay-from-sequence and lifecycle handling and N4.3's server-side
> ping/pong are implemented. **N6 is half done** — the PWA manifest, icons,
> offline page and service-worker registration exist; Web Push still needs
> VAPID keys set on Render and Vercel. **N7 has not been started.**
> `docs/PROJECT_STATUS_AND_REMAINING_WORK.md` has the current picture.

---

## 0. The good news, stated first

The hard architectural decision is already correct and already built.

**Your PC never accepts an inbound connection.** The gateway *dials out* to the
Control Plane over WSS and keeps that socket open
(`odysseus/gateway/tunnel/src/tunnel-client.ts`). Commands travel back down the
socket the gateway opened.

That means **no port forwarding, no dynamic DNS, no firewall rule, no public IP,
no ngrok.** Your router's NAT is untouched. This works identically on home WiFi,
a café hotspot, and a phone hotspot, because it is an outbound connection like
any other HTTPS request.

It also means the entire "connect my phone to my PC" problem reduces to one
question: **where does the Control Plane live?** Today the answer is
`localhost:4000`, which is why nothing works remotely. Everything below follows
from changing that answer.

Also already built and *not* in the gap list:

- Reconnect with proportional jitter, unlimited retries, health-gated backoff reset (`gateway/tunnel/src/types.ts:125-148`)
- Gateway heartbeat every 15s with a 5s timeout (`heartbeatIntervalMs: 15000`)
- Session reconciliation and event replay on tunnel resume (`TunnelReconciliationProvider`)
- Supervised restarts, drain, signal handling, failure taxonomy, exit codes (PRs 1–8)
- Event backfill endpoint `GET /api/v1/sessions/:id/events?fromSequence=N` (`control-plane/src/api/http-router.ts:1916`)
- CORS origin allowlisting (`http-router.ts:2411-2459`), login/register rate limiting (`http-router.ts:65-66`)

The transport was engineered for a hostile network. The problem is that it has
never been pointed at one.

---

## Phase N0 — Close the two holes that make public exposure unsafe

> **This phase is blocking.** Do not bind the Control Plane to a public address
> until N0.1 and N0.2 are done. Not "do it in staging first" — the moment the
> port is reachable from the internet, both holes below are remotely exploitable
> by anyone who can guess or observe a device id.

### N0.1 🔴 The gateway tunnel authenticates nobody

**What is there now.** `TunnelServer` handles the `auth` message at
`control-plane/src/tunnel/tunnel-server.ts:212-320`. It reads `deviceId` and
`gatewayId` straight out of the payload, looks the device up, checks it is not
revoked, and replies `auth_success`.

There is no nonce. There is no challenge. There is no signature check. Grepping
the entire control plane for `auth_challenge`, `signature`, `nonce` or `verify`
inside the tunnel path returns **nothing**.

**Why that is worse than it sounds.** The gateway already does its half
correctly — it signs the auth payload (`tunnel-client.ts:386`), it handles an
`auth_challenge` message (`tunnel-client.ts:467`), it signs the challenge
response (`tunnel-client.ts:524`), and it signs individual messages
(`tunnel-client.ts:809`). The client implements a challenge-response protocol
**that the server never initiates and never checks.** The security model was
designed and built on one side only.

Worse, when the server auto-creates a device from a confirmed pairing it writes
`publicKeyPem: ''` and `publicKeyJwk: {}` (`tunnel-server.ts:245-246`) — so even
if you added verification today, there would be no key to verify against.

**Concretely, what an attacker does.** A device id is not a secret — it appears
in API responses, in the UI, and in logs. Anyone holding one connects to
`wss://your-control-plane/ws/tunnel`, sends `{type:'auth', deviceId, gatewayId}`,
and is now **registered as your workstation**. They receive every session command
intended for your machine, and every event they publish is written to your
session history and fanned out to your browser as if your machine produced it.

**The work:**

1. On `auth`, respond with `auth_challenge` carrying a random nonce bound to that
   socket, with a short expiry (5s matches the client's `authTimeoutMs`).
2. Verify the signed response against the device's stored `publicKeyJwk` using
   the same signing scheme `DeviceIdentityManager` uses.
3. Reject and close on mismatch, expiry, or nonce reuse.
4. Capture the real public key at pairing time so `publicKeyPem` is never empty —
   the pairing record must carry it (see N5).
5. Decide the policy for `signMessages: true` (`types.ts:145`): the client signs
   every message; the server should verify at least state-changing ones.

### N0.2 🔴 The browser WebSocket accepts unauthenticated clients

`ClientServer` reads a `token` query parameter. If the token is **invalid** it
closes with 4001 — correct. If the token is **absent**, it falls through to:

```ts
userId: userId || 'anonymous',
```

(`control-plane/src/tunnel/client-server.ts:~67`)

The connection is accepted and registered. On localhost this is a convenience.
On the internet it is an unauthenticated subscriber to your session event stream.

**The work:** require a valid JWT at upgrade; close 4001 when it is missing.
Keep the post-connect `auth` message path for token refresh, not for first auth.

### N0.3 🟠 The JWT secret has a working default

```ts
jwtSecret: process.env.JWT_SECRET || 'dev-secret-odysseus-control-plane-change-in-prod-2026'
```

(`control-plane/src/config.ts:6`)

That string is in a public GitHub repository. Anyone can mint a valid token for
any user id against a deployment that forgot to set the env var — and it will
forget silently, because the default makes the server boot happily.

**The work:** when `NODE_ENV === 'production'`, refuse to start without
`JWT_SECRET`. Exit 78 (CONFIG) — the gateway's own `exit-codes.ts` already
establishes this convention. A deployment that cannot start is a far better
outcome than one that starts insecure.

### N0.4 🟠 WebSocket upgrades need their own origin check

Browsers do **not** apply CORS to WebSocket handshakes. The careful origin
allowlist at `http-router.ts:2430` protects the REST API and does nothing for
`/ws/client`. Without an `Origin` check on upgrade, any website your logged-in
phone visits can open a socket to your Control Plane and — once N0.2 requires a
token, which cookies would supply — act as you. This is Cross-Site WebSocket
Hijacking.

**The work:** validate `Origin` against `config.corsOrigins` during the upgrade
handshake, before `handleUpgrade`.

---

## Phase N1 — Persistence, or every restart un-pairs your machine

`ControlPlane` selects `MemoryDatabase` unless `USE_FIRESTORE === 'true'` or
Firebase admin credentials are present (`control-plane/src/control-plane.ts:47-63`).

In-memory is correct for tests and fine for a local run you restart by hand. It
is **wrong for anything hosted**, because hosted platforms restart containers
routinely — deploys, health-check failures, host migrations, scale-to-zero. Every
one of those wipes your users, your paired devices, your sessions and your audit
log. Your phone would need to re-pair the workstation after every deploy, and the
audit trail — the thing that makes an AFK agent defensible — would have the
durability of a browser tab.

**The work:**

1. Make Firestore (or Postgres) the deployed default and refuse to start in
   production on `MemoryDatabase` rather than quietly degrading.
2. Exercise `FirestoreDatabase` against the same test suite `MemoryDatabase`
   passes — it is a second implementation of `IDatabase` and has had far less
   traffic through it.
3. Decide event retention. Session events are the highest-volume write; unbounded
   growth becomes a cost problem before it becomes a correctness problem.

---

## Phase N2 — Actually deploy the Control Plane

**There are currently zero deployment artifacts in this repository.** No
Dockerfile, no compose file, no `fly.toml`, no `render.yaml`, no `vercel.json`,
no Procfile, and no CI workflows. Verified by a repo-wide search. The Control
Plane has only ever been started by `tsx` on your own machine.

### N2.1 The host must support long-lived WebSockets

This is the one deployment decision that can go badly wrong, so it is worth being
blunt about it:

**Vercel cannot host the Control Plane.** Neither can Netlify Functions, Lambda,
or any serverless platform. Not a limitation to work around — serverless has no
persistent process to hold a socket open, and this architecture *is* a persistent
socket. Deploying the frontend to Vercel is fine and expected. The Control Plane
needs somewhere else.

Suitable: **Fly.io** (WS-native, cheap, good global placement), **Render**
(persistent web services), **Railway**, or any VPS with a reverse proxy. You have
Vercel, Render and Cloudflare connectors available in this workspace, so Render
is the path of least friction.

### N2.2 The artifacts to write

- A multi-stage `Dockerfile` for the pnpm workspace (build with `tsc --build`, ship `dist/` + prod deps only)
- A documented environment contract: `JWT_SECRET`, `CORS_ORIGINS`, `USE_FIRESTORE`, `CONTROL_PLANE_PORT`, `NODE_ENV=production`, `SECURE_COOKIES=true`, credentials
- Health check wired to the existing `/health` route (`http-router.ts:202`)
- `corsOrigins` set to the deployed frontend origin — it currently defaults to `http://localhost:3000` (`config.ts:9`), which will reject your real frontend
- TLS terminated at the platform edge, giving you `https://` and `wss://` for free

### N2.3 Idle timeouts are the thing that will bite you

Every proxy between your phone and the Control Plane will close a socket it
thinks is idle. Cloudflare's is ~100s. nginx defaults to 60s. Fly and Render have
their own. The gateway's 15s heartbeat comfortably beats all of them. **The
browser client sends nothing at all** — see N4.2. Measure the real idle timeout
of whichever host you pick and set the client heartbeat below it, rather than
assuming.

---

## Phase N3 — Point the three clients at the deployed host

Small phase, listed separately because each default is a place the system quietly
falls back to localhost.

| Client | Setting | Current default | File |
|---|---|---|---|
| Gateway | `ODYSSEUS_CONTROL_PLANE_URL` (or `CONTROL_PLANE_WS`, or `--control-plane-url`) | `ws://localhost:4000/ws/tunnel` | `gateway/core/src/runtime/config-loader.ts:51,176` |
| Frontend REST | `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | `frontend/lib/api-client.ts:6` |
| Frontend WS | `NEXT_PUBLIC_WS_URL` | `ws://localhost:4000` | `frontend/lib/realtime.ts:44` |

All three must move to `https://` / `wss://`. Note that a page served over HTTPS
**cannot** open a `ws://` socket — browsers block mixed content outright — so a
missed `NEXT_PUBLIC_WS_URL` produces a frontend that loads fine and is silently
realtime-dead. Worth an explicit startup assertion.

Then deploy the frontend itself (Vercel, which it is already structured for).

---

## Phase N4 — Make the link survive a real mobile network

This is the phase your question is actually about. N0–N3 get you connected; this
is what keeps you connected when the phone goes in your pocket.

### N4.1 Gateway ⇄ Control Plane — largely done, needs validation

Heartbeats, jittered reconnect, unlimited retries, reconciliation and replay all
exist. What has never happened is running them against a real network with a real
proxy in the path. The work here is validation, not construction: confirm the
heartbeat beats the host's idle timeout, confirm a killed WiFi link reconnects
and replays without gaps, confirm a laptop resuming from sleep recovers.

### N4.2 🔴 Browser ⇄ Control Plane — this is the weak link

`frontend/lib/realtime.ts` (221 lines) has exponential-backoff reconnect
(`realtime.ts:141-148`) and nothing else. Specifically it has:

- **No heartbeat.** A mobile socket that goes quiet gets reaped by an intermediate proxy. The client will not notice until it tries to send.
- **No event replay on reconnect.** It resubscribes and resumes the live stream. Everything that happened while the phone was asleep is **silently missing** — no gap marker, no error, just an event log with holes. For an AFK tool this is the worst possible failure mode: the screen looks healthy and is lying.
- **No `visibilitychange` or `online` handling.** Unlock your phone and you wait out the backoff timer — up to tens of seconds staring at a stale screen — when the network came back instantly.
- **No half-open detection.** Mobile networks produce sockets that are open on your end and dead on the other. Without a ping there is nothing to detect this with.

**The fix is small and the primitive already exists.** The server already serves
`GET /api/v1/sessions/:id/events?fromSequence=N` (`http-router.ts:1916`). The
client needs to track the last sequence it rendered and backfill from it on every
reconnect. Plus a ~20s ping, and immediate reconnect on `visibilitychange` and
`online`.

This is the single highest-value item in Chapter 3 for perceived stability. The
gateway side was engineered for a hostile network; the browser side was written
for localhost, and the phone is the side on the hostile network.

### N4.3 🟠 Neither WebSocket server pings its clients

There is no ws-level `ping`/`pong` in `tunnel-server.ts` or `client-server.ts`.
`TunnelServer` infers liveness from application heartbeats, which works for the
gateway. Nothing reaps a dead browser socket, so the registry accumulates
connections that will never receive anything, and broadcasts fan out to sockets
that are gone.

**The work:** server-side ping interval with terminate-on-missed-pong for both
servers. Standard `ws` pattern.

---

## Phase N5 — Pairing across the internet

The pairing endpoints exist and work (`http-router.ts:407-470`): the gateway
initiates, the user confirms a code in the web UI, the gateway polls for
confirmation. Over the internet it needs tightening:

- **Bind the device public key at pairing time.** Today the key never enters the pairing record, which is why `publicKeyPem: ''` lands in the device (`tunnel-server.ts:245`). N0.1 cannot work without this. These two items are one piece of work.
- **Rate-limit code verification.** Login and register are rate-limited (`http-router.ts:65-66`); pairing is not. A short code with unlimited attempts is brute-forceable — and the reward is a trusted device on your account.
- **Enforce single use and the 300s TTL** (`config.ts:11`) on the confirm path, not just at read time.
- **Show the fingerprint on both sides.** `DeviceIdentityManager` already produces human-readable fingerprint words and the gateway prints them at startup. Surfacing the same words in the browser turns pairing into a verification the user can actually perform, rather than a code they type on faith.

---

## Phase N6 — The phone experience

You asked specifically about a phone. Two gaps:

- **No PWA manifest.** `frontend/public/` has icons and a `sw.js`, but no `manifest.json`. Without it the app cannot be installed to the home screen and runs as a plain browser tab — which iOS is aggressive about suspending, which makes N4.2 hurt more.
- **Push notifications are scaffolded, not wired.** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` exists in the env example and `PushSender` exists in the control plane. Push is what makes AFK work: the whole premise is that you are *not* looking at the screen. Without it, "the agent needs your approval" waits until you happen to open the tab.

Both are small. Both are the difference between "a website that works on a phone"
and "the thing you actually use."

---

## Phase N7 — Verification that means something

`odysseus/scripts/smoke-core-loop.ts` runs 11 end-to-end checks and passes. It
runs entirely in-process against localhost.

**The work:** a remote variant that takes a deployed base URL, runs the same
checks against a gateway on your workstation and a client on a genuinely
different network, and additionally asserts the things only a real network can
break — kill WiFi mid-session and confirm replay closes the gap with no missing
sequences; background the phone for five minutes and confirm the timeline is
complete on return; confirm a revoked device is actually refused.

A green localhost smoke test is not evidence about the internet. Until this
exists, every claim in this document about stability is a design argument rather
than a measurement.

---

## Recommended order

```
N0  Auth holes             ← BLOCKING. Nothing else may ship before this.
N1  Persistence            ← Otherwise every deploy un-pairs your machine.
N2  Deploy the CP          ← The step that actually makes it reachable.
N3  Repoint clients        ← Small; three env vars and a mixed-content assertion.
N4  Connection resilience  ← N4.2 is what "stable" will feel like.
N5  Pairing hardening      ← N5's key-binding is a prerequisite of N0.1.
N6  PWA + push             ← Turns it from reachable into usable.
N7  Remote verification    ← Turns all of the above from claimed into measured.
```

**N0 and N5's key-binding are one unit of work** — the challenge-response cannot
be implemented without the public key that pairing must start storing. Doing N0.1
first and discovering this is a wasted pass.

**The shortest honest path to your phone talking to your PC** is N0 → N1 → N2 →
N3. That gets you connected and safe. N4.2 is what determines whether the
experience is trustworthy or merely functional, and it is a few hundred lines in
one file.

---

## What this document does not claim

Everything above is read off the code at `95179e2`. The file:line references are
current. But none of it has been run against a deployed host, because no deployed
host exists yet — so the idle-timeout numbers, the reconnect behaviour on a real
cell handover, and the Firestore adapter's behaviour under load are all
*predictions from the code*, not observations. N7 is what converts them.
