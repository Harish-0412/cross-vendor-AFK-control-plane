# Frontend Control Center — Design & Implementation Plan

**Document type:** Design/implementation plan verified against the actual running frontend and the actual current Control Plane API (post-Phase 11), not against the original Phase 4 plan document — which predates roughly half of what the backend now exposes.
**Scope:** `frontend/` — the authenticated web/mobile control center (distinct from anything marketing-facing). Referred to throughout as "the app."

---

## 0. Where this actually stands today — read this before anything else

The original Phase 4 plan (`docs/PHASE_4_EXECUTION_PLAN.md`) proposed a separate `apps/web/` project, React Query, and a from-scratch build. **None of that is what happened, and that's fine** — what actually got built is a real, working Next.js App Router app living in `frontend/`, sharing space with the marketing site but in its own `(app)`/`(auth)` route groups, using **Zustand** for client state and a **hand-rolled singleton `RealtimeClient`** for the WebSocket connection instead of React Query. This plan is written against *that* real architecture — extending established conventions, not replacing them.

### 0.1 What's already built and working

| Layer | State |
|---|---|
| Auth (`lib/auth.ts`, `lib/firebase.ts`) | ✅ Firebase-backed, silent refresh, `useAuthStore` (Zustand) |
| API client (`lib/api-client.ts`) | ✅ Cookie-based refresh, `ApiError`, typed `get`/`post`/etc. |
| Realtime (`lib/realtime.ts`) | ✅ Singleton `RealtimeClient`, reconnect-with-backoff, per-session/per-device/global listener maps, `useRealtimeStore` for connection status |
| Push (`lib/push.ts`) | ✅ Web Push subscription registration |
| App shell (`components/layout/AppShell.tsx`, `Header.tsx`, `Sidebar.tsx`, `MobileNav.tsx`) | ✅ Auth-gated shell, desktop sidebar + mobile bottom nav, realtime auto-connect on auth |
| Kill switch (`components/layout/KillSwitch.tsx`) | ✅ Genuinely excellent — STOP ALL / LOCK ALL in persistent header chrome, per Phase 7 §2.5, already fetches live device state and fans out correctly |
| Pages: Dashboard, Devices (list + detail + pair), Sessions (list + live detail, 920 lines — this is the real live console), Approvals, Audit, Policy, Settings, Login/Register/MFA | ✅ Built |

**This is a mature app, not a skeleton.** The job of this plan is not "build a frontend" — it's "close the gap between what the backend now does and what the sidebar currently lets anyone reach."

### 0.2 The actual gap — verified against the live API surface

The current sidebar (`components/layout/Sidebar.tsx`) has exactly 7 destinations: Dashboard, Devices, Sessions, Approvals, Audit Log, Policy, Settings. The Control Plane's actual routed API surface, read directly from `control-plane/src/api/http-router.ts`, is substantially larger:

```
/api/v1/organizations        (GET, POST)  + /:id/members (GET, POST)
/api/v1/projects             (GET, POST)  + /:id/dashboard, /:id/git/*, /:id/review
/api/v1/budgets              (GET, POST)
/api/v1/orchestrations       (POST)       + /:id/advance
/api/v1/routing/preview      (POST)
/api/v1/risk/assess          (POST)
/api/v1/integrations/github  (oauth/start, oauth/callback, repositories, DELETE)
```

**None of these has a page or a sidebar entry.** A user who's paired a device, run sessions, and reviewed approvals — everything the current 7 pages cover — has no way to create an organization, invite a teammate, see a project's dashboard, connect GitHub, set a budget, or preview which agent a routing decision would pick. This plan's primary job is designing and building those, in a way that sits naturally alongside what's already there rather than looking bolted on.

---

## 1. Information Architecture — the complete sidebar specification

This is the answer to "what goes in the sidebar and what does each thing do." Structured as three groups, matching the existing visual pattern (top-level items, then a labeled "Governance" section) — extended with two new labeled groups rather than one long flat list, because a 14-item flat sidebar is a worse information architecture than 7 items in 3 clearly-labeled groups of similar things.

### 1.1 Primary group (unlabeled, top of sidebar — unchanged from today)

