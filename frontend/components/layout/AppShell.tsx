"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { Header } from "./Header";
import { useAuthStore } from "@/lib/auth";
import { realtimeClient } from "@/lib/realtime";
import { formatRelative, type UsageAlert } from "@/lib/ai-integrations";
import { ensureServiceWorker } from "@/lib/push";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading, isInitialized, checkAuth } =
    useAuthStore();

  useEffect(() => {
    if (!isInitialized) {
      void checkAuth();
    }
  }, [isInitialized, checkAuth]);

  useEffect(() => {
    if (isInitialized && !isLoading) {
      if (!isAuthenticated) {
        const currentPath =
          typeof window !== "undefined"
            ? window.location.pathname + window.location.search
            : "";
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
      toast.warning(
        `${alert.usedPercent}% of your ${alert.windowLabel.toLowerCase()} is used`,
        {
          description: `${Math.max(0, 100 - alert.usedPercent)}% left. Resets ${formatRelative(alert.resetsAt)}.`,
          action: {
            label: "View limits",
            onClick: () => router.push("/budgets"),
          },
          duration: 12_000,
        },
      );
    });
  }, [isAuthenticated, router]);

  if (!isInitialized || (isLoading && !isAuthenticated)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            Connecting to Odysseus Control Plane...
          </p>
        </div>
      </div>
    );
  }

  // Redirecting to /login — render a brief splash instead of a blank screen
  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">
            Redirecting to sign in...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-canvas min-h-screen bg-background">
      <Sidebar />

      <div className="flex min-h-screen flex-col pb-16 lg:pl-72 lg:pb-0">
        <Header />

        <main className="flex-1 overflow-x-hidden p-4 sm:p-6 lg:p-8 xl:p-10">
          {children}
        </main>

        <MobileNav />
      </div>
    </div>
  );
}
