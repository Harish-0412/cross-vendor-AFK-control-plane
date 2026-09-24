"use client";

// frontend/app/admin/page.tsx
// Admin overview: platform-wide counts, integration adoption, audit-chain
// health and a developer quick-reference of the live subsystems.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Users,
  MonitorSmartphone,
  PlaySquare,
  ShieldAlert,
  ScrollText,
  Server,
  CheckCircle2,
  XCircle,
  Activity,
} from "lucide-react";
import { adminApi, formatDuration, type AdminStats } from "@/lib/admin";
import { cn } from "@/lib/utils";

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const tones = {
    default: "text-zinc-100",
    good: "text-emerald-400",
    warn: "text-amber-400",
    bad: "text-rose-400",
  };
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
        <Icon className="h-4 w-4 text-zinc-600" />
      </div>
      <p className={cn("mt-2 text-2xl font-semibold tabular-nums", tones[tone])}>{value}</p>
      {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
    </div>
  );
}

export default function AdminOverviewPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminApi
      .getStats()
      .then(setStats)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-6 text-sm text-rose-300">
        {error}
      </div>
    );
  }
  if (!stats) {
    return <div className="py-20 text-center text-sm text-zinc-500">Loading overview…</div>;
  }

  const integrationRows = Object.entries(stats.integrations.activeGrants);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin overview</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Everything on this Control Plane, across every user. v{stats.version} · up{" "}
            {formatDuration(stats.uptimeSeconds)}
          </p>
        </div>
        <div
          className={cn(
            "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs",
            stats.audit.chainValid
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : "border-rose-500/40 bg-rose-500/10 text-rose-300",
          )}
        >
          {stats.audit.chainValid ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <XCircle className="h-3.5 w-3.5" />
          )}
          Audit chain {stats.audit.chainValid ? "verified" : "BROKEN"} · {stats.audit.events} events
        </div>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Users"
          value={stats.users.total}
          sub={`${stats.users.active} active · ${stats.users.suspended} suspended · ${stats.users.admins} admins`}
          icon={Users}
        />
        <StatCard
          label="Devices"
          value={stats.devices.total}
          sub={`${stats.devices.online} online now · ${stats.devices.revoked} revoked`}
          icon={MonitorSmartphone}
          tone={stats.devices.online > 0 ? "good" : "default"}
        />
        <StatCard
          label="Active sessions"
          value={stats.sessions.active}
          sub={`${stats.sessions.total} total · ${stats.sessions.failed} failed/crashed`}
          icon={PlaySquare}
        />
        <StatCard
          label="Pending approvals"
          value={stats.approvals.pending}
          sub={`${stats.sessions.waitingForApproval} sessions waiting`}
          icon={ShieldAlert}
          tone={stats.approvals.pending > 0 ? "warn" : "default"}
        />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Integration adoption
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {integrationRows.length === 0 && (
            <p className="col-span-full text-sm text-zinc-500">
              No integrations connected yet on this deployment.
            </p>
          )}
          {integrationRows.map(([integration, count]) => (
            <div
              key={integration}
              className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 text-center"
            >
              <p className="text-xl font-semibold tabular-nums text-zinc-100">{count}</p>
              <p className="mt-1 truncate text-xs capitalize text-zinc-500">
                {integration.replace(/-/g, " ")}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold">Control Plane</h2>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-zinc-500">Version</dt>
              <dd className="font-mono text-xs text-zinc-300">{stats.version}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Uptime</dt>
              <dd className="text-zinc-300">{formatDuration(stats.uptimeSeconds)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Audit chain</dt>
              <dd className={stats.audit.chainValid ? "text-emerald-400" : "text-rose-400"}>
                {stats.audit.chainValid ? "valid" : `broken @ ${stats.audit.events}`}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-zinc-500">Audit events</dt>
              <dd className="tabular-nums text-zinc-300">{stats.audit.events}</dd>
            </div>
          </dl>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold">Quick actions</h2>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <Link
              href="/admin/users"
              className="rounded-lg border border-zinc-800 px-3 py-2 hover:bg-zinc-800/60"
            >
              Manage users
            </Link>
            <Link
              href="/admin/sessions"
              className="rounded-lg border border-zinc-800 px-3 py-2 hover:bg-zinc-800/60"
            >
              Live sessions
            </Link>
            <Link
              href="/admin/integrations"
              className="rounded-lg border border-zinc-800 px-3 py-2 hover:bg-zinc-800/60"
            >
              Integrations
            </Link>
            <Link
              href="/admin/audit"
              className="rounded-lg border border-zinc-800 px-3 py-2 hover:bg-zinc-800/60"
            >
              Audit log
            </Link>
          </div>
          {stats.sessions.waitingForApproval > 0 && (
            <p className="mt-3 text-xs text-amber-400">
              {stats.sessions.waitingForApproval} session(s) are waiting for a human decision.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