| Item | Icon | Route | What it shows | Primary actions available |
|---|---|---|---|---|
| **Dashboard** | `LayoutDashboard` | `/dashboard` | Stats grid, active sessions, attention-needed feed, recent activity — already built | Quick-launch a session (existing `QuickLaunchModal`) |
| **Devices** | `Monitor` | `/devices` | Every paired Gateway: online/offline, resource usage, active session count | Pair new device, view detail, trigger per-device kill-switch/lock (already exists at `/devices/[id]`) |
| **Sessions** | `Activity` | `/sessions` | All sessions across all devices/projects, filterable by state/device/project | Start new, open live console (`/sessions/[id]`) |
| **Approvals** | `ShieldAlert` | `/approvals` | Pending + historical approval requests | Approve/deny (already built, 553 lines — substantial) |

### 1.2 NEW group: "Workspace" — projects, git, and the org/team layer

This is the largest addition. Insert **after** the primary group, **before** Governance.

| Item | Icon | Route | What it shows | Primary actions | Backend it calls |
|---|---|---|---|---|---|
| **Projects** | `FolderGit2` | `/projects` | Every registered project: repo, workspace root, default branch, active session count, last activity | Register a new project (root path + optional GitHub repo link) | `GET/POST /api/v1/projects` |
| **Project detail** | *(not sidebar-level — reached via click-through)* | `/projects/[id]` | The full Phase 9 dashboard bundle: repository info, workspace, policies scoped to this project, agent preferences, active sessions, history | Edit agent preferences (preferred adapter, default trust profile scoped to this project), view policy rules scoped here, trigger a review flow for a completed session | `GET /api/v1/projects/:id/dashboard`, `GET /api/v1/projects/:id/review` |
| **Integrations** | `Github` | `/integrations` | Connection status for GitHub (connected account, scopes granted, linked repositories) | Connect/disconnect GitHub (OAuth redirect flow), browse repositories to link to a project | `GET /api/v1/integrations/github/repositories`, `GET .../oauth/start`, `DELETE /api/v1/integrations/github` |
| **Organization** | `Building2` | `/organization` | Org name, member list with roles, pending invitations | Create an org (if none), invite a member, change a member's role (owner-only) | `GET/POST /api/v1/organizations`, `GET/POST /api/v1/organizations/:id/members` |

**Why "Organization" is singular and not "Organizations" (plural, like a switcher):** the backend's `OrganizationRecord` model (one `ownerId`, a flat membership list) reads as **one organization per account context**, not a Slack-style multi-org switcher — matching this project's actual scale (a small team sharing governance over their AFK sessions, not a multi-tenant SaaS with org-switching). If multi-org-per-user becomes real usage down the line, this is the one item to revisit; building an org switcher now would be speculative complexity against a backend that doesn't model it yet.

### 1.3 NEW group: "Intelligence" — the parts that reason about cost and routing

A separate labeled group because these are read-mostly, analysis-oriented screens — conceptually distinct from "things you configure" (Workspace) or "security posture" (Governance).

| Item | Icon | Route | What it shows | Primary actions | Backend it calls |
|---|---|---|---|---|---|
| **Budgets** | `Wallet` | `/budgets` | Every configured budget limit (per-project or per-org), current spend vs. limit, a simple progress bar per budget | Create a new budget limit (scope: project/org, amount, period) | `GET/POST /api/v1/budgets` |
| **Routing** | `Route` | `/routing` | A "what would happen" preview tool: pick a project + a hypothetical task description, see which adapter the routing engine would pick and why | Run a preview (no side effects — this is explicitly a dry-run tool, matching `/routing/preview`'s own name) | `POST /api/v1/routing/preview` |

**A note on scope discipline here:** `/api/v1/orchestrations` and `/api/v1/risk/assess` exist in the backend but are **deliberately not given top-level sidebar entries** in this plan. Orchestration (multi-agent coordination) is Phase 17 territory per the roadmap — the endpoint existing doesn't mean the UI should present it as a finished feature to a user. Risk assessment (`/risk/assess`) is more naturally **surfaced inline** where a risk score is actually relevant (next to an approval request, or in the routing preview's result — "this task scores HIGH risk, routed to trusted-afk-eligible adapters only") rather than as its own standalone page nobody would visit deliberately. Build the API wiring for both now if convenient, but don't manufacture sidebar real estate for a first-class page around them yet.

### 1.4 Governance group (existing — unchanged, one addition)

