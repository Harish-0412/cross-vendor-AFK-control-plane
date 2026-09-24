# Odysseus — verification, new features, and what is left

Written 24 September 2026, against `main`. Everything below was run, not
assumed; where something was not verified, it says so.

---

## 1. Verification

### What passes

| Check | Result |
|---|---|
| `pnpm exec tsc --build` (23 packages) | clean |
| `pnpm -r test` | **789 tests pass, 0 fail** |
| `pnpm -r lint` | **0 errors** (28 warnings in `gateway/pairing`) |
| `pnpm build` (frontend) | clean, 24 routes |
| Deployed Control Plane `/health` | 200, warm in 0.8 s |

P0–P7 of the integrations plan are implemented and tested. The phases cover
consent-gated access, Codex and Antigravity history, plan limits, the web
screens, live Codex and Antigravity sessions, the ChatGPT export importer, and
OpenAI organisation spend.

### What did not pass — and this is the important one

**The deployed Control Plane is running code from 21 September.** The live
deploy is commit `fdce3f9`; `main` is fourteen commits ahead. Everything from
P0 onwards — every integration route, all of History, all of Budgets' plan
limits — is not deployed.

This is measurable, not inferred:

```
GET https://odysseus-control-plane.onrender.com/api/v1/devices   → 401  (route exists)
GET https://odysseus-control-plane.onrender.com/api/v1/history   → 404  (route absent)
GET .../api/v1/usage/providers                                   → 404  (route absent)
GET .../api/v1/integrations/catalog                              → 404  (route absent)
```

A deployed build would answer `401 Unauthorized` on all four, because every one
of those routes checks authentication before anything else. A `404` means the
route is not in the running image.

The Render service has `autoDeploy: yes` with trigger `commit`, but no deploy
has been created since 21 September and no deploy in its history was ever
triggered by a commit — the recorded triggers are `api`, `manual` and
`blueprint_sync`. The GitHub webhook is not reaching Render.

**Fix it in two steps.** First, deploy the current code:

- Render Dashboard → `odysseus-control-plane` → **Manual Deploy** → *Deploy
  latest commit*.

Then stop it happening again: **Settings → Build & Deploy → Repository** →
disconnect and reconnect the GitHub repository, which recreates the webhook.
Confirm by pushing any commit and watching a deploy appear with trigger
`commit`.

Until that first deploy runs, the Integrations and History pages on the website
will fail for everything added in P0–P7, however well they work locally.

### What has not been verified

- **Nobody has clicked through the web app signed in.** Signing in needs a
  password, which I do not type. The pages typecheck, build, and are covered by
  end-to-end API tests, but the first person to see them in a browser is you.
- **CI has never been observed passing.** The workflow exists and now gates on
  lint; whether the Docker build and the gitleaks scan pass on GitHub's runners
  is unconfirmed.
- **`agy` is not installed on this machine.** The Antigravity live-session
  adapter (P7) is written and tested against fixtures and reported as verified
  against `agy` 1.1.27, but `agy` is not on `PATH` now and is not at
  `%LOCALAPPDATA%\agy\bin`. The adapter degrades honestly — it reports
  "Antigravity CLI (agy) was not found on PATH" rather than failing obscurely —
  but live Antigravity sessions cannot run here until it is reinstalled.
  Antigravity itself is installed (`%LOCALAPPDATA%\Programs\antigravity`), and
  reading its history does not need `agy`.
- **Docker is installed but not running**, so the container sandbox path is
  untested on this machine.

### A bug found and fixed during verification

`pnpm lint` had been failing on the first package it touched, for every
package, since the workspace became ESM: `.eslintrc.js` is CommonJS, and
`"type": "module"` in `odysseus/package.json` made Node refuse to read it. CI
did not catch it because the lint step was `continue-on-error`, so a total
failure and a clean run looked identical.

Repaired in `9d04f27`: the config is now `.eslintrc.cjs`, `tsconfig.eslint.json`
lists every workspace package (ten of the errors that surfaced were false ones
caused by unresolvable imports — including the exact ten the CI comment cited as
the reason not to gate on lint), the remaining 89 real errors are fixed rather
than silenced, and the CI lint step is now blocking.

---

## 2. New features

Five additions, chosen because each one closes a gap that showed up while
verifying the rest.

