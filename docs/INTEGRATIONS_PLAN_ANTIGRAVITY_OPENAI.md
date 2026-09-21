# Integrations Plan — Google Antigravity & OpenAI (ChatGPT / Codex)

**Goal:** see and steer your Antigravity and OpenAI work from Odysseus: past
conversations, live sessions, and remaining usage. Every connection needs your
explicit, revocable permission, and that permission is **enforced on your
workstation**, where the data lives, so the web app alone cannot bypass it.

**Status:** P0–P3 are implemented and tested: permissions, Codex history and usage, Antigravity history, and the web screens to connect, browse and see limits. P4–P7 remain.

**Decisions (confirmed):** sync titles and metadata by default, with content per
conversation; delete synced history on revoke; approve in the running gateway
or with `pnpm grants`; OpenAI organisation spend (P6) is in scope, and the
Admin key will be entered at a local prompt, never in chat or the web app.

**How this was written:** the reference blueprint was treated as a starting
point, and every claim in it was checked against the code, against what is on
this workstation, and against current provider documentation. Several claims
were wrong or out of date; §1 lists them. The rest of the plan is built only on
what was verified.

---

## 1. What the reference got wrong

Each of these, if built as written, would have produced something that
**looks like it works and does not**: missing data, broken requests, or
invented numbers.