| Item | Icon | Route | Change |
|---|---|---|---|
| Audit Log | `ScrollText` | `/audit` | Unchanged |
| Policy | `FileCode2` | `/policy` | Unchanged, but see §3.4 — should gain project-scoping now that projects exist |
| **Notifications** *(NEW)* | `BellRing` | `/settings/notifications` | AFK Mode's `NotificationPreferences` (Phase 7) — quiet hours, per-event-type mute, digest vs. immediate | Nested under Settings, not a top-level item — this is a settings screen, not a governance decision |
| Settings | `Settings` | `/settings` | Unchanged as the parent; Notifications becomes a tab/section within it |

### 1.5 Complete sidebar, final structure

```
┌─────────────────────────────┐
│  Odysseus AFK — Control Plane │
├─────────────────────────────┤
│  Dashboard                   │
│  Devices                     │
│  Sessions                    │
│  Approvals                   │
├─ WORKSPACE ──────────────────┤
│  Projects                    │
│  Integrations                │
│  Organization                │
├─ INTELLIGENCE ───────────────┤
│  Budgets                     │
│  Routing                     │
├─ GOVERNANCE ──────────────────┤
│  Audit Log                   │
│  Policy                      │
│  Settings                    │
└─────────────────────────────┘
```

10 top-level items across 4 groups (up from 7 across 2). On mobile, per §4, only Dashboard/Devices/Sessions/Approvals stay in the bottom tab bar — everything else is one tap into an "expand" sheet, per the existing `MobileNav.tsx` pattern (verify that pattern already supports an overflow sheet; if it currently hardcodes 4 fixed tabs with no overflow, that's a required change — see §4.1).

---

## 2. Screen-by-screen design for every NEW page

Each follows the same discipline the existing pages already establish: real data from day one (no long-lived mock states), the same shadcn/ui primitives already in `components/ui/`, and — the standing rule from the Phase 4 plan that's still correct — **never hand-roll a type that already exists in `@odysseus/protocol`**.

### 2.1 `/projects` — Project list

- **Layout:** a card grid (reuse the visual pattern from `/devices`, which already does device cards well) — one card per project: name, repo (if GitHub-linked, show the repo's icon/name; if not, show "local only"), default branch, active session count badge, last-activity timestamp.
- **Empty state:** "No projects yet" with a clear "Register a project" CTA — this is a real first-run state, not a hypothetical, since `POST /api/v1/projects` requires a root path the user has to supply.
- **Register-project flow:** a modal (reuse `QuickLaunchModal`'s modal shell pattern) asking for: project root path, display name, and an optional "Link a GitHub repository" step that — only if GitHub is already connected (§2.3) — offers a searchable dropdown of `GET /integrations/github/repositories`'s results.
- **Component tree:** `ProjectsPage → ProjectGrid → ProjectCard[] , RegisterProjectModal`

### 2.2 `/projects/[id]` — Project detail (the Phase 9 dashboard)

This is the highest-value new screen — it's the direct payoff of Phase 9's git/review work, and today there is **no way to see it at all**.

- **Header:** project name, repo link (opens GitHub in a new tab if linked), default branch badge.
- **Tab or section layout** (match whatever tab pattern `/sessions/[id]` already uses internally, for visual consistency):
  - **Overview** — the raw dashboard bundle: repository stats, workspace root, policies scoped to this project (a filtered view of the same policy list `/policy` shows), agent preferences (editable: preferred adapter dropdown, default trust profile selector — reuse the trust-profile selector component from the session detail page, since Phase 7's trust profiles already have a picker somewhere in that 920-line file).
  - **Active Sessions** — a filtered version of `/sessions`, scoped to `projectId`.
  - **History** — past sessions, each row expandable to show its review bundle if one exists (diff summary, test results) — this is where Phase 9's `GitReviewBundle` type finally gets a UI. If a session has a `reviewBundle`, render: files-changed count, a link to open the diff (reuse or build a diff viewer — see §2.2.1), test pass/fail summary, and (if the session ended in a pending git action) an approve/reject-with-feedback control matching the existing Approvals page's action pattern.

**2.2.1 Diff viewer — the one genuinely new, non-trivial component this plan requires building from scratch.** Nothing in the existing component library renders a unified diff. Options, in order of preference:
1. **`react-diff-viewer-continued`** (small, actively maintained, split/unified modes) — lowest integration cost, matches the "don't hand-roll what a library already does well" discipline.
2. A minimal hand-rolled line-by-line renderer (parse `+`/`-`/context lines, color them) if a new dependency is undesirable — genuinely not hard for a unified diff string, and keeps the dependency count down.

Either way: **dark-mode-aware colors** (this app is dark-first per the existing design), and a per-file collapse/expand (a diff touching 8 files should not render 8 files of content by default).

### 2.3 `/integrations` — GitHub connection management

- **Not connected state:** a single prominent "Connect GitHub" button → redirects to `GET /api/v1/integrations/github/oauth/start`, which itself redirects to GitHub's OAuth consent screen. On return (`/oauth/callback` is a backend-handled redirect target, not a frontend route), land back on `/integrations` with a success toast.
- **Connected state:** show the connected account (avatar + username, if the backend's token-store/OAuth response includes it — check `EncryptedTokenStore`'s stored shape; if it doesn't currently capture the GitHub username, that's a small, worthwhile backend addition so this screen isn't just "GitHub: Connected" with no identifying detail), a "Disconnect" button (`DELETE /api/v1/integrations/github` — this is a destructive-ish action; confirm with a dialog, matching the existing confirm-dialog pattern used for kill-switch/device revocation elsewhere in the app), and a searchable list of repositories (`GET .../repositories`) with a "Link to project" action per repo that opens the same project-linking flow as §2.1's register modal.
- **Scope transparency:** explicitly display which OAuth scopes were granted (Phase 9's plan mandated "scope tokens narrowly" — showing the user exactly what was granted, not just "connected," is the honest UI counterpart to that backend discipline).

### 2.4 `/organization` — Team management

- **No org yet:** prompt to create one (name only — `ownerId` is implicit from the authenticated user).
- **Org exists:** member list table (name, email, role badge, joined date), an "Invite member" action (email input + role selector — `owner`/`admin`/`member`) for owners/admins only (role-gate this control client-side for UX, but remember the real gate is server-side per this project's own established security discipline — the button should simply not render for a `member`-role viewer, backed by the server rejecting the call regardless).
- **Role changes:** inline role-selector per row, owner-only, with the same confirm-before-destructive-action pattern for demoting/removing a member.

### 2.5 `/budgets` — Cost governance

- **List view:** each budget as a card — scope (project name or "Organization-wide"), limit amount, current period spend, a progress bar (color escalates: green under 70%, amber 70–90%, red over 90% — this mirrors the exact visual language `HealthModule`'s own CPU/memory thresholds already use server-side, so the UI is speaking the same risk vocabulary the backend does).
- **Create budget:** a form — scope selector (org or a specific project), amount (USD), period (matches whatever `BudgetLimit`'s actual period field supports — check the type before assuming monthly-only).
- **No enforcement-action UI needed here** — budgets in this phase are observability, not a hard stop (verify against `BudgetLimit`'s actual semantics in `@odysseus/protocol` before assuming otherwise; if it does support a hard-stop behavior, this page needs an explicit toggle for it, clearly labeled, since silently blocking a user's work over budget is a UX decision that must never be ambiguous).

### 2.6 `/routing` — Routing preview (dry-run tool)

- **Simple, single-purpose screen:** a form (project selector, free-text task description, optional explicit risk-class override) and a "Preview routing" button calling `POST /api/v1/routing/preview`.
- **Result panel:** which adapter would be selected, and — critically — **why** (whatever reasoning the `RoutingDecision` type carries — surface it verbatim, don't summarize it away). If the routing preview's response includes a risk assessment (natural pairing with `/risk/assess`), show that inline here rather than building `/risk/assess` its own page, per §1.3's scope note.
- **No side effects, ever** — this page must never be capable of starting a real session. Make this true at the API-call level (call the preview endpoint only), not just at the UI-copy level.

### 2.7 `/settings/notifications` — AFK notification preferences

- **Quiet hours:** a time-range picker (start/end), matching Phase 7's `NotificationPreferences` shape.
- **Per-event-type mute toggles:** one row per notification-worthy event category (task complete, task failed, approval required, security event) — reuse the Attention Engine's own `AttentionLevel` categories as the row labels, so the UI vocabulary matches the backend's exactly rather than inventing parallel terminology.
- **Digest vs. immediate:** a simple toggle for the `notify`-level category specifically (per Phase 7's design, `high_priority`/`critical` always deliver immediately — don't offer a digest option for those, since offering it would imply it's safe to delay a security event, which it isn't).

---

## 3. Enhancements to EXISTING pages (things to add, not pages to build from scratch)

### 3.1 Dashboard — project-awareness

The existing `StatsGrid`/`ActiveSessions`/`RecentActivity` components are almost certainly device/session-scoped only today. Add a **project filter** at the top of the dashboard (a simple dropdown: "All projects" + each registered project) — this becomes far more valuable the moment `/projects` exists, since a user with 5 projects wants "what's happening in *this* one" more often than "everything, everywhere."

### 3.2 Sessions list — add project and organization columns/filters

Once projects exist, `/sessions`'s filter bar should gain a project filter alongside whatever device/state filters it already has. Small, additive.

### 3.3 Device detail — surface `availableAgents`

`DeviceRecord.availableAgents` (advertised capabilities per adapter, used for routing eligibility) is real backend data with no UI surface today. Add a small "Available Agents" section to `/devices/[id]` listing each adapter the Gateway has detected, with its `AgentCapabilities` levels shown as a compact badge row (supported/partial/unsupported per capability) — this is the direct UI payoff of Phase 8's "never fake a capability" discipline: a user should be able to see, per device, exactly what each installed agent honestly claims to support.

### 3.4 Policy page — add project scoping

`PolicyRule.match.projectId` already exists as a real field (Phase 5). If `/policy` today shows a flat, unscoped rule list, add a project filter/scope selector so a rule authored for one project doesn't get lost in a global list once multiple projects exist. This is the same "small, additive, don't rebuild" instruction as §3.1–3.2.

### 3.5 Approvals — surface policy context more prominently, if not already

Given the Approvals page is already 553 lines, it likely already shows `matchedRules`/`policyVersion`/`requiredRole` per the Phase 5 approval-record shape — verify this is true before adding anything here; if the fields are already rendered, this section is a no-op, correctly documented as "already satisfied" rather than re-specified.

---

## 4. Mobile-specific design rules

The existing `MobileNav.tsx` + `AppShell.tsx` split (sidebar hidden below `lg:`, bottom nav shown, `pb-16` content padding) is the right foundation — extend it, don't replace it.

### 4.1 Bottom nav: 4 fixed tabs + one overflow entry, not 10 tabs

Mobile bottom navigation has a hard practical limit — 5 icons is already tight on a phone screen, and this plan's sidebar now has 10 top-level destinations. Keep the **4 highest-frequency items** (Dashboard, Devices, Sessions, Approvals) as fixed bottom-tab icons, exactly as today, and add a **5th "More" tab** opening a bottom sheet (reuse `components/ui/drawer.tsx`, already in the design system) listing the remaining 6 items (Projects, Integrations, Organization, Budgets, Routing, Audit/Policy/Settings grouped as they are in the sidebar). This is the concrete required change to `MobileNav.tsx` flagged in §1.5 — if it currently hardcodes exactly 4 tabs with no overflow mechanism, adding the 5th "More" sheet-trigger tab is this plan's one mandatory mobile-shell change.

### 4.2 The diff viewer (§2.2.1) needs an explicit mobile layout, not just a shrunk desktop one

A side-by-side split diff view is unusable below roughly 768px. On mobile, force unified mode (never split) regardless of a user's desktop preference toggle, and keep per-file collapse **collapsed by default** on mobile (expanded by default is fine on desktop) — the goal is that opening a 6-file diff on a phone doesn't dump an unreadable wall of text before the user has chosen which file they care about.

### 4.3 Every new form (budget creation, org invite, project registration) needs a full-screen mobile presentation, not a centered modal

The existing `QuickLaunchModal` pattern should already establish this convention (verify it does — a centered desktop-style modal on a 375px-wide screen is a common, avoidable mistake). If it does, every new modal in this plan (§2.1, §2.4, §2.5) inherits that same responsive modal component rather than each screen inventing its own breakpoint logic.

---

## 5. Data-fetching and realtime conventions — matching what's already established

State this explicitly so five new pages don't each invent a slightly different pattern:

- **Server data:** `apiClient.get<T>(...)` inside a `useEffect`, matching `KillSwitch.tsx`'s own pattern exactly (fetch on mount, optionally poll on an interval for data that changes server-side without a corresponding WebSocket event — e.g., budget spend, which isn't itself a `session.*` event type).
- **Realtime-driven data:** subscribe via `realtimeClient`'s existing session/device/global listener maps. Nothing in this plan's new pages needs a *new* subscription category — Projects/Organization/Budgets/Routing are all fundamentally CRUD-and-poll screens, not live-event screens, and should not be forced into the realtime layer just for consistency's sake.
- **Client-only UI state:** local `useState`, or a new small Zustand store only if the state genuinely needs to be shared across components that aren't in a parent/child relationship (matching why `useAuthStore`/`useRealtimeStore` exist as stores rather than context) — most of this plan's new screens don't need one.
- **Types:** every new page imports its data shapes from `@odysseus/protocol` (`OrganizationRecord`, `ProjectRecord`, `BudgetLimit`, `RoutingDecision`, `GitReviewBundle`, etc. — all already defined, per the actual `control-plane/src/types.ts` this plan was verified against). **Zero new hand-rolled interfaces duplicating a protocol type** — this is the same discipline the original Phase 4 plan stated and it remains exactly as important now that there are more types to potentially duplicate, not less.

---

## 6. Design system rules to hold the line on

The app is already dark-first, uses shadcn/ui + Tailwind, and has a consistent visual vocabulary (rounded-xl cards, subtle borders, color-coded status dots, mono-font badges for technical metadata like "Phase 7 §2.5" labels seen in `KillSwitch.tsx`). New screens must not introduce a second visual language:

- **Status color vocabulary, reused everywhere:** green = healthy/online/under-budget, amber = degraded/elevated/approaching-limit, red = unhealthy/offline/over-budget/critical-approval. `KillSwitch.tsx` and the health-threshold colors described in §2.5 already establish this — every new page's status indicators must reuse these three colors for these same meanings, never introduce a fourth ad-hoc color for "warning."
- **Empty states are a first-class design requirement, not an afterthought** — Projects, Organization, Integrations, and Budgets will all realistically be empty on a fresh account. Each needs a designed empty state with a clear single CTA, not a bare "No data" string.
- **Every destructive or high-consequence action gets a confirm dialog** — disconnecting GitHub, removing an org member, deleting a project. Match the existing confirm-dialog pattern already used for kill-switch/device actions; do not ship a new destructive action with a bare button and no confirmation step.
- **Loading states use the existing spinner/skeleton components** (`components/ui/spinner.tsx`, `skeleton.tsx`) — already in the library, already used in `AppShell.tsx`'s own loading states. No new loading-indicator pattern.

---

## 7. Implementation order

Sequenced by dependency and by value-per-effort, not by the order sections appear above:

1. **`/projects` + `/projects/[id]` (§2.1, §2.2), excluding the diff viewer.** This is Phase 9's actual payoff finally reaching a screen — highest value, and nothing else in this plan depends on it existing first, but almost everything (§3.1, §3.2, §3.4, §2.3's repo-linking) reads more naturally once it does.
2. **The diff viewer component (§2.2.1)** as its own isolated unit — build and test it against a fixture diff string before wiring it into the project-detail page's History tab, exactly the same "fixture-first" discipline the original Phase 4 plan used for this same component.
3. **`/integrations` (§2.3)** — unlocks real repo-linking in step 1's register-project flow (which should ship with a "link later" option in the meantime, not block on this).
4. **Sidebar restructure (§1.5) + mobile nav overflow (§4.1)** — do this once there are at least 2–3 real new pages to route to, not before (an empty "Workspace" section with nothing built yet is worse than adding the group as each piece lands).
5. **`/organization` (§2.4)**, **`/budgets` (§2.5)** — independent of each other, can be built in parallel by two contributors.
6. **`/routing` (§2.6)** — lowest urgency; it's a preview/dry-run tool, valuable but not blocking any real workflow.
7. **`/settings/notifications` (§2.7)** and the small enhancements in §3 — fold in opportunistically alongside whichever of the above a given contributor is already touching.

## 8. Definition of Done for this plan

- [ ] All 10 sidebar items route to a real, populated page — no dead links, no "coming soon" placeholders left in the shipped sidebar.
- [ ] Every new page's data types are imported from `@odysseus/protocol`, zero duplicated interfaces.
- [ ] The diff viewer renders correctly in both light truncated (mobile) and full (desktop) modes, dark-mode-correct.
- [ ] Every destructive action (disconnect GitHub, remove member, delete project) has a confirm step.
- [ ] Mobile bottom nav has exactly 5 tabs (4 fixed + More), never a longer flat list forced into the tab bar.
- [ ] The routing preview page cannot, under any code path, start a real session.
- [ ] Budget progress bars use the exact same 3-color threshold vocabulary as device health status elsewhere in the app.
