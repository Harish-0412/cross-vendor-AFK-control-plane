"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { OctagonAlert, Lock, Loader2, CheckCircle2 } from "lucide-react";
import { apiClient, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

/**
 * Phase 7 §2.5 — the kill switch belongs in persistent chrome, visible from
 * every screen. This component lives in the app Header:
 *  - "STOP ALL" fans out POST /devices/:id/kill-switch for every device with
 *    active sessions (cancels them).
 *  - "LOCK ALL" fans out POST /devices/:id/lock (observation-only).
 * Both are ownership-checked and audited server-side (§7.6).
 */

interface KillSwitchDevice {
  id: string;
  friendlyName: string;
  online: boolean;
  activeSessionCount: number;
}

interface KillSwitchResult {
  deviceId: string;
  friendlyName: string;
  sessions: Array<{ sessionId: string; state: string }>;
}

export function KillSwitch() {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<KillSwitchDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"kill" | "lock" | null>(null);
  const [done, setDone] = useState<{ action: "kill" | "lock"; devices: number; sessions: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const activeTotal = devices.reduce((acc, d) => acc + d.activeSessionCount, 0);

  const fetchDevices = async () => {
    try {
      const data = await apiClient.get<KillSwitchDevice[]>("/api/v1/devices");
      setDevices(data || []);
    } catch {
      /* header must never crash */
    }
  };

  useEffect(() => {
    if (!open) return;
    void fetchDevices();
    const interval = setInterval(fetchDevices, 10_000);
    return () => clearInterval(interval);
  }, [open]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const runAction = async (action: "kill" | "lock") => {
    if (busy) return;
    setBusy(action);
    try {
      const targets = devices.filter((d) => d.activeSessionCount > 0);
      if (targets.length === 0) {
        toast.info("No active sessions to stop");
        setBusy(null);
        return;
      }
      const results = await Promise.all(
        targets.map(async (d) => {
          const res = await apiClient.post<KillSwitchResult>(
            `/api/v1/devices/${d.id}/${action === "kill" ? "kill-switch" : "lock"}`,
            { reason: action === "kill" ? "STOP ALL pressed from app chrome" : "LOCK ALL pressed from app chrome" },
          );
          return { deviceId: d.id, friendlyName: d.friendlyName, sessions: res?.sessions ?? [] };
        }),
      );
      const sessionCount = results.reduce((acc, r) => acc + r.sessions.length, 0);
      setDone({ action, devices: results.length, sessions: sessionCount });
      toast.success(
        action === "kill"
          ? `Kill switch: ${sessionCount} session${sessionCount === 1 ? "" : "s"} cancelled across ${results.length} device${results.length === 1 ? "" : "s"}`
          : `Locked ${sessionCount} session${sessionCount === 1 ? "" : "s"} to observation-only`,
      );
      void fetchDevices();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Action failed";
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`relative flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-semibold transition-all duration-200 ${
          activeTotal > 0
            ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 hover:shadow-md hover:shadow-red-500/10"
            : "border-border bg-card text-muted-foreground hover:text-foreground"
        }`}
        title="Emergency stop controls"
      >
        <OctagonAlert className={`h-3.5 w-3.5 ${activeTotal > 0 ? "animate-pulse" : ""}`} />
        <span className="hidden sm:inline">STOP ALL</span>
        {activeTotal > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {activeTotal}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full mt-2 z-50 w-80 rounded-2xl border border-border bg-card p-4 shadow-2xl shadow-black/10"
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-bold tracking-tight text-foreground">Emergency Controls</h3>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Phase 7 §2.5
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-3">
              {activeTotal > 0
                ? `${activeTotal} active session${activeTotal === 1 ? "" : "s"} across ${devices.filter((d) => d.activeSessionCount > 0).length} device${devices.filter((d) => d.activeSessionCount > 0).length === 1 ? "" : "s"}.`
                : "No active sessions. Controls are armed and ready."}
            </p>

            {loading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning devices…
              </div>
            )}

            <div className="max-h-44 overflow-y-auto mb-3 space-y-1.5">
              {devices.map((d) => (
                <div
                  key={d.id}
                  className={`flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${
                    d.activeSessionCount > 0
                      ? "border-red-500/20 bg-red-500/5"
                      : "border-border/60 bg-background opacity-60"
                  }`}
                >
                  <span className="font-medium text-foreground truncate">{d.friendlyName}</span>
                  <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground shrink-0">
                    <span className={`h-1.5 w-1.5 rounded-full ${d.online ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                    {d.activeSessionCount} act.
                  </span>
                </div>
              ))}
              {devices.length === 0 && !loading && (
                <p className="text-xs text-muted-foreground py-2 text-center">No devices paired.</p>
              )}
            </div>

            {done && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                {done.action === "kill"
                  ? `Kill switch complete — ${done.sessions} session${done.sessions === 1 ? "" : "s"} cancelled on ${done.devices} device${done.devices === 1 ? "" : "s"}.`
                  : `Locked ${done.sessions} session${done.sessions === 1 ? "" : "s"} to observation-only. Pending approvals superseded.`}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={() => void runAction("kill")}
                disabled={busy !== null || activeTotal === 0}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-500 px-3 py-2 text-xs font-bold text-white transition-all hover:bg-red-600 hover:shadow-md hover:shadow-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy === "kill" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <OctagonAlert className="h-3.5 w-3.5" />}
                STOP ALL
              </button>
              <button
                onClick={() => void runAction("lock")}
                disabled={busy !== null || activeTotal === 0}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-600 dark:text-amber-400 transition-all hover:bg-amber-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busy === "lock" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Lock className="h-3.5 w-3.5" />}
                LOCK ALL
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}