### 2.1 Search inside your conversations

**What it does.** The search box on History now searches the *messages* of
conversations you have loaded, not just their titles. Matching happens on the
Control Plane; the result list shows the text around the hit with the match
highlighted, and how many times it appears.

**How it works.** When a conversation's content is synced, a lowercased,
40 000-character index is built from its messages and stored on the
conversation record. A search reads that index — one document per conversation
— rather than every stored message chunk. Conversations whose content was
synced before this existed get their index built the first time they are
opened.

**Why it is useful.** With 55 imported Codex sessions, "the one where I fixed
the pairing handshake" is not something a title search finds. Tool calls and
their output are indexed too, so "which session ran that migration" is
answerable. The index never reaches the browser, and the text in it was already
redacted on the workstation.

**What it is honest about.** The result list states how many conversations'
messages were actually searched and how many could only be searched by title,
with a pointer to **Load conversation**. Without that, an empty result would
imply "not found" when the truth is "never synced here".

### 2.2 Export a conversation

**What it does.** A conversation you have loaded can be saved as **Markdown**
or **JSON** from its page.

**How it works.** Entirely in the browser, from the conversation already on
screen. No request is made and nothing is uploaded. The Markdown keeps the
speaker structure, puts tool calls and output in fenced blocks — choosing a
fence long enough to contain any backticks in the output, so code inside tool
results does not break the document — and labels anything that was shortened.
The JSON carries the full conversation record and every item.

**Why it is useful.** It is the answer to "I need this in a ticket / a PR
description / my notes", and it means an imported conversation is not trapped
in one web app. The file says plainly that content was redacted on the
workstation, so nobody mistakes an export for a raw transcript.

### 2.3 Plan-limit warnings

**What it does.** When a Codex usage window passes **80% used**, you get a
notification — a toast in the web app, and a Web Push notification on your
phone even with nothing open.

**How it works.** The check runs when a usage reading arrives from the
workstation, not when a page is opened, so it fires whether or not anyone is
looking. Each window is identified by its reset time, which is what makes "warn
once" work without a timer: the same window keeps the same reset time however
often the gateway re-reports it, and gets a new one when it resets. The dedupe
state is stored with the usage record, so it survives a Control Plane restart.

**Why it is useful.** This is the AFK case exactly. Starting a long agent run
and walking away is the product; discovering three hours later that it stopped
at 4% remaining is the failure mode. 80% is early enough to finish what is
running or move to another plan.

**What it is honest about.** A reading whose window has already reset raises
nothing — the percentage describes a period that is over. That is the same rule
the Budgets page already follows when it shows "reset since this reading"
instead of a stale number.

### 2.4 The sandbox now tells the truth on Windows

**What it does.** The Windows sandbox used to report `filesystemIsolation:
true`, `processIsolation: true`, `networkIsolation: true`, `cpuLimits: true`,
`memoryLimits: true` and `processLimits: true`. It enforces **none** of them:
Job Objects need native bindings and firewall rules need an elevated process,
so `start()` spawns the agent as an ordinary child process and records the
limits it *would* have applied as metadata.

Those flags now report what is actually enforced — everything false except
`rootless`, which is true. A new `sandbox` preflight check prints it at gateway
startup:

```
⚠ sandbox  No sandbox enforcement on win32: an agent runs with your own file and network access
           → Windows has no enforcing sandbox here. Give sessions a project root that
             contains nothing you would mind an agent reading, and keep approval mode on
             for anything that writes.
```

**Why it is useful.** Those flags are the answer to "can I leave an agent
running on this machine unattended", which is the single question this project
exists to answer. Claiming an isolation that does not exist is worse than
having none, because it invites exactly the unattended run the isolation was
supposed to make safe. macOS (`sandbox-exec`) and Linux with Docker do enforce
it; Windows does not, and now says so.

The gateway still starts. Refusing to run would not make anyone safer — it
would move the work somewhere with no warning at all.

### 2.5 An installable phone app

**What it does.** The control centre can now be added to a phone's home screen.
It opens without browser chrome, has its own icon, and has shortcuts straight
to Approvals, Sessions and History.

