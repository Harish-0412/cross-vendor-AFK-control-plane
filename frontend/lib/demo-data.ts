/**
 * Deterministic frontend-only demo data. Set NEXT_PUBLIC_DEMO_MODE=false to
 * return to the live Control Plane without changing any component code.
 */
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE !== "false";

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

export const DEMO_DEVICE_ID = "dev_odysseus_workstation";
export const DEMO_SESSIONS = {
  antigravity: "sess_antigravity_checkout",
  claude: "sess_claude_review",
} as const;

const devices = [
  {
    id: DEMO_DEVICE_ID,
    friendlyName: "Haris's Windows Workstation",
    platform: "windows",
    status: "trusted",
    online: true,
    lastSeenAt: iso(0),
    activeSessionCount: 0,
    createdAt: iso(60 * 24 * 12),
    updatedAt: iso(0),
    systemInfo: {
      hostname: "HARIS-DEV",
      arch: "x64",
      nodeVersion: "v22.14.0",
      gatewayVersion: "0.1.0-demo",
    },
    resourceUsage: {
      cpuPercent: 18,
      memoryMb: 6842,
      memoryPeakMb: 7920,
      activeProcesses: 214,
      diskFreeMb: 182_400,
    },
    fingerprintHex: "4f8b8f5c0c1a23eab7c0d4d4e6a0f953bed74a6ee20289dbe40ec9e2d4fa7c11",
    agents: [
      { id: "antigravity", name: "Antigravity", status: "connected", note: "Previous session available" },
      { id: "claude-code", name: "Claude Code", status: "connected", note: "Previous session available" },
      { id: "opencode", name: "OpenCode", status: "disconnected", note: "CLI is not connected" },
      { id: "codex", name: "Codex", status: "disconnected", note: "No gateway adapter connected" },
      { id: "gemini-cli", name: "Gemini CLI", status: "disconnected", note: "CLI is not connected" },
      { id: "cursor", name: "Cursor", status: "disconnected", note: "No gateway adapter connected" },
    ],
  },
];

const sessions = [
  {
    id: DEMO_SESSIONS.antigravity,
    userId: "usr_demo_operator",
    deviceId: DEMO_DEVICE_ID,
    agentId: "antigravity",
    projectRoot: "C:\\SideQuest\\AI Coding Agent AFK Control Plane",
    state: "completed",
    trustProfile: "trusted-afk",
    startedAt: iso(148),
    createdAt: iso(148),
    completedAt: iso(112),
    tokensUsed: 18_420,
  },
  {
    id: DEMO_SESSIONS.claude,
    userId: "usr_demo_operator",
    deviceId: DEMO_DEVICE_ID,
    agentId: "claude-code",
    projectRoot: "C:\\SideQuest\\AI Coding Agent AFK Control Plane\\frontend",
    state: "completed",
    trustProfile: "supervised",
    startedAt: iso(96),
    createdAt: iso(96),
    completedAt: iso(71),
    tokensUsed: 11_860,
  },
];

type DemoEvent = {
  eventType: string;
  payload: Record<string, unknown>;
};

