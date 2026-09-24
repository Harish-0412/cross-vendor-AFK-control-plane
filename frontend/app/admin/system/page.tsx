"use client";

// frontend/app/admin/system/page.tsx
// Developer-facing health view: control-plane vitals, audit-chain integrity,
// session outcome rates and the deployment posture of the two services.

import { useCallback, useEffect, useState } from "react";
import { Activity, CheckCircle2, RefreshCw, Server, XCircle, Globe, Database } from "lucide-react";
import { adminApi, formatDuration, type AdminStats } from "@/lib/admin";
import { cn } from "@/lib/utils";

interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export default function AdminSystemPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiLatencyMs, setApiLatencyMs] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const started = performance.now();
      const data = await adminApi.getStats();
      setApiLatencyMs(Math.round(performance.now() - started));
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load system stats");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="mx-auto max-w-4xl rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-sm text-rose-300">
        {error}
      </div>
    );
  }
  if (!stats) {
    return <div className="py-20 text-center text-sm text-zinc-500">Running health checks…</div>;
  }

  const failureRate =
    stats.sessions.total > 0
      ? Math.round((stats.sessions.failed / stats.sessions.total) * 100)
      : 0;

  const checks: HealthCheck[] = [
    {
      name: "API reachable",
      status: "ok",
      detail: `Admin stats responded in ${apiLatencyMs ?? "—"} ms`,
    },
    {
      name: "Audit hash chain",
      status: stats.audit.chainValid ? "ok" : "fail",
      detail: stats.audit.chainValid
        ? `${stats.audit.events} events, genesis→head intact`
        : "TAMPERING DETECTED — investigate immediately",
    },
    {
      name: "Session outcomes",
      status: failureRate > 25 ? "warn" : "ok",
      detail: `${stats.sessions.failed} failed/crashed of ${stats.sessions.total} (${failureRate}%)`,
    },
    {
      name: "Device fleet",
      status: stats.devices.online > 0 ? "ok" : "warn",
      detail: `${stats.devices.online}/${stats.devices.total} online · ${stats.devices.revoked} revoked`,
    },
    {
      name: "Approval backlog",
      status: stats.approvals.pending > 10 ? "warn" : "ok",
      detail: `${stats.approvals.pending} pending decisions`,
    },
    {
      name: "Account health",
      status: stats.users.suspended > 0 ? "warn" : "ok",
      detail: `${stats.users.suspended} suspended · ${stats.users.active} active`,
    },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System health</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Live posture of the Odysseus Control Plane and its dependents.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm hover:bg-zinc-800/60"
        >
          <RefreshCw className="h-4 w-4" /> Re-run checks
        </button>
      </header>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-zinc-500" />
          <h2 className="text-sm font-semibold">Checks</h2>
        </div>
        <div className="mt-4 space-y-2">
          {checks.map((check) => (
            <div
              key={check.name}
              className="flex items-center justify-between gap-4 rounded-lg border border-zinc-800/70 px-3 py-2.5"
            >
              <div className="flex items-center gap-3">
                {check.status === "ok" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                ) : check.status === "warn" ? (
                  <Activity className="h-4 w-4 shrink-0 text-amber-400" />
                ) : (
                  <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
                )}
                <span className="text-sm font-medium">{check.name}</span>
              </div>
              <span
                className={cn(
                  "text-right text-xs",
                  check.status === "ok"
                    ? "text-zinc-400"
                    : check.status === "warn"
                      ? "text-amber-300"
                      : "text-rose-300",
                )}
              >
                {check.detail}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold">Control Plane</h2>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Version</dt>
              <dd className="font-mono text-xs">{stats.version}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Uptime</dt>
              <dd>{formatDuration(stats.uptimeSeconds)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">REST latency (this page)</dt>
              <dd>{apiLatencyMs ?? "—"} ms</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Audit events</dt>
              <dd className="tabular-nums">{stats.audit.events}</dd>
            </div>
          </dl>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold">Deployment</h2>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Frontend</dt>
              <dd className="text-xs">Vercel (this site)</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">API host</dt>
              <dd className="text-xs">
                {process.env.NEXT_PUBLIC_API_PROXY === "true"
                  ? "proxied same-origin"
                  : "direct / onrender.com"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Tunnel endpoint</dt>
              <dd className="text-xs font-mono">wss → control plane</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Integrations active</dt>
              <dd className="tabular-nums">
                {Object.values(stats.integrations.activeGrants).reduce((a, b) => a + b, 0)}
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}
