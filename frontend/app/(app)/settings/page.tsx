"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import {
  Shield,
  User as UserIcon,
  Mail,
  Monitor,
  KeyRound,
  Pencil,
  Check,
  Loader2,
  LogOut,
  Wifi,
  WifiOff,
  Save,
  X,
  RefreshCw,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient, ApiError } from "@/lib/api-client";
import { useAuthStore } from "@/lib/auth";
import { realtimeClient } from "@/lib/realtime";
import { toast } from "sonner";
import {
  enablePushNotifications,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/push";

interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    createdAt: string;
  };
  deviceCount: number;
  connectedDeviceCount: number;
}

interface SettingsDevice {
  id: string;
  friendlyName: string;
  platform: string;
  status: string;
  online: boolean;
  lastSeenAt: string | null;
  defaultTrustProfile: string;
  createdAt: string;
}

const TRUST_PROFILES = [
  { value: "default", label: "Default", desc: "Standard supervised autonomy" },
  { value: "supervised", label: "Supervised", desc: "Extra approval checkpoints" },
  { value: "trusted-afk", label: "Trusted AFK", desc: "Full autonomy for long runs" },
  { value: "read-only", label: "Read-only", desc: "Inspect code, no mutations" },
  { value: "locked", label: "Locked", desc: "Require approval for everything" },
];

