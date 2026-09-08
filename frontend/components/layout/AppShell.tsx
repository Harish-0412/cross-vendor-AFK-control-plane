"use client";

import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { Header } from "./Header";
import { useAuthStore } from "@/lib/auth";
import { realtimeClient } from "@/lib/realtime";
import { Loader2 } from "lucide-react";

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
        const currentPath = typeof window !== 'undefined'
          ? window.location.pathname + window.location.search
          : '';
        const target = currentPath && currentPath !== '/' && !currentPath.startsWith('/login') && !currentPath.startsWith('/register')
          ? `/login?redirect=${encodeURIComponent(currentPath)}`
          : '/login';
        router.push(target);
      } else {
        realtimeClient.connect();
      }
    }
  }, [isInitialized, isLoading, isAuthenticated, router]);

  if (!isInitialized || (isLoading && !isAuthenticated)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Connecting to FreeBuff Control Plane...</p>
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
          <p className="text-sm text-muted-foreground">Redirecting to sign in...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />

      <div className="flex flex-col lg:pl-64 min-h-screen pb-16 lg:pb-0">
        <Header />

        <main className="flex-1 overflow-x-hidden p-4 lg:p-8">
          {children}
        </main>

        <MobileNav />
      </div>
    </div>
  );
}
