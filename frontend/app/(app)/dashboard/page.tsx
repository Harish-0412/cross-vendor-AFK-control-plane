"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { useAuthStore } from "@/lib/auth";
import { apiClient } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import {
  AttentionNeeded,
  PendingApprovalItem,
} from "@/components/dashboard/AttentionNeeded";
import {
  ActiveSessions,
  SessionItem,
} from "@/components/dashboard/ActiveSessions";
import { RecentActivity } from "@/components/dashboard/RecentActivity";
import { QuickLaunchModal } from "@/components/dashboard/QuickLaunchModal";
import {
  ArrowRight,
  CircleAlert,
  Link2,
  MonitorUp,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface DeviceItem {
  id: string;
  friendlyName: string;
  platform: string;
  status: string;
  online: boolean;
  activeSessionCount: number;
}

export default function DashboardPage() {
  const { user } = useAuthStore();
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [devData, sessData, apprData] = await Promise.all([
        apiClient.get<DeviceItem[]>("/api/v1/devices").catch(() => []),
        apiClient.get<SessionItem[]>("/api/v1/sessions").catch(() => []),
        apiClient
          .get<PendingApprovalItem[]>("/api/v1/approvals")
          .catch(() => []),
      ]);

      setDevices(devData || []);
      setSessions(sessData || []);
      setApprovals(apprData || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();

    // 30-second background polling
    const interval = setInterval(() => {
      void fetchData();
    }, 30_000);

    // Live update on realtime events
    const unsub = realtimeClient.subscribeAllEvents((msg) => {
      if (
        msg.eventType === "session.status_changed" ||
        msg.eventType === "session.approval_required" ||
        msg.eventType === "session.approval_decided"
      ) {
        void fetchData();
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [fetchData]);

  const handleManualRefresh = () => {
    setRefreshing(true);
    void fetchData();
  };

  const deviceMap: Record<string, string> = {};
  for (const d of devices) {
    deviceMap[d.id] = d.friendlyName;
  }

  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const onlineCount = devices.filter((d) => d.online).length;
  const activeSessionsList = sessions.filter(
    (s) =>
      s.state === "running" ||
      s.state === "waiting_for_approval" ||
      s.state === "initializing",
  );
  const completedSessionsList = sessions.filter(
    (s) =>
      s.state === "completed" ||
      s.state === "failed" ||
      s.state === "cancelled",
  );

  return (
    <div className="flex flex-col gap-8 max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
            Welcome back, {user?.name || "Operator"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Overview of your connected machines, active agents, and pending
            approvals.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="gap-1.5 text-xs transition-transform active:scale-95"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>

          <QuickLaunchModal devices={devices} onSessionLaunched={fetchData} />
        </div>
      </motion.div>

      {!loading && devices.length === 0 ? (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/[0.12] via-card to-card shadow-sm"
        >
          <div className="grid gap-8 p-6 sm:p-8 lg:grid-cols-[1.15fr_0.85fr] lg:p-10">
            <div className="max-w-2xl">
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
                <MonitorUp className="h-6 w-6" />
              </div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-primary">
                First-time setup
              </p>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                Connect the computer that runs your coding agents
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
                Odysseus keeps credentials and source code on your workstation.
                The control plane receives only the session information you
                choose to sync.
              </p>
              <Button asChild className="mt-6 gap-2 rounded-xl">
                <Link href="/devices/pair">
                  Pair a workstation
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>

            <div className="grid gap-3 self-center">
              {[
                {
                  icon: Link2,
                  title: "Pair with a one-time PIN",
                  body: "Verify the workstation name and fingerprint before trusting it.",
                },
                {
                  icon: Wrench,
                  title: "Connect your local tools",
                  body: "Enable Codex, Claude Code, or Antigravity from the machine itself.",
                },
                {
                  icon: MonitorUp,
                  title: "Control work from anywhere",
                  body: "Review history, usage, sessions, and approvals from this dashboard.",
                },
              ].map((step, index) => (
                <div
                  key={step.title}
                  className="flex gap-4 rounded-2xl border border-border/70 bg-background/70 p-4 backdrop-blur-sm"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <step.icon className="h-4 w-4" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {index + 1}. {step.title}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {step.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </motion.section>
      ) : null}

      {!loading && devices.length > 0 && onlineCount === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-4 rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] p-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex gap-3">
            <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
            <div>
              <p className="text-sm font-semibold">
                Your workstations are currently offline
              </p>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                Start the Odysseus Gateway on a paired computer to restore live
                sessions and tool sync.
              </p>
            </div>
          </div>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="shrink-0 gap-2"
          >
            <Link href="/devices">
              View machines
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </motion.div>
      ) : null}

      <StatsGrid
        onlineDevices={onlineCount}
        totalDevices={devices.length}
        activeSessions={activeSessionsList.length}
        pendingApprovals={pendingApprovals.length}
        completedSessions={completedSessionsList.length}
      />

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-3">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.25 }}
          className="xl:col-span-2 flex flex-col gap-8"
        >
          <AttentionNeeded approvals={pendingApprovals} onRefresh={fetchData} />
          <ActiveSessions sessions={activeSessionsList} deviceMap={deviceMap} />
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.35 }}
          className="xl:col-span-1"
        >
          <RecentActivity
            recentSessions={completedSessionsList}
            approvals={pendingApprovals}
            deviceCount={devices.length}
          />
        </motion.div>
      </div>
    </div>
  );
}
