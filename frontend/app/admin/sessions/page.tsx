"use client";

// frontend/app/admin/sessions/page.tsx
// Every agent session across every user, with admin kill capability.

import { useCallback, useEffect, useMemo, useState } from "react";
import { PlaySquare, RefreshCw, Square, Search } from "lucide-react";
import { adminApi, timeAgo, type AdminSession } from "@/lib/admin";
import { useAuthStore } from "@/lib/auth";
import { cn } from "@/lib/utils";

const STATE_STYLES: Record<string, string> = {
  running: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  waiting_for_approval: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  initializing: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  paused: "border-zinc-500/30 bg-zinc-500/10 text-zinc-300",
  completed: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
  failed: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  crashed: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  cancelled: "border-zinc-500/30 bg-zinc-500/10 text-zinc-500",
};

export default function AdminSessionsPage() {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<AdminSession | null>(null);
  const myUserId = useAuthStore((s) => s.user?.id);

  const load = useCallback(async () => {
    try {
      setError(null);
      setSessions(await adminApi.listSessions(500));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const q = query.toLowerCase().trim();
    return sessions.filter((s) => {
      if (stateFilter !== "all" && s.state !== stateFilter) return false;
      if (!q) return true;
      return (
        s.id.toLowerCase().includes(q) ||
        s.userId.toLowerCase().includes(q) ||
        s.agentId.toLowerCase().includes(q)
      );
    });
  }, [sessions, query, stateFilter]);

  async function cancel(session: AdminSession) {
    setBusyId(session.id);
    try {
      await adminApi.cancelSession(session.id, "Cancelled from admin console");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setBusyId(null);
      setConfirmCancel(null);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {sessions
              ? `${sessions.filter((s) => s.state === "running" || s.state === "waiting_for_approval").length} live · ${sessions.length} total`
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

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-56">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by session, user or agent…"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500/50"
          />
        </div>
        <select
          value={stateFilter}
          onChange={(e) => setStateFilter(e.target.value)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm outline-none"
        >
          <option value="all">All states</option>
          <option value="running">Running</option>
          <option value="waiting_for_approval">Waiting for approval</option>
          <option value="initializing">Initializing</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {!sessions ? (
        <div className="py-20 text-center text-sm text-zinc-500">Loading sessions…</div>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-500">No sessions match.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">Session</th>
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filtered.map((session) => {
                const busy = busyId === session.id;
                const active =
                  session.state === "running" ||
                  session.state === "waiting_for_approval" ||
                  session.state === "initializing" ||
                  session.state === "paused";
                return (
                  <tr key={session.id} className="hover:bg-zinc-900/40">
                    <td className="px-4 py-3 font-mono text-xs text-zinc-300">
                      {session.id.slice(0, 18)}…
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">
                      {session.userId === myUserId ? "you" : session.userId.slice(0, 12) + "…"}
                    </td>
                    <td className="px-4 py-3 text-zinc-300">{session.agentId}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full border px-2 py-0.5 text-[11px]",
                          STATE_STYLES[session.state] ?? STATE_STYLES.completed,
                        )}
                      >
                        {session.state.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-400">{timeAgo(session.startedAt)}</td>
                    <td className="px-4 py-3 text-right">
                      {active && (
                        <button
                          disabled={busy}
                          onClick={() => setConfirmCancel(session)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
                        >
                          <Square className="h-3 w-3" /> Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {confirmCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6">
            <h3 className="text-lg font-semibold">Cancel this session?</h3>
            <p className="mt-2 text-sm text-zinc-400">
              The agent process is stopped immediately and pending approvals are voided. Owner:{" "}
              <span className="font-mono text-xs">{confirmCancel.userId}</span>
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setConfirmCancel(null)}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
              >
                Keep running
              </button>
              <button
                onClick={() => void cancel(confirmCancel)}
                disabled={busyId === confirmCancel.id}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-40"
              >
                {busyId === confirmCancel.id ? "Cancelling…" : "Cancel session"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
