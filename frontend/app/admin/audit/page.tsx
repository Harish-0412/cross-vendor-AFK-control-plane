"use client";

// frontend/app/admin/audit/page.tsx
// The tamper-evident audit trail, admin-wide: every recorded action with
// filters and one-click chain verification.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollText, RefreshCw, ShieldCheck, ShieldX } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { timeAgo } from "@/lib/admin";
import { cn } from "@/lib/utils";

interface AuditEventView {
  id: string;
  sequence: number;
  timestamp: string;
  actor: { type: string; id: string };
  sessionId?: string;
  deviceId?: string;
  action: string;
  decision: string;
  policyVersion?: string;
  matchedRules?: string[];
  hash: string;
  previousHash: string;
}

const DECISION_STYLES: Record<string, string> = {
  allow: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  granted: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  deny: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  denied: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  require_approval: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  timeout: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
};

export default function AdminAuditPage() {
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState("all");
  const [chainValid, setChainValid] = useState<boolean | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await apiClient.get<AuditEventView[]>("/api/v1/audit?limit=300");
      setEvents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit log");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!events) return [];
    const q = query.toLowerCase().trim();
    return events.filter((e) => {
      if (decision !== "all" && e.decision !== decision) return false;
      if (!q) return true;
      return (
        e.action.toLowerCase().includes(q) ||
        e.actor.id.toLowerCase().includes(q) ||
        (e.sessionId?.toLowerCase().includes(q) ?? false) ||
        (e.deviceId?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [events, query, decision]);

  async function verifyChain() {
    setVerifying(true);
    try {
      const res = await apiClient.get<{ valid: boolean }>("/api/v1/audit/verify");
      setChainValid(res.valid);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Hash-chained, append-only record of every governed action.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {chainValid !== null && (
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs",
                chainValid
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                  : "border-rose-500/40 bg-rose-500/10 text-rose-300",
              )}
            >
              {chainValid ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
              {chainValid ? "Chain verified" : "Chain BROKEN"}
            </span>
          )}
          <button
            onClick={() => void verifyChain()}
            disabled={verifying}
            className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm hover:bg-zinc-800/60 disabled:opacity-40"
          >
            <ShieldCheck className="h-4 w-4" /> {verifying ? "Verifying…" : "Verify chain"}
          </button>
          <button
            onClick={() => void load()}
            className="flex items-center gap-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm hover:bg-zinc-800/60"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search action, actor, session or device…"
          className="flex-1 min-w-56 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-emerald-500/50"
        />
        <select
          value={decision}
          onChange={(e) => setDecision(e.target.value)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm outline-none"
        >
          <option value="all">All decisions</option>
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
          <option value="require_approval">Require approval</option>
          <option value="granted">Granted</option>
          <option value="denied">Denied</option>
          <option value="timeout">Timeout</option>
        </select>
      </div>

      {!events ? (
        <div className="py-20 text-center text-sm text-zinc-500">Loading audit log…</div>
      ) : filtered.length === 0 ? (
        <p className="py-10 text-center text-sm text-zinc-500">No audit events match.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Actor</th>
                <th className="px-4 py-3">Decision</th>
                <th className="px-4 py-3">Hash</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/70">
              {filtered.map((event) => (
                <tr key={event.id} className="hover:bg-zinc-900/40">
                  <td className="px-4 py-2.5 text-xs tabular-nums text-zinc-500">
                    {event.sequence}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-zinc-400">{timeAgo(event.timestamp)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-zinc-200">{event.action}</td>
                  <td className="px-4 py-2.5 text-xs text-zinc-400">
                    {event.actor.type}
                    <span className="ml-1 font-mono text-zinc-500">
                      {event.actor.id.slice(0, 10)}…
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "inline-flex rounded-full border px-2 py-0.5 text-[11px]",
                        DECISION_STYLES[event.decision] ?? DECISION_STYLES.timeout,
                      )}
                    >
                      {event.decision.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[10px] text-zinc-600">
                    {event.hash.slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
