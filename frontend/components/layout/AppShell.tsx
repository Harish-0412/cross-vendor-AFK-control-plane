"use client";

import { ReactNode, useEffect } from "react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";

import { CommandPalette } from "./CommandPalette";
import { Header } from "./Header";
import { MobileNav } from "./MobileNav";
import { SIDEBAR_COLLAPSED, SIDEBAR_EXPANDED, Sidebar } from "./Sidebar";
import { LaunchSessionSheet } from "@/components/dashboard/QuickLaunchModal";
import { EASE_OUT } from "@/components/motion";
import { formatRelative, type UsageAlert } from "@/lib/ai-integrations";
import { useAuthStore } from "@/lib/auth";
import { ensureServiceWorker } from "@/lib/push";
import { realtimeClient } from "@/lib/realtime";
import { useUiStore } from "@/lib/ui-store";
import { useIsDesktop } from "@/lib/use-device";
import { startWorkspaceSync } from "@/lib/workspace-store";

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading, isInitialized, checkAuth } = useAuthStore();

  useEffect(() => {
    if (!isInitialized) {
      void checkAuth();
    }
  }, [isInitialized, checkAuth]);

  useEffect(() => {
    if (isInitialized && !isLoading) {
      if (!isAuthenticated) {
        const currentPath =
          typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
        const target =
          currentPath &&
          currentPath !== "/" &&
          !currentPath.startsWith("/login") &&
          !currentPath.startsWith("/register")
            ? `/login?redirect=${encodeURIComponent(currentPath)}`
            : "/login";
        router.push(target);
      } else {
        realtimeClient.connect();
      }
    }
  }, [isInitialized, isLoading, isAuthenticated, router]);

  // One place keeps machines, sessions and approvals current for every
  // screen and badge, instead of each fetching its own copy.
  useEffect(() => {
    if (!isAuthenticated) return;
    return startWorkspaceSync();
  }, [isAuthenticated]);

  // Registering the service worker is what makes the app installable on a
  // phone and gives it an offline page. It is also a prerequisite for Web
  // Push on iOS, so it must not wait until push is configured.
  useEffect(() => {
    if (!isAuthenticated) return;
    void ensureServiceWorker();
  }, [isAuthenticated]);

  // A plan limit running low is worth interrupting for wherever you are in the
  // app: the point of knowing is to stop an agent before the limit does. The
  // same warning is pushed to the phone, so this is the desk half of it.
  useEffect(() => {
    if (!isAuthenticated) return;
    return realtimeClient.subscribeAllEvents((message) => {
      if (message.type !== "usage_alert") return;
      const alert = (message as { alert?: UsageAlert }).alert;
      if (!alert) return;
      toast.warning(`${alert.usedPercent}% of your ${alert.windowLabel.toLowerCase()} is used`, {
        description: `${Math.max(0, 100 - alert.usedPercent)}% left. Resets ${formatRelative(alert.resetsAt)}.`,
        action: {
          label: "View limits",
          onClick: () => router.push("/budgets"),
        },
        duration: 12_000,
      });
    });
  }, [isAuthenticated, router]);

  if (!isInitialized || (isLoading && !isAuthenticated)) {
    return <Splash label="Connecting to your control plane" />;
  }

  // Redirecting to /login — a brief splash instead of a blank screen.
  if (!isAuthenticated) {
    return <Splash label="Redirecting to sign in" />;
  }

  return <ShellFrame>{children}</ShellFrame>;
}

/**
 * The signed-in layout — sidebar, header, animated page area, phone tabs and
 * the global sheets — without the session check around it. AppShell wraps it
 * for real use; the development preview renders it directly with sample data.
 */
export function ShellFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const isDesktop = useIsDesktop();
  const collapsed = useUiStore((state) => state.sidebarCollapsed);

  const sidebarWidth = isDesktop ? (collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED) : 0;

  return (
    <div className="app-canvas min-h-dvh bg-background">
      <Sidebar />

      <motion.div
        initial={false}
        animate={{ paddingLeft: sidebarWidth }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32 }}
        className="flex min-h-dvh flex-col"
      >
        <Header />

        <main className="flex-1 overflow-x-clip px-4 pb-28 pt-2 sm:px-6 lg:px-8 lg:pb-12 lg:pt-4 xl:px-10">
          {/*
            Route transition: the outgoing page fades and the incoming one
            rises into place. Keyed on the first path segment so tab switches
            animate but in-page URL changes (a query string, a filter) do not.
          */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={pathname.split("/").slice(0, 3).join("/")}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(4px)" }}
              animate={
                reduce
                  ? { opacity: 1 }
                  : {
                      opacity: 1,
                      y: 0,
                      filter: "blur(0px)",
                      // Any filter, even blur(0), makes this element the
                      // containing block for position:fixed descendants.
                      // Clear it once the entrance has finished.
                      transitionEnd: { filter: "none" },
                    }
              }
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, filter: "blur(2px)" }}
              transition={{ duration: reduce ? 0.12 : 0.32, ease: EASE_OUT }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </motion.div>

      <MobileNav />
      <CommandPalette />
      <LaunchSessionSheet />
    </div>
  );
}

function Splash({ label }: { label: string }) {
  return (
    <div className="app-canvas flex min-h-dvh items-center justify-center bg-background">
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: EASE_OUT }}
        className="flex flex-col items-center gap-5"
      >
        <div className="relative">
          <div className="absolute -inset-6 rounded-full bg-primary/20 blur-2xl" />
          <motion.div
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            className="relative h-16 w-16 overflow-hidden rounded-2xl shadow-xl ring-1 ring-white/10"
          >
            <Image src="/icon-192.png" alt="Odysseus" width={64} height={64} priority />
          </motion.div>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="flex gap-1">
            {[0, 1, 2].map((dot) => (
              <motion.span
                key={dot}
                className="h-1.5 w-1.5 rounded-full bg-primary"
                animate={{ opacity: [0.25, 1, 0.25] }}
                transition={{ duration: 1.1, repeat: Infinity, delay: dot * 0.18 }}
              />
            ))}
          </span>
          {label}
        </div>
      </motion.div>
    </div>
  );
}
