"use client";

// frontend/lib/admin.ts
// Typed admin API client + shared types for the Admin Console.
// All requests ride the same fetchWithAuth pipeline (silent refresh included)
// as the rest of the app; the Control Plane re-verifies admin role from the
// database on every call.

import { apiClient, ApiError } from "./api-client";

export type UserStatus = "active" | "suspended";
export type PlatformRole = "user" | "admin" | "owner";
export type GrantStatusView = "active" | "pending" | "denied" | "revoked" | "expired" | "none";

export interface IntegrationStatusSummary {
  integration: string;
  status: GrantStatusView;
  scopes: string[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: PlatformRole;
  status: UserStatus;
  suspendedReason?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string | null;
  deviceCount: number;
  onlineDeviceCount: number;
  activeSessionCount: number;
  sessionCount: number;
  pendingApprovalCount: number;
  integrations: IntegrationStatusSummary[];
  connectedProviders: string[];
}

export interface AdminStats {
  users: { total: number; active: number; suspended: number; admins: number };
  devices: { total: number; online: number; revoked: number };
  sessions: {
    total: number;
    active: number;
    waitingForApproval: number;
    failed: number;
  };
  approvals: { pending: number };
  audit: { chainValid: boolean; events: number };
  integrations: {
    activeGrants: Record<string, number>;
    connectedUsers: Record<string, number>;
  };
  uptimeSeconds: number;
  version: string;
}

export interface DeveloperAnalytics {
  generatedAt: string;
  window: { startsAt: string; endsAt: string };
  activity: {
    activeUsers: number;
    newUsers: number;
    sessionsStarted: number;
    completedSessions: number;
    failedSessions: number;
    activeSessions: number;
    pendingApprovals: number;
  };
  usage: {
    recordedTokens: number;
    meteredCostUsd: number;
    subscriptionTokens: number;
    byAgent: Record<string, { sessions: number; tokens: number }>;
  };
  service: {
    auditChainValid: boolean;
    devicesOnline: number;
    devicesTotal: number;
    deviceAvailabilityPercent: number;
    uptimeSeconds: number;
  };
}

export interface AdminDevice {
  id: string;
  userId: string;
  friendlyName: string;
  platform: string;
  status: string;
  online: boolean;
  defaultTrustProfile: string;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface AdminSession {
  id: string;
  userId: string;
  deviceId: string;
  agentId: string;
  state: string;
  trustProfile: string;
  startedAt: string;
  tokensUsed?: number;
  error?: string;
}

export function isAdminApiError(err: unknown, status: number): err is ApiError {
  return err instanceof ApiError && err.status === status;
}

export const adminApi = {
  getStats: () => apiClient.get<AdminStats>("/api/v1/admin/stats"),
  getAnalytics: () => apiClient.get<DeveloperAnalytics>("/api/v1/admin/analytics"),

  listUsers: () => apiClient.get<AdminUser[]>("/api/v1/admin/users"),
  getUser: (id: string) => apiClient.get<AdminUser>(`/api/v1/admin/users/${id}`),

  setUserStatus: (id: string, status: UserStatus, reason?: string) =>
    apiClient.post<AdminUser>(`/api/v1/admin/users/${id}/status`, { status, reason }),

  setUserRole: (id: string, role: PlatformRole) =>
    apiClient.post<AdminUser>(`/api/v1/admin/users/${id}/role`, { role }),

  terminateUser: (id: string, reason?: string) =>
    apiClient.post<{ devicesDisconnected: string[]; sessionsCancelled: number; approvalsSuperseded: number }>(
      `/api/v1/admin/users/${id}/terminate`,
      { reason },
    ),

  destroyUser: (id: string, confirmEmail: string) =>
    apiClient.delete<{ deleted: boolean; removed: Record<string, number> }>(
      `/api/v1/admin/users/${id}`,
      { body: JSON.stringify({ confirmEmail }) } as RequestInit,
    ),

  listDevices: () => apiClient.get<AdminDevice[]>("/api/v1/admin/devices"),
  revokeDevice: (id: string, reason?: string) =>
    apiClient.post<{ id: string; status: "revoked"; sessionsCancelled: number; approvalsSuperseded: number }>(
      `/api/v1/admin/devices/${id}/revoke`,
      { reason },
    ),
  listSessions: (limit = 200) => apiClient.get<AdminSession[]>(`/api/v1/admin/sessions?limit=${limit}`),
  cancelSession: (id: string, reason?: string) =>
    apiClient.post<{ id: string; state: string; delivered: boolean }>(
      `/api/v1/admin/sessions/${id}/cancel`,
      { reason },
    ),
  disconnectVcsProvider: (userId: string, provider: "github" | "gitlab" | "bitbucket") =>
    apiClient.delete<{ disconnected: boolean }>(
      `/api/v1/admin/users/${userId}/providers/${provider}`,
    ),
};

export const INTEGRATION_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  antigravity: "Antigravity",
  claude: "Claude Code",
  codex: "Codex",
  "chatgpt-export": "ChatGPT Export",
  "openai-org": "OpenAI Org",
};

export const STATUS_STYLES: Record<GrantStatusView, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  pending: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  denied: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  revoked: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  expired: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  none: "bg-zinc-500/10 text-zinc-500 border-zinc-500/20",
};

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
