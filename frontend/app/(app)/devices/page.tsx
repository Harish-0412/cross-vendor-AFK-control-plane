"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Monitor, Plus, Circle, Server, Laptop, Cpu, HardDrive, RefreshCw, OctagonAlert, Lock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";
import { toast } from "sonner";

interface DeviceRecord {
  id: string;
  friendlyName: string;
  platform: "windows" | "linux" | "darwin" | "unknown";
  status: string;
  online: boolean;
  lastSeenAt: string | null;
  activeSessionCount: number;
  resourceUsage?: {
    cpuPercent?: number;
    memoryMb?: number;
    memoryPeakMb?: number;
    activeProcesses?: number;
    diskFreeMb?: number;
  } | null;
  createdAt: string;
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const runDeviceAction = async (device: DeviceRecord, action: "kill-switch" | "lock") => {
    if (busyId) return;
    if (device.activeSessionCount === 0) {
      toast.info("No active sessions on this device");
      return;
    }
    setBusyId(device.id);
    try {
      const res = await apiClient.post<{ sessions: unknown[] }>(
        `/api/v1/devices/${device.id}/${action}`,
        { reason: action === "kill-switch" ? "Kill switch from devices page" : "Lock from devices page" },
      );
      const count = res?.sessions?.length ?? 0;
      toast.success(
        action === "kill-switch"
          ? `${count} session${count === 1 ? "" : "s"} cancelled on ${device.friendlyName}`
          : `${count} session${count === 1 ? "" : "s"} locked to observation-only`,
      );
      void fetchDevices();
    } catch {
      toast.error(`Failed to ${action === "kill-switch" ? "stop" : "lock"} device`);
    } finally {
      setBusyId(null);
    }
  };

  const fetchDevices = async () => {
    try {
      const data = await apiClient.get<DeviceRecord[]>("/api/v1/devices");
      setDevices(data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchDevices();

    const interval = setInterval(() => {
      void fetchDevices();
    }, 15_000);

    const unsub = realtimeClient.subscribeAllEvents(() => {
      void fetchDevices();
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, []);

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case "darwin":
        return <Laptop className="h-5 w-5 text-foreground/70" />;
      case "linux":
        return <Server className="h-5 w-5 text-foreground/70" />;
      default:
        return <Monitor className="h-5 w-5 text-foreground/70" />;
    }
  };

  const formatLastSeen = (lastSeenAt: string | null, online: boolean) => {
    if (online) return "Active now";
    if (!lastSeenAt) return "Never";
    const diffMs = Date.now() - new Date(lastSeenAt).getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return new Date(lastSeenAt).toLocaleDateString();
  };

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">Connected Machines</h1>
          <p className="text-sm text-muted-foreground">Manage and inspect your registered remote gateway devices.</p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void fetchDevices();
            }}
            disabled={refreshing}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Link href="/devices/pair">
            <Button size="sm" className="gap-2 w-full sm:w-auto">
              <Plus className="h-4 w-4" /> Pair Device
            </Button>
          </Link>
        </div>
      </motion.div>

      {devices.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-12 text-center shadow-sm">
          <Monitor className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-base font-semibold text-foreground">No devices paired yet</h3>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            Pair your local workstation or remote server running the FreeBuff Gateway to start executing agent tasks.
          </p>
          <Link href="/devices/pair" className="mt-4">
            <Button size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" /> Pair Your First Device
            </Button>
          </Link>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {devices.map((device, i) => (
          <motion.div
            key={device.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.06 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
          >
          <Link href={`/devices/${device.id}`} className="block h-full">
            <div className="flex flex-col gap-4 h-full rounded-xl border border-border bg-card p-5 hover:border-primary/50 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 group">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                    {getPlatformIcon(device.platform)}
                  </div>
                  <div className="flex flex-col">
                    <span className="font-semibold text-foreground tracking-tight text-sm">
                      {device.friendlyName}
                    </span>
                    <span className="text-[11px] font-mono text-muted-foreground">{device.id}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-xs font-medium">
                  <Circle
                    className={`h-2 w-2 fill-current ${
                      device.online ? "text-emerald-500" : "text-destructive"
                    }`}
                  />
                  <span className="capitalize">{device.online ? "Online" : "Offline"}</span>
                </div>
              </div>

              {/* Resource usage telemetry if reported */}
              {device.resourceUsage && (
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/50 p-2.5 text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Cpu className="h-3.5 w-3.5 text-primary" />
                    <span>CPU:</span>
                    <span className="font-medium text-foreground font-mono">
                      {device.resourceUsage.cpuPercent !== undefined
                        ? `${device.resourceUsage.cpuPercent}%`
                        : "—"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <HardDrive className="h-3.5 w-3.5 text-blue-500" />
                    <span>RAM:</span>
                    <span className="font-medium text-foreground font-mono">
                      {device.resourceUsage.memoryMb !== undefined
                        ? `${device.resourceUsage.memoryMb} MB`
                        : "—"}
                    </span>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5 pt-2 border-t border-border/50 text-xs text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span>Last seen</span>
                  <span className="font-medium text-foreground">
                    {formatLastSeen(device.lastSeenAt, device.online)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Active sessions</span>
                  <span className="font-medium text-foreground font-mono">
                    {device.activeSessionCount}
                  </span>
                </div>
              </div>

              {/* Phase 7 §2.5 — per-device kill switch / lock */}
              {device.activeSessionCount > 0 && (
                <div className="flex items-center gap-2 pt-1" onClick={(e) => e.preventDefault()}>
                  <button
                    onClick={() => void runDeviceAction(device, "kill-switch")}
                    disabled={busyId === device.id}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/5 px-2 py-1.5 text-[11px] font-bold text-red-600 dark:text-red-400 transition-all hover:bg-red-500/15 disabled:opacity-50"
                    title="Cancel every active session on this device"
                  >
                    {busyId === device.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <OctagonAlert className="h-3 w-3" />}
                    Stop All
                  </button>
                  <button
                    onClick={() => void runDeviceAction(device, "lock")}
                    disabled={busyId === device.id}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-400 transition-all hover:bg-amber-500/15 disabled:opacity-50"
                    title="Lock sessions to observation-only (approvals superseded)"
                  >
                    <Lock className="h-3 w-3" />
                    Lock
                  </button>
                </div>
              )}
            </div>
          </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
