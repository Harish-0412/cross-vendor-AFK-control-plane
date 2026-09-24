"use client";

// frontend/app/admin/users/page.tsx
// User management: the full account table with live status and the
// integration matrix, plus the three levels of access control —
// suspend/restore, terminate (cut live access), and destroy (hard delete
// with typed-email confirmation).

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  Ban,
  RotateCcw,
  Power,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import {
  adminApi,
  INTEGRATION_LABELS,
  STATUS_STYLES,
  timeAgo,
  type AdminUser,
  type GrantStatusView,
  type PlatformRole,
  type UserStatus,
} from "@/lib/admin";
import { useAuthStore } from "@/lib/auth";
import { cn } from "@/lib/utils";

const ROLE_STYLES: Record<PlatformRole, string> = {
  owner: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  admin: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  user: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

function Badge({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  typedConfirmation,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
  /** When set, the button stays disabled until the user types this exactly. */
  typedConfirmation?: string;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !typedConfirmation || typed.toLowerCase().trim() === typedConfirmation.toLowerCase();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 p-6">
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-zinc-400">{description}</p>
        {typedConfirmation && (
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={`Type "${typedConfirmation}"`}
            className="mt-4 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-rose-500"
            autoFocus
          />
        )}
        {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Action failed");
              } finally {
                setBusy(false);
              }
            }}
            disabled={!ready || busy}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | UserStatus>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "suspend"; user: AdminUser }
    | { kind: "restore"; user: AdminUser }
    | { kind: "terminate"; user: AdminUser }
    | { kind: "destroy"; user: AdminUser }
    | { kind: "role"; user: AdminUser; role: PlatformRole }
    | null
  >(null);
  const myRole = useAuthStore((s) => s.user?.role);
  const isOwner = myRole === "owner";

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await adminApi.listUsers();
      setUsers(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!users) return [];
    const q = query.toLowerCase().trim();
    return users.filter((u) => {
      if (statusFilter !== "all" && u.status !== statusFilter) return false;
      if (!q) return true;
      return (
        u.email.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.id.toLowerCase().includes(q)
      );
    });
  }, [users, query, statusFilter]);

  async function runAction(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
      setTimeout(() => setError(null), 6000);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-zinc-400">
            {users ? `${users.length} accounts on this Control Plane` : "Loading…"}
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
            placeholder="Search by email, name or id…"
            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-500/50"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm outline-none"
        >
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {!users ? (
        <div className="py-20 text-center text-sm text-zinc-500">Loading users…</div>
      ) : (
        <div className="space-y-4">
          {filtered.map((user) => {
            const busy = busyId === user.id;
            const suspended = user.status === "suspended";
            return (
              <div
                key={user.id}
                className={cn(
                  "rounded-xl border bg-zinc-900/40 p-4",
                  suspended ? "border-rose-500/30" : "border-zinc-800",
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium">{user.name}</p>
                      <Badge className={ROLE_STYLES[user.role]}>{user.role}</Badge>
                      <Badge
                        className={
                          suspended
                            ? "border-rose-500/40 bg-rose-500/15 text-rose-300"
                            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                        }
                      >
                        {user.status}
                      </Badge>
                      {user.onlineDeviceCount > 0 && (
                        <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                          {user.onlineDeviceCount} device{user.onlineDeviceCount > 1 ? "s" : ""} online
                        </Badge>
                      )}
                      {user.activeSessionCount > 0 && (
                        <Badge className="border-sky-500/30 bg-sky-500/10 text-sky-300">
                          {user.activeSessionCount} active session
                          {user.activeSessionCount > 1 ? "s" : ""}
                        </Badge>
                      )}
                      {user.pendingApprovalCount > 0 && (
                        <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-300">
                          {user.pendingApprovalCount} pending approval
                          {user.pendingApprovalCount > 1 ? "s" : ""}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-zinc-400">{user.email}</p>
                    <p className="mt-1 text-xs text-zinc-500">
                      {user.deviceCount} device{user.deviceCount === 1 ? "" : "s"} ·{" "}
                      {user.sessionCount} session{user.sessionCount === 1 ? "" : "s"} · last
                      activity {timeAgo(user.lastActivityAt)} · joined{" "}
                      {new Date(user.createdAt).toLocaleDateString()}
                    </p>
                    {suspended && user.suspendedReason && (
                      <p className="mt-1 text-xs text-rose-400">Reason: {user.suspendedReason}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Role control (owner only) */}
                    {isOwner && user.id !== useAuthStore.getState().user?.id && (
                      <div className="relative">
                        <select
                          value={user.role}
                          disabled={busy}
                          onChange={(e) =>
                            setDialog({
                              kind: "role",
                              user,
                              role: e.target.value as PlatformRole,
                            })
                          }
                          className="appearance-none rounded-lg border border-zinc-700 bg-zinc-950 py-1.5 pl-3 pr-8 text-xs outline-none hover:border-zinc-500"
                        >
                          <option value="user">user</option>
                          <option value="admin">admin</option>
                          <option value="owner">owner</option>
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                      </div>
                    )}

                    {suspended ? (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void runAction(user.id, () =>
                            adminApi.setUserStatus(user.id, "active"),
                          )
                        }
                        className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 disabled:opacity-40"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Restore
                      </button>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => setDialog({ kind: "suspend", user })}
                        className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20 disabled:opacity-40"
                      >
                        <Ban className="h-3.5 w-3.5" /> Suspend
                      </button>
                    )}

                    <button
                      disabled={busy}
                      onClick={() => setDialog({ kind: "terminate", user })}
                      className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                    >
                      <Power className="h-3.5 w-3.5" /> Terminate access
                    </button>

                    <button
                      disabled={busy}
                      onClick={() => setDialog({ kind: "destroy", user })}
                      className="flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20 disabled:opacity-40"
                    >
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                </div>

                {/* Integration matrix */}
                <div className="mt-4 border-t border-zinc-800/70 pt-3">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                    Application connections
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {user.integrations.map((item) => (
                      <Badge
                        key={`${user.id}-${item.integration}`}
                        className={STATUS_STYLES[item.status as GrantStatusView]}
                        title={
                          item.scopes.length > 0 ? `Scopes: ${item.scopes.join(", ")}` : undefined
                        }
                      >
                        {INTEGRATION_LABELS[item.integration] ?? item.integration}
                        {item.status !== "none" ? ` · ${item.status}` : " · not connected"}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-500">No users match this filter.</p>
          )}
        </div>
      )}

      {dialog?.kind === "suspend" && (
        <ConfirmDialog
          title={`Suspend ${dialog.user.email}?`}
          description="They are signed out immediately: devices disconnect, active sessions stop, pending approvals are voided, and login/refresh is refused. Fully reversible via Restore."
          confirmLabel="Suspend account"
          typedConfirmation={dialog.user.email}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await adminApi.setUserStatus(dialog.user.id, "suspended", "Suspended from admin console");
          }}
        />
      )}
      {dialog?.kind === "restore" && (
        <ConfirmDialog
          title={`Restore ${dialog.user.email}?`}
          description="The account returns to active and can sign in again. Devices may need to re-pair if they were revoked."
          confirmLabel="Restore account"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await adminApi.setUserStatus(dialog.user.id, "active");
          }}
        />
      )}
      {dialog?.kind === "terminate" && (
        <ConfirmDialog
          title={`Terminate live access for ${dialog.user.email}?`}
          description="Every device is disconnected, active sessions are cancelled and pending approvals are voided — right now. The account itself is untouched and they can reconnect."
          confirmLabel="Terminate access"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await adminApi.terminateUser(dialog.user.id, "Access terminated from admin console");
          }}
        />
      )}
      {dialog?.kind === "destroy" && (
        <ConfirmDialog
          title={`Permanently delete ${dialog.user.email}?`}
          description="This removes the account and all of its devices. Their audit history stays in the tamper-evident log. This cannot be undone — type the account email to confirm."
          confirmLabel="Delete forever"
          typedConfirmation={dialog.user.email}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await adminApi.destroyUser(dialog.user.id, dialog.user.email);
          }}
        />
      )}
      {dialog?.kind === "role" && (
        <ConfirmDialog
          title={`Change role of ${dialog.user.email} to "${dialog.role}"?`}
          description={
            dialog.role === "user"
              ? "They lose console and governance powers."
              : dialog.role === "admin"
                ? "They gain full console powers: user management, policy, audit and device control."
                : "They gain owner powers, including changing other admins' roles and deleting admins."
          }
          confirmLabel="Change role"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await adminApi.setUserRole(dialog.user.id, dialog.role);
          }}
        />
      )}
    </div>
  );
}