| # | Reference said | What is actually true | Evidence |
|---|---|---|---|
| 1 | Antigravity history is at `brain/<id>/.system_generated/logs/transcript.jsonl` | Only **1 of 6** conversations on this machine has a transcript. The other 5 hold only artifact `.json` files. | Directory scan of `~/.gemini/antigravity/brain` |
| 2 | Read `transcript.jsonl` | That file **truncates**: 24 records list `content` in `truncated_fields`. `transcript_full.jsonl` beside it has no truncation. | Schema scan (key names only, no content read) |
| 3 | Map `USER_INPUT` → prompt, everything else → output | Records are `USER_INPUT`, `PLANNER_RESPONSE` (with `thinking` and `tool_calls`), `GENERIC` (with `tool_calls`), `SYSTEM_MESSAGE`, `ERROR_MESSAGE`. Collapsing them to "output" discards all 69 tool calls and the error. | Schema scan |
| 4 | Emit `session.prompt` | No such event type exists. User turns are `session.message` with `role: "user"`. | `packages/protocol/src/types/events.ts` |
| 5 | Antigravity runs as `agy --input-format stream-json` | **No `agy` binary is installed here.** Antigravity's launcher runs `language_server.exe agentapi`. The existing adapter's protocol assumption is unverified. The adapter manifest also detects `antigravity` while the adapter runs `agy`, so the two disagree. | `where agy`; `~/.gemini/antigravity/bin/agentapi.bat`; manifest vs adapter |
| 6 | Get Antigravity remaining quota from the Cloud Quotas API | The Cloud Quotas API reports quota **limits** for *your own* Google Cloud project, not remaining usage. Antigravity on a personal Google account does not draw on your project's quota at all. The reference's fallback `?? 1_000_000` **invents a number** when the real one is unknown. | [Cloud Quotas API overview](https://cloud.google.com/docs/quotas/api-overview) |
| 7 | Sync ChatGPT history with `GET /v1/threads/{id}/messages` | **The Assistants API was shut down on 26 August 2026.** Threads are gone and there was no automatic migration. The request would fail immediately. | [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations); [announcement](https://community.openai.com/t/assistants-api-beta-deprecation-august-26-2026-sunset/1354666) |
| 8 | Remaining balance from `GET /v1/dashboard/billing/subscription` | Undocumented. It requires a **browser session key**, not an API key, and returns errors to server-side callers. There is no supported API for a remaining credit balance. | [community thread](https://community.openai.com/t/billing-usage-api-requires-session-key-backend-requests-failing/1367484) |
| 9 | OpenAI adapter detects `node --version` | That succeeds on every machine with Node, so "detected" would mean nothing. | Reference manifest |
| 10 | Keys typed into the web Integrations page | This sends workstation credentials to the cloud even when they are only ever used on the workstation. See §3.4. | Design |

### What the reference missed, which is the most useful source available

**Codex is installed on this machine and already records your real ChatGPT
plan limits.** Each `event_msg/token_count` record in
`~/.codex/sessions/**/rollout-*.jsonl` carries:

- `rate_limits.primary` / `rate_limits.secondary`: `used_percent`, `window_minutes`, `resets_at`
- `rate_limits.credits`: `has_credits`, `unlimited`, `balance`
- `rate_limits.plan_type`
- `info.total_token_usage` / `info.last_token_usage`: input, cached input, output, reasoning and total tokens

That is genuine remaining-usage data for your ChatGPT plan, from files you
already own, with no API key and no undocumented endpoints. There are 55 local
session files. The largest has 474 token-count records, 449 tool calls and 488
reasoning items.

---

## 2. Principles

Every design decision below follows from these rules.

1. **Local-first.** History and usage are read on the workstation, where they
   live. The Control Plane receives only what you have allowed, after redaction.
2. **Credentials stay where they are used.** A credential that is only used on
   the workstation never goes to the cloud.
3. **Permission is enforced where the data is.** The gateway is the authority.
   A stolen web session, or a compromised Control Plane, cannot read your disk.
4. **Least privilege.** Each integration has separate scopes (read history,
   read usage, run sessions), granted one by one.
5. **Allowlist, never denylist.** Parsers open only known file patterns. Nothing
   else in `~/.codex` or `~/.gemini` is ever opened, and `auth.json` is named
   in a test that proves it is never read.
6. **Redact before anything leaves the machine.** People paste API keys into
   chats. Every piece of content passes through `@odysseus/redaction` on the
   gateway.
7. **No invented numbers.** If a value is unknown, the UI says "not available",
   never a default. Every figure carries its source and the time it was observed.
8. **Honest capabilities.** An integration only claims what has been verified
   against the real tool.

---

## 3. Permission model — the part that must not be bypassable

### 3.1 The grant

A **grant** is permission for **one integration** on **one device**, with
explicit **scopes** and an **expiry**:

```ts
interface IntegrationGrant {
  grantId: string;
  deviceId: string;
  userId: string;                 // the account that requested it
  integration: 'antigravity' | 'codex' | 'chatgpt-export' | 'openai-org';
  scopes: Array<'history.read' | 'usage.read' | 'session.run'>;
  roots: string[];                // exact directories it may read, resolved
  grantedAt: string;
  expiresAt: string;              // default 90 days, then you are asked again
  approvedOn: 'workstation';      // permission is only ever given locally
  signature: string;              // signed with this device's private key
}
```

### 3.2 Two-party consent: requested in the browser, approved on the workstation

```
 Web app (signed in)            Control Plane                 Gateway (your PC)
       │  Request access to Codex    │                              │
       │  history + usage            │                              │
       ├────────────────────────────▶│  integration.grant_request   │
       │                             ├─────────────────────────────▶│
       │                             │                              │  Shows, locally:
       │                             │                              │   • what will be read
       │                             │                              │   • exact folders
       │                             │                              │   • how many files
       │                             │                              │   • what leaves the PC
       │                             │                              │   • what is never read
       │                             │                              │  [ Approve ] [ Deny ]
       │                             │   integration.grant_changed  │
       │   "Connected"               │◀─────────────────────────────┤  Signed grant saved
       │◀────────────────────────────┤                              │  to ~/.odysseus/grants
```

**Neither side can grant access alone.**
- Someone who steals your web session can *request* access, but nothing happens until you approve at the workstation, and the request shows up there for you to deny.
- The Control Plane can *send commands*, but the gateway refuses any read that isn't backed by a local, signed, unexpired grant. **The gateway is the enforcement point. The web UI and the Control Plane check too, but only as backup.**

Approving on the workstation happens in the running gateway (a terminal
prompt), or with `pnpm grants approve <id>` if the gateway runs unattended.
Nothing can be approved from the browser.

### 3.3 Stopping local software from granting itself access

The grants file sits in `~/.odysseus`, next to the device key.

- Each grant is **signed with the device private key** and checked on every
  use. A hand-edited or forged grant fails the check and counts as no grant.
- Approval requires an **interactive terminal** and the **confirmation code shown
  in the browser**, so a process that simply runs `pnpm grants approve` without a
  terminal, or without that code, cannot grant.

**Correction found while implementing.** This plan originally said
`~/.odysseus` would be added to the paths denied to agent sandboxes. That
protection **is not real on Windows or Linux**: the sandbox computes
`deniedPaths` but never applies them when it starts an agent. Only macOS uses a
system sandbox; on Windows the "sandbox" is a Job Object that limits memory and
process count, not file access.

What that means, stated plainly:

- Grants **do** stop remote bypass. A stolen web session or a compromised
  Control Plane cannot make the gateway read anything, because the gateway
  only acts on a grant it signed itself.
- Grants **cannot** stop software already running as you on this PC —
  including a coding agent Odysseus starts — from reading files directly.
  That needs a real file sandbox, which is its own piece of work and is
  tracked separately. Grants govern what **Odysseus** sends off the machine.
### 3.4 Credentials

| Credential | Where it is used | Where it is stored |
|---|---|---|
| Codex / ChatGPT login (`~/.codex/auth.json`) | Codex itself | **Never read by Odysseus.** Covered by an allowlist test. |
| Antigravity login | Antigravity itself | Never read |
| OpenAI **Admin** API key (org usage and costs) | Calls to OpenAI's Usage/Costs API | **On the gateway**, encrypted at rest. The gateway calls OpenAI and sends only the resulting totals. The key never reaches the Control Plane. |
| ChatGPT export file | One-time import | Read on the workstation, never uploaded raw |

When an Admin key is entered it is **write-only**: checked once against the
API, saved, shown afterwards as `sk-admin-…a4f2`, never returned, never logged
(the new access log already excludes request bodies).

### 3.5 What the gateway checks before every read

1. A grant exists for this integration, **signed by this device**, and not expired.
2. The requested scope is in the grant.
3. The path resolves to a real location **inside a granted root**, with symlinks and `..` resolved *before* the check, so a link can't point outside.
4. The file matches the integration's **allowlist pattern**.
5. The file is under the size limit, and is read as a stream, one line at a time.

Any failed check → the read is refused and an audit entry is written.

### 3.6 Revoking, expiry and audit

- Revoke from the web app **or** locally. The gateway deletes the grant, stops file watching, and reports back.
- On revoke you choose between **keep synced history** and **delete synced history**. The default is to delete.
- Grants expire (90 days by default), and you are asked again.
- Every request, approval, denial, revocation, sync and refused read goes into the existing `AuditLog`.

### 3.7 Threats and mitigations

| Threat | Mitigation | How it is tested |
|---|---|---|
| Stolen web session pulls your local history | Approval only on the workstation (§3.2) | Command without a local grant → refused |
| Compromised Control Plane sends `history.sync` with no grant | Gateway is authoritative (§3.5) | Forged command → refused and audited |
| Forged or edited grant file | Device-key signature (§3.3) | Tampered grant → treated as absent |
| Coding agent grants itself access | `~/.odysseus` denied to agent sandboxes | Sandbox write to `~/.odysseus` → denied |
| Path traversal via a conversation id or symlink | Resolve the real path, then check it's inside the root | `../../`, absolute paths and escaping symlinks → refused |
| Credential files read by mistake | Allowlist patterns | Test: `auth.json` is never opened |
| Secrets pasted into chats leak | Redaction on the gateway | Test data with keys → masked before sending |
| Admin key leaks via UI or logs | Stored on the gateway, write-only, masked | API response never contains the key |
| Huge or malformed files stall the gateway | Size caps, line-by-line reading, per-line errors | 1 GB file, invalid lines, partial last line |
| Duplicate or replayed sync | Stable event ids (the existing `eventId` de-duplication) | Re-sync → no duplicates |
| One user sees another's imported history | Device-ownership check on every route | Access across users → 403 |
| Made-up quota numbers | No defaults; unknown shows as "not available" | Missing field → UI shows "not available" |

---

## 4. Google Antigravity

### 4.1 History

**Source**, in order of preference:
1. `brain/<id>/.system_generated/logs/transcript_full.jsonl` (untruncated)
2. `transcript.jsonl`, used only if the full file is missing, with truncation recorded on each event

**Mapping** to existing protocol events:

| Antigravity record | Odysseus event(s) |
|---|---|
| `USER_INPUT.content` | `session.message` `{ role: 'user' }` |
| `PLANNER_RESPONSE.content` | `session.message` `{ role: 'assistant' }` |
| `PLANNER_RESPONSE.thinking` | `session.thinking` |
| `*.tool_calls[] {name, args}` | `session.tool_call`, one per call |
| `GENERIC.content` | `session.tool_result` when it follows a tool call, otherwise `session.output` |
| `SYSTEM_MESSAGE` | `session.output` `{ stream: 'system' }` |
| `ERROR_MESSAGE.error` | `session.tool_error` |
| `truncated_fields` | carried as `truncated: [...]` so the UI can say "content shortened" |

The `GENERIC`-to-result pairing is the one mapping not yet confirmed. It gets
checked against real records during implementation, and fixed if it's wrong.

**Conversations without a transcript** (5 of 6 here) are listed as "no
transcript available", not silently skipped. `conversation_summaries.db` and the
protobuf files use undocumented formats and are **out of scope** until they can
be read reliably.

**Incremental and live:** a per-conversation cursor (last `step_index`, file
size and modified time), tolerance for a half-written last line, and a watcher
on `brain/`. Result: **work you do in the Antigravity IDE shows up on your
phone while it happens**, as a *read-only mirror*. Steering those sessions
isn't possible, because the IDE owns them.

Imported sessions are marked `origin: 'antigravity'`, `readOnly: true`, with ids
`ag:<conversationId>:<step_index>`, so re-syncing never duplicates them.

### 4.2 Live sessions (run Antigravity from Odysseus)

**Blocked until verified.** The adapter assumes an `agy` command speaking
`stream-json`. What's actually installed is `language_server.exe agentapi`,
with an unknown protocol. The first step is to test it: run `agentapi` with
`--help`, record its real interface, and rewrite the adapter against that.
Until then the adapter reports **session.run unsupported**, and the manifest's
detection is fixed so it looks for the binary the adapter actually runs.

### 4.3 Usage and quota

**Not available**, and the UI will say exactly that. There is no public API for
Antigravity usage on a personal Google account, and the transcripts carry no
token counts. If you later use your *own* Gemini or Vertex project, Cloud
Monitoring usage metrics for that project could be added as a separate,
optional source. That would still describe your project, not Antigravity's
allowance.

---

## 5. OpenAI

### 5.1 Codex (main path: history, usage and live sessions)

**History.** Source: `~/.codex/sessions/**/rollout-*.jsonl` (allowlisted).
Observed record types:

| Codex record | Odysseus event(s) |
|---|---|
| `session_meta` | session metadata (id, project folder, model) |
| `response_item/message` | `session.message` (role taken from the item) |
| `response_item/reasoning` | `session.thinking` (the summary; nothing is decrypted) |
| `response_item/custom_tool_call`, `function_call` | `session.tool_call` |
| `response_item/*_call_output` | `session.tool_result` / `session.tool_error` |
| `event_msg/task_started` / `task_complete` / `turn_aborted` | `session.status_changed` / `session.completed` / `session.cancelled` |
| `event_msg/token_count` | usage records (§5.1, usage) |
| `compacted`, `world_state`, `turn_context`, `thread_settings_applied`, `item_completed` | kept as metadata, not shown as chat |

**Never opened:** `auth.json`, `.sandbox-secrets/`, every `*.sqlite`,
`history.jsonl`, and anything else not matched by the pattern above.

**Usage.** From `token_count` records:
- **Plan limits card:** the primary and secondary windows as *used %* with *resets at*, the credit balance where there is one, and the plan type. Each value shows when it was recorded ("as of 14:32"), and is flagged as out of date when it's old.
- **Tokens → `CostGovernor.recordUsage`** with a new `billing: 'subscription'` flag, so plan tokens count toward token budgets **without being turned into made-up dollar costs**.

**Live sessions.** A Codex adapter based on Codex's non-interactive mode. The
exact command and flags are **checked against the installed version**
(`codex exec --help`) before anything is built, the same way the Claude Code
adapter was built from its real docs. It uses the Windows `.cmd`-shim resolver
already added for the other adapters, and never runs through a shell.

### 5.2 ChatGPT (chatgpt.com) — import only

There is no API for consumer ChatGPT conversations. The supported route is
**Settings → Data controls → Export data**, which produces a zip containing
`conversations.json`.

- **Imported on the workstation:** `pnpm import chatgpt <path-to-export.zip>`. The raw export never leaves the machine; only redacted, parsed conversations are sent.
- The format is a **message tree**: each conversation has a `mapping` of nodes with parents and children. The parser follows the path to the current message so edited or regenerated branches don't come out jumbled. The format is undocumented and changes over time, so the parser must tolerate unknown fields, and it's tested against a sample export.
- Requires the `chatgpt-export` grant with `history.read`.

### 5.3 OpenAI API platform — organisation spend only

- **History: out of scope.** The Assistants API is gone. The Responses and Conversations APIs only return items your *own* app created, fetched by id, and there's no way to list all past chats. There's nothing general to sync.
- **Spend:** the organisation Usage API (`/v1/organization/usage/completions`) and Costs API (`/v1/organization/costs`), which need an **Admin API key**. The data is daily buckets, which gives "spent this period, by model and project" against your Odysseus budget.
- **Remaining balance: not available.** No supported endpoint provides one to an API key. The UI shows spend against budget and doesn't guess.
- The Admin key stays on the gateway (§3.4). The gateway polls on a schedule and sends totals only.

---

## 6. Usage and cost model

A single shape for every provider figure, with the source always attached:

```ts
interface ProviderUsageSnapshot {
  provider: 'codex' | 'openai-org' | 'antigravity';
  source: 'codex-rate-limits' | 'openai-costs-api' | 'openai-usage-api';
  observedAt: string;            // shown in the UI
  planType?: string;
  windows?: Array<{ name: 'primary' | 'secondary'; usedPercent: number;
                    windowMinutes: number; resetsAt: string }>;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: number };
  spend?: { periodStart: string; periodEnd: string; amountUsd: number };
}
```

A missing field stays missing. `antigravity` has no snapshot, so its card reads
**"Usage not available for this provider"**.

---

## 7. Changes by layer

**Protocol**
- Commands: `integration.grant_request`, `integration.revoke`, `history.sync`, `usage.poll`
- Events: `integration.grant_changed`, `history.progress`, `usage.snapshot`
- Session fields: `origin`, `readOnly`, `externalId`

**Gateway (`gateway/core` and a new `gateway/integrations` package)**
- `grants/`: signed grant store, local approval prompt, `pnpm grants` command, checks before every read
- `history/`: safe file reader (allowlist, real-path check, size cap, line-by-line reading, cursors), plus Antigravity, Codex and ChatGPT-export parsers
- `usage/`: Codex rate-limit reader, OpenAI org client (Admin key held locally)
- Redaction on every piece of content before it leaves the machine
- `~/.odysseus` added to the paths agent sandboxes are denied

**Control Plane**
- Collections: `integration_grants` (a copy; the gateway's is the authority), `provider_usage_snapshots`; `origin`/`readOnly` fields on sessions
- Routes (signed in, and you must own the device): `GET/POST/DELETE /api/v1/devices/:id/integrations/:integration/grant`, `POST …/sync`, `GET /api/v1/usage/providers`
- `CostGovernor.recordUsage` gains the `billing` flag
- Audit entries for every grant event

**Frontend**
- **Integrations:** a card each for Antigravity, Codex, ChatGPT export and OpenAI organisation. Status: *Not connected → Waiting for approval on {device} → Connected (scopes, expiry) → Expired / Revoked*. Before requesting, it shows exactly what will be read. Last sync, item counts and errors are visible.
- **Sessions:** imported sessions carry an "Imported · Antigravity / Codex / ChatGPT" badge and are read-only.
- **Budgets:** provider-limit cards (used %, reset time, "as of" time), or "not available".

---

## 8. Phases

Each phase ships with tests, including **tests that try to get round the
permission checks**.

| Phase | Delivers | Done when |
|---|---|---|
| **P0 — Permissions** ✅ | Signed grants, approval on the workstation, gateway checks, safe file reader, audit, `pnpm grants`, web request/revoke routes, revokes held for offline devices | Done: 33 permission tests and 8 end-to-end tests pass; two protections were disabled on purpose to confirm the tests catch it |
| **P1 — Codex history + usage** ✅ | Rollout parser, plan-limit reader, subscription billing | Done: 55 real sessions import (54 titled, 106.7M tokens); limits read exactly as Codex recorded them, and shown as reset rather than current once their window has passed |
| **P2 — Antigravity history** ✅ | Full-transcript parser, conversations without transcripts listed | Done: the 1 real transcript imports untruncated with tool calls, results, errors and checkpoints; the other 4 are listed as having no transcript. Live mirror of an open IDE session is covered by the 5-minute resync, not a file watcher |
| **P3 — Frontend** ✅ | Integrations (connect/approve/sync/revoke), History list and conversation view, plan-limit cards | Done: builds and typechecks; end-to-end API tests cover connect → history → content → usage → revoke. Not yet clicked through in a signed-in browser |
| **P4 — Codex live sessions** | Codex adapter checked against the installed CLI | A session started from the phone runs Codex on the PC |
| **P5 — ChatGPT export import** | Local import command, tree parser | A sample export imports with branches in the right order |
| **P6 — OpenAI org spend** | Admin key held on the gateway, usage/costs polling | Spend matches OpenAI's own Costs page |
| **P7 — Antigravity live sessions** | Adapter rewritten against the real `agentapi` interface | **Blocked** until that interface is verified |

**Not being built, and why:** Assistants thread sync (the API has been shut
down); live access to consumer ChatGPT (no API exists); an Antigravity quota
figure (no API exists); an OpenAI remaining-balance figure (only a browser
session key can get it).

---

## 9. Decisions needed from you

1. **What syncs by default?** (a) full conversation content, redacted, or (b) titles and metadata only, with full content switched on per conversation. *Recommend (b): least exposure by default.*
2. **What happens to synced history when you revoke?** *Recommend: delete it.*
3. **Where do you approve?** A prompt in the running gateway plus `pnpm grants` for when it runs unattended. *Recommend both.*
4. **OpenAI organisation spend (P6):** do you have an OpenAI Admin key, and do you want API spend tracked? If not, P6 can be dropped.
5. **Order of work:** the recommended order is P0 → P1 → P3, because Codex has the richest real data on your machine, and it proves the permission model end to end before Antigravity.

---

Sources:
[OpenAI API deprecations](https://developers.openai.com/api/docs/deprecations) ·
[Assistants API sunset announcement](https://community.openai.com/t/assistants-api-beta-deprecation-august-26-2026-sunset/1354666) ·
[OpenAI Costs API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs) ·
[Usage API cookbook](https://developers.openai.com/cookbook/examples/completions_usage_api) ·
[Billing endpoints require a session key](https://community.openai.com/t/billing-usage-api-requires-session-key-backend-requests-failing/1367484) ·
[Cloud Quotas API overview](https://cloud.google.com/docs/quotas/api-overview) ·
[Cloud Quotas use cases](https://cloud.google.com/docs/quotas/manage-quotas-using-api)
