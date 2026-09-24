"use client";

// Developer Analytics intentionally uses only server-measured values. It is
// an operational view, not product telemetry inferred in the browser.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Coins, RefreshCw, Server, Users, type LucideIcon } from "lucide-react";
import { adminApi, formatDuration, type DeveloperAnalytics } from "@/lib/admin";

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export default function AdminAnalyticsPage() {
  const [analytics, setAnalytics] = useState<DeveloperAnalytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setAnalytics(await adminApi.getAnalytics());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load developer analytics");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const agents = useMemo(
    () =>
      Object.entries(analytics?.usage.byAgent ?? {}).sort(
        ([, a], [, b]) => b.sessions - a.sessions || b.tokens - a.tokens,
      ),
    [analytics],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Developer analytics</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Measured Control Plane activity for the previous 24 hours. Browser activity is not
            counted as user activity.
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

      {!analytics ? (
        <div className="py-20 text-center text-sm text-zinc-500">Loading measured activity…</div>
      ) : (
        <>
          <p className="text-xs text-zinc-500">
            Window: {new Date(analytics.window.startsAt).toLocaleString()} – {new Date(analytics.window.endsAt).toLocaleString()} · refreshed {new Date(analytics.generatedAt).toLocaleTimeString()}
          </p>

          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric icon={Users} label="Active users" value={formatNumber(analytics.activity.activeUsers)} detail={`${analytics.activity.newUsers} new accounts`} />
            <Metric icon={Activity} label="Sessions started" value={formatNumber(analytics.activity.sessionsStarted)} detail={`${analytics.activity.completedSessions} completed · ${analytics.activity.failedSessions} failed`} />
            <Metric icon={Coins} label="Recorded tokens" value={formatNumber(analytics.usage.recordedTokens)} detail={`${formatNumber(analytics.usage.subscriptionTokens)} subscription tokens`} />
            <Metric icon={Server} label="Fleet available" value={`${analytics.service.deviceAvailabilityPercent}%`} detail={`${analytics.service.devicesOnline}/${analytics.service.devicesTotal} devices online`} />
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="text-sm font-semibold">Service posture</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <Row label="Active sessions" value={formatNumber(analytics.activity.activeSessions)} />
                <Row label="Pending approvals" value={formatNumber(analytics.activity.pendingApprovals)} />
                <Row label="Audit chain" value={analytics.service.auditChainValid ? "verified" : "BROKEN"} danger={!analytics.service.auditChainValid} />
                <Row label="Control Plane uptime" value={formatDuration(analytics.service.uptimeSeconds)} />
              </dl>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
              <h2 className="text-sm font-semibold">Usage accounting</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <Row label="Metered cost" value={`$${analytics.usage.meteredCostUsd.toFixed(4)}`} />
                <Row label="Metered + subscription tokens" value={formatNumber(analytics.usage.recordedTokens)} />
                <p className="pt-1 text-xs leading-relaxed text-zinc-500">
                  Subscription tokens intentionally have no estimated dollar price. The cost figure
                  includes only usage records billed as metered.
                </p>
              </dl>
            </div>
          </section>

          <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <h2 className="text-sm font-semibold">Agent activity</h2>
            {agents.length === 0 ? (
              <p className="mt-4 text-sm text-zinc-500">No sessions began in this window.</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-zinc-500">
                    <tr><th className="pb-2">Agent</th><th className="pb-2 text-right">Sessions</th><th className="pb-2 text-right">Session tokens</th></tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800/70">
                    {agents.map(([agent, value]) => (
                      <tr key={agent}>
                        <td className="py-2.5 font-mono text-xs text-zinc-300">{agent}</td>
                        <td className="py-2.5 text-right tabular-nums">{formatNumber(value.sessions)}</td>
                        <td className="py-2.5 text-right tabular-nums">{formatNumber(value.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Metric({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"><Icon className="h-4 w-4 text-emerald-400" /><p className="mt-3 text-2xl font-semibold tabular-nums">{value}</p><p className="mt-1 text-sm text-zinc-300">{label}</p><p className="mt-1 text-xs text-zinc-500">{detail}</p></div>;
}

function Row({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><dt className="text-zinc-500">{label}</dt><dd className={danger ? "font-medium text-rose-300" : "font-medium text-zinc-200"}>{value}</dd></div>;
}
