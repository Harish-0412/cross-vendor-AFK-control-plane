# Phase 4 — Mobile-First Web Control Center: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 4
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents
**Target Milestone:** M4 (A user can sign in on a phone, watch a session live, approve/deny an action, and review a diff — with no desktop IDE)
**Depends on:** Phase 3 (Cloud Control Plane) — verified complete: auth, device pairing, session lifecycle, real-time WebSocket relay, 45/45 tests passing.
**Status:** Planning

---

## 1. Executive Direction & Scope

Phase 3 built the hub. Phase 4 builds the thing a human actually looks at: a **mobile-first Progressive Web App** that turns "an agent is running on my machine" into "I can see it, and act on it, from anywhere."

The product principle from the roadmap is explicit and non-negotiable: **this is not a miniature IDE.** A phone screen cannot and should not replace VS Code. The UI answers five questions and nothing more:

```
What is happening?
Is it safe?
Does it need me?
What changed?
What should I do?
```

Every screen in this plan is designed backward from one of those five questions. If a feature doesn't serve one of them, it does not belong in Phase 4 (it may belong in Phase 9 — Git/Diff Review — or later).

### 1.1 Where this sits relative to the existing frontend/

The repository already contains `frontend/` — a Next.js 15 marketing/landing page ("SmartConnect") built with shaders, GSAP animation, and a full shadcn/ui component set. **That project is not touched by Phase 4.** It is the public-facing "what is this product" site and stays that way. Phase 4 builds a **separate, authenticated application** at `freebuff/apps/web/`, per the roadmap's repository layout. The two share nothing except, optionally, a visual design language — they are different audiences (a visitor vs. a logged-in operator) with different security postures (public vs. authenticated) and different deployment lifecycles.

Reusing `frontend/`'s dependency choices (Next.js, Tailwind, shadcn/ui, `zustand`, `zod`) as the starting point for `apps/web` is sensible and saves a design-system decision — but as a fresh App Router project, not a fork of the marketing site's routes.

---

## 2. Core Architectural Decisions for Phase 4

### 2.1 Framework: Next.js App Router, deployed as a static-exportable PWA

- **Next.js 15, App Router**, `output: 'export'`-compatible where possible. The control plane is a separate origin (it is not Next.js), so this app is a pure client that talks to it over HTTPS/WSS — there is no server-side rendering dependency on private data, which means it can be hosted as static files behind any CDN (S3+CloudFront, Cloudflare Pages, GitHub Pages) at $0, consistent with the project's free-tier posture.
- **Why not a plain Vite SPA:** Next.js's built-in PWA tooling (`next-pwa` / manual service worker registration), route-based code splitting, and image optimization outweigh Vite's faster dev loop for this use case. The team already has Next.js expertise from `frontend/`.
- **Why not native mobile:** Explicitly deferred — matches the roadmap's "PWA first, native later" and the v2 cost plan's Apple Developer Program deferral.

### 2.2 State management: server state and client state are architecturally separate

This is the decision most likely to be gotten wrong, so it is stated as a hard rule:

| Kind of state | Owner | Tool |
|---|---|---|
| Anything that comes from the control plane (sessions, devices, approvals, events) | **Server** — the control plane is the source of truth | `@tanstack/react-query` (cache, refetch, optimistic updates) |
| Realtime deltas (a `session.output` event arriving over WebSocket) | **Server**, applied as query-cache patches | React Query's `setQueryData`, driven by the WS client (§2.4) |
| Pure UI state (which tab is open, is the diff panel expanded, dark mode) | **Client** | `zustand`, no persistence beyond `localStorage` for preferences |

**Never** duplicate server state into a global client store (Redux/Zustand) and then try to keep it in sync with WebSocket events by hand — this is exactly the kind of divergent-state bug class Phase 2's reconciliation engine exists to prevent at the Gateway↔Control-Plane layer, and repeating it at the Control-Plane↔Browser layer would undo that work.

