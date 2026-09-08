# Phase 7 — AFK Mode: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 7
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents
**Target Milestone:** M7 (A user can start a task, lock their phone, receive exactly the notifications that matter, approve remotely, and get a truthful summary of what happened — with a kill switch that always works)
**Depends on:** Phase 4 (Web Control Center — push subscription plumbing from its Subphase 4.6), Phase 5 (Policy Engine — trust profiles are already typed, not yet wired to anything real), Phase 6 (Redaction — AFK sessions run unsupervised for longer, making leaked secrets more consequential, not less)
**Status:** Planning

---

## 1. Executive Direction & Scope

This is the phase the product is named for. Everything through Phase 6 makes it *safe* to let an agent run unsupervised; Phase 7 is what actually makes "unsupervised" a deliberate, controllable state rather than just "you happened to look away." The roadmap's goal statement is precise about this: *"allow a user to intentionally hand off work to the agent while preserving safety and control."* Both halves matter — a phase that maximized "hand off" at the expense of "control" would be a regression from everything Phase 5 built, and a phase that maximized "control" by notifying about everything would just be Phase 4 with a louder phone.

### 1.1 What already exists, and the one real gap that changes this phase's shape

| Roadmap requirement | Status |
|---|---|
| §11.1 Trust profiles | 🟡 **Typed but not wired.** `TrustProfile = 'supervised' \| 'trusted-afk' \| 'read-only' \| 'default'` already exists in `@freebuff/protocol` (`packages/protocol/src/types/policy.ts`), and `PolicyEvaluationContext.trustProfile` already flows through every Phase 5 evaluation call. **But nothing persists a chosen trust profile anywhere** — every call site in `control-plane/src/policy/policy-engine-service.ts` defaults to `context.trustProfile ?? 'default'`, and no `DeviceRecord` or `SessionRecord` field exists to read a real value from. Today, "activating AFK mode" has no storage to activate. |
| §11.1 "Locked" profile (observation only) | ❌ Missing from the `TrustProfile` union entirely — needs adding. |
| §11.2 Attention Engine | ❌ Does not exist. Every event today is treated identically by anything downstream (Phase 4's planned Live Session screen renders all of them equally). |
| §11.3 "While you were away" summary | ❌ Does not exist as a feature, but **all of its inputs already exist** — `StoredEvent`s (Phase 3) and `AuditEvent`s (Phase 5) already contain everything a summary needs to be built from; this is a synthesis layer over existing data, not a new data source. |
| §11.4 Escalation | ❌ Does not exist — no scheduling/reminder mechanism anywhere in the Control Plane today. |
| §11.5 Kill switch | 🟡 **The primitive exists, the aggregate doesn't.** `POST /sessions/:id/cancel` is already implemented and tested (Phase 3). `sessions.listByUser`/`listByDevice` already exist in the repository interface. What's missing is a single "stop everything" endpoint that fans out to all of them — not a new cancellation mechanism, a new aggregation over an existing one. |
| Push delivery | ❌ Phase 4 built the *subscription* plumbing (`POST /api/v1/push/subscribe`) but explicitly deferred *sending* anything — this phase is where that pipe finally gets used. |

**The one gap that reshapes the whole phase:** trust profiles have no home to live in. Before an Attention Engine can decide "this event matters more because the user is AFK," something has to actually know the user is AFK, for *this session*, right now. Subphase 7.1 (below) is not a warm-up — it's the load-bearing piece everything else in this phase reads from.

---

## 2. Core Architectural Decisions for Phase 7

### 2.1 Trust profile is a per-session override on top of a per-device default — not a single global toggle

A user might run three sessions at once: one they're actively pairing with, one they've deliberately walked away from, one they've locked down to read-only while debugging something unrelated. A single account-wide "AFK: on/off" flag can't express that. The model:

```
DeviceRecord.defaultTrustProfile: TrustProfile   // NEW — what a new session starts with
SessionRecord.trustProfile: TrustProfile          // NEW — this session's actual, current value
```

`SessionRecord.trustProfile` is set from `DeviceRecord.defaultTrustProfile` at session creation and can be **changed mid-session** (this is the literal "activate AFK profile" action in the roadmap's own Definition of Done — steps 1 and 2 are "start task" then "activate AFK profile," implying the profile change happens *after* the session already exists, not only at creation time). Every `PolicyEvaluationContext.trustProfile` passed into Phase 5's `evaluate()` call now reads `SessionRecord.trustProfile` for real, replacing every `?? 'default'` fallback that currently masks the fact that nothing supplies a real value.

### 2.2 The `Locked` trust profile — a genuine addition to Phase 5's type, not just a Phase 7 concept

```ts
// packages/protocol/src/types/policy.ts
export type TrustProfile = 'supervised' | 'trusted-afk' | 'read-only' | 'locked' | 'default';
```

`read-only` (already existing) denies any WRITE-class capability outright. `locked` is stricter still: it denies **every** capability, including LOW-risk ones like `filesystem.read` — the session becomes pure observation, its event stream still flows to the phone, but the agent cannot act at all until unlocked. This is precisely what the kill switch (§2.5) sets a session *to*, as an alternative to fully cancelling it — "stop acting, but let me see what state you're in before I decide whether to resume or kill outright" is a genuinely different, less destructive action than cancellation, and the roadmap's own framing (*"Locked: Observation only"*) describes a state, not a termination.

**This is a real, if small, edit to the Phase 5 execution plan**: `packages/policy-engine`'s risk-class-default table (§4.1 of that plan) needs one more branch — under `trustProfile: 'locked'`, every risk class (including LOW) resolves to `DENY`, before the normal LOW/MEDIUM/HIGH/CRITICAL defaults are even consulted. Note this in the Phase 5 doc when this phase is implemented.

### 2.3 The Attention Engine is a pure classification function, not a service — mirroring Phase 5's `packages/policy-engine` shape deliberately

The roadmap's own table (§11.2) is already a complete decision table:

```
normal output       → dashboard only
milestone           → dashboard, optional notification
task complete       → notification
task failed         → high priority
approval required   → high priority
security event      → critical
```

This has the exact same shape as Phase 5's policy evaluation: a pure function of `(eventType, sessionTrustProfile, userNotificationPreferences) → NotificationPriority`, with no I/O of its own. Building it as a shared package (`packages/attention-engine`, following `packages/policy-engine`'s already-proven pattern of "pure logic, zero I/O, imported by whoever needs to decide") means the same classification the Control Plane uses to decide whether to send a push is available, byte-identical, to Phase 4's client if the web app ever wants to do its own local notification-badge logic (e.g., which sessions show an unread-attention dot in the Home screen) — one decision function, not two that can drift.

```ts
// packages/attention-engine/src/classify.ts
export type AttentionLevel = 'silent' | 'notify' | 'high_priority' | 'critical';

export function classifyEvent(
  event: EventEnvelope,
  trustProfile: TrustProfile,
  prefs: NotificationPreferences,
): AttentionLevel;
```

**Trust profile modulates the table, it doesn't replace it:** under `supervised`, even a `session.completed` might stay `notify` rather than escalating, because the user is presumed to be watching the dashboard already; under `trusted-afk`, the same event type escalates more readily, because the entire premise of that profile is that nobody's watching. This is exactly the mechanism that makes step 4 of the roadmap's own DoD ("receive no unnecessary notifications") and step 5 ("receive approval request") coexist — the Attention Engine is what makes "no unnecessary" and "the necessary one still arrives" the same guarantee rather than a tension.

### 2.4 Escalation: an in-process timer wheel, not a job queue — matching the project's $0-infra discipline

The roadmap's escalation chain (approval created → push → no response → reminder → optional email/Slack → timeout → session stays paused or falls back to policy) needs *some* scheduling mechanism. The tempting answer — a real job queue (BullMQ + Redis, or similar) — is exactly the kind of infrastructure dependency this project has deliberately avoided everywhere else (the v2 roadmap's whole premise is self-hosted Postgres/Redis *only if you already run them*, never a hard new dependency for one feature). Approvals already carry an `expiresAt` (Phase 5, §3.7 of that plan). Escalation reuses that same timestamp field, at a shorter interval, entirely in-process:

```ts
// control-plane/src/afk/escalation-scheduler.ts
class EscalationScheduler {
  // On approval creation: schedule a reminder at 50% of the way to expiresAt,
  // and (if configured) an email/Slack fallback at 80%. Both are plain
  // setTimeout calls, unref'd (same pattern gateway/checkpoint and
  // gateway/health already use for their own interval timers), reconciled
  // against the DB on process restart so a Control Plane redeploy mid-wait
  // doesn't silently drop a scheduled reminder.
}
```

This is a genuinely bounded piece of new infrastructure — one class, no new external dependency — and it directly reuses the `expiresAt` field Phase 5 already introduced rather than inventing a parallel scheduling concept.

### 2.5 Kill switch: a fan-out over the existing per-session cancel, plus one profile-only variant

Two distinct operations, both new endpoints, both thin wrappers over things that already work:

```
POST /api/v1/devices/:deviceId/kill-switch
  → fans out to sessions.listByDevice(deviceId), calls the EXISTING
    tunnelServer.sendCommandToDevice(deviceId, 'session.cancel', {sessionId})
    for each active session — the same call POST /sessions/:id/cancel
    already makes, just looped.

POST /api/v1/devices/:deviceId/lock
  → sets every active session's trustProfile to 'locked' (§2.2) instead of
    cancelling — the "stop acting, keep observing" variant.
```

