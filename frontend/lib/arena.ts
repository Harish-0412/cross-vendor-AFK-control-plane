/**
 * The cross-vendor features: never idle, contests and the leaderboard.
 * Types mirror the Control Plane's arena records.
 */
import { apiClient } from "./api-client";

export const AGENT_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  freebuff: "Freebuff",
  mock: "Mock agent",
};

export const AGENT_VENDOR: Record<string, string> = {
  "claude-code": "Anthropic",
  claude: "Anthropic",
  codex: "OpenAI",
  opencode: "OpenCode",
  antigravity: "Google",
  freebuff: "Freebuff",
  mock: "Test",
};

export const agentLabel = (id: string) => AGENT_LABEL[id] ?? id;

// ------------------------------------------------------------------ types

export interface TestRun {
  ran: boolean;
  passed: boolean;
  command: string;
  exitCode: number | null;
  durationMs: number;
  summary: string;
  outputTail: string;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface ContestEntry {
  agentId: string;
  state: "preparing" | "running" | "evaluating" | "reviewing" | "done" | "failed" | "cancelled";
  sessionId?: string;
  startedAt?: string;
  finishedAt?: string;
  evaluation?: {
    diff?: string;
    diffTruncated: boolean;
    files: FileChange[];
    added: number;
    removed: number;
    tests: TestRun;
  };
  review?: {
    reviewerAgentId: string;
    sessionId?: string;
    state: "pending" | "running" | "done" | "failed" | "skipped";
    score?: number;
    verdict?: "approve" | "changes_requested";
    summary?: string;
    issues?: string[];
    error?: string;
  };
  score?: number;
  scoreBreakdown?: { tests: number; review: number; notes: string[] };
  error?: string;
}

export interface Contest {
  id: string;
  projectId: string;
  projectName: string;
  deviceId: string;
  task: string;
  state: "running" | "judging" | "decided" | "failed" | "cancelled";
  entries: ContestEntry[];
  winnerAgentId?: string;
  decisionReason?: string;
  applied?: { agentId: string; branch: string; commit: string; at: string };
  cleanedUp?: boolean;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BenchmarkTask {
  commit: string;
  parent: string;
  title: string;
  body: string;
  date: string;
  files: string[];
  testFiles: string[];
  linesChanged: number;
}

export interface BenchmarkAttempt {
  id: string;
  changeCommit: string;
  agentId: string;
  state: "queued" | "preparing" | "running" | "evaluating" | "done" | "failed" | "cancelled" | "reviewing";
  sessionId?: string;
  durationMs?: number;
  solved?: boolean;
  testsRan?: boolean;
  testSummary?: string;
  fileOverlap?: number;
  linesChanged?: number;
  error?: string;
}

export interface Benchmark {
  id: string;
  projectId: string;
  projectName: string;
  deviceId: string;
  agents: string[];
  tasks: BenchmarkTask[];
  attempts: BenchmarkAttempt[];
  state: "running" | "completed" | "failed" | "cancelled";
  error?: string;
  createdAt: string;
}

export interface LeaderboardRow {
  agentId: string;
  rank: number;
  attempted: number;
  solved: number;
  solveRate: number;
  averageOverlap: number;
  averageMinutes: number;
  failed: number;
}

export interface Leaderboard {
  rows: LeaderboardRow[];
  tasks: number;
  benchmarks: number;
  preferredAgentId: string | null;
}

export interface NeverIdleSettings {
  enabled: boolean;
  fallbackOrder: string[];
  resumeAfterReset: boolean;
  maxHandoffs: number;
}

export interface VendorLimit {
  agentId: string;
  deviceId: string;
  detectedAt: string;
  resetsAt: string;
  resetKnown: boolean;
  message: string;
  sessionId: string;
}

export interface Handoff {
  id: string;
  chainId: string;
  depth: number;
  fromSessionId: string;
  fromAgentId: string;
  toSessionId?: string;
  toAgentId?: string;
  kind: "handoff" | "scheduled_resume" | "no_alternative";
  reason: string;
  resetsAt?: string;
  projectRoot: string;
  createdAt: string;
  error?: string;
}

export interface ScheduledResume {
  id: string;
  agentId: string;
  deviceId: string;
  fromSessionId: string;
  projectRoot: string;
  runAt: string;
  state: "waiting" | "started" | "failed" | "cancelled";
}

export interface NeverIdleOverview {
  settings: NeverIdleSettings;
  limits: VendorLimit[];
  handoffs: Handoff[];
  scheduled: ScheduledResume[];
}

// -------------------------------------------------------------------- api

export const arena = {
  neverIdle: () => apiClient.get<NeverIdleOverview>("/api/v1/never-idle"),
  saveNeverIdle: (settings: Partial<NeverIdleSettings>) =>
    apiClient.put<NeverIdleSettings>("/api/v1/never-idle/settings", settings),
  clearLimit: (deviceId: string, agentId: string) =>
    apiClient.delete(`/api/v1/never-idle/limits/${encodeURIComponent(deviceId)}/${encodeURIComponent(agentId)}`),
  cancelScheduled: (id: string) => apiClient.delete(`/api/v1/never-idle/scheduled/${encodeURIComponent(id)}`),

  contests: () => apiClient.get<Contest[]>("/api/v1/contests"),
  contest: (id: string) => apiClient.get<Contest>(`/api/v1/contests/${encodeURIComponent(id)}`),
  startContest: (input: { projectId: string; deviceId: string; task: string; agents: string[] }) =>
    apiClient.post<Contest>("/api/v1/contests", input),
  applyContest: (id: string, agentId?: string) =>
    apiClient.post<Contest>(`/api/v1/contests/${encodeURIComponent(id)}/apply`, agentId ? { agentId } : {}),
  cancelContest: (id: string) => apiClient.post<Contest>(`/api/v1/contests/${encodeURIComponent(id)}/cancel`, {}),
  cleanupContest: (id: string) => apiClient.post<Contest>(`/api/v1/contests/${encodeURIComponent(id)}/cleanup`, {}),

  benchmarks: (projectId?: string) =>
    apiClient.get<Benchmark[]>(`/api/v1/benchmarks${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`),
  previewBenchmark: (projectId: string, deviceId: string, changes: number) =>
    apiClient.get<BenchmarkTask[]>(
      `/api/v1/benchmarks/preview?projectId=${encodeURIComponent(projectId)}&deviceId=${encodeURIComponent(deviceId)}&changes=${changes}`,
    ),
  startBenchmark: (input: { projectId: string; deviceId: string; agents: string[]; changes: number }) =>
    apiClient.post<Benchmark>("/api/v1/benchmarks", input),
  cancelBenchmark: (id: string) => apiClient.post<Benchmark>(`/api/v1/benchmarks/${encodeURIComponent(id)}/cancel`, {}),
  leaderboard: (projectId: string) =>
    apiClient.get<Leaderboard>(`/api/v1/leaderboard?projectId=${encodeURIComponent(projectId)}`),
  prefer: (projectId: string, agentId: string) =>
    apiClient.post<{ preferredAgentId: string | null }>("/api/v1/leaderboard/prefer", { projectId, agentId }),
};

/** "in 2h 5m", "in 40m", "now". */
export function untilText(iso: string, now = Date.now()): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function clockText(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
    : "—";
}