### 2.3 Auth token handling

- **Access token**: held in memory only (a module-level variable in the API client), never `localStorage`. Lost on tab refresh by design — refreshed via §2.3.1 on load.
- **Refresh token**: `httpOnly`, `Secure`, `SameSite=Strict` cookie, set by the control plane's `/api/v1/auth/login` and `/api/v1/auth/refresh` responses via a `Set-Cookie` header (this requires a small, additive change to `HttpRouter` — see §5.2 — the endpoints already exist and already return the token pair in the JSON body for the Gateway/CLI case; the web client needs the cookie variant instead of the body value for the refresh token specifically).
- **Rationale**: `localStorage` is readable by any script on the page, so a single XSS bug in a dependency (this app pulls in a chart library, a markdown renderer, and a diff viewer — all attack surface) becomes full session takeover. An `httpOnly` cookie is not readable by JavaScript at all. The access token still lives in JS memory (it must, to be attached to `Authorization` headers and WS query strings), but it is short-lived (matches the control plane's existing `jwtExpiresInSec`, default 24h — Phase 4 should tighten this to 15 minutes for the web client specifically, with the refresh flow doing the work silently) and never touches disk.
- **2.3.1 Silent refresh**: on app load and on any `401` from the API client, attempt `POST /api/v1/auth/refresh` (cookie sent automatically) before failing the original request. Exactly one in-flight refresh at a time (a request-deduplication guard), so 10 simultaneous `401`s don't fire 10 refreshes.

### 2.4 Realtime layer: a typed wrapper around the control plane's `/ws/client` socket

The control plane already implements the server side of this exactly as Phase 4 needs it (`ClientServer` in `freebuff/control-plane/src/tunnel/client-server.ts`): connect with `?token=<jwt>`, send `{action: 'subscribe_session', sessionId}` / `subscribe_device`, receive `{type: 'event', ...}` frames. Phase 4's job is a client-side counterpart with the same reliability posture as the Gateway's own tunnel client (Phase 1/2), because a phone on cellular data drops connections far more often than a server:

```
apps/web/src/realtime/
├── socket-client.ts        # Connect, auth, reconnect state machine
├── subscription-manager.ts # Tracks which sessions/devices are subscribed;
│                           # re-subscribes automatically after reconnect
├── event-router.ts         # Dispatches inbound {type:'event',...} frames to
│                           # React Query cache updates by eventType
└── types.ts
```

- **Reconnect state machine**: `CONNECTED → DISCONNECTED → RECONNECTING (exponential backoff, 1s→2s→4s→...→30s cap, jitter) → CONNECTED`. This deliberately mirrors the state machine already proven in `spikes/transport` and the Gateway's `TunnelClient` — same shape, different transport role (subscriber, not publisher).
- **Re-subscription on reconnect**: the `subscription-manager` remembers what the UI currently has open (which session screen, which device screen) and re-sends `subscribe_session`/`subscribe_device` immediately after the socket reopens. Without this, a phone that locks its screen for 30 seconds silently stops receiving events forever after reconnecting — this is the single most likely "why isn't this updating" bug report Phase 4 will get if skipped.
- **No client-side event replay/dedup logic needed in Phase 4**: the durability/replay guarantee lives in Phase 2's gap-detector and Phase 3's `StoredEvent` log — a reconnecting web client simply re-subscribes and fetches the session's current state via `GET /api/v1/sessions/:id` (a normal React Query refetch), rather than trying to replay missed WebSocket frames itself. This keeps the browser client simple and pushes correctness to where the durable log already exists.

### 2.5 Design system

Reuse `frontend/`'s Tailwind + shadcn/ui foundation (Radix primitives, `class-variance-authority`, `tailwind-merge`) as the component base — it is already vetted, accessible (Radix), and in the team's hands. `apps/web` gets its own `components.json`/theme tokens rather than importing `frontend/`'s components directly, keeping the two apps deployable independently (a rule already implicit in the repo's monorepo structure).

