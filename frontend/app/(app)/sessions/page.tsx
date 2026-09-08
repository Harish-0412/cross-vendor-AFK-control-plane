"use client";

import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  Bot,
  Cpu,
  Folder,
  Play,
  Clock,
  CheckCircle2,
  AlertCircle,
  PauseCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";
import { QuickLaunchModal } from "@/components/dashboard/QuickLaunchModal";

interface SessionRecord {
  id: string;
  deviceId: string;
  agentId: string;
  projectRoot: string;
  state: string;
  startedAt: string;
  createdAt: string;
  completedAt?: string | null;
  error?: string | null;
  tokensUsed?: number | null;
}

interface DeviceItem {
  id: string;
  friendlyName: string;
  online: boolean;
  platform: string;
}

export default function SessionsPage() {
  const searchParams = useSearchParams();
  const filterDeviceId = searchParams.get("deviceId") || "";

  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<string>("all");
  const [selectedDevice, setSelectedDevice] = useState<string>(filterDeviceId);

  const fetchSessionsAndDevices = async () => {
    try {
      const [sessData, devData] = await Promise.all([
        apiClient.get<SessionRecord[]>("/api/v1/sessions"),
        apiClient.get<DeviceItem[]>("/api/v1/devices").catch(() => []),
      ]);
      setSessions(sessData || []);
      setDevices(devData || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchSessionsAndDevices();

    const interval = setInterval(() => {
      void fetchSessionsAndDevices();
    }, 15_000);

    const unsub = realtimeClient.subscribeAllEvents((msg) => {
      if (
        msg.eventType === "session.status_changed" ||
        msg.eventType === "session.approval_required"
      ) {
        void fetchSessionsAndDevices();
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, []);

  const deviceMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of devices) {
      map[d.id] = d.friendlyName;
    }
    return map;
  }, [devices]);

  const filteredSessions = useMemo(() => {
    return sessions.filter((s) => {
      if (selectedDevice && s.deviceId !== selectedDevice) return false;
      if (activeTab === "running") return s.state === "running" || s.state === "initializing";
      if (activeTab === "waiting") return s.state === "waiting_for_approval";
      if (activeTab === "paused") return s.state === "paused";
      if (activeTab === "completed") return s.state === "completed";
      if (activeTab === "failed") return s.state === "failed" || s.state === "cancelled";
      return true;
    });
  }, [sessions, activeTab, selectedDevice]);

  const getStatusBadge = (state: string) => {
    switch (state) {
      case "running":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Running
          </span>
        );
      case "waiting_for_approval":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-ping" />
            Needs Approval
          </span>
        );
      case "paused":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 border border-blue-500/20">
            <PauseCircle className="h-3 w-3" /> Paused
          </span>
        );
      case "failed":
      case "cancelled":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive border border-destructive/20">
            <AlertCircle className="h-3 w-3" /> {state}
          </span>
        );
      case "completed":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground border border-border">
            <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Completed
          </span>
        );
      default:
        return (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {state}
          </span>
        );
    }
  };

  const formatDuration = (startedAt: string, completedAt?: string | null) => {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    const sec = Math.max(0, Math.floor((end - start) / 1000));
    const min = Math.floor(sec / 60);
    const hrs = Math.floor(min / 60);

    if (hrs > 0) return `${hrs}h ${min % 60}m`;
    if (min > 0) return `${min}m ${sec % 60}s`;
    return `${sec}s`;
  };

  const counts = {
    all: sessions.length,
    running: sessions.filter((s) => s.state === "running" || s.state === "initializing").length,
    waiting: sessions.filter((s) => s.state === "waiting_for_approval").length,
    paused: sessions.filter((s) => s.state === "paused").length,
    completed: sessions.filter((s) => s.state === "completed").length,
    failed: sessions.filter((s) => s.state === "failed" || s.state === "cancelled").length,
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">Agent Sessions</h1>
          <p className="text-sm text-muted-foreground">
            Monitor, inspect, and interact with autonomous coding agent runs.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void fetchSessionsAndDevices();
            }}
            disabled={refreshing}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>

          <QuickLaunchModal devices={devices} onSessionLaunched={fetchSessionsAndDevices} />
        </div>
      </div>

      {/* Filter Tabs & Machine Selector */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-3">
        <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
          {[
            { key: "all", label: "All", count: counts.all },
            { key: "running", label: "Running", count: counts.running },
            { key: "waiting", label: "Approvals", count: counts.waiting },
            { key: "paused", label: "Paused", count: counts.paused },
            { key: "completed", label: "Completed", count: counts.completed },
            { key: "failed", label: "Failed / Cancelled", count: counts.failed },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                activeTab === tab.key
                  ? "bg-primary text-primary-foreground font-semibold"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <span>{tab.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                  activeTab === tab.key ? "bg-primary-foreground/20" : "bg-muted"
                }`}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>

        {devices.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Filter Machine:</span>
            <select
              className="rounded-md border border-input bg-background px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
              value={selectedDevice}
              onChange={(e) => setSelectedDevice(e.target.value)}
            >
              <option value="">All Machines</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.friendlyName}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Session Cards List */}
      {filteredSessions.length === 0 && !loading ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-12 text-center shadow-sm">
          <Activity className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-base font-semibold text-foreground">No sessions found</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            {activeTab === "all"
              ? "No agent sessions have been started yet."
              : `No sessions currently matching the "${activeTab}" filter.`}
          </p>
          <div className="mt-4">
            <QuickLaunchModal devices={devices} onSessionLaunched={fetchSessionsAndDevices} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filteredSessions.map((s) => {
            const deviceName = deviceMap[s.deviceId] || s.deviceId;
            return (
              <Link href={`/sessions/${s.id}`} key={s.id}>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 hover:border-primary/50 hover:shadow-md transition-all group">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0 mt-0.5 group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                      <Bot className="h-5 w-5" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-foreground font-mono">
                          {s.id}
                        </span>
                        {getStatusBadge(s.state)}
                        <span className="font-mono text-[11px] bg-muted px-2 py-0.5 rounded text-foreground/80 font-medium">
                          {s.agentId}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        <span className="flex items-center gap-1">
                          <Cpu className="h-3.5 w-3.5" />
                          {deviceName}
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1 font-mono text-[11px] max-w-xs truncate">
                          <Folder className="h-3.5 w-3.5" />
                          {s.projectRoot}
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          Duration: {formatDuration(s.startedAt, s.completedAt)}
                        </span>
                      </div>

                      {s.error && (
                        <p className="text-xs text-destructive mt-0.5 line-clamp-1">
                          Error: {s.error}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-3 sm:ml-auto">
                    {s.tokensUsed !== undefined && s.tokensUsed !== null && (
                      <span className="text-xs text-muted-foreground font-mono">
                        {s.tokensUsed.toLocaleString()} tokens
                      </span>
                    )}
                    <Button size="sm" variant="outline" className="text-xs group-hover:border-primary">
                      Open Console →
                    </Button>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
