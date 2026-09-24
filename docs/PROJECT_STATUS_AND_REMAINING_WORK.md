# Odysseus — status and remaining work

Updated 24 September 2026, against `main`. Everything below was run, not
assumed; where something was not verified, it says so.

---

## 1. Where things stand

| Check | Result |
|---|---|
| Typecheck (24 packages) | clean |
| Backend tests (`pnpm -r test` in `odysseus/`) | **856 pass, 0 fail** |
| Web app tests (`pnpm test` in `frontend/`) | **31 pass, 0 fail** |
| Lint, whole workspace | **0 errors, 0 warnings** |
| End-to-end smoke (`scripts/smoke-core-loop.ts`) | **11/11** |
| `pnpm verify:deploy` against production | see §2 |

Integrations P0–P7 are implemented and tested. The signed-in web app has been
redesigned, with separate desktop and phone layouts (§4). The agent team
(planner, builders, tester, reviewer, context) and the Freebuff adapter are
described in §0.

---

## 0. This round: re-pairing, the agent team, Freebuff

### "No devices paired" while the PC was connected

A workstation keeps one device identity on disk. Confirming a pairing for a
device that already existed only reset its status, so it stayed owned by the
account that first paired it: the tunnel accepted it, and the account that
had just paired it saw an empty list. `pnpm pair` now signs its registration
with the device key, and a key-signed re-pair moves the device to the
confirming account. An unsigned registration naming someone else's device is
refused. **Run `git pull`, then `pnpm pair` once, to move an existing PC.**

Also: `/api/v1/status` no longer lists every account's online devices to
anyone; the tunnel no longer creates devices owned by `usr_anonymous`.

### The agent team (Agent team page, `/orchestrations`)

Give a goal; the run is a DAG of ordinary sessions on your own machines, each
through the usual router, risk score, policy, approval and budget checks.

| Agent | What it does |
|---|---|
| Planner | First step, read-only, prefers Claude Code then Codex. Its `odysseus-plan` block becomes the rest of the run (max 12 steps, strictly validated). |
| Builders | Implementation steps. They take turns, because they share one working tree. |
| Tester | Must end with `ODYSSEUS_TEST_RESULT: PASS/FAIL`. A FAIL adds a fix step and a re-test, and whatever waited on the test now waits on the re-test. |
| Reviewer | Gets the builders' diff; returns an `odysseus-review` block. High/critical findings send the work back the same way. |
| Context | Ranks your imported conversations (yours only) against each planning/building step and adds the best few, bounded, to its prompt. Deterministic — no model call. |

A plan that changes code always gets a test and a review, even if the planner
forgot. Fix loops stop after the run's fix-attempt limit (default 2) and the
run fails with the reason. Runs advance by themselves whenever a step's
session finishes; a denied approval ends that step.

Fixed on the way: sessions of adapters that only send `session.completed`
(OpenCode) were never marked finished; orchestration runs were written to
Firestore with `undefined` fields (rejected in production) and read back with
raw Timestamps.

### Freebuff (`gateway/adapters/freebuff`)

