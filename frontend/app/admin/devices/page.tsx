"use client";

// frontend/app/admin/devices/page.tsx
// Every paired device across every user, with live online state.

import { useCallback, useEffect, useState } from "react";
import { MonitorSmartphone, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { adminApi, timeAgo, type AdminDevice } from "@/lib/admin";
import { cn } from "@/lib/utils";

export default function AdminDevicesPage() {
  const [devices, setDevices] = useState<AdminDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setDevices(await adminApi.listDevices());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load devices");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Devices</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {devices
              ? `${devices.filter((d) => d.online).length} online · ${devices.length} total`
              : "Loading…"}
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm hover:bg-zinc-800/60"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </header>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {!devices ? (
        <div className="py-20 text-center text-sm text-zinc-500">Loading devices…</div>
      ) : devices.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-500">No devices paired yet.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {devices.map((device) => (
            <div
              key={device.id}
              className={cn(
                "rounded-xl border bg-zinc-900/40 p-4",
                device.online ? "border-emerald-500/30" : "border-zinc-800",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <MonitorSmartphone className="h-5 w-5 text-zinc-500" />
                  <div>
                    <p className="font-medium">{device.friendlyName}</p>
                    <p className="text-xs text-zinc-500">
                      {device.platform} · {device.id}
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
                    device.online
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                      : "border-zinc-700 bg-zinc-800/60 text-zinc-400",
                  )}
                >
                  {device.online ? (
                    <Wifi className="h-3 w-3" />
                  ) : (
                    <WifiOff className="h-3 w-3" />
                  )}
                  {device.online ? "online" : "offline"}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-zinc-500">Owner</dt>
                <dd className="truncate font-mono text-zinc-300">{device.userId}</dd>
                <dt className="text-zinc-500">Status</dt>
                <dd className="text-zinc-300">{device.status}</dd>
                <dt className="text-zinc-500">Trust profile</dt>
                <dd className="text-zinc-300">{device.defaultTrustProfile}</dd>
                <dt className="text-zinc-500">Last seen</dt>
                <dd className="text-zinc-300">{timeAgo(device.lastSeenAt)}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