**"Always visible" (roadmap's own phrase) is a Phase 4 UI requirement, not a backend one** — flagged here so it's not lost: the kill switch button belongs in the app's persistent chrome (visible from every screen), not buried in a per-session menu, and this is exactly the kind of thing to note explicitly in an implementation plan rather than assume the UI phase will infer it. **Add this as an explicit line to the Phase 4 execution plan's Subphase 4.3 (Live session screen) when this phase is implemented** — a global, always-visible "STOP ALL" affordance, distinct from that screen's existing per-session pause/resume/cancel controls.

### 2.6 Push delivery: Web Push (VAPID) first, matching Phase 4's already-laid pipe exactly

Phase 4's Subphase 4.6 already registers a service-worker push subscription and stores it via `POST /api/v1/push/subscribe` — deliberately not sending anything yet. Phase 7 is where that subscription finally gets used:

```
control-plane/src/afk/
├── push-sender.ts          # web-push library, VAPID keys from env config
├── notification-templates.ts
└── afk-orchestrator.ts     # wires Attention Engine output -> push-sender
```

`web-push` (the standard Node library for VAPID-based Web Push) is a genuinely free, no-vendor-account dependency — consistent with the v2 roadmap's stated stack (§1.1: *"Web Push (VAPID) for the PWA, free, no vendor"*). Firebase Cloud Messaging (also free) is the natural Android-native fallback, **already partially plumbed** — `control-plane/src/auth/firebase-admin.ts` already exists (added alongside Firebase-based auth verification), so the Firebase Admin SDK dependency is already in the project; Phase 7 would extend that existing integration to also send FCM pushes rather than introducing a new vendor relationship from zero.

---

## 3. Detailed Subphases

### Subphase 7.1 — Trust profile persistence and real wiring (the foundation everything else reads)

**Work:**
- Add `TrustProfile.locked` (§2.2) to `@freebuff/protocol`.
- Add `DeviceRecord.defaultTrustProfile` and `SessionRecord.trustProfile` (§2.1) — additive fields on both existing types and their repository implementations (`MemoryDatabase`, `FirestoreStore`).
- New endpoints: `PATCH /api/v1/devices/:id` (set default), `PATCH /api/v1/sessions/:id/trust-profile` (change an active session's profile — this is literally "activate AFK profile" from the roadmap's DoD step 2).
- Replace every `trustProfile ?? 'default'` fallback in `control-plane/src/policy/policy-engine-service.ts` and `control-plane/src/control-plane.ts` with an actual lookup of the session's persisted value.
- Extend `packages/policy-engine`'s risk-class defaults with the `locked` branch from §2.2.

**Definition of done:** a policy-engine test proving a `HIGH`-risk action that would normally `REQUIRE_APPROVAL` under `default` instead resolves to `ALLOW` under `trusted-afk` for a rule explicitly scoped to that profile (using Phase 5's existing `match.trustProfile` rule field, which — like `TrustProfile` itself — was already typed and already unused before this phase); and a second test proving `locked` denies a `LOW`-risk `filesystem.read`, which no other profile denies.

### Subphase 7.2 — `packages/attention-engine`

**Work:** the pure classification function from §2.3, plus a `NotificationPreferences` type (`packages/protocol/src/types/notifications.ts`, new) covering at minimum: per-event-type mute toggles, quiet hours (a time window where only `critical` escalates), and a digest-vs-immediate choice for `notify`-level events.

**Definition of done:** a full table-driven unit test matching every row of the roadmap's own §11.2 table, plus the trust-profile-modulation behavior from §2.3, plus a quiet-hours test proving a `notify`-level event is suppressed at 3am while a `critical`-level one still fires.

### Subphase 7.3 — Push delivery pipeline

**Work:** `push-sender.ts` (Web Push via `web-push`, extending the existing Firebase Admin integration for FCM), `notification-templates.ts` (one template per `AttentionLevel`, referencing the specific event — "Approval needed: git push to production" not a generic "Something happened"), and `afk-orchestrator.ts` wiring `TunnelServer`'s existing `onEventBroadcast` hook (Phase 3, already the mechanism events reach the client-facing WebSocket) to *also* call the Attention Engine and, above `notify` threshold, the push sender.

**Definition of done:** an integration test using a mock Web Push endpoint (a local test server capturing what would have been sent, not a real push service) proving that a `session.approval_required` event, on a `trusted-afk` session, produces exactly one push notification with the correct approval content — and that the same event on a `supervised` session with the app foregrounded (WebSocket connection currently open and subscribed) does **not** also fire a redundant push, since the user is, by definition of having an open connection, already watching.

### Subphase 7.4 — Escalation scheduler

**Work:** `EscalationScheduler` (§2.4) — schedule-on-create, reminder-at-50%, optional-fallback-at-80%, and the terminal behavior at 100% (`expiresAt`) already exists from Phase 5 (auto-transition to `timeout`, session's underlying action denied) — Phase 7 adds the *reminders leading up to* that existing terminal state, not a new terminal state.

**Definition of done:** using a fake clock (the same pattern Phase 5's own expiry tests already use), verify a pending approval fires exactly one reminder push at the 50% mark and no more than one, verify the scheduler survives a simulated process restart (reconciling from the DB's `expiresAt` rather than losing in-memory timer state), and verify an approval that's already been decided before its reminder fires does **not** send a stale "still waiting" push.

### Subphase 7.5 — "While you were away" summary

**Work:** a synthesis function reading `StoredEvent`s and `AuditEvent`s for a session across a time window (session start → now, or last-viewed-timestamp → now for a returning user), producing the compact roadmap-format summary:

```
While you were away
✓ Fixed 3 tests
✓ Modified 6 files
✓ Added 8 tests
⚠ Dependency install required approval
✓ Working tree clean
```

**Architecture note:** this is deliberately **not** an LLM-generated summary in this phase — it's a structured aggregation (count `session.tool_result` successes by tool category, count `session.file_changed` events, surface any `session.approval_required` that occurred) rendered through the same fixed template style as the roadmap's own example. A natural-language LLM summary is a legitimate future enhancement, but it would introduce a new external dependency (an LLM call) into the Control Plane's core path for a feature whose entire value is *reliability* of the report — a templated aggregation over data that's already exactly, provably correct (it's reading the same audit log Phase 5 made tamper-evident) is the right scope for this phase. Note explicitly: **this is a natural, low-risk place to reuse Phase 6's Feature-C-style on-device summarization if that hackathon-track work landed** (see `docs/HACKATHON_2026_FEATURE_INTEGRATION.md` §3) — a client-side model could turn this same structured aggregate into prose, on-device, with no new server-side LLM dependency at all. Flagged as a natural follow-on, not built in this subphase.

**Definition of done:** given a fixture session with a known sequence of events (successes, a file change, one approval), the generated summary matches the expected structured output exactly; surfaced via `GET /api/v1/sessions/:id/summary` and included in the push notification payload when a session completes on an AFK-profile session (so the "task complete" notification *is* the summary, not a separate thing to tap into afterward).

### Subphase 7.6 — Kill switch and lock

**Work:** the two endpoints from §2.5, both requiring the same auth as every other device-scoped endpoint (device ownership check, already the established pattern), both audited (Phase 5's `AuditLog.append`, so "who hit the kill switch and when" is itself part of the tamper-evident record — a safety-critical control being un-audited would be a real gap in a project whose entire premise is provable governance).

**Definition of done:** kill-switch fan-out cancels every active session for a device in one call, verified against a fixture with three concurrent sessions; the lock variant is verified to stop a `HIGH`-risk action mid-flight (a session already `require_approval`-pending gets its underlying approval auto-denied when the session locks, reusing Phase 5's existing `superseded`-on-revocation pattern — locking a session supersedes its pending approvals the same way revoking a device already does) without terminating the process the way cancel does.

---

## 4. Directory Structure for Phase 7

```
freebuff/
├── packages/
│   └── attention-engine/          # NEW — pure classification, per §2.3
│       ├── src/classify.ts
│       ├── src/preferences.ts
│       └── tests/
├── control-plane/src/
│   └── afk/                       # NEW
│       ├── push-sender.ts
│       ├── notification-templates.ts
│       ├── escalation-scheduler.ts
│       ├── afk-orchestrator.ts
│       └── summary-generator.ts   # Subphase 7.5
└── packages/protocol/src/types/
    └── notifications.ts           # NEW — NotificationPreferences, additive
```

---

## 5. Phase 7 Definition of Done

Matches the roadmap's own DoD, made concrete:

- [ ] Start a task, then explicitly activate `trusted-afk` on the running session (Subphase 7.1) — verified as a distinct action from session creation.
- [ ] Lock the screen (simulate: close the WebSocket subscription) — verify no `notify`-level events produce a push while the profile is `supervised`, but `trusted-afk` correctly escalates the same event types.
- [ ] Receive **no unnecessary notifications** — the quiet-hours and foreground-suppression tests from Subphases 7.2/7.3 pass.
- [ ] Receive an approval request as a real push, containing enough content to act on without opening the app first (Subphase 7.3's template test).
- [ ] Approve remotely — this is Phase 4's existing Approval screen, unchanged; Phase 7 only affects whether/how the phone was told to open it.
- [ ] Receive a completion summary matching the roadmap's exact format (Subphase 7.5), delivered as part of the completion push, not a separate step.
- [ ] Stop the agent remotely — both the destructive (kill switch) and non-destructive (lock) variants work and are independently audited.
- [ ] An approval left unanswered receives exactly one reminder at the halfway mark, and expires per Phase 5's existing terminal behavior — no double-reminders, no reminders after a decision is already made.

## 6. Do NOT Build Yet

- Email/Slack fallback delivery channels — the escalation scheduler's *hook* for them exists (§2.4), but wiring an actual email provider or Slack app is a distinct, deferrable integration; the push channel alone satisfies this phase's DoD
- LLM-generated natural-language summaries (§Subphase 7.5's explicit note) — templated aggregation is correct for this phase
- Per-notification-type granular routing rules beyond the mute/quiet-hours/digest controls in `NotificationPreferences` — a full rules-based notification-preferences *engine* would be duplicating Phase 5's policy engine for a much lower-stakes domain; keep this simple until real usage shows the simple version is insufficient
- Native iOS push (APNs) — deferred with native iOS generally, per the v2 roadmap's cost plan; Web Push + FCM covers PWA and Android, which is this project's stated Phase 4/7 scope