---

## 3. Detailed Subphases

### Subphase 4.1 — App shell, auth, and routing

**Deliverables:**
- `apps/web/` Next.js project scaffold, PWA manifest (`manifest.json`), service worker registration (caching the app shell only — **not** API responses, which must always be fresh).
- Login/register screens, wired to the control plane's existing `/api/v1/auth/*` endpoints.
- The auth token lifecycle from §2.3, including the silent-refresh interceptor.
- Route structure (Next.js App Router):
  ```
  /login
  /register
  /                          → Home
  /machines/[deviceId]       → Machine
  /sessions/[sessionId]      → Live session
  /sessions/[sessionId]/diff → Diff review
  /approvals/[approvalId]    → Approval
  ```

**Definition of done:** a user can register, log in, get redirected to `/`, refresh the page and stay logged in (silent refresh), and log out (which must call the existing `/api/v1/auth/logout` **and** clear the refresh cookie — the current `logout` endpoint is a no-op acknowledgment per its own comment ("stateless; client discards tokens"), which is correct for the JWT itself but the cookie still needs an explicit `Set-Cookie: refreshToken=; Max-Age=0` from the server).

### Subphase 4.1a — QR Pairing Scan (Hackathon Feature A)

**Deliverables:**
- Camera capture UI using `getUserMedia` API with torch/flashlight toggle for low-light scanning
- JS QR decoder (e.g., `jsqr` or `zxing-wasm`) processing video frames in real-time
- Integration with existing pairing-confirmation API: decoded `qrPayload` → `parseQrPayload()` → pairing confirmation flow
- Fallback to manual code entry when camera permission is denied or unavailable
- Visual feedback: scanning animation, success/failure states, fingerprint preview before confirmation

**Architecture note — security preserved:** The QR code contains the **fingerprint**, not the private key. Scanning the QR is a faster way to execute the exact verification step that already exists — the phone still shows the words/fingerprint for a final glance before confirming, and the actual device certificate still only gets issued through the existing pairing-manager state machine. This is a UX improvement, not a new trust root.

**Implementation details:**
- `apps/web/src/components/pairing/QRScanner.tsx`: Camera capture + video frame processing
- `apps/web/src/lib/qr-decoder.ts`: Wrapper around QR decoding library with error handling
- `apps/web/src/hooks/useCamera.ts`: Camera permission management and stream lifecycle
- No changes to `@freebuff/protocol` or Control Plane — purely additive on the client side

**Definition of done:** a user can scan a QR code displayed on the Gateway's terminal during pairing, the decoded fingerprint matches the displayed words, and pairing completes successfully. Camera permission denial gracefully falls back to manual code entry.

### Subphase 4.2 — Home, Machine, and Agent screens (read-only)

The three screens that answer "what is happening?" — Home lists machines/running agents/needs-attention/recently-completed (four `GET /api/v1/sessions?state=...` and `GET /api/v1/devices` queries, polled every 30s **and** kept live via `subscribe_device` on every listed device); Machine shows one device's online status, resource usage (from the Gateway's existing health-module heartbeat data — this requires the control plane to persist and expose the heartbeat payload it already receives, a small additive change, see §5.1), and its agents/sessions; Agent shows one adapter's declared capabilities (`AgentAdapter.installOrDetect()`'s result, already typed in `@freebuff/protocol`) and current task.

**Definition of done:** Home updates in real time when a session anywhere changes state, with zero manual refresh, verified by starting a session from a second browser tab and watching it appear.

### Subphase 4.3 — Live session screen

This is the centerpiece screen and the one with the most realtime surface area: compact logs, agent messages, milestones, warnings, actions — driven by every `session.*` event type the control plane already relays (`session.output`, `session.message`, `session.tool_call`, `session.tool_result`, `session.tool_error`, `session.file_changed`, `session.checkpoint`, `session.status_changed`, `session.completed`, `session.failed`).

