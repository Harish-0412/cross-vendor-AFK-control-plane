"use client";

// frontend/app/admin/layout.tsx
// Admin console shell: access guard + sidebar navigation.
//
// The guard is client-side UX only. Real authorization happens on the
// Control Plane, which re-reads the caller's role from the database on
// every /api/v1/admin/* request — a tampered client gets styled 403s,
// never data.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuthStore } from "@/lib/auth";
import {
  LayoutDashboard,
  Users,
  MonitorSmartphone,
  PlaySquare,
  Plug,
  Activity,
  ScrollText,
  ArrowLeft,
  ShieldCheck,
  ShieldX,
  ShieldQuestion,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { adminApi, isAdminApiError } from "@/lib/admin";

const NAV = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/devices", label: "Devices", icon: MonitorSmartphone },
  { href: "/admin/sessions", label: "Sessions", icon: PlaySquare },
  { href: "/admin/integrations", label: "Integrations", icon: Plug },
  { href: "/admin/analytics", label: "Developer Analytics", icon: Activity },
  { href: "/admin/system", label: "System Health", icon: Activity },
  { href: "/admin/audit", label: "Audit Log", icon: ScrollText },
];

type GuardState = "checking" | "allowed" | "denied" | "error";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAuthenticated, isInitialized, user, checkAuth } = useAuthStore();
  const [guard, setGuard] = useState<GuardState>("checking");
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function verify() {
      // Make sure a session exists (silent refresh on cold load).
      if (!useAuthStore.getState().isAuthenticated) {
        await useAuthStore.getState().checkAuth();
      }
      try {
        // Firebase custom claims only take effect after an ID-token refresh.
        // This is intentionally done before the privileged probe, so someone
        // just granted owner/admin in Firebase Console does not have to clear
        // browser storage or wait for the normal token rotation interval.
        await useAuthStore.getState().refreshFirebaseRole();

        // Use the app's authenticated client. A raw fetch only sent the
        // control-plane refresh cookie, never Firebase's in-memory bearer
        // token, so Firebase administrators were denied on every cold load.
        await adminApi.getStats();
        if (cancelled) return;
        setRole(useAuthStore.getState().user?.role ?? "admin");
        setGuard("allowed");
      } catch (err) {
        if (cancelled) return;
        if (isAdminApiError(err, 401) || isAdminApiError(err, 403)) {
          setGuard("denied");
        } else {
          setGuard("error");
        }
      }
    }
    void verify();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wait for auth init before concluding anything.
  useEffect(() => {
    if (isInitialized && guard === "checking" && !isAuthenticated) {
      setGuard("denied");
    }
  }, [isInitialized, isAuthenticated, guard]);

  if (guard === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
        <div className="flex flex-col items-center gap-3">
          <ShieldQuestion className="h-8 w-8 animate-pulse" />
          <p className="text-sm">Verifying access…</p>
        </div>
      </div>
    );
  }

  if (guard === "denied") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-200">
        <div className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-rose-500/5 p-8 text-center">
          <ShieldX className="mx-auto h-10 w-10 text-rose-400" />
          <h1 className="mt-4 text-xl font-semibold">Access denied</h1>
          <p className="mt-2 text-sm text-zinc-400">
            {isAuthenticated
              ? "Your account does not have admin or owner privileges on this Control Plane."
              : "Sign in with an administrator account to open the admin console."}
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
            >
              Back to app
            </Link>
            {!isAuthenticated && (
              <Link
                href="/login?redirect=/admin"
                className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (guard === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 text-zinc-200">
        <div className="w-full max-w-md rounded-2xl border border-amber-500/30 bg-amber-500/5 p-8 text-center">
          <ShieldQuestion className="mx-auto h-10 w-10 text-amber-400" />
          <h1 className="mt-4 text-xl font-semibold">Control Plane unreachable</h1>
          <p className="mt-2 text-sm text-zinc-400">
            The admin console could not verify your role. The server may be waking up — free
            hosting sleeps when idle. Wait a few seconds and reload.
          </p>
          <button
            onClick={() => {
              setGuard("checking");
              window.location.reload();
            }}
            className="mt-6 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-zinc-800 bg-zinc-900/50 lg:flex">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-4">
          <ShieldCheck className="h-6 w-6 text-emerald-400" />
          <div>
            <p className="text-sm font-semibold tracking-tight">Odysseus Admin</p>
            <p className="text-[11px] text-zinc-500">Control Plane console</p>
          </div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
          {NAV.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-emerald-500/10 text-emerald-300"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-zinc-800 p-4">
          <div className="mb-3 text-xs text-zinc-500">
            Signed in as
            <div className="truncate text-zinc-300">{user?.email ?? "…"}</div>
            {role && <span className="text-emerald-400">· {role}</span>}
          </div>
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Control Center
          </Link>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-20 flex items-center gap-2 overflow-x-auto border-b border-zinc-800 bg-zinc-900/80 px-4 py-3 backdrop-blur lg:hidden">
        <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "whitespace-nowrap rounded-full px-3 py-1.5 text-xs",
                active ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-400",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* Content */}
      <main className="min-w-0 flex-1 px-4 pb-10 pt-16 lg:pl-64 lg:pr-8 lg:pt-8">{children}</main>
    </div>
  );
}
