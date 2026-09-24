"use client";

/**
 * Development-only preview of the signed-in shell and dashboard, filled with
 * sample data.
 *
 * It exists so the interface can be looked at — in every state that matters —
 * without signing in and without a real workstation producing real sessions:
 *
 *   /dev-preview?state=busy      agents running, decisions waiting (default)
 *   /dev-preview?state=clear     running, nothing waiting
 *   /dev-preview?state=offline   machines paired but none reachable
 *   /dev-preview?state=empty     first run, nothing paired
 *   /dev-preview?state=error     the machine list failed to load
 *   /dev-preview?view=team       an agent-team run midway through a fix loop
 *
 * Nothing here talks to a server. In a production build the page renders a
 * 404 and the middleware does not exempt it from sign-in, so it cannot be
 * reached on the deployed site.
 */
import { Suspense, useEffect, useState } from "react";
import { notFound, useSearchParams } from "next/navigation";

import { DesktopDashboard } from "@/components/dashboard/DesktopDashboard";
import { MobileDashboard } from "@/components/dashboard/MobileDashboard";
import { RunDetail } from "@/components/orchestrations/RunDetail";
import { ShellFrame } from "@/components/layout/AppShell";
import { useAuthStore } from "@/lib/auth";
import { useRealtimeStore } from "@/lib/realtime";
import type { OrchestrationRun } from "@/lib/orchestrations";
import { useIsDesktop } from "@/lib/use-device";
import { useWorkspace } from "@/lib/workspace-store";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

function seed(state: string) {
  const devices = [
    {
      id: "dev_0a1b2c3d4e5f",
      friendlyName: "HARISH-PC",
      platform: "windows",
      status: "trusted",
      online: state !== "offline",
      activeSessionCount: state === "offline" ? 0 : 2,
      lastSeenAt: minutesAgo(state === "offline" ? 42 : 0),
    },
    {
      id: "dev_9f8e7d6c5b4a",
      friendlyName: "build-server",
      platform: "linux",
      status: "trusted",
      online: false,
      activeSessionCount: 0,
      lastSeenAt: minutesAgo(60 * 26),
    },
  ];
  const liveSessions =
    state === "offline"
      ? []
      : [
          {
            id: "ses_codex_7f3a",
            deviceId: devices[0]!.id,
            agentId: "codex",
            projectRoot: "C:\\SideQuest\\cross-vendor-AFK-control-plane",
            state: "running",
            startedAt: minutesAgo(18),
            createdAt: minutesAgo(18),
          },
          {
            id: "ses_claude_2b91",
            deviceId: devices[0]!.id,
            agentId: "claude-code",
            projectRoot: "C:\\projects\\recoup-api",
            state: state === "busy" ? "waiting_for_approval" : "running",
            startedAt: minutesAgo(46),
            createdAt: minutesAgo(46),
          },
        ];
  const finished = [
    ["opencode", "portfolio-site", "completed", 95],
    ["codex", "startup-assistant", "completed", 210],
    ["antigravity", "investment-platform", "failed", 380],
    ["codex", "cross-vendor-AFK-control-plane", "completed", 60 * 20],
  ].map(([agentId, project, sessionState, ago], index) => ({
    id: `ses_done_${index}`,
    deviceId: devices[0]!.id,
    agentId: agentId as string,
    projectRoot: `C:\\projects\\${project as string}`,
    state: sessionState as string,
    startedAt: minutesAgo((ago as number) + 30),
    createdAt: minutesAgo((ago as number) + 30),
    updatedAt: minutesAgo(ago as number),
  }));
  const approvals =
    state === "busy"
      ? [
          {
            id: "apr_1",
            sessionId: "ses_claude_2b91",
            deviceId: devices[0]!.id,
            actionType: "shell.exec",
            description: "Run database migration: prisma migrate deploy",
            requestedAt: minutesAgo(3),
            status: "pending",
          },
          {
            id: "apr_2",
            sessionId: "ses_codex_7f3a",
            deviceId: devices[0]!.id,
            actionType: "git.push",
            description: "Push branch feature/pairing-record to origin",
            requestedAt: minutesAgo(11),
            status: "pending",
          },
        ]
      : [];

  const empty = state === "empty" || state === "error";
  useWorkspace.setState({
    devices: {
      data: empty ? [] : devices,
      error: state === "error" ? "Request failed with status 503" : null,
    },
    sessions: { data: empty ? [] : [...liveSessions, ...finished], error: null },
    approvals: { data: empty ? [] : approvals, error: null },
    usage: {
      data: empty
        ? []
        : [
            {
              deviceId: devices[0]!.id,
              integration: "codex",
              receivedAt: minutesAgo(4),
              snapshot: {
                provider: "codex",
                source: "codex-rate-limits",
                observedAt: minutesAgo(4),
                planType: "plus",
                windows: [
                  { name: "primary", usedPercent: 62, windowMinutes: 300, resetsAt: hoursFromNow(2.4) },
                  { name: "secondary", usedPercent: 34, windowMinutes: 10080, resetsAt: hoursFromNow(90) },
                ],
              },
            },
          ],
      error: null,
    },
    loaded: true,
    refreshing: false,
    lastRefreshedAt: Date.now(),
    // The preview never talks to a server.
    refresh: async () => undefined,
  });
  useRealtimeStore.setState({ status: state === "offline" ? "reconnecting" : "connected" });
  useAuthStore.setState({
    user: { id: "usr_preview", email: "harish@example.com", name: "Harish", role: "owner" },
  } as never);
}