**Architecture note — virtualized, append-only event log:** a long-running session can produce thousands of `session.output` chunks. The event list must be a virtualized list (`@tanstack/react-virtual`) appending to an immutable, capped buffer (cap at ~2,000 rendered events client-side; the full history remains queryable via `GET /api/v1/sessions/:id/events`, already implemented in `HttpRouter`), never a naive `array.push` into React state — that degrades to a frozen tab well before 2,000 events on a mid-range phone.

**Session control actions** (prompt/pause/resume/cancel) map directly to the already-implemented `POST /sessions/:id/{prompt,pause,resume,cancel}` endpoints. No new control-plane work needed here — Phase 4 is purely a client for what Phase 3 already exposes.

**Definition of done:** from a phone, start a session (against the mock adapter, since Phase 8's real adapter doesn't exist yet), watch output stream in live, send a follow-up prompt, pause, resume, and cancel — matching the roadmap's Phase 4 Definition of Done word-for-word.

### Subphase 4.4 — Approval screen

The highest-stakes screen in Phase 4, and the direct UI counterpart to Phase 5's policy engine (built in parallel; see the Phase 5 plan §6 for the exact contract this screen consumes). Renders: what is requested, why, what resource it affects, what policy triggered it, what happens if approved, and a `[DENY]` / `[APPROVE]` pair.

**Architecture note — this screen must degrade honestly when Phase 5 isn't done yet.** Until Phase 5 lands, "what policy triggered it" has no real answer — the current `ApprovalRecord` has only `actionType`/`description`/`details`. The screen should render a "Policy: not yet enforced (manual approval only)" state rather than fabricate a policy explanation, so Phase 4 can ship and be tested against Phase 3 alone without lying to the user about a guarantee the system doesn't provide yet. Once Phase 5 ships `matched_rules`/`policy_version`/`required_role` on the approval payload, this screen renders them — additively, no rework.

#### Subphase 4.4a — Voice Feedback on Approval Decisions (Hackathon Feature B)

**Deliverables:**
- "Reject with Feedback" voice-capture control using Web Speech API (`SpeechRecognition`)
- Real-time transcription display with edit capability (user can refine the transcript before submitting)
- Integration with existing approval decision endpoint: voice transcript → `feedback` field → `POST /approvals/:id/decision { approved: false, feedback: transcript }`
- Audio recording indicator (pulsing microphone icon) with visual waveform feedback
- Fallback to text input when speech recognition is unavailable or permission is denied

**Architecture note — hard dependency on Phase 5:** This subphase requires the Phase 5 edit that adds the optional `feedback?: string` field to the approval decision endpoint and the `ApprovalWorkflow.submitDecision` method. Without Phase 5's `session.message` dispatch on denial with feedback, the transcript has nowhere to go. Sequence accordingly: Phase 5 edit first, then this subphase.

**Implementation details:**
- `apps/web/src/components/approval/VoiceFeedback.tsx`: Speech recognition UI with recording controls
- `apps/web/src/hooks/useSpeechRecognition.ts`: Web Speech API wrapper with fallback handling
- `apps/web/src/lib/speech-config.ts`: Language model configuration, noise cancellation settings
- Client-side only: transcription happens in the browser, no server-side speech processing
- The transcript is just the string that fills the existing `feedback` field — no new event type, no protocol ambiguity

**Voice-to-text stays entirely client-side:** The browser's Web Speech API transcribes locally, and the transcript is submitted through the same decision-endpoint call the Approve/Deny buttons already use. No new server-side speech processing, no new event type, no protocol ambiguity. This is exactly the pattern described in `docs/HACKATHON_2026_FEATURE_INTEGRATION.md` §2.

