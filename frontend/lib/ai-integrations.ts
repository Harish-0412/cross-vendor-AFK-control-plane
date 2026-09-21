// frontend/lib/ai-integrations.ts
// Client for AI-tool integrations (Codex, Antigravity, …): access requests,
// imported history, and provider usage limits.
//
// Access is only ever *granted* on the workstation. This client can request,
// revoke and read — nothing here can approve.

import type {
  ExternalConversationSummary,
  HistoryItem,
  IntegrationDefinition,
  IntegrationGrantState,
  IntegrationId,
  IntegrationScope,
  ProviderUsageSnapshot,
} from "@odysseus/protocol";

import { apiClient } from "./api-client";

export type { HistoryItem, IntegrationId, IntegrationScope, ProviderUsageSnapshot };

export interface DeviceOption {
  id: string;
  friendlyName: string;
  online: boolean;
  platform?: string;
}

export interface DeviceIntegration extends IntegrationDefinition {
  state: IntegrationGrantState;
  revokePending: boolean;
}

export interface ImportedConversation extends ExternalConversationSummary {
  id: string;
  deviceId: string;
  contentSynced: boolean;
  contentSyncedAt?: string;
  contentTruncated?: boolean;
}

export interface ProviderUsageEntry {
  deviceId: string;
  integration: IntegrationId;
  snapshot: ProviderUsageSnapshot;
  receivedAt: string;
}

/** Integrations whose data can be read today. The others are planned, not built. */
export const AVAILABLE_INTEGRATIONS: IntegrationId[] = ["codex", "antigravity"];

export const aiIntegrations = {
  devices: () => apiClient.get<DeviceOption[]>("/api/v1/devices"),

  forDevice: (deviceId: string) =>
    apiClient.get<DeviceIntegration[]>(`/api/v1/devices/${deviceId}/integrations`),

  requestAccess: (deviceId: string, integration: IntegrationId, scopes: IntegrationScope[]) =>
    apiClient.post<{ requestId: string; confirmationCode: string; expiresAt: string; scopes: IntegrationScope[] }>(
      `/api/v1/devices/${deviceId}/integrations/${integration}/requests`,
      { scopes },
    ),

  revoke: (deviceId: string, integration: IntegrationId) =>
    apiClient.delete<{ delivered: boolean }>(`/api/v1/devices/${deviceId}/integrations/${integration}`),

  syncNow: (deviceId: string, integration: IntegrationId) =>
    apiClient.post(`/api/v1/devices/${deviceId}/integrations/${integration}/sync`, {}),

  history: (filter: { integration?: IntegrationId; deviceId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filter.integration) params.set("integration", filter.integration);
    if (filter.deviceId) params.set("deviceId", filter.deviceId);
    const query = params.toString();
    return apiClient.get<ImportedConversation[]>(`/api/v1/history${query ? `?${query}` : ""}`);
  },

  conversation: (id: string) =>
    apiClient.get<{ conversation: ImportedConversation; items: HistoryItem[] }>(
      `/api/v1/history/${encodeURIComponent(id)}`,
    ),

  requestContent: (id: string) =>
    apiClient.post(`/api/v1/history/${encodeURIComponent(id)}/content`, {}),

  usage: () => apiClient.get<ProviderUsageEntry[]>("/api/v1/usage/providers"),
};

// ----------------------------------------------------------- usage freshness

export interface WindowView {
  name: "primary" | "secondary";
  label: string;
  usedPercent: number;
  resetsAt: Date;
  /**
   * The window reset after this reading was taken, so the recorded percentage
   * no longer describes it. Codex only records limits while it runs; the real
   * current figure is unknown until it runs again.
   */
  resetSinceReading: boolean;
}

export function describeWindow(minutes: number): string {
  if (minutes >= 10080 && minutes % 10080 === 0) return minutes === 10080 ? "Weekly" : `${minutes / 10080}-week`;
  if (minutes >= 1440 && minutes % 1440 === 0) return minutes === 1440 ? "Daily" : `${minutes / 1440}-day`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function windowViews(snapshot: ProviderUsageSnapshot, now = Date.now()): WindowView[] {
  return (snapshot.windows ?? []).map((window) => {
    const resetsAt = new Date(window.resetsAt);
    return {
      name: window.name,
      label: `${describeWindow(window.windowMinutes)} limit`,
      usedPercent: window.usedPercent,
      resetsAt,
      resetSinceReading: resetsAt.getTime() <= now,
    };
  });
}

export function formatRelative(date: Date | string, now = Date.now()): string {
  const value = typeof date === "string" ? new Date(date) : date;
  const diff = value.getTime() - now;
  const abs = Math.abs(diff);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, unit] of units) {
    if (abs >= ms) {
      const n = Math.round(abs / ms);
      const text = `${n} ${unit}${n === 1 ? "" : "s"}`;
      return diff < 0 ? `${text} ago` : `in ${text}`;
    }
  }
  return diff < 0 ? "just now" : "in under a minute";
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
