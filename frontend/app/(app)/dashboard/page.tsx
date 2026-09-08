"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import { useAuthStore } from "@/lib/auth";
import { apiClient } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";
import { StatsGrid } from "@/components/dashboard/StatsGrid";
import { AttentionNeeded, PendingApprovalItem } from "@/components/dashboard/AttentionNeeded";
import { ActiveSessions, SessionItem } from "@/components/dashboard/ActiveSessions";
import { RecentActivity } from "@/components/dashboard/RecentActivity";
import { QuickLaunchModal } from "@/components/dashboard/QuickLaunchModal";
import { RefreshCw } from "lucide-react";
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
        apiClient.get<PendingApprovalItem[]>("/api/v1/approvals").catch(() => []),
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
    (s) => s.state === "running" || s.state === "waiting_for_approval" || s.state === "initializing",
  );
  const completedSessionsList = sessions.filter(
    (s) => s.state === "completed" || s.state === "failed" || s.state === "cancelled",
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
            Overview of your connected machines, active agents, and pending approvals.
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
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>

          <QuickLaunchModal devices={devices} onSessionLaunched={fetchData} />
        </div>
      </motion.div>

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
