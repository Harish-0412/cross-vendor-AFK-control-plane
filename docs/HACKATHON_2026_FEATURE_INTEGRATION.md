# iQOO Hackathon 2026 — Feature Integration & Phase Redefinition

**Purpose:** Analysis of `Freebuff: iQOO Hackathon 2026 Optimization Strategy` against the actual codebase, with corrections where the source document's proposed wiring conflicts with existing architecture, and exact edits to existing phase documents.

**How to read this doc:** each feature gets a verdict (**Accept as-is** / **Accept, modified** / **Reject as stated, replace with**), grounded in what's actually in source, followed by a section listing every phase document that needs to change and precisely what changes.

---

## 0. Top-line verdict

The hackathon doc's instinct is right — a passive PWA dashboard scores badly on hardware-tracked rubric items, and Freebuff's governance core is a genuine differentiator worth showcasing live. But two of its four features are described in a way that would either **weaken the security model the whole project exists to demonstrate** (Feature A, as literally written) or **misuse the event protocol** (Feature B, as literally written). Both are fixable with small corrections that also happen to be cheaper to build, because the underlying plumbing already exists. Feature C needs one honest technical caveat about what "NPU" actually means from a browser. Feature D needs a containment boundary so a proprietary OEM demo feature doesn't leak into the vendor-neutral core.

None of this is a rejection of the strategy. It's the difference between a demo that looks impressive and a demo that's also still true to what you'd tell a security reviewer afterward — and for a "Technical Depth" + "Novelty" judged category, the second one is the one that survives a judge's follow-up question.

---

## 1. Feature A — Visual pairing (camera)

**Verdict: Accept, modified — and it's cheaper than the source doc thinks.**

