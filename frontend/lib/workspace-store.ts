"use client";

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { apiClient } from "./api-client";
import { aiIntegrations, type ProviderUsageEntry } from "./ai-integrations";
import { realtimeClient } from "./realtime";

/**
 * The operational picture every screen shares: paired machines, sessions,
 * approvals and plan usage.
 *
 * One store, refreshed in one place, because several things show the same
 * facts at once — the pending-approval badge in the navigation, the dashboard
 * and the phone's tab bar. Fetching separately in each made them disagree for
 * a few seconds after every change.
 *
 * A failed request is kept apart from an empty one. "You have no machines"
 * and "the machine list could not be loaded" lead to opposite actions — pair
 * a new one, or wait and retry — and showing the first when the truth is the
 * second has sent people to re-pair a machine that was fine.
 */

export interface DeviceSummary {
  id: string;
  friendlyName: string;
  platform: string;
  status: string;
  online: boolean;
  activeSessionCount: number;
  lastSeenAt?: string | null;
  connectedAt?: string | null;
  fingerprintShort?: string | null;
  systemInfo?: { hostname?: string; gatewayVersion?: string } | null;
  availableAgents?: Array<{ id: string; capabilities?: Record<string, string> }>;
}

export interface SessionSummary {
  id: string;
  deviceId: string;
  agentId: string;
  projectRoot: string;
  state: string;
  startedAt: string;
  createdAt: string;
  updatedAt?: string;
  tokensUsed?: number;
  error?: string;
}

export interface ApprovalSummary {
  id: string;
  sessionId: string;
  deviceId: string;
  actionType: string;
  description: string;
  requestedAt: string;
  status: string;
  riskLevel?: string;
}

type Section<T> = { data: T; error: string | null };

interface WorkspaceState {
  devices: Section<DeviceSummary[]>;
  sessions: Section<SessionSummary[]>;
  approvals: Section<ApprovalSummary[]>;
  usage: Section<ProviderUsageEntry[]>;
  /** False until the first refresh has settled, so screens can show skeletons. */
  loaded: boolean;
  refreshing: boolean;
  lastRefreshedAt: number | null;
  refresh: () => Promise<void>;
}

const empty = <T,>(data: T): Section<T> => ({ data, error: null });

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "Could not be reached";
}

async function load<T>(request: () => Promise<T>, fallback: T): Promise<Section<T>> {
  try {
    return { data: (await request()) ?? fallback, error: null };
  } catch (error) {
    return { data: fallback, error: describe(error) };
  }
}

let inFlight: Promise<void> | null = null;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  devices: empty([]),
  sessions: empty([]),
  approvals: empty([]),
  usage: empty([]),
  loaded: false,
  refreshing: false,
  lastRefreshedAt: null,

  refresh: () => {
    // Coalesce: a realtime event, the poll and a manual refresh arriving
    // together should cost one round of requests, not three.
    if (inFlight) return inFlight;
    set({ refreshing: true });
    inFlight = (async () => {
      const [devices, sessions, approvals, usage] = await Promise.all([
        load(() => apiClient.get<DeviceSummary[]>("/api/v1/devices"), []),
        load(() => apiClient.get<SessionSummary[]>("/api/v1/sessions"), []),
        load(() => apiClient.get<ApprovalSummary[]>("/api/v1/approvals"), []),
        // Usage is optional: an account with nothing connected has none, and
        // a failure here should not mark the dashboard as broken.
        load(() => aiIntegrations.usage(), []),
      ]);
      const previous = get();
      set({
        // Keep the last good data when a refresh fails, so a transient error
        // does not blank a screen that was showing correct information.
        devices: devices.error ? { ...previous.devices, error: devices.error } : devices,
        sessions: sessions.error ? { ...previous.sessions, error: sessions.error } : sessions,
        approvals: approvals.error ? { ...previous.approvals, error: approvals.error } : approvals,
        usage: usage.error ? { data: previous.usage.data, error: null } : usage,
        loaded: true,
        refreshing: false,
        lastRefreshedAt: Date.now(),
      });
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  },
}));

// ------------------------------------------------------------- derived views

const LIVE_STATES = new Set(["running", "waiting_for_approval", "initializing", "paused"]);
const DONE_STATES = new Set(["completed", "failed", "cancelled", "crashed"]);

export function selectPendingApprovals(state: WorkspaceState): ApprovalSummary[] {
  return state.approvals.data.filter((approval) => approval.status === "pending");
}

export function selectLiveSessions(state: WorkspaceState): SessionSummary[] {
  return state.sessions.data.filter((session) => LIVE_STATES.has(session.state));
}

export function selectFinishedSessions(state: WorkspaceState): SessionSummary[] {
  return state.sessions.data
    .filter((session) => DONE_STATES.has(session.state))
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt ?? b.startedAt ?? b.createdAt) -
        Date.parse(a.updatedAt ?? a.startedAt ?? a.createdAt),
    );
}

/*
 * Hooks for the derived lists. The selectors above build a new array on every
 * call; handed straight to the store hook, that reads as a change every time
 * and React re-renders forever. Comparing element by element makes an
 * unchanged list the same list.
 */
export const usePendingApprovals = () => useWorkspace(useShallow(selectPendingApprovals));
export const useLiveSessions = () => useWorkspace(useShallow(selectLiveSessions));
export const useFinishedSessions = () => useWorkspace(useShallow(selectFinishedSessions));

// --------------------------------------------------------------- live sync

/**
 * Events that change what the overview shows. Machines coming and going have
 * no browser event of their own; the gateway's lifecycle events, the
 * foreground refresh and the poll cover them.
 */
const REFRESH_EVENTS = new Set([
  "session.created",
  "session.started",
  "session.status_changed",
  "session.completed",
  "session.failed",
  "session.crashed",
  "session.cancelled",
  "session.approval_required",
  "session.approval_granted",
  "session.approval_denied",
  "gateway.started",
  "gateway.shutting_down",
  "gateway.shutdown",
]);

/**
 * Keep the store current: refresh now, on relevant realtime events, when the
 * tab or app comes back to the foreground, and on a slow poll as a backstop.
 * Returns a cleanup function. Mounted once, by the app shell.
 */
export function startWorkspaceSync(): () => void {
  const { refresh } = useWorkspace.getState();
  void refresh();

  const unsubscribe = realtimeClient.subscribeAllEvents((message) => {
    if (
      (message.eventType && REFRESH_EVENTS.has(message.eventType)) ||
      message.type === "integration_update"
    ) {
      void refresh();
    }
  });

  // A phone that was locked for twenty minutes should not show twenty-minute-
  // old state for another half a minute when it is unlocked.
  const onVisible = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  document.addEventListener("visibilitychange", onVisible);

  const poll = setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, 30_000);

  return () => {
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(poll);
  };
}