**Definition of done:** a user can tap the microphone button, speak a reason for rejection, see the transcription in real-time, edit it if needed, and submit it — the denial with feedback reaches the agent as a `session.message` command (verified via mock adapter's `sendMessage` call), and the session continues with the corrective instruction.

### Subphase 4.5 — Diff review screen

Files changed, summary, patch, tests, risk indicators, commit/PR action. **This screen has a hard dependency the roadmap itself doesn't call out explicitly: it needs a real agent adapter that produces real diffs (Phase 8) to be meaningfully tested**, since the mock adapter has no filesystem effect. Build the screen against a **fixture** diff (a canned unified-diff string) for Phase 4's own test suite, and treat live integration with a real adapter's actual diff output as part of Phase 9 (Git, Diff Review and Project Workspaces), which the roadmap already scopes as its own phase for exactly this reason. Phase 4 ships the component; Phase 9 wires it to something real.

#### Subphase 4.5a — Client-side Diff Summarization (Hackathon Feature C)

**Deliverables:**
- WebGPU-based small model (WebLLM or ONNX Runtime Web / Transformers.js) running entirely in the browser
- Diff summarization pipeline: unified diff → tokenization → on-device inference → human-readable summary
- UI integration: summary card at the top of the diff review screen, expandable for details
- Loading state with progress indicator (model download + inference)
- Fallback to server-side summary when WebGPU is unavailable (feature-detection, graceful degradation)

**Critical technical caveat (stated here to prevent implementation errors):**
A Progressive Web App **cannot access a phone's NPU silicon directly** — there is no web API that hands a page a handle to Snapdragon/MediaTek NPU delegate hardware. What a PWA *can* do, genuinely on-device and genuinely local-first, is run a small quantized model via **WebGPU** (WebLLM, or a small ONNX Runtime Web / Transformers.js model) — real on-device inference, real "not sent to a cloud LTF," just running on the GPU compute path rather than a literal NPU tensor accelerator. For a browser-only PWA, **this is what "on-device AI" honestly means**, and it's still a completely legitimate, still-impressive claim: no network round trip, no cloud API key, works offline.

**If literal NPU delegate access is a hard rubric requirement**, the only honest way to get it is a **thin native Android wrapper** around the same PWA (a Trusted Web Activity or Capacitor shell — the web app's code doesn't change, only its packaging), using MediaPipe Tasks or TFLite with the NNAPI delegate, which *does* route to the device's NPU on supported hardware. This is a real fork in the plan — see `docs/HACKATHON_2026_FEATURE_INTEGRATION.md` §6 for the exact phase-structure implication.

**Implementation details:**
- `apps/web/src/lib/diff-summarizer.ts`: Model loading, tokenization, and inference pipeline
- `apps/web/src/components/diff/SummaryCard.tsx`: Summary display with expand/collapse
- `apps/web/src/hooks/useWebGPU.ts`: WebGPU availability detection and context management
- Model choice: WebLLM (Llama-3.2-1B-Instruct quantized) or Phi-3-mini-4k-instruct via ONNX Runtime Web
- First-run model download cached in browser's IndexedDB for offline use
- Summary consumes the same diff payload the screen already renders — no Control Plane changes needed

**Definition of done:** given a fixture diff, the screen renders an AI-generated summary (2-3 sentences describing what changed and why) within 2 seconds on a mid-range phone, with a loading indicator during model initialization. When WebGPU is unavailable, the summary card shows a fallback message or fetches from a server-side endpoint.

### Subphase 4.6 — Push notifications (Web Push / VAPID)

Registers a service worker push subscription, sends the subscription endpoint to a new control-plane endpoint (`POST /api/v1/push/subscribe`), and — **this is Phase 7's job, not Phase 4's** to actually fire notifications on `session.approval_required`. Phase 4's scope is strictly: request permission, register the subscription, and store it server-side. Wiring "an approval was created → send a push" is explicitly AFK Mode (Phase 7), and building it early would mean building it twice once Phase 7's notification-preferences and quiet-hours logic exists. Phase 4 lays the pipe; Phase 7 turns on the tap.

**Definition of done:** a user can grant notification permission and see their subscription recorded server-side; no push is actually *sent* yet (that's Phase 7).

### Subphase 4.7 — Offline/reconnect resilience and PWA installability

- Service worker caches the app shell (JS/CSS/manifest) for install-to-homescreen and instant reload; **never** caches API/WS traffic.
- A visible connection-status indicator (small persistent banner: "Reconnecting…") whenever the WS client (§2.4) is not in `CONNECTED` state — silence here is the number one source of "it looks broken" bug reports for realtime apps.
- Lighthouse PWA audit (installable, works offline for the shell, correct manifest) as a CI gate.

**Definition of done — this is the roadmap's own Phase 4 DoD, verified explicitly:**
1. sign in
2. see workstation
3. see agent
4. start a session
5. send a message
6. watch live progress
7. stop it
8. **reconnect and see consistent state** — tested by killing WiFi mid-session on a real device, waiting 10s, restoring it, and confirming the event log has no gap and no duplicate.

---

## 4. Directory Structure for Phase 4

```
freebuff/
└── apps/
    └── web/
        ├── app/
        │   ├── (auth)/login/page.tsx
        │   ├── (auth)/register/page.tsx
        │   ├── (app)/page.tsx                       # Home
        │   ├── (app)/machines/[deviceId]/page.tsx
        │   ├── (app)/sessions/[sessionId]/page.tsx  # Live session
        │   ├── (app)/sessions/[sessionId]/diff/page.tsx
        │   ├── (app)/approvals/[approvalId]/page.tsx
        │   └── layout.tsx
        ├── src/
        │   ├── api/
        │   │   ├── client.ts          # fetch wrapper: auth header, 401→refresh→retry
        │   │   ├── sessions.ts        # typed query/mutation hooks (React Query)
        │   │   ├── devices.ts
        │   │   ├── approvals.ts
        │   │   └── auth.ts
        │   ├── realtime/              # per §2.4
        │   ├── stores/                # zustand — UI-only state
        │   ├── components/
        │   │   ├── session/           # log viewer, action bar, milestone timeline
        │   │   ├── approval/
        │   │   ├── diff/
        │   │   └── ui/                # shadcn/ui primitives
        │   └── types/                 # re-exports from @freebuff/protocol where possible —
        │                               # never redeclares EventEnvelope/SessionState locally
        ├── public/
        │   ├── manifest.json
        │   └── sw.js
        ├── package.json
        ├── next.config.mjs
        └── tsconfig.json
```

**Critical rule, stated explicitly because it's easy to violate under deadline pressure:** `apps/web` depends on `@freebuff/protocol` and `@freebuff/schemas` as workspace packages for every type that crosses the wire (`EventEnvelope`, `SessionState`, `ApprovalAction`, etc.). It must **never** hand-roll a parallel copy of these types. This is the same discipline already enforced between the Gateway and the Control Plane in Phases 1–3, and the entire point of `@freebuff/protocol` existing as a shared package — the moment the browser's idea of a `SessionState` drifts from the Gateway's, every symptom will look like a backend bug.

---

## 5. Required Control-Plane Additions (small, additive, non-breaking)

Phase 4 is deliberately scoped to consume Phase 3's existing API wherever possible, but three small gaps exist:

### 5.1 Device heartbeat/resource-usage persistence and exposure
The Gateway's `HealthModule` (Phase 1) already produces CPU/memory/heartbeat data; the tunnel protocol already has a `heartbeat` message type (`tunnel-server.ts` handles it). Today the control plane updates `lastSeenAt` on heartbeat but discards the resource payload. Add: persist the last heartbeat's resource snapshot on the `DeviceRecord`, and expose it via the existing `GET /api/v1/devices` response. No new endpoint — an additive field.

### 5.2 Refresh-token cookie mode for browser clients
`POST /api/v1/auth/login` and `/refresh` currently return `{accessToken, refreshToken}` in the JSON body (correct for the Gateway/CLI, which has nowhere to receive a cookie). Add a `Set-Cookie` header alongside the existing body **only** when the request includes a new header (e.g. `X-Client-Type: web`), so the CLI/Gateway path is completely unaffected. Additive, backward-compatible.

### 5.3 Push-subscription storage endpoint
`POST /api/v1/push/subscribe` (and `DELETE` to unsubscribe) — new, small, no interaction with existing routes. Just persists a Web Push subscription object against the authenticated user, for Phase 7 to read later.

None of these require touching the tunnel protocol, the session lifecycle, or any Phase 1–3 test. They are pure additions.

---

## 6. Testing Strategy

| Layer | Tool | What it proves |
|---|---|---|
| Components | Vitest + React Testing Library | Rendering logic, loading/error states, accessibility roles |
| Realtime client | Vitest, with a mock WebSocket server (reuse the pattern already proven in `freebuff/control-plane/tests/tunnel.test.ts` and `spikes/transport`) | Reconnect state machine, re-subscription on reconnect, no duplicate event delivery |
| End-to-end | Playwright, against a real `ControlPlane` instance started in-process (the same `ControlPlane` class Phase 3's own tests already instantiate) + the mock agent adapter | The full roadmap DoD checklist (§3, Subphase 4.7), run as one scripted flow |
| PWA/Lighthouse | `lighthouse-ci` | Installability, offline shell, performance budget |

**No new infrastructure required** — Playwright's ability to point at an in-process `ControlPlane` (rather than a deployed environment) means Phase 4's e2e suite is exactly as free and exactly as fast to run in CI as Phase 3's own test suite.

---

## 7. Phase 4 Definition of Done (DoD)

### Core DoD (Product Roadmap)

Matches the roadmap's own DoD, made concrete and testable:

- [ ] Register, log in, silent-refresh survives a page reload, log out clears the session server-side and client-side.
- [ ] Home reflects session/device state changes in real time with zero manual refresh (verified cross-tab).
- [ ] Live session: start, prompt, watch streamed output (virtualized, no frame drop past 2,000 events), pause, resume, cancel.
- [ ] Approval screen renders and resolves an approval created by the mock adapter, end-to-end, phone-viewport tested.
- [ ] Diff screen renders a fixture diff correctly on a phone-width viewport.
- [ ] Reconnect test: kill network mid-session, restore after 10s, event log has no gap, no duplicate, connection-status banner reflected the outage honestly throughout.
- [ ] Push subscription registers successfully (no notification actually sent — that's Phase 7).
- [ ] Lighthouse PWA score: installable, offline app-shell, no console errors.
- [ ] Zero hand-rolled duplicate types — every wire type imported from `@freebuff/protocol`/`@freebuff/schemas`.

---

### Hackathon-Track DoD (Feature A, B, C Integration)

**These items are in addition to the Core DoD above.** "Phase 4 done" for the product roadmap and "Phase 4 done" for the hackathon demo remain two distinguishable, both-satisfiable claims.

#### Feature A — Visual Pairing (QR Scan)
- [ ] QR scanner component renders and captures camera input on supported devices
- [ ] Decoded QR payload matches the displayed fingerprint words
- [ ] Pairing completes successfully via QR scan (end-to-end test)
- [ ] Camera permission denial gracefully falls back to manual code entry
- [ ] QR scanner works on both iOS Safari and Android Chrome (verified on real devices)

#### Feature B — Voice Feedback on Approvals
- [ ] "Reject with Feedback" voice-capture control renders and activates microphone
- [ ] Real-time transcription displays with edit capability
- [ ] Submitted feedback reaches the agent as a `session.message` command (verified via mock adapter)
- [ ] Speech recognition unavailable gracefully falls back to text input
- [ ] Voice feedback works on both iOS Safari and Android Chrome (verified on real devices)
- [ ] **Hard dependency:** Phase 5's `feedback` field on approval decision endpoint is implemented and tested

#### Feature C — On-device Diff Summarization
- [ ] WebGPU-based model loads and runs inference in the browser
- [ ] Diff summary renders within 2 seconds on a mid-range phone
- [ ] Summary card displays at the top of the diff review screen
- [ ] WebGPU unavailable gracefully degrades (fallback message or server-side summary)
- [ ] Model download cached in IndexedDB for offline use
- [ ] **Technical caveat stated:** WebGPU inference, not NPU delegate — documented in the UI and in this plan

#### Hardware Integration (Optional)
- [ ] iQOO Office Kit bridge feature-detected and contained in `apps/web/src/integrations/office-kit/`
- [ ] Clipboard and file sharing work on iQOO hardware
- [ ] Feature is invisible on non-iQOO hardware (no errors, no performance impact)
- [ ] Containment test passed: `office-kit/` directory can be deleted without affecting other code

## 8. Do NOT Build Yet (per roadmap, reaffirmed)

- A code editor or terminal emulator (this is a decision tool, not an IDE)
- Advanced analytics/dashboards
- Native Android/iOS (Phase 14+, budgeted separately)
- Collaborative multi-user review of the same session
- Actual push notification delivery (Phase 7)
- Live diff against a real adapter (Phase 9)
- Any policy/rule authoring UI (Phase 5 backend first; a policy *designer* UI is explicitly out of scope for Phase 5 too, per its own roadmap section)

### §8.x — iQOO Office Kit Bridge (Optional, Hardware-Demo-Scoped)

**⚠️ OPTIONAL SECTION — Not part of the core DoD checklist**

This section describes an optional integration with iQOO's proprietary Office Kit bridge for clipboard/file operations on iQOO hardware. It is **explicitly fenced off from the core architecture** — this is a demo-hardware integration, not a platform feature.

**Containment boundary:**
- All Office Kit integration code lives entirely in `apps/web/src/integrations/office-kit/`
- This directory imports nothing from `@freebuff/protocol`, `gateway/*`, or `control-plane/*`
- This directory is imported by nothing in the core application
- **Containment test:** if this directory were deleted entirely, nothing else in the repository should need to change

**Feature detection pattern:**
```typescript
// apps/web/src/integrations/office-kit/index.ts
export const useOfficeKitBridge = () => {
  // Feature-detect the Office Kit API
  const isAvailable = typeof window !== 'undefined' && 'officeKit' in window;
  
  return {
    isAvailable,
    clipboard: {
      read: isAvailable ? () => window.officeKit.clipboard.read() : Promise.resolve(''),
      write: isAvailable ? (text: string) => window.officeKit.clipboard.write(text) : Promise.resolve(),
    },
    file: {
      open: isAvailable ? (path: string) => window.officeKit.file.open(path) : Promise.resolve(),
      share: isAvailable ? (path: string) => window.officeKit.file.share(path) : Promise.resolve(),
    },
  };
};
```

**Integration points (all optional, all feature-detected):**
- Clipboard sync: when viewing a diff, the user can copy a file path or code snippet to the phone's clipboard via Office Kit (if available)
- File sharing: the user can share a changed file from the diff review screen to other apps via Office Kit's share sheet
- No impact on existing Phase 4 tests — all Office Kit calls are guarded by feature detection and gracefully no-op when unavailable

**Definition of done (hackathon-specific):**
- On iQOO hardware with Office Kit available: clipboard and file sharing work from the diff review screen
- On any other hardware: the feature is invisible, no errors, no performance impact
- The `office-kit/` directory can be deleted without affecting any other code

---

**Note:** This section is documented here for completeness but is NOT required for the core Phase 4 DoD. It is a hackathon demo enhancement that showcases hardware integration without compromising the vendor-neutral architecture.
