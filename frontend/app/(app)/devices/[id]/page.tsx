"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Monitor,
  Circle,
  Activity,
  Key,
  Trash2,
  Cpu,
  HardDrive,
  Play,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient, ApiError } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";
import { toast } from "sonner";

interface DeviceDetail {
  id: string;
  friendlyName: string;
  platform: string;
  status: string;
  online: boolean;
  lastSeenAt: string | null;
  systemInfo?: {
    hostname?: string;
    arch?: string;
    nodeVersion?: string;
    gatewayVersion?: string;
  } | null;
  resourceUsage?: {
    cpuPercent?: number;
    memoryMb?: number;
    memoryPeakMb?: number;
    activeProcesses?: number;
    diskFreeMb?: number;
  } | null;
  fingerprintHex?: string;
  activeSessions: Array<{
    id: string;
    state: string;
    agentId: string;
    startedAt: string;
  }>;
  recentSessions: Array<{
    id: string;
    state: string;
    agentId: string;
    startedAt: string;
  }>;
  totalSessionCount: number;
  createdAt: string;
  updatedAt: string;
}

export default function DeviceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const router = useRouter();
  const deviceId = resolvedParams.id;

  const [device, setDevice] = useState<DeviceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

  const fetchDevice = async () => {
    try {
      const data = await apiClient.get<DeviceDetail>(`/api/v1/devices/${deviceId}`);
      setDevice(data);
    } catch {
      toast.error("Failed to load device details");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchDevice();

    const interval = setInterval(() => {
      void fetchDevice();
    }, 10_000);

    const unsub = realtimeClient.subscribeDevice(deviceId, () => {
      void fetchDevice();
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [deviceId]);

  const handleRevoke = async () => {
    setRevoking(true);
    try {
      await apiClient.delete(`/api/v1/devices/${deviceId}`);
      toast.success("Device revoked successfully");
      router.push("/devices");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to revoke device";
      toast.error(msg);
      setRevoking(false);
      setShowRevokeConfirm(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!device) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <h2 className="text-xl font-bold">Device Not Found</h2>
        <p className="text-sm text-muted-foreground mt-2">
          The requested device does not exist or has been revoked.
        </p>
        <Link href="/devices" className="mt-4">
          <Button variant="outline" size="sm">
            Back to Devices
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/devices">
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Monitor className="h-5 w-5" />
            </div>
            <div className="flex flex-col">
              <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
                {device.friendlyName}
              </h1>
              <span className="text-xs font-mono text-muted-foreground">{device.id}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-medium border border-border">
            <Circle
              className={`h-2.5 w-2.5 fill-current ${
                device.online ? "text-emerald-500" : "text-destructive"
              }`}
            />
            <span className="capitalize">{device.online ? "Online" : "Offline"}</span>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={fetchDevice}
            className="gap-1 text-xs"
            title="Refresh device details"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 flex flex-col gap-6">
          {/* Live System Telemetry */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold tracking-tight mb-4 flex items-center gap-2">
              <Cpu className="h-4 w-4 text-primary" /> Live System Telemetry
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/40 border border-border/50">
                <span className="text-xs text-muted-foreground">CPU Usage</span>
                <span className="text-xl font-bold font-mono text-foreground">
                  {device.resourceUsage?.cpuPercent !== undefined
                    ? `${device.resourceUsage.cpuPercent}%`
                    : "—"}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/40 border border-border/50">
                <span className="text-xs text-muted-foreground">Memory</span>
                <span className="text-xl font-bold font-mono text-foreground">
                  {device.resourceUsage?.memoryMb !== undefined
                    ? `${device.resourceUsage.memoryMb} MB`
                    : "—"}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/40 border border-border/50">
                <span className="text-xs text-muted-foreground">Active Procs</span>
                <span className="text-xl font-bold font-mono text-foreground">
                  {device.resourceUsage?.activeProcesses !== undefined
                    ? device.resourceUsage.activeProcesses
                    : "—"}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/40 border border-border/50">
                <span className="text-xs text-muted-foreground">Disk Free</span>
                <span className="text-xl font-bold font-mono text-foreground">
                  {device.resourceUsage?.diskFreeMb !== undefined
                    ? `${device.resourceUsage.diskFreeMb} MB`
                    : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Device Hardware & Software Info */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <h2 className="text-base font-semibold tracking-tight mb-4">Device Specifications</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-4 gap-x-8 text-sm">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Platform</span>
                <span className="font-medium capitalize">{device.platform}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Architecture</span>
                <span className="font-mono">{device.systemInfo?.arch || "—"}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Hostname</span>
                <span className="font-mono">{device.systemInfo?.hostname || "—"}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Gateway Version</span>
                <span className="font-mono">{device.systemInfo?.gatewayVersion || "0.1.0"}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Node Version</span>
                <span className="font-mono">{device.systemInfo?.nodeVersion || "—"}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">Registered At</span>
                <span>{new Date(device.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          {/* Active & Recent Sessions */}
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" /> Session History ({device.totalSessionCount})
              </h2>
            </div>

            {device.recentSessions.length === 0 ? (
              <p className="text-xs text-muted-foreground">No sessions have run on this device yet.</p>
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {device.recentSessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between py-2.5 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-medium text-foreground">{s.id}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                        {s.agentId}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="capitalize text-muted-foreground">{s.state}</span>
                      <Link href={`/sessions/${s.id}`}>
                        <Button size="sm" variant="ghost" className="h-7 text-xs">
                          View
                        </Button>
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Security & Fingerprint */}
          {device.fingerprintHex && (
            <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <Key className="h-4 w-4 text-primary" />
                <h2 className="text-base font-semibold tracking-tight">Security Fingerprint</h2>
              </div>
              <p className="text-xs text-muted-foreground mb-2">SHA-256 Public Key Fingerprint</p>
              <code className="block bg-muted p-3 rounded-lg text-xs font-mono text-foreground break-all border border-border">
                {device.fingerprintHex}
              </code>
            </div>
          )}
        </div>

        {/* Action Panel */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-border bg-card p-6 shadow-sm flex flex-col gap-3">
            <h2 className="text-base font-semibold tracking-tight mb-2">Actions</h2>

            <Link href={`/sessions?deviceId=${device.id}`}>
              <Button variant="outline" className="w-full justify-start gap-2 text-xs">
                <Activity className="h-4 w-4" /> Filter Device Sessions
              </Button>
            </Link>

            <div className="h-px w-full bg-border my-2" />

            <Button
              variant="destructive"
              onClick={() => setShowRevokeConfirm(true)}
              className="w-full justify-start gap-2 bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground border-none text-xs"
            >
              <Trash2 className="h-4 w-4" /> Revoke Machine Access
            </Button>
          </div>
        </div>
      </div>

      {/* Revoke Confirmation Modal */}
      {showRevokeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-destructive">
              <AlertTriangle className="h-6 w-6" />
              <h3 className="text-lg font-bold">Revoke Device Access?</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to revoke <strong>{device.friendlyName}</strong>? The gateway tunnel connection will be immediately terminated, and this machine will no longer be able to run agent tasks until re-paired.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRevokeConfirm(false)}
                disabled={revoking}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleRevoke}
                disabled={revoking}
              >
                {revoking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Yes, Revoke Device"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