**How it works.** A web app manifest (`/manifest.webmanifest`), 192px, 512px
and maskable icons generated from the existing mark, and the service worker now
registers on sign-in rather than only when push is configured. The service
worker gained an offline fallback for page loads and caches nothing else — session
state and approvals are private and change constantly, and a stale copy of them
presented as current would be worse than showing that the connection is down.

**Why it is useful.** Two things beyond convenience:

- **Web Push on iOS only works for a site added to the home screen.** Without a
  manifest, an approval request can never reach an iPhone while the browser is
  closed — which is the situation the product is for.
- iOS is aggressive about suspending plain browser tabs. An installed app keeps
  its session and is one tap away.

**Still required for push to actually fire:** `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` on Render, and
`NEXT_PUBLIC_VAPID_PUBLIC_KEY` on Vercel. Generate a pair with
`npx web-push generate-vapid-keys`. Until they are set, Settings correctly
reports push as unavailable.

---

## 3. What is left

Ordered by what actually blocks use.

### Blocking

1. **Deploy the current code to Render**, and reconnect the GitHub webhook so
   it keeps happening. Section 1 has the steps. Nothing else in this list
   matters while production runs September's code.

### High value

2. **Set the VAPID keys.** Push is the difference between an AFK control plane
   and a dashboard you have to remember to check. Everything else for it is
   built.

3. **Remote verification (N7).** `scripts/smoke-core-loop.ts` passes 11 checks
   in-process against localhost. A green localhost test is not evidence about
   the internet. The remote variant takes a deployed base URL, runs against a
   gateway on your workstation and a client on a different network, and asserts
   what only a real network breaks: kill WiFi mid-session and confirm replay
   closes the gap with no missing sequence numbers; background the phone for
   five minutes and confirm the timeline is complete on return; confirm a
   revoked device is refused.

4. **A real filesystem sandbox.** Windows enforces nothing, and now says so —
   but saying so is not fixing it. The realistic route is the container path
   that Linux already uses, via Docker Desktop. One caveat found while reading
   that code: the Docker sandbox only applies when the agent binary is inside
   the project root, so Codex, `agy` and OpenCode — installed elsewhere —
   currently fall back to the unenforced "lightweight" runtime **on Linux
   too**. Fixing that means an image with the agent CLIs in it.

5. **Claude Code cannot ask you to approve each step.** The adapter needs a
   `--permission-prompt-tool` MCP host it does not yet run, so sessions set to
   "ask me first" are rejected rather than silently downgraded. Claude Code is
   now installed on this machine, so this can be built and tested for real.

### Correctness and hardening

6. **Login rate limits can be bypassed.** The limit is per IP, and the IP is
   taken from a client-supplied header.

7. **28 lint warnings in `gateway/pairing`.** Now visible, since lint runs
   again.

8. **Confirm CI passes on GitHub** — tests, the Docker image build, and the
   gitleaks secret scan.

9. **Revoke the Render and Vercel API tokens** pasted into chat in an earlier
   session, if that has not been done.

### Product

10. **A live session run end to end from a phone**, using OpenCode — the agent
    that is actually installed and working here. It needs `opencode auth login`
    first.

11. **The frontend has no test runner.** The new export and search helpers are
    pure functions and would be cheap to cover; there is currently nowhere to
    put the test.

12. **Deferred hackathon features:** QR pairing, voice steering, on-device
    summaries of code changes, the OEM demo.

13. **Cleanup:** the old `freebuff-control-plane` Render service, the old
    `freebuff-control-center` Vercel project, and the leftover `freebuff/`
    directories.

14. **The second tunnel connection is built but not used.** `N=2` would make a
    dropped socket invisible rather than a reconnect.

---

## 4. How to use what was added

Restart the gateway to pick up the new code — it will now print the sandbox
warning at startup:

```powershell
$env:ODYSSEUS_CONTROL_PLANE_URL = "wss://odysseus-control-plane.onrender.com/ws/tunnel"
```

```powershell
pnpm gateway --project-root "C:\path\to\your\project"
```

Then, **after the Render deploy has run**:

- **History → search** — type anything. Open a conversation and choose *Load
  conversation* to make its messages searchable.
- **History → a conversation → Markdown / JSON** — saves the file locally.
- **Budgets** — plan limits. A window above 80% now warns you rather than
  waiting to be looked at.
- **Your phone's browser → Share → Add to Home Screen** — installs the app.
