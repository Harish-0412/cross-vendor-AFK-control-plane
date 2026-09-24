"use client";

// frontend/app/admin/integrations/page.tsx
// Who has connected what. One row per user, one badge per integration —
// including the ones they have NOT connected, so an admin can see coverage
// at a glance and act from the Users page.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plug, RefreshCw, Search } from "lucide-react";
import {
  adminApi,
  INTEGRATION_LABELS,
  STATUS_STYLES,
  timeAgo,
  type AdminUser,
  type GrantStatusView,
} from "@/lib/admin";
import { cn } from "@/lib/utils";

const INTEGRATION_ORDER = ["github", "antigravity", "claude", "codex", "chatgpt-export", "openai-org"];

export default function AdminIntegrationsPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<"all" | "connected" | "disconnected">("all");

  const load = useCallback(async () => {
    try {
      setError(null);
      setUsers(await adminApi.listUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load integration status");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = query.toLowerCase().trim();
    return users.filter((u) => {
      const connected = u.integrations.filter((i) => i.status === "active").length;
      if (only === "connected" && connected === 0) return false;
      if (only === "disconnected" && connected > 0) return false;
      if (!q) return true;
      return u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q);
    });
  }, [users, query, only]);

  const totals = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const user of users ?? []) {
      for (const item of user.integrations) {
        if (item.status === "active") {
          counts[item.integration] = (counts[item.integration] ?? 0) + 1;
        }
      }
    }
    return counts;
  }, [users]);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Connection status of every application, per user. Grant changes happen on the
            workstation — this is the control-plane view.
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

      {/* Adoption summary */}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {INTEGRATION_ORDER.map((integration) => (
          <div
            key={integration}
            className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-center"
          >
            <p className="text-lg font-semibold tabular-nums">{totals[integration] ?? 0}</p>
            <p className="truncate text-[11px] text-zinc-500">
              {INTEGRATION_LABELS[integration] ?? integration}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-56">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search users…"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500/50"
          />
        </div>
        <select
          value={only}
          onChange={(e) => setOnly(e.target.value as typeof only)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm outline-none"
        >
          <option value="all">All users</option>
          <option value="connected">With connections</option>
          <option value="disconnected">Without connections</option>
        </select>
      </div>

      {!users ? (
        <div className="py-20 text-center text-sm text-zinc-500">Loading…</div>
      ) : (
        <div className="space-y-3">
          {filtered.map((user) => (
            <div key={user.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{user.name}</p>
                  <p className="text-xs text-zinc-500">
                    {user.email} · last activity {timeAgo(user.lastActivityAt)}
                  </p>
                </div>
                <p className="text-xs text-zinc-400">
                  {user.integrations.filter((i) => i.status === "active").length} /{" "}
                  {user.integrations.length} connected
                </p>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {user.integrations.map((item) => (
                  <span
                    key={`${user.id}-${item.integration}`}
                    title={item.scopes.length > 0 ? `Scopes: ${item.scopes.join(", ")}` : undefined}
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      STATUS_STYLES[item.status as GrantStatusView],
                    )}
                  >
                    {INTEGRATION_LABELS[item.integration] ?? item.integration}
                    {item.status !== "none" ? ` · ${item.status}` : " · not connected"}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">No users match.</p>
          )}
        </div>
      )}
    </div>
  );
}