### What the source doc gets wrong
It describes the QR code as containing *"the workstation's Ed25519 public key and session endpoint."* If the phone scans a QR code and simply **trusts the key inside it**, you've collapsed pairing verification down to a single channel — the QR code itself — with no independent confirmation. That's a regression from the current word-fingerprint design, whose entire purpose is that the fingerprint travels over a channel independent of the connection being verified (you read it off the laptop screen with your own eyes; a machine-in-the-middle on the network can't also control what your eyes see). A QR code containing the actual key, scanned and trusted automatically, has no such independence — anything that can display a QR code on the laptop's screen (including malware that's already compromised the display pipeline) can hand the phone a key it will blindly accept.

### What's actually already built
`gateway/identity/src/fingerprint.ts` already has `fingerprintToQrPayload(fingerprint, deviceId, gatewayId)`, producing exactly `{v, d: deviceId, g: gatewayId, f: fingerprintHex, t: timestamp}` — **the fingerprint, not the key** — base64url-encoded. `gateway/pairing/src/types.ts` already carries `qrPayload: string` on the pairing session, and the pairing manager's own CLI output already says *"Step 3: Enter the Pairing Code or scan QR"* — the protocol-level design already anticipated this feature. What's missing is two small, purely-additive things:

1. **Gateway side:** render `qrPayload` as an actual scannable QR (ASCII-art QR in the terminal via a small dependency-free encoder, or a tiny local HTML page the CLI opens) instead of only logging it as a raw string.
2. **Phone side (Phase 4, doesn't exist yet):** a camera capture (`getUserMedia` + a JS QR decoder) that reads the code, decodes it with the **already-existing** `parseQrPayload()` (already hardened against malformed input per the type-checking fix made during Phase 2 verification), and feeds the decoded fingerprint into the **same pairing-confirmation flow that exists today** — the phone still shows the words/fingerprint for a final glance before confirming, and the actual device certificate still only gets issued through the existing pairing-manager state machine, not from anything inside the QR.

**Net effect:** the QR code is a *faster way to do the exact verification step that already exists*, not a new trust root. Security posture is preserved (arguably improved — a mis-typed or mis-read 8-character code is a worse UX failure mode than a camera scan), and most of the work is a rendering/scanning layer on data that's already generated and already typed.

---

## 2. Feature B — Voice-actuated steering

**Verdict: Reject the wiring as stated, replace with a small Phase 5 extension.**

### What the source doc gets wrong
It proposes injecting the corrective instruction "back into the `AgentAdapter` via the WSS tunnel as a `session.tool_result`." Check `packages/protocol/src/types/events.ts`: `session.tool_result` is already a defined event type meaning **the outcome of a tool the agent itself invoked** (e.g., "the agent ran a command, here's stdout/exit code"). Overloading it to also mean "human corrective feedback attached to a denied approval" makes the event stream ambiguous — anything downstream that pattern-matches on `tool_result` (logging, the audit trail, a future analytics view) would now have to disambiguate machine-originated results from human-originated instructions inside the same event type. This is exactly the kind of protocol drift `@freebuff/protocol`'s existence is supposed to prevent.

### What to build instead
The control plane **already has** the correct mechanism: `POST /api/v1/sessions/:id/prompt` sends a `session.message` command down the tunnel via `tunnelServer.sendCommandToDevice(deviceId, 'session.message', {sessionId, message})` (`control-plane/src/api/http-router.ts`, already implemented and tested). A corrective instruction from a human **is** a new prompt to the agent — that's precisely what `session.message` already models.

The actual gap is one field and one call-site, both in Phase 5's `approval-workflow.ts`:

1. **API surface** — extend the approval decision endpoint's body: `POST /approvals/:id/decision { approved: boolean, reason?: string, feedback?: string }`. `feedback` is new.
2. **`ApprovalWorkflow.submitDecision`** — currently `submitDecision(approvalId, decidedBy, approved, reason?)`. Add a `feedback?: string` parameter. When present **and** `approved === false`: after the existing CAS-and-record-the-denial logic runs, call the same `sendCommandToDevice(record.deviceId, 'session.message', {sessionId: record.sessionId, message: feedback})` path the prompt endpoint already uses. This requires `ApprovalWorkflow` to hold a reference to `TunnelServer` (constructor injection, same pattern `HttpRouter` already uses) — currently it's constructed with only `db`.
3. **Voice-to-text stays entirely client-side** (Phase 4): the browser's `Web Speech API` transcribes locally in the browser, and the transcript is just the string that fills the existing `feedback` field. No new server-side speech processing, no new event type, no protocol ambiguity.

This is a **smaller** change than the source doc's version (one optional field + one extra call in an already-existing method, vs. a new tool_result-shaped payload the rest of the system would need special-casing for) and it stays inside Phase 5's existing state machine rather than adding a parallel path around it.

---

## 3. Feature C — On-device diff summarization

**Verdict: Accept, with one technical caveat stated up front so it doesn't become a demo-day surprise.**

A **Progressive Web App cannot access a phone's NPU silicon directly** — there is no web API that hands a page a handle to Snapdragon/MediaTek NPU delegate hardware. What a PWA *can* do, genuinely on-device and genuinely local-first, is run a small quantized model via **WebGPU** (WebLLM, or a small ONNX Runtime Web / Transformers.js model) — real on-device inference, real "not sent to a cloud LLM," just running on the GPU compute path rather than a literal NPU tensor accelerator. For a browser-only PWA, **this is what "on-device AI" honestly means**, and it's still a completely legitimate, still-impressive claim: no network round trip, no cloud API key, works offline. Say "on-device, GPU-accelerated inference" rather than "NPU" if staying inside the pure-PWA architecture — a judge who asks "which NPU API are you calling" deserves an answer that survives the question.

**If literal NPU delegate access is a hard rubric requirement**, the only honest way to get it is a **thin native Android wrapper** around the same PWA (a Trusted Web Activity or Capacitor shell — the web app's code doesn't change, only its packaging), using MediaPipe Tasks or TFLite with the NNAPI delegate, which *does* route to the device's NPU on supported hardware. This is a real fork in the plan — see §5's phase-structure implication below, since it reintroduces a native packaging step the whole roadmap has otherwise deliberately deferred to Phase 14.

**What already exists to build on:** `GET /api/v1/sessions/:id/diff` is already implemented (Phase 3) and Phase 4's plan already scopes a Diff Review screen against fixture data (since a real adapter with real diffs is Phase 8/9). The summarization model consumes exactly that same diff payload client-side — no control-plane change needed at all for this feature.

---

## 4. Feature D — Office Kit bridge (clipboard/file)

**Verdict: Accept, but explicitly fenced off from the core architecture — this is a demo-hardware integration, not a platform feature.**

Office Kit is a proprietary, single-vendor OEM bridge. The entire rest of this project is built around the opposite principle — vendor neutrality, "bring your own agent," works on any Linux/macOS/Windows machine with any browser. Wiring a proprietary phone-OEM API into the Gateway, the Control Plane, or the shared protocol package would be the one place in this codebase where "vendor-neutral" quietly stops being true. That's a real cost, not just a purity concern: every future contributor reading `@freebuff/protocol` would need to know that one code path only works on one phone brand.

**The fix is containment, not rejection.** Office Kit integration belongs entirely inside `apps/web`'s optional capability layer — a feature-detected enhancement, structurally identical to how the PWA already has to feature-detect Web Push support (not every browser has it, and the app already has to work without it). Concretely: a `useOfficeKitBridge()` hook that no-ops to nothing when the API isn't present (i.e., on literally every device except the demo hardware), sitting entirely in `apps/web/src/integrations/office-kit/` — a directory that does not exist yet and imports nothing from, and is imported by nothing in, `@freebuff/protocol`, `gateway/*`, or `control-plane/*`. If this directory were deleted entirely, nothing else in the repository should need to change. That's the containment test.

---

## 5. Exact edits to existing phase documents

### `docs/PHASE_2_EXECUTION_PLAN.md` — *(no such file exists yet; Phase 2 is committed code without a written execution-plan doc, unlike Phases 3–5)*
No architectural change needed — Phase 2's pairing protocol already supports Feature A as designed above. **Optional:** if you want a written record, add a short "Phase 2 Addendum — QR Rendering" note to whatever doc tracks Phase 2, stating that `qrPayload` (already emitted) is now also rendered as a scannable QR by the CLI. This is documentation, not redesign.

### `docs/PHASE_4_EXECUTION_PLAN.md` — several additive sections needed
1. **New Subphase 4.1a — QR pairing scan.** Insert after the existing Subphase 4.1 (App shell, auth, routing). Camera capture + JS QR decode + call into the existing pairing-confirmation API. Depends on nothing not already in the plan.
2. **New Subphase 4.4a — Voice feedback on approval decisions.** Insert into Subphase 4.4 (Approval screen). Adds a "Reject with Feedback" voice-capture control using `Web Speech API`, populating the new `feedback` field described in §2 above, submitted through the same decision-endpoint call the Approve/Deny buttons already use. **Cross-reference:** this subphase has a hard dependency on the Phase 5 edit in §6 below — sequence accordingly.
3. **New Subphase 4.5a — Client-side diff summarization.** Insert into Subphase 4.5 (Diff review screen). A WebGPU-based small model (WebLLM or equivalent) consuming the same diff payload the screen already renders. State the §3 caveat in this subphase's own text, not just in this integration doc, so whoever implements it doesn't reach for a native-only NPU API by mistake.
4. **New §8.x — iQOO Office Kit bridge (optional, hardware-demo-scoped).** A clearly-labeled *optional* section, not folded into the main DoD checklist — per §4 above, containment lives in `apps/web/src/integrations/office-kit/`, feature-detected, and its absence must not fail any existing Phase 4 test.
5. **Update §7 (Definition of Done):** add the three new items as **hackathon-track DoD**, kept separate from the existing core DoD checklist, so "Phase 4 done" for the product roadmap and "Phase 4 done" for the hackathon demo remain two distinguishable, both-satisfiable claims.

### `docs/PHASE_5_EXECUTION_PLAN.md` — one concrete, scoped edit
1. **§7.1 (New HTTP endpoints) / existing decision endpoint:** document the new optional `feedback?: string` body field on the approval decision endpoint.
2. **§7.3 (Approval workflow state machine):** add a new invariant: *"A denial carrying non-empty `feedback` additionally dispatches that text to the session as a `session.message` command via the same path `POST /sessions/:id/prompt` uses — this is not a new decision status, it is `denied` with a side effect."* This keeps the state machine's existing five terminal states (`pending/granted/denied/timeout/superseded`) unchanged — no sixth "redirected" status is needed, which keeps §9's existing test matrix valid without additions.
3. **`ApprovalWorkflow` constructor** needs `TunnelServer` injected (currently `db` only) — call this out explicitly in the module layout table (§7) so it's not missed as a "just add a field" change that quietly breaks the constructor signature every existing test already calls.
4. **New test case for §9's table:** *"Denial with feedback delivers the feedback as a session message"* — verifies the side effect actually reaches the (mock) adapter's `sendMessage`, end to end.

### No changes needed to `docs/PHASE_3_EXECUTION_PLAN.md`
Nothing in this feature set touches auth, device registry, or the tunnel protocol's shape — only new payload fields and new client-side capabilities layered on top of what Phase 3 already exposes.

---

## 6. The one real architectural fork this introduces: does Phase 4 stay pure-PWA?

State this decision explicitly rather than letting it happen by accident, because it has a real consequence for the roadmap's own stated cost/scope discipline:

- **If Feature C's "on-device AI" is satisfied by WebGPU inference in the browser** (the honest, PWA-native reading — see §3): **no fork.** Phase 4 stays exactly as planned, a pure static PWA, $0 packaging cost, works on any phone.
- **If literal NPU-delegate access or Office Kit's native bridge genuinely require it**: this pulls a **thin native Android wrapper forward from Phase 14** (Cross-Platform Gateway Packaging, currently scoped as installers for the *Gateway*, not the phone client — this would be new scope, not an accelerated existing one). That wrapper should be scoped as **narrowly as possible**: a Trusted Web Activity or Capacitor shell around the *same* `apps/web` PWA code, whose only job is exposing two native bridge calls (NPU delegate, Office Kit) back to the web layer via a JS bridge — not a parallel native app with its own UI.

**Recommendation:** default to the PWA-only path (first bullet) unless you've confirmed the hackathon's HackTracker actually distinguishes "WebGPU inference" from "NPU delegate inference" — if it doesn't (most likely, since it's almost certainly detecting *any* on-device model execution rather than inspecting which hardware path served it), the pure-PWA version scores identically for a fraction of the engineering risk this close to a deadline, and it's the version that doesn't put a native-packaging dependency in the critical path of a hackathon demo.

---

## 7. What's explicitly unchanged, and should stay that way

- **Phase 6 (redaction) and Phase 17 (multi-agent orchestration)** remain out of scope, exactly as the source doc's own Action B already correctly argues — nothing here contradicts that.
- **The deny-override floor and Policy Engine evaluation order (Phase 5, already built)** are not touched by any of these four features — voice feedback attaches to an *already-denied* action; it never becomes a new way to grant one.
- **`@freebuff/protocol` gets exactly one addition** (the optional `feedback` field, threaded through `ApprovalRecord`/the decision request shape) and zero new event types. Every other feature in this integration lives entirely in `apps/web`, which doesn't exist yet, so it adds no risk to the four phases already built and tested.

---

## 8. Suggested build order (tightest path to a working demo)

1. Fix the Phase 5 build (already flagged separately, unrelated to this feature set, but blocking everything downstream that touches `packages/policy-engine`).
2. Phase 5 edit from §5 (feedback field + workflow side-effect) — small, and unblocks Subphase 4.4a.
3. Phase 4 core (App shell → Home/Machine/Agent → Live Session → Approval) per the existing plan, with 4.1a (QR scan) and 4.4a (voice feedback) built inline rather than bolted on after — they touch the same screens.
4. Phase 4.5a (on-device diff summary) — independent of the above, can be built in parallel by a second contributor.
5. Office Kit bridge (§4) last, and only if time remains — it is additive, optional, and by construction cannot break anything built in steps 1–4.
