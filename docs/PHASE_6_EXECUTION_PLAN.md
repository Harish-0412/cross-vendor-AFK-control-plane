# Phase 6 — Secret Redaction + Data Boundary: Execution Plan

**Document:** Canonical Engineering Execution Plan for Phase 6
**Project:** Freebuff — The Kubernetes/Control-Plane Layer for AI Coding Agents
**Target Milestone:** M6 (A secret that exists anywhere in an agent's output, tool results, or diffs never appears in a cloud-bound payload, provably, against a real test corpus)
**Depends on:** Phase 1 (Gateway Foundation, `EventBus`) — verified complete. Phase 5 (Policy Engine) — for per-project custom pattern configuration, additive only.
**Status:** Planning

---

## 1. Executive Direction & Scope

Phase 5 answered "can this action happen at all." Phase 6 answers a narrower but equally load-bearing question: **given that an action is allowed to happen, does anything it produces leak a credential on the way to the cloud?** These are genuinely different failure modes. A `git push` can be fully policy-compliant — approved, logged, audited — and still have printed an AWS secret key to stdout three lines earlier because a misconfigured test suite dumped its environment. Phase 5 has nothing to say about that. Phase 6 does.

### 1.1 The scope is narrower than it sounds, because most of it already exists

Before writing a line of new code, an honest inventory of what's already built matters more than usual for this phase, because two of the roadmap's three stated requirements are **already substantially done**:

| Roadmap requirement (§10) | Status |
|---|---|
| §10.3 "Block by default": `.env`, credential stores, SSH private keys, files outside project scope | ✅ **Already implemented.** `DEFAULT_DENIED_PATHS` in `@freebuff/protocol` (`packages/protocol/src/types/project.ts`) already lists `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.env*`, `/etc/shadow`, `/etc/sudoers*`, `**/.env*`, `**/*.pem`, `**/*.key` — and it's already wired into both `gateway/sandbox/src/profiles.ts` and `gateway/sandbox/src/sandbox-manager.ts` as the default deny-list every sandbox profile inherits. |
| §10.2 "Redact": pattern-based scrubbing of API keys, tokens, private keys, passwords, connection strings | 🟡 **Fully designed and implemented as a spike**, not yet wired into a running pipeline. `spikes/redaction/` has a complete `Redactor` implementation, 39+ patterns across 9 secret categories, a streaming variant, an entropy-based fallback detector, and a `DataBoundary`/`Classifier` pair — proven in isolation with its own test suite, never called from `gateway/core`. |
| §10.1 "Outbound data path" (Agent Output → Normalizer → Redaction Proxy → Classification → Encryption → Tunnel) | ❌ **The pipeline stage doesn't exist.** Events flow from an adapter straight to the event bus and out the tunnel today, untouched. |

**This reframes Phase 6's actual work:** it is not "build a redaction system" — that's done and sitting in `spikes/`. It is **"promote the spike to production status, and insert it at the one correct point in an already-existing pipeline."** That is a much smaller, much lower-risk phase than the roadmap's framing might suggest, and Phase 6's plan should not manufacture extra scope to feel proportionate to Phase 5 — the right size here is the right size.

---

## 2. Core Architectural Decisions for Phase 6

### 2.1 Redaction runs on the Gateway, never on the Control Plane — this is the whole point, stated as a hard constraint

If redaction happened at the Control Plane, the secret would already have crossed the network to get there — the "prevent transmission" goal would already have failed by the time redaction ran. **Every redaction call in this phase happens inside the Gateway process, before a payload is handed to the tunnel client.** The Control Plane never redacts anything; it should never receive anything that needs redacting in the first place. This single sentence is Phase 6's equivalent of Phase 5's "the trust boundary is the Control Plane" — it is the constraint everything else is checked against.

### 2.2 Exactly one insertion point: `wireAdapterEvents` in `gateway/core/src/gateway.ts`

Every event, from every adapter, regardless of vendor, already funnels through one `for await (const event of stream)` loop (`gateway.ts:531-539`) before being registered, checkpointed, and published to the `EventBus` (whose subscribers include the tunnel client). This is not a new discovery Phase 6 has to engineer — it's an existing chokepoint, and it means redaction can be added as **one call**, not a scattered set of patches across every adapter:

```ts
// gateway/core/src/gateway.ts — wireAdapterEvents, current shape:
for await (const event of stream) {
  if (!this.registry.get(gatewaySessionId)) break;
  this.registry.appendEvent(gatewaySessionId, event);   // <- redact BEFORE this line
  this.bus.publish(event);                               // <- and BEFORE this line
  ...
}

// Phase 6 shape:
for await (const rawEvent of stream) {
  if (!this.registry.get(gatewaySessionId)) break;
  const event = this.redactionProxy.redactEvent(rawEvent);
  this.registry.appendEvent(gatewaySessionId, event);
  this.bus.publish(event);
  ...
}
```

**Why redact before `checkpointStore`/`registry.appendEvent` too, not just before the tunnel:** the checkpoint store persists to local disk so a killed session can resume. That's the developer's own machine, so the stakes are lower than the network hop — but a checkpoint file is still something that could end up in a backup tool, a support bundle attached to a bug report, or a `git add .` mistake in a dotfiles repo. Redacting once, at the single point closest to the source, means every downstream consumer — checkpoint, registry, bus, tunnel — sees the same already-safe data. Redacting separately at each consumer would mean four places that all have to independently remember to do it, and Phase 6 exists specifically to replace "remembering" with "structurally can't forget."

### 2.3 Promote the spike into `gateway/redaction`, following the exact package pattern every other Gateway module already uses

```
freebuff/gateway/redaction/
├── src/
│   ├── index.ts
│   ├── patterns.ts          # ported from spikes/redaction, expanded (§4.2)
│   ├── redactor.ts          # ported, with the any-typing gap closed (§3.1)
│   ├── classifier.ts        # ported
│   ├── redaction-proxy.ts   # NEW — the event-shaped wrapper gateway.ts calls
│   └── types.ts
├── tests/
│   ├── redactor.test.ts               # ported from spikes/redaction/tests
│   ├── performance.test.ts            # ported — the <10ms/1KB, <2s/1MB budgets stay as a gate
│   └── redaction-proxy.test.ts        # NEW — event-shaped, not string-shaped
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

`spikes/redaction/` is left in place, untouched, as historical record of the original spike — matching how Phase 0's other spikes (`spikes/sandbox`, `spikes/transport`) were never deleted after their real counterparts (`gateway/sandbox`, `gateway/tunnel`) were built. `gateway/redaction` is a fresh package that **starts from** the spike's code but is the one everything else in the workspace actually imports.

### 2.4 Close the one real type-safety gap the spike has

`spikes/redaction/src/types.ts` declares `redactObject(obj: any): any` on the `Redactor` interface. Given this project's now-established discipline (every other module in Phases 1–5 had at least one `any`-related defect found and fixed during promotion to production), this is exactly the kind of thing to fix on the way in, not after:

```ts
// Before (spike):
redactObject(obj: any): any;

// After (gateway/redaction):
redactObject<T>(obj: T): T;
```

The implementation still has to walk an arbitrary object shape at runtime (redaction is inherently "look at every string value, regardless of where it lives in the structure"), so the function body still needs internal type narrowing — but the **public contract** should promise the caller gets back the same shape they passed in, not `any`, so a call site like `redactionProxy.redactEvent(rawEvent as EventEnvelope)` doesn't silently degrade to `any` the moment it touches redaction.

---

## 3. Detailed Subphases

### Subphase 6.1 — Promote the spike to `gateway/redaction`

**Work:** move (not copy-and-abandon) the spike's four source files into the new package structure from §2.3, apply the generic-typing fix from §2.4, wire up `package.json`/`tsconfig.json`/`vitest.config.ts` matching every sibling Gateway package (composite project references into `@freebuff/protocol`/`@freebuff/config`, `test`/`build`/`typecheck`/`lint` scripts — the exact pattern already standardized across `gateway/checkpoint`, `gateway/health`, `gateway/sandbox`, etc. after the Phase 1–3 build-consistency work).

**Definition of done:** `pnpm --filter @freebuff/redaction test` passes with the full ported test suite (50+ pattern tests, false-positive tests, performance benchmarks) unchanged in behavior from the spike, and `pnpm build` at the workspace root includes this package with zero new type errors.

### Subphase 6.2 — The `RedactionProxy`: from raw strings to typed events

This is the one genuinely new piece of code in this phase. The spike's `Redactor.redact(text: string)` operates on plain strings; the Gateway's event stream is `EventEnvelope` objects with a `payload: unknown` field whose shape varies by `eventType`. `RedactionProxy` is the adapter between the two:

```ts
// gateway/redaction/src/redaction-proxy.ts
export interface RedactionProxy {
  redactEvent(event: EventEnvelope): EventEnvelope;
  getStats(): RedactionProxyStats;   // §6 — for the metrics already typed in @freebuff/protocol
}

export function createRedactionProxy(
  redactor: Redactor,
  classifier: Classifier,
  options?: RedactionProxyOptions,
): RedactionProxy;
```

**Which fields get walked, and why not "the whole object blindly":** `redactEvent` recursively walks `event.payload` (via the now-generic `redactor.redactObject<T>`) plus a small explicit allowlist of other string-bearing fields (`event.payload` covers `session.output`'s `content`, `session.message`'s `text`, `session.tool_call`'s `arguments`, `session.tool_result`'s `output`, `session.file_changed`'s `diff`). Fields like `event.id`, `event.sequence`, `event.sessionId`, `event.timestamp` are **never** passed through the redactor — they're structural metadata, not agent-produced content, and running secret-detection regexes against a UUID wastes cycles for zero benefit. Being explicit about this boundary (rather than "redact everything, recursively, forever") is what keeps the performance budget from §6.1's ported benchmarks intact once this runs on every single event instead of on isolated test strings.

**Definition of done:** a table-driven test (`redaction-proxy.test.ts`) covering every `EventType` that carries agent-produced text (`session.output`, `session.message`, `session.tool_call`, `session.tool_result`, `session.file_changed`, `session.checkpoint`), each with a fixture payload containing one embedded fake secret, asserting the returned event's payload no longer contains it and the rest of the payload (non-secret fields) is byte-identical to the input.

### Subphase 6.3 — Wire the proxy into `gateway/core`

The one-line change described in §2.2, plus:

- `GatewayCore` gains a `redactionProxy: RedactionProxy` constructed in the constructor, following the exact pattern `checkpointStore`/`healthModule`/`tunnelClient` already use (all constructed in `GatewayImpl`'s constructor today).
- `GatewayOptions.redaction` **already exists** as a field (`DEFAULT_GATEWAY_OPTIONS.redaction: { enabled: true, customPatterns: [] }` is already defined in `@freebuff/config`'s `constants.ts` — another place the roadmap was already anticipated in the type layer before the feature existed). Phase 6 makes this field **actually do something**: `redaction.enabled` gates whether `wireAdapterEvents` calls the proxy at all (default `true`; disabling it should require the same `--dev-unsafe-no-sandbox`-style explicit, loudly-logged opt-out the README already mandates for skipping the sandbox — redaction and sandboxing are both non-negotiable-by-default security properties, and should be disable-able through the same class of escape hatch, not two different UX patterns for "I am choosing to turn off a safety feature").
- `redaction.customPatterns` (already typed, currently always empty) becomes the place a project- or policy-level custom secret pattern gets injected — see §5 for how Phase 5's Policy Engine feeds this.

**Definition of done:** an integration test in `gateway/core/tests/integration/` — extending the existing `gateway.test.ts`/`api-server.test.ts` suite rather than a new isolated harness — where the mock adapter (extended per Subphase 6.4) emits an event containing a fake AWS key, and the test asserts that `bus.publish` and `checkpointStore` both received the redacted version, never the raw one. This is the test that actually proves the §2.2 chokepoint claim rather than just asserting it in a comment.

### Subphase 6.4 — Extend the mock adapter with a redaction test scenario

`gateway/adapters/mock/src/scenarios.ts` already has a scripted-scenario pattern (used throughout Phase 0–3 testing). Add a new scenario — `leaky-output` — that emits a `session.output` event whose content is a realistic secret-shaped string (a fake-but-pattern-matching AWS key, e.g. `AKIAIOSFODNN7EXAMPLE`, which is literally AWS's own published example key for exactly this kind of testing — never a real credential in test fixtures). This gives every layer above (Gateway integration tests, Control Plane end-to-end tests, and eventually Phase 4's web app tests) a standard, reusable way to prove "a secret was in the pipeline and did not survive it" without each layer inventing its own fixture.

**Definition of done:** `leaky-output` scenario exists, is exercised by Subphase 6.3's integration test, and is documented in `gateway/adapters/mock/README.md` (or wherever the existing scenario list is documented) as the canonical redaction-proof fixture for any future layer that needs one — including Phase 8's real-adapter work, which will want exactly this kind of "does the real agent's actual output survive redaction" check.

### Subphase 6.5 — The test corpus (the roadmap's explicit Definition of Done)

The roadmap requires a specific corpus: fake cloud keys, fake JWTs, fake passwords, private-key blocks, database connection strings, secrets encoded in logs. **This corpus already exists** — `spikes/redaction/test-fixtures/secrets/` has exactly this (`api-keys.txt`, `aws-credentials.txt`, `jwt-tokens.txt`, `private-keys.pem`, `connection-strings.txt`, `passwords-in-code.ts`, `ssh-keys.pub`, `mixed-content.md`). Subphase 6.5's job is to **move it alongside the promoted package** (`gateway/redaction/test-fixtures/`) and add exactly one new fixture the spike didn't need but the live pipeline does: a full `EventEnvelope` JSON fixture per event type, embedding one secret from each existing corpus file, so the event-shaped tests from Subphase 6.2 draw from the same proven corpus rather than a parallel, drifting set of inline strings.

**Definition of done:** every existing corpus file has at least one passing test proving its secret is caught; the new event-shaped fixtures exist and are consumed by Subphase 6.2's tests; and — the roadmap's own closing requirement — a single end-to-end test exists that starts a real (mock, for this phase; real-adapter coverage lands naturally once Phase 8 exists) session, feeds it the `leaky-output` scenario, and asserts against the **Control Plane's own stored event** (via the already-existing `GET /api/v1/sessions/:id/events`, Phase 3) that the secret never arrived there. This is the test that makes the DoD claim ("raw secret never reaches cloud event payload") an assertion against the actual cloud-side storage, not just against the Gateway's internal state — closing the loop across all three services rather than trusting that redacting-before-the-tunnel implies redacting-in-the-cloud.

---

## 4. Data Classification and the "Do Not Transmit" List

### 4.1 `DataBoundary`/`Classifier` — already built, needs exactly one integration decision

`spikes/redaction/src/classifier.ts` already has `DefaultClassifier`, `DataBoundary`, and a three-tier `'strict' | 'moderate' | 'lenient'` policy factory (`createDataBoundary(policy)`), classifying content into `public | internal | confidential | restricted` with `pii`/`secrets`/`credentials` flags. Promoted alongside the redactor (§2.3), the remaining decision is **what a `restricted` classification actually does**, since today the classifier can label something but nothing acts on the label:

- **Decision:** a `restricted`-classified payload (this is stricter than "contains a secret that got redacted" — it's for content the classifier judges shouldn't be transmitted **even in redacted form**, e.g. a full raw environment dump) causes the `RedactionProxy` to replace the **entire** payload with a placeholder event noting `payload_blocked: true, reason: 'restricted_content'`, rather than a partially-redacted version. This matches the roadmap's §10.3 framing of certain content as **block by default**, distinct from §10.2's **redact by default** — redaction assumes the surrounding context is safe to send once the secret is masked; blocking assumes the context itself is the problem.

### 4.2 Pattern set: audit and extend, don't just port unchanged

The spike's 39 patterns across API keys/AWS/GCP/Azure/JWT/private-keys/SSH/connection-strings/passwords/high-entropy already cover the roadmap's explicit list. Phase 6 should do one pass of **deliberate extension**, informed by what Phase 6's own integration (§2.2) newly exposes to redaction that the spike never had to consider: agent **tool-call arguments** (a shell command an agent is about to run might itself contain `--api-key=sk-...` inline, which is a different shape than a key appearing in output text — command-line argument redaction needs to preserve enough of the command structure to still be meaningful in an audit log while masking the secret value itself). This is a genuinely new pattern category, not present in the spike because the spike only ever tested against output/log-shaped text.

---

## 5. Integration with Phase 5's Policy Engine (additive, not a dependency in the other direction)

Phase 6 does not depend on Phase 5 to function — a workspace with no custom policy still gets full default redaction and default file-blocking. But `GatewayOptions.redaction.customPatterns` (§3, already typed) is the natural place for Phase 5's policy layer to inject **project-specific** secret patterns once it exists — e.g., a project using an internal secret format the built-in 39 patterns don't recognize can declare a custom pattern via a `PolicyRule`-adjacent config, delivered to the Gateway the same way the active `PolicyVersion` already is (§5 of the Phase 5 plan's local-cache mechanism). This is listed as a **future integration point**, not Phase 6 scope — building the policy-to-redaction-config delivery path now would be scope creep into Phase 5's territory; Phase 6 just needs to leave the `customPatterns` field genuinely functional (§3.3) so that path is a small addition later, not a redesign.

---

## 6. Metrics (the typed-but-unused fields, finally used)

`@freebuff/protocol` likely warrants a small addition here mirroring the pattern already seen in `PolicyEngineMetrics` (typed, unused, until the engine that produces them exists) — Phase 6 should add:

```ts
export interface RedactionProxyStats {
  eventsProcessed: number;
  secretsRedacted: number;
  payloadsBlocked: number;      // restricted-classification blocks, §4.1
  redactionsByType: Record<SecretType, number>;
  averageLatencyMs: number;     // should track the <10ms/1KB budget from §6.1's ported benchmarks
}
```

Exposed via `RedactionProxy.getStats()` and surfaced through the Gateway's existing health-check registration pattern (`healthModule.registerCheck('redaction-proxy', () => ({...}))`, the exact mechanism `gateway.ts`'s constructor already uses for `session-registry`, `adapter-manager`, `checkpoint-store`, and `tunnel-client`) — so redaction health becomes visible in the same place every other subsystem's health already is, rather than inventing a new observability surface.

---

## 7. Phase 6 Definition of Done

- [ ] `gateway/redaction` exists, builds, lints clean, and passes the full ported spike test suite plus new event-shaped tests.
- [ ] `redactObject` (and the public `Redactor` contract generally) is generically typed — zero `any` in the promoted package's public API.
- [ ] `wireAdapterEvents` in `gateway/core/src/gateway.ts` redacts every event before it reaches `registry.appendEvent`, `checkpointStore`, or `bus.publish` — verified by an integration test, not just code inspection.
- [ ] `GatewayOptions.redaction.enabled` actually gates the behavior; disabling it requires the same loud, explicit opt-out pattern as `--dev-unsafe-no-sandbox`.
- [ ] The full roadmap-required test corpus (cloud keys, JWTs, passwords, private-key blocks, connection strings, secrets-in-logs) passes, sourced from the existing `spikes/redaction/test-fixtures/`.
- [ ] A `leaky-output` mock-adapter scenario exists and is the standard fixture for proving redaction end-to-end.
- [ ] **The closing test**: a full session run whose output contains a real-shaped fake secret, verified absent from the Control Plane's own stored event log (`GET /api/v1/sessions/:id/events`) — not just absent from the Gateway's internal state.
- [ ] `restricted`-classified content is fully blocked (not partially redacted), distinct from ordinary secret redaction.
- [ ] `RedactionProxyStats` exists, is populated, and is visible through the existing health-check mechanism.

## 8. Do NOT Build Yet

- A policy-authored custom-pattern authoring UI (Phase 5's own "no policy designer" constraint applies equally here — `customPatterns` is a config field, not a product surface, until there's a UI phase that justifies one)
- Redaction of data **at rest** in the Control Plane's database (out of scope — Phase 6's guarantee is about the transmission boundary; a separate at-rest encryption/retention policy is a Phase 13 - Security Hardening concern)
- Machine-learning-based secret detection (the entropy-based fallback already in the spike, `isHighEntropy`, is a sufficient heuristic layer for this phase; a learned classifier is real scope creep against a phase whose whole thesis is "promote what already works")