function Preview() {
  const params = useSearchParams();
  const state = params?.get("state") ?? "busy";
  const isDesktop = useIsDesktop();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    seed(state);
    setReady(true);
  }, [state]);

  if (!ready) return null;
  if (params?.get("view") === "team")
    return (
      <ShellFrame>
        <RunDetail run={sampleRun()} busy={false} onAct={() => undefined} />
      </ShellFrame>
    );
  return <ShellFrame>{isDesktop ? <DesktopDashboard /> : <MobileDashboard />}</ShellFrame>;
}

/** An agent-team run midway: planned, built, tests failed once and were fixed, review running. */
function sampleRun(): OrchestrationRun {
  const base = { dependsOn: [] as string[], prompt: "" };
  return {
    id: "orch_preview",
    goal: "Add rate limiting to the login endpoint and cover it with tests",
    state: "running",
    maxFixAttempts: 2,
    createdAt: minutesAgo(18),
    updatedAt: minutesAgo(0),
    plan: {
      title: "Add rate limiting",
      projectId: "proj_preview",
      steps: [
        {
          ...base,
          id: "plan",
          title: "Plan the work",
          taskKind: "planning",
          prompt: "Plan how to achieve this goal in this repository.",
          state: "completed",
          agentId: "claude",
          contextConversationIds: ["codex_1", "claude_2"],
          outcome: { summary: "Three steps: add a limiter, wire it into /login, test it.", filesChanged: [] },
        },
        {
          ...base,
          id: "limiter",
          title: "Add a per-account rate limiter",
          taskKind: "implementation",
          dependsOn: ["plan"],
          prompt: "Create src/auth/limiter.ts with a sliding-window limiter keyed by account.",
          state: "completed",
          agentId: "freebuff",
          origin: "planner",
          outcome: {
            summary: "Added SlidingWindowLimiter with a 5-per-minute default.",
            filesChanged: ["src/auth/limiter.ts", "src/auth/index.ts"],
          },
        },
        {
          ...base,
          id: "test",
          title: "Run the auth tests",
          taskKind: "test",
          dependsOn: ["limiter"],
          prompt: "Run the auth test suite.",
          state: "completed",
          agentId: "codex",
          origin: "guarantee",
          outcome: {
            summary: "login.spec.ts › locks after 5 attempts: expected 429, got 200",
            filesChanged: [],
            testsPassed: false,
          },
        },
        {
          ...base,
          id: "test-fix-1",
          title: "Fix failing tests (attempt 1)",
          taskKind: "implementation",
          dependsOn: ["test"],
          prompt: "Fix the code so the tests pass.",
          state: "completed",
          agentId: "claude",
          origin: "test_fix",
          attempt: 1,
          outcome: { summary: "The limiter was never called from the route.", filesChanged: ["src/routes/login.ts"] },
        },
        {
          ...base,
          id: "test-recheck-1",
          title: "Run the auth tests (re-check 1)",
          taskKind: "test",
          dependsOn: ["test-fix-1"],
          prompt: "Run the auth test suite.",
          state: "completed",
          agentId: "codex",
          origin: "test_fix",
          outcome: { summary: "42 passed", filesChanged: [], testsPassed: true },
        },
        {
          ...base,
          id: "review",
          title: "Review the changes",
          taskKind: "security_review",
          dependsOn: ["test-recheck-1"],
          prompt: "Review all the code changes for bugs and security problems.",
          state: "running",
          agentId: "claude",
          origin: "guarantee",
        },
      ],
    },
  };
}

export default function DevPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense fallback={null}>
      <Preview />
    </Suspense>
  );
}
