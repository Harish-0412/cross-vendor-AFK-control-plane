"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronRight,
  LogOut,
  Moon,
  Sparkles,
  Sun,
  WifiOff,
} from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import { useAuthStore } from "@/lib/auth";
import { realtimeClient, useRealtimeStore } from "@/lib/realtime";
import { KillSwitch } from "@/components/layout/KillSwitch";

const routeNames: Record<string, string> = {
  dashboard: "Overview",
  devices: "Connected machines",
  sessions: "Live sessions",
  history: "Conversation history",
  approvals: "Approvals",
  projects: "Projects",
  integrations: "AI integrations",
  organization: "Organization",
  budgets: "Budgets",
  routing: "Agent routing",
  audit: "Audit log",
  policy: "Policy",
  settings: "Settings",
};

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const status = useRealtimeStore((state) => state.status);
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 6);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const currentSection = useMemo(() => {
    const segment = pathname.split("/").filter(Boolean)[0] ?? "dashboard";
    return routeNames[segment] ?? "Workspace";
  }, [pathname]);

  const handleLogout = async () => {
    realtimeClient.disconnect();
    await logout();
    router.push("/login");
  };

  const isDark = (resolvedTheme || theme) === "dark";

  return (
    <header
      className={`sticky top-0 z-40 flex h-[76px] w-full items-center justify-between border-b px-4 backdrop-blur-xl transition-all sm:px-6 lg:px-8 ${
        scrolled
          ? "border-slate-200/80 bg-background/90 shadow-sm dark:border-white/[0.07]"
          : "border-slate-200/60 bg-background/75 dark:border-white/[0.05]"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 lg:hidden">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-600 to-indigo-700 text-white">
              <Sparkles className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold">Odysseus</span>
          </Link>
        </div>
        <div className="hidden items-center gap-2 lg:flex">
          <span className="text-xs font-medium text-muted-foreground">
            Control plane
          </span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
          <span className="truncate text-sm font-semibold text-foreground">
            {currentSection}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        <KillSwitch />

        <div
          className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold ${
            status === "connected"
              ? "border-emerald-500/20 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300"
              : status === "offline"
                ? "border-red-500/20 bg-red-500/[0.07] text-red-700 dark:text-red-300"
                : "border-amber-500/20 bg-amber-500/[0.08] text-amber-700 dark:text-amber-300"
          }`}
          title={
            status === "connected"
              ? "Authenticated live updates are active"
              : "Live updates are not currently connected"
          }
        >
          {status === "offline" ? (
            <WifiOff className="h-3.5 w-3.5" />
          ) : (
            <span className="relative flex h-2 w-2">
              {status === "connected" && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full ${status === "connected" ? "bg-emerald-500" : "bg-amber-500"}`}
              />
            </span>
          )}
          <span className="hidden sm:inline">
            {status === "connected"
              ? "Live sync"
              : status === "offline"
                ? "Offline"
                : "Connecting"}
          </span>
        </div>

        {mounted ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className="h-9 w-9 rounded-xl text-muted-foreground"
            aria-label={isDark ? "Use light theme" : "Use dark theme"}
          >
            {isDark ? (
              <Sun className="h-4 w-4" />
            ) : (
              <Moon className="h-4 w-4" />
            )}
          </Button>
        ) : (
          <div className="h-9 w-9" />
        )}

        {user && (
          <div className="hidden items-center gap-2 border-l pl-3 md:flex">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 text-xs font-semibold text-white">
              {(user.name || user.email || "U").slice(0, 1).toUpperCase()}
            </div>
            <div className="max-w-36 leading-tight">
              <p className="truncate text-xs font-semibold">
                {user.name || user.email}
              </p>
              <p className="text-[10px] capitalize text-muted-foreground">
                {user.role || "user"}
              </p>
            </div>
          </div>
        )}

        <Button
          variant="ghost"
          size="icon"
          onClick={handleLogout}
          className="h-9 w-9 rounded-xl text-muted-foreground hover:text-red-600"
          title="Sign out"
          aria-label="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </header>
  );
}