Freebuff's CLI has no prompt argument and no headless mode, and requires a
TTY (Codebuff issue #947). The adapter drives its terminal through a
pseudo-terminal (`@lydell/node-pty`, prebuilt binaries — no build tools) and a
headless xterm: paste the prompt, treat a screen that has not changed for 20 s
(`FREEBUFF_DONE_QUIET_MS`) as the end of the turn, report the new screen text
and the files `git status` shows changed. Approval interception is
unsupported and it runs outside the sandbox; its capabilities say so, so the
router keeps high-risk steps away from it. **Needs `npm install -g freebuff`
and one interactive `freebuff` run to sign in.** Tested against a stand-in
TUI, not the real Freebuff, which is not installed here.

Also fixed in every adapter: the event stream's async iterator delivered each
event that arrived while the gateway was waiting twice.

---

## 2. Production

**Run `pnpm verify:deploy` (in `odysseus/`) after every deploy.** It needs no
account and changes nothing. Every check is an unauthenticated request whose
correct answer is a refusal:

- **Freshness.** A route that exists refuses with 401. A route missing because
  the deploy is stale answers 404.
- **Health.**
- **CORS.** The website is admitted and a foreign origin is refused.
- **Browser socket.** An invalid token is refused and closed, and a foreign
  origin is refused.
- **Gateway tunnel.**
- **Website.** Its API proxy works, and the manifest is served.
- **Development preview.** It is not reachable.

This command exists because production ran three-day-old code while every
test passed locally.

**Render still does not deploy on push.** Deploys since 21 September were
triggered manually or through the API; none has ever had trigger `commit`.
Reconnect the GitHub repository in the Render dashboard:
**`odysseus-control-plane` → Settings → Build & Deploy → Repository**. Until
then, every change to the Control Plane needs a manual deploy.

Vercel does deploy on push.

---

## 3. What was fixed in this round

### The paired device that did not appear on the website

Three things combined:

- **`pnpm pair` defaulted to `http://localhost:4000`.** From a fresh terminal it
  registered the device with the local development server.
- **`pnpm gateway` also defaulted to localhost.** It took its URL from a
  different variable, in a different format.
- **The server's refusal was silent.** A server that has never seen a device
  refuses it with a retryable error, so the gateway reconnected forever,
  logged nothing and looked healthy.

The fix:

- `pnpm pair` now defaults to the hosted Control Plane. `--local` selects the
  development server.
- On success, pairing writes `~/.odysseus/pairing.json`.
- The gateway reads that file as a config layer
  (`flags > env > file > pairing > defaults`), so it connects to the server
  the device is registered on without being told.
- A `pairing` preflight names both hosts if they differ.
- The gateway logs `tunnel.device_not_registered` once, with the fix, instead
  of retrying silently.

**One-time step for an existing machine:** run `pnpm pair` again, so the
record is written.

### Security

- **Login throttling could be bypassed** by rotating `X-Forwarded-For`. Failed
  logins are now also capped per account, whatever the address.
- **Refused WebSockets stayed open in production.** `ws` waits up to 30 s for a
  close reply, and Render's proxy was losing it. An unauthenticated socket
  could therefore hold server resources indefinitely. Every rejection now
  terminates the connection one second after the close frame. A raw-TCP test
  reproduces the proxy, and it fails with the fix disabled.

### Web app

- **No `<Toaster />` was mounted**, so every toast in the app was silently
  dropped.
- **Geist was imported but never applied**, so the app rendered in a fallback
  font.
- Four bugs were found by looking at the redesign through the development
  preview:
  - a render loop, which crashed the page with "Maximum update depth";
  - the hero scrolling sideways when a button inside it was focused;
  - fuzzy search matching letters inside IDs;
  - counters stuck at 0 in background tabs.
- The web app now has a test runner and a CI job that tests and builds it.

---

## 4. The redesigned app

**Everywhere:**

- New design tokens and a consistent motion vocabulary.
- Route transitions, staggered entrances, count-up numbers and live status
  dots.
- Every animation respects reduced motion.

**Desktop:**

- A collapsible sidebar with a sliding active marker and a live
  approvals badge.
- A ⌘K command palette for pages, machines and running sessions.
- An account menu.
- The launch dialog.
- A dashboard ordered by urgency: what needs a decision, then what is
  running, with machines, plan usage and activity down the side.

**Phone:**

- A title bar, bottom tabs within thumb reach, and a raised button that
  launches an agent.
- The rest of the app in a draggable bottom sheet.
- Launching opens as a bottom sheet with large machine and agent cards.
- The dashboard leads with one card and one button that answer "do I need
  to do anything?".

**Both:** one shared data store, so badges and dashboard never disagree. When
the machine list fails to load, only an error is shown. The page never
displays "all clear" over zeros it cannot vouch for.

**Previewing locally:** `http://localhost:3000/dev-preview?state=busy`
renders the real shell with sample data. The other states are `clear`,
`offline`, `empty` and `error`. Production refuses this page twice: the
middleware requires sign-in, and the page itself returns 404.

**Not redesigned individually:** the other pages (Machines, Sessions,
Approvals, History and so on). They inherit the new shell, fonts, cards,
buttons and transitions, but their own layouts are unchanged.

---

## 5. Remaining work

### Needs you (I cannot do these)

1. **Reconnect Render to GitHub** so pushes deploy (§2).
2. **Run `pnpm pair` once** on your workstation, then `pnpm gateway`. No
   environment variables are needed now.
3. **Set the Web Push keys.** Push is fully built but dormant without them:
   - Generate a pair with `npx web-push generate-vapid-keys`.
   - Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` on Render.
   - Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on Vercel.
4. **Revoke the Render and Vercel API tokens** pasted into chat earlier, if
   you have not already.
5. **Delete the old services:** `freebuff-control-plane` on Render and
   `freebuff-control-center` on Vercel. Deleting is permanent, so it is your
   call.
6. **Reinstall `agy`.** Antigravity live sessions (P7) need it; it is no longer
   on this machine's PATH. Reading Antigravity history does not need it.

### Engineering

7. **A real filesystem sandbox.** Windows now reports honestly that it enforces
   nothing, but that is not a fix. On Linux, the Docker sandbox applies only
   when the agent binary is inside the project root, so the real agent CLIs
   are not contained there either. The fix is a container image that ships the
   agent CLIs.
8. **Per-step approval for Claude Code.** The adapter needs a
   `--permission-prompt-tool` host. Claude Code is installed here now, so
   this can be built and tested for real.
9. **Network-disruption tests (N7).** `verify:deploy` covers everything that
   needs no account. The rest needs a signed-in client and a live gateway:
   - a Wi-Fi drop mid-session followed by replay without gaps;
   - a phone backgrounded for minutes;
   - a revoked device being refused.
10. **Landing-page type errors.** `CardNav`, `FoldText`, `PixelSnow`,
    `TiltedCard` and `sections/hero` have type errors. They predate this work
    and are hidden because the Next build skips type validation.
11. **Redesign the remaining pages** in the new style, using the phone and
    desktop split the dashboard now has.