const conversations: Record<string, DemoEvent[]> = {
  [DEMO_SESSIONS.antigravity]: [
    { eventType: "session.message", payload: { role: "user", content: "Review the device dashboard and make the connection state easy to understand." } },
    { eventType: "session.message", payload: { role: "assistant", content: "I’ll inspect the existing device cards, add explicit online status, and keep the controls scoped to the selected machine." } },
    { eventType: "session.tool_call", payload: { toolName: "filesystem.read", arguments: { path: "frontend/app/(app)/devices/page.tsx" } } },
    { eventType: "session.tool_result", payload: { toolName: "filesystem.read", output: "Device card uses gateway status, resource telemetry, and active-session controls." } },
    { eventType: "session.file_changed", payload: { path: "frontend/app/(app)/devices/page.tsx", action: "modified" } },
    { eventType: "session.message", payload: { role: "assistant", content: "Done. The workstation now presents a clear connected state with CPU, memory, and session history." } },
    { eventType: "session.status_changed", payload: { state: "completed" } },
  ],
  [DEMO_SESSIONS.claude]: [
    { eventType: "session.message", payload: { role: "user", content: "Review the frontend session console for clarity before recording the demo." } },
    { eventType: "session.message", payload: { role: "assistant", content: "I’ll check the session stream, action affordances, and status hierarchy. I’ll keep this review read-only." } },
    { eventType: "session.tool_call", payload: { toolName: "filesystem.read", arguments: { path: "frontend/app/(app)/sessions/[id]/page.tsx" } } },
    { eventType: "session.tool_result", payload: { toolName: "filesystem.read", output: "Console supports output, messages, tool calls, approval states, and a structured completion summary." } },
    { eventType: "session.message", payload: { role: "assistant", content: "Review complete: the console has a clear event hierarchy and exposes the active trust profile in the header." } },
    { eventType: "session.status_changed", payload: { state: "completed" } },
  ],
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sessionEvents(sessionId: string): unknown[] {
  const items = conversations[sessionId] ?? [];
  return items.map((item, index) => ({
    id: `evt_demo_${sessionId}_${index + 1}`,
    sessionId,
    deviceId: DEMO_DEVICE_ID,
    sequence: index + 1,
    eventType: item.eventType,
    envelope: {
      eventId: `evt_demo_${sessionId}_${index + 1}`,
      eventType: item.eventType,
      eventVersion: 1,
      sessionId,
      deviceId: DEMO_DEVICE_ID,
      sequence: index + 1,
      occurredAt: iso(110 - index * 2),
      payload: item.payload,
    },
    storedAt: iso(110 - index * 2),
  }));
}

export function mockApiResponse(endpoint: string, method: string, body?: unknown): unknown {
  const path = endpoint.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const sessionMatch = path.match(/^\/api\/v1\/sessions\/([^/]+)/);
  const deviceMatch = path.match(/^\/api\/v1\/devices\/([^/]+)/);

  if (path === "/api/v1/auth/refresh" || path === "/api/v1/auth/login" || path === "/api/v1/auth/register") {
    return { accessToken: "odysseus-demo-token", user: { id: "usr_demo_operator", email: "operator@odysseus.demo", name: "Demo Operator", role: "admin" } };
  }
  if (path === "/api/v1/auth/me") {
    return { user: { id: "usr_demo_operator", email: "operator@odysseus.demo", name: "Demo Operator", role: "admin" }, deviceCount: devices.length, connectedDeviceCount: 1 };
  }
  if (path === "/api/v1/devices" && method === "GET") return clone(devices);
  if (path === "/api/v1/sessions" && method === "GET") return clone(sessions);
  if (path === "/api/v1/approvals" && method === "GET") return [];

  if (sessionMatch) {
    const session = sessions.find((item) => item.id === sessionMatch[1]);
    if (path.endsWith("/events")) return session ? sessionEvents(session.id) : [];
    if (path.endsWith("/summary")) return { sessionId: sessionMatch[1], generatedAt: iso(0), fixedTests: 4, modifiedFiles: 3, addedTests: 2, approvalsRequired: [], workingTreeClean: true, lines: ["Demo session summary"], text: "Reviewed the implementation, validated the changed files, and completed the task without requiring an approval." };
    if (session && method === "GET") return clone(session);
    if (session && ["POST", "PATCH"].includes(method)) return clone(session);
  }

  if (deviceMatch) {
    const device = devices.find((item) => item.id === deviceMatch[1]);
    if (device && method === "GET") {
      return clone({
        ...device,
        activeSessions: [],
        recentSessions: sessions.map(({ id, state, agentId, startedAt }) => ({ id, state, agentId, startedAt })),
        totalSessionCount: sessions.length,
      });
    }
    if (device && ["POST", "PATCH"].includes(method)) return { sessions: [], ...clone(device) };
  }

  if (path === "/api/v1/sessions" && method === "POST") {
    return { id: DEMO_SESSIONS.antigravity, ...clone(body as Record<string, unknown>) };
  }
  if (path === "/api/v1/audit/verify") return { valid: true, firstBrokenIndex: null };
  if (path === "/api/v1/audit") return [];
  if (path === "/api/v1/budgets") return { budgets: [], summary: { totalSpend: 0, limit: 100, currency: "USD" } };
  if (path.startsWith("/api/v1/policy/")) return [];

  return {};
}