export default function SettingsPage() {
  const { user, logout } = useAuthStore();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [devices, setDevices] = useState<SettingsDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingDeviceId, setSavingDeviceId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const fetchAll = useCallback(async () => {
    try {
      const [meData, devData] = await Promise.all([
        apiClient.get<MeResponse>("/api/v1/auth/me").catch(() => null),
        apiClient.get<SettingsDevice[]>("/api/v1/devices").catch(() => []),
      ]);
      if (meData) setMe(meData);
      setDevices(devData || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const handleChangeTrustProfile = async (deviceId: string, profile: string) => {
    setSavingDeviceId(deviceId);
    try {
      await apiClient.patch(`/api/v1/devices/${deviceId}`, {
        defaultTrustProfile: profile,
      });
      setDevices((prev) =>
        prev.map((d) => (d.id === deviceId ? { ...d, defaultTrustProfile: profile } : d)),
      );
      toast.success("Trust profile updated");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to update trust profile";
      toast.error(msg);
    } finally {
      setSavingDeviceId(null);
    }
  };

  const handleRename = async (deviceId: string) => {
    const name = renameValue.trim();
    if (!name) return;
    setSavingDeviceId(deviceId);
    try {
      await apiClient.patch(`/api/v1/devices/${deviceId}`, { friendlyName: name });
      setDevices((prev) =>
        prev.map((d) => (d.id === deviceId ? { ...d, friendlyName: name } : d)),
      );
      setRenamingId(null);
      setRenameValue("");
      toast.success("Device renamed");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to rename device";
      toast.error(msg);
    } finally {
      setSavingDeviceId(null);
    }
  };

  const handleLogout = async () => {
    realtimeClient.disconnect();
    await unsubscribeFromPush();
    await logout();
    window.location.href = "/login";
  };

  // Phase 7.3 — Web Push notifications
  const pushSupported = isPushSupported();
  const [pushState, setPushState] = useState<{
    enabled: boolean;
    busy: boolean;
    unsupported: boolean;
    permission: string;
  }>({
    enabled: false,
    busy: false,
    unsupported: !pushSupported,
    permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
  });

  useEffect(() => {
    // On mount: if already granted, silently re-sync the subscription.
    if (pushSupported && typeof Notification !== "undefined" && Notification.permission === "granted") {
      void subscribeToPush().then((ok) =>
        setPushState((s) => ({ ...s, enabled: ok || s.enabled })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEnablePush = async () => {
    if (pushState.busy) return;
    setPushState((s) => ({ ...s, busy: true }));
    const result = await enablePushNotifications();
    setPushState((s) => ({
      ...s,
      busy: false,
      enabled: result === "granted",
      permission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
    }));
    if (result === "granted") {
      toast.success("Push notifications enabled — AFK alerts will arrive here");
    } else if (result === "denied") {
      toast.error("Permission denied — enable notifications in your browser settings");
    } else if (result === "unsupported") {
      toast.error("Push not supported — set NEXT_PUBLIC_VAPID_PUBLIC_KEY and use HTTPS/localhost");
    } else {
      toast.error("Could not subscribe — check the control plane VAPID configuration");
    }
  };

  const handleDisablePush = async () => {
    setPushState((s) => ({ ...s, busy: true }));
    await unsubscribeFromPush();
    setPushState((s) => ({ ...s, busy: false, enabled: false }));
    toast.info("Push notifications disabled");
  };

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your profile, account, and per-device trust policies.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchAll}
          className="gap-1.5 text-xs self-start sm:self-auto"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Profile column */}
        <div className="flex flex-col gap-4 lg:sticky lg:top-24">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05 }}
            className="rounded-2xl border border-border bg-card p-6 shadow-sm"
          >
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                <UserIcon className="h-7 w-7" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="font-semibold text-foreground truncate">
                  {me?.user?.name || user?.name || "Operator"}
                </span>
                <span className="text-xs text-muted-foreground truncate flex items-center gap-1">
                  <Mail className="h-3 w-3" />
                  {me?.user?.email || user?.email}
                </span>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1 rounded-xl bg-muted/40 border border-border/50 p-3">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Role
                </span>
                <span className="text-sm font-semibold capitalize text-foreground">
                  {me?.user?.role || user?.role || "user"}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-xl bg-muted/40 border border-border/50 p-3">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Member Since
                </span>
                <span className="text-sm font-semibold text-foreground">
                  {me?.user?.createdAt ? new Date(me.user.createdAt).toLocaleDateString() : "—"}
                </span>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-between rounded-xl border border-border bg-background p-3">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  Connected Devices
                </span>
                <span className="text-lg font-bold font-mono text-foreground">
                  {me?.connectedDeviceCount ?? 0} / {me?.deviceCount ?? 0}
                </span>
              </div>
              <Wifi className="h-5 w-5 text-emerald-500" />
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleLogout}
              className="mt-4 w-full gap-1.5 text-xs text-muted-foreground hover:text-destructive"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign Out
            </Button>
          </motion.div>

          {/* Security card */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="rounded-2xl border border-border bg-card p-6 shadow-sm"
          >
            <div className="flex items-center gap-2 mb-4">
              <Shield className="h-4 w-4 text-primary" />
              <h2 className="text-base font-semibold tracking-tight">Security</h2>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Every gateway connection is authenticated with a device certificate and paired via
              out-of-band fingerprint confirmation. Revoke a machine at any time from the devices
              page to immediately sever its tunnel.
            </p>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
              <KeyRound className="h-3.5 w-3.5 text-amber-500" />
              Audit trail is hash-chained and verifiable.
            </div>
          </motion.div>
        </div>

        {/* Devices / trust profiles */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="rounded-2xl border border-border bg-card p-6 shadow-sm"
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-base font-semibold tracking-tight">Device Trust Profiles</h2>
              <Link href="/devices">
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground">
                  Manage devices
                </Button>
              </Link>
            </div>
            <p className="text-xs text-muted-foreground mb-5">
              Set the default autonomy level applied to new agent sessions on each machine.
            </p>

            {devices.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border p-10 text-center">
                <Monitor className="h-8 w-8 text-muted-foreground mb-2" />
                <p className="text-xs text-muted-foreground">
                  No devices paired yet. Pair a gateway machine to manage its trust profile.
                </p>
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-border">
                {devices.map((device) => (
                  <div key={device.id} className="py-4 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-foreground/70">
                          <Monitor className="h-4 w-4" />
                        </div>
                        <div className="flex flex-col">
                          {renamingId === device.id ? (
                            <div className="flex items-center gap-2">
                              <Input
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                className="h-7 w-48 text-xs"
                                autoFocus
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void handleRename(device.id);
                                  if (e.key === "Escape") setRenamingId(null);
                                }}
                              />
                              <button
                                onClick={() => void handleRename(device.id)}
                                className="text-emerald-500 hover:text-emerald-400 transition-colors"
                                title="Save name"
                              >
                                <Check className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => setRenamingId(null)}
                                className="text-muted-foreground hover:text-foreground transition-colors"
                              >
                                <X className="h-4 w-4" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm text-foreground">
                                {device.friendlyName}
                              </span>
                              <button
                                onClick={() => {
                                  setRenamingId(device.id);
                                  setRenameValue(device.friendlyName);
                                }}
                                className="text-muted-foreground hover:text-primary transition-colors"
                                title="Rename device"
                              >
                                <Pencil className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                          <span className="text-[11px] font-mono text-muted-foreground">
                            {device.id}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span
                          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border ${
                            device.online
                              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                              : "bg-muted text-muted-foreground border-border"
                          }`}
                        >
                          {device.online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                          {device.online ? "Online" : "Offline"}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-col gap-2">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                        Default trust profile
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {TRUST_PROFILES.map((p) => {
                          const active = device.defaultTrustProfile === p.value;
                          return (
                            <button
                              key={p.value}
                              onClick={() => void handleChangeTrustProfile(device.id, p.value)}
                              disabled={savingDeviceId === device.id}
                              className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${
                                active
                                  ? "border-primary bg-primary/10 text-primary shadow-sm"
                                  : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground"
                              } ${savingDeviceId === device.id ? "opacity-60 cursor-wait" : "cursor-pointer"}`}
                              title={p.desc}
                            >
                              {active && <Check className="h-3 w-3" />}
                              {p.label}
                            </button>
                          );
                        })}
                        {savingDeviceId === device.id && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary self-center" />
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {TRUST_PROFILES.find((p) => p.value === device.defaultTrustProfile)?.desc}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>

          {/* Phase 7.3 — Push notifications */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.12 }}
            className="rounded-2xl border border-border bg-card p-6 shadow-sm"
          >
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-base font-semibold tracking-tight">Push Notifications</h2>
              <span
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold border ${
                  pushState.enabled
                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                    : "bg-muted text-muted-foreground border-border"
                }`}
              >
                {pushState.enabled ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Active
                  </>
                ) : (
                  "Off"
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
              Get AFK alerts as real push notifications — approval requests, critical policy
              blocks, and completed-task summaries arrive even when this tab is closed
              (Phase 7 §2.6, Web Push / VAPID).
            </p>

            {pushState.unsupported ? (
              <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border bg-muted/30 p-4">
                <p className="text-xs text-muted-foreground">
                  Push is not available in this environment. Set{" "}
                  <code className="font-mono text-[10px] bg-muted px-1 py-0.5 rounded">
                    NEXT_PUBLIC_VAPID_PUBLIC_KEY
                  </code>{" "}
                  and serve the app over HTTPS or localhost.
                </p>
              </div>
            ) : pushState.enabled ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleDisablePush()}
                disabled={pushState.busy}
                className="gap-1.5 text-xs"
              >
                {pushState.busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                Disable Push
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => void handleEnablePush()}
                disabled={pushState.busy}
                className="gap-1.5 text-xs"
              >
                {pushState.busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Bell className="h-3.5 w-3.5" />
                )}
                Enable Push Notifications
              </Button>
            )}
          </motion.div>

          {/* Account actions */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
            className="rounded-2xl border border-border bg-card p-6 shadow-sm"
          >
            <h2 className="text-base font-semibold tracking-tight mb-1">Danger Zone</h2>
            <p className="text-xs text-muted-foreground mb-4">
              Actions that affect access to your infrastructure.
            </p>
            <div className="flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/5 p-4">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">Sign out of this device</span>
                <span className="text-xs text-muted-foreground">
                  Terminates the live control-plane connection on this browser.
                </span>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleLogout}
                className="gap-1.5 text-xs"
              >
                <Save className="h-3.5 w-3.5" /> Sign Out
              </Button>
            </div>
          </motion.div>
        </div>
      </div>
    </div>
  );
}