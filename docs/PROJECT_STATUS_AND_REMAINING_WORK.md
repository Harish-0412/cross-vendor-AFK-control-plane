# Odysseus — status and remaining work

Updated 24 September 2026, against `main`. Everything below was run, not
assumed; where something was not verified, it says so.

---

## 1. Where things stand

| Check | Result |
|---|---|
| Typecheck (23 packages) | clean |
| Backend tests (`pnpm -r test` in `odysseus/`) | **826 pass, 0 fail** |
| Web app tests (`pnpm test` in `frontend/`) | **29 pass, 0 fail** |
| Lint, whole workspace | **0 errors, 0 warnings** |
| Web app build | clean |
| `pnpm verify:deploy` against production | see §2 |

Integrations P0–P7 are implemented and tested. The signed-in web app has been
redesigned, with separate desktop and phone layouts (§4).

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
