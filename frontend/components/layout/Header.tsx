"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronDown,
  LogOut,
  Monitor as MonitorIcon,
  Moon,
  Search,
  Settings,
  Sun,
  WifiOff,
} from "lucide-react";
import { useTheme } from "next-themes";

import { KillSwitch } from "@/components/layout/KillSwitch";
import { LiveDot } from "@/components/motion";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuthStore } from "@/lib/auth";
import { titleForPath } from "@/lib/navigation";
import { realtimeClient, useRealtimeStore } from "@/lib/realtime";
import { useUiStore } from "@/lib/ui-store";
import { useIsDesktop } from "@/lib/use-device";
import { cn } from "@/lib/utils";

/**
 * The top bar. Desktop and phone get different bars, because they do
 * different jobs: on a desktop it is a toolbar with room for search, status
 * and account; on a phone it is a title bar that stays out of the way of the
 * content and leaves navigation to the tabs at the bottom.
 */
export function Header() {
  const isDesktop = useIsDesktop();
  return isDesktop ? <DesktopHeader /> : <MobileHeader />;
}

function useScrolled(threshold = 6): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

function DesktopHeader() {
  const pathname = usePathname();
  const scrolled = useScrolled();
  const openCommand = useUiStore((state) => state.setCommandOpen);
  const title = titleForPath(pathname);

  return (
    <header
      className={cn(
        "sticky top-0 z-40 flex h-[72px] w-full items-center justify-between gap-4 px-8 transition-[background-color,box-shadow,border-color] duration-300",
        scrolled
          ? "glass border-b border-border/70 shadow-[0_1px_0_0_var(--border)]"
          : "border-b border-transparent",
      )}
    >
      <div className="min-w-0">
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
          Control plane
        </p>
        <AnimatePresence mode="wait" initial={false}>
          <motion.h2
            key={title}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="truncate text-lg font-semibold tracking-tight"
          >
            {title}
          </motion.h2>
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => openCommand(true)}
          className="hidden h-9 w-64 items-center gap-2 rounded-xl border bg-card/70 px-3 text-sm text-muted-foreground shadow-xs transition-all hover:border-primary/40 hover:text-foreground xl:flex"
        >
          <Search className="h-4 w-4" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded-md border bg-muted px-1.5 font-mono text-[10px]">⌘K</kbd>
        </button>
        <KillSwitch />
        <StatusPill />
        <ThemeToggle />
        <AccountMenu />
      </div>
    </header>
  );
}

function MobileHeader() {
  const pathname = usePathname();
  const scrolled = useScrolled(2);
  const title = titleForPath(pathname);
  const status = useRealtimeStore((state) => state.status);

  return (
    <header
      className={cn(
        "pt-safe sticky top-0 z-40 w-full transition-[background-color,box-shadow] duration-300",
        scrolled ? "glass shadow-[0_1px_0_0_var(--border)]" : "bg-transparent",
      )}
    >
      <div className="flex h-14 items-center justify-between gap-3 px-4">
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2.5" aria-label="Overview">
          <span className="relative flex h-8 w-8 shrink-0 overflow-hidden rounded-[10px] shadow-sm ring-1 ring-white/10">
            <Image src="/icon-192.png" alt="" width={32} height={32} priority />
          </span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={title}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="truncate text-[17px] font-semibold tracking-tight"
            >
              {title}
            </motion.span>
          </AnimatePresence>
        </Link>

        <div className="flex items-center gap-1.5">
          <span
            className="flex h-9 w-9 items-center justify-center"
            aria-label={`Live updates: ${status}`}
            title={`Live updates: ${status}`}
          >
            {status === "offline" ? (
              <WifiOff className="h-4 w-4 text-destructive" />
            ) : (
              <LiveDot
                tone={status === "connected" ? "success" : "warning"}
                live={status === "connected"}
              />
            )}
          </span>
          <KillSwitch />
          <AccountMenu compact />
        </div>
      </div>
    </header>
  );
}

function StatusPill() {
  const status = useRealtimeStore((state) => state.status);
  const label =
    status === "connected"
      ? "Live"
      : status === "offline"
        ? "Offline"
        : status === "reconnecting"
          ? "Reconnecting"
          : "Connecting";
  return (
    <motion.div
      layout
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-xs font-semibold",
        status === "connected"
          ? "border-success/25 bg-success/10 text-success"
          : status === "offline"
            ? "border-destructive/25 bg-destructive/10 text-destructive"
            : "border-warning/30 bg-warning/10 text-warning",
      )}
      title={
        status === "connected"
          ? "Authenticated live updates are active"
          : "Live updates are not connected right now"
      }
    >
      {status === "offline" ? (
        <WifiOff className="h-3.5 w-3.5" />
      ) : (
        <LiveDot tone={status === "connected" ? "success" : "warning"} live={status === "connected"} />
      )}
      {label}
    </motion.div>
  );
}

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-9 w-9" />;
  const isDark = (resolvedTheme || theme) === "dark";
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative h-9 w-9 overflow-hidden rounded-xl text-muted-foreground"
      aria-label={isDark ? "Use light theme" : "Use dark theme"}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={isDark ? "sun" : "moon"}
          initial={{ y: 14, opacity: 0, rotate: -40 }}
          animate={{ y: 0, opacity: 1, rotate: 0 }}
          exit={{ y: -14, opacity: 0, rotate: 40 }}
          transition={{ duration: 0.22 }}
          className="flex"
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </motion.span>
      </AnimatePresence>
    </Button>
  );
}

function AccountMenu({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const { theme, setTheme } = useTheme();
  if (!user) return null;
  const initial = (user.name || user.email || "U").slice(0, 1).toUpperCase();

  const signOut = async () => {
    realtimeClient.disconnect();
    await logout();
    router.push("/login");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 rounded-xl transition-colors hover:bg-foreground/[0.05]",
            compact ? "h-9 w-9 justify-center" : "h-9 pl-1 pr-2",
          )}
          aria-label="Account"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-gradient text-xs font-semibold text-white shadow-sm">
            {initial}
          </span>
          {!compact && (
            <>
              <span className="max-w-32 truncate text-xs font-semibold">{user.name || user.email}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 rounded-xl p-1.5">
        <DropdownMenuLabel className="px-2 py-2">
          <p className="truncate text-sm font-semibold">{user.name || "Signed in"}</p>
          <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild className="rounded-lg">
          <Link href="/settings">
            <Settings className="h-4 w-4" /> Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild className="rounded-lg">
          <Link href="/devices">
            <MonitorIcon className="h-4 w-4" /> Machines
          </Link>
        </DropdownMenuItem>
        {compact && (
          <DropdownMenuItem
            className="rounded-lg"
            onSelect={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            {theme === "dark" ? "Light theme" : "Dark theme"}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="rounded-lg text-destructive focus:text-destructive"
          onSelect={() => void signOut()}
        >
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
