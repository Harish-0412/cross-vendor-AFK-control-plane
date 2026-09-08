"use client";

import { LogOut, Shield, Wifi, WifiOff } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/auth";
import { realtimeClient, useRealtimeStore } from "@/lib/realtime";
import { Button } from "@/components/ui/button";

export function Header() {
  const router = useRouter();
  const { user, logout } = useAuthStore();
  const status = useRealtimeStore((s) => s.status);

  const handleLogout = async () => {
    realtimeClient.disconnect();
    await logout();
    router.push("/login");
  };

  const getStatusBadge = () => {
    switch (status) {
      case "connected":
        return (
          <div className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="hidden sm:inline">Connected</span>
          </div>
        );
      case "reconnecting":
      case "connecting":
        return (
          <div className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-ping" />
            <span className="hidden sm:inline">{status === 'connecting' ? 'Connecting...' : 'Reconnecting...'}</span>
          </div>
        );
      case "offline":
      default:
        return (
          <div className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive border border-destructive/20">
            <WifiOff className="h-3 w-3" />
            <span className="hidden sm:inline">Offline</span>
          </div>
        );
    }
  };

  return (
    <header className="sticky top-0 z-40 flex h-16 w-full items-center justify-between border-b border-border bg-card/80 px-4 backdrop-blur-xl lg:px-8">
      <div className="flex items-center gap-2 lg:hidden">
        <Link href="/dashboard" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Shield className="h-5 w-5" />
          </div>
          <span className="font-semibold text-foreground tracking-tight text-lg">FreeBuff AFK</span>
        </Link>
      </div>

      <div className="hidden lg:flex items-center gap-2 text-sm text-muted-foreground">
        <span>Control Plane:</span>
        <span className="font-mono text-foreground text-xs bg-muted px-2 py-0.5 rounded">v0.1.0</span>
      </div>

      <div className="flex items-center gap-3">
        {getStatusBadge()}

        {user && (
          <div className="hidden md:flex flex-col text-right">
            <span className="text-xs font-medium text-foreground">{user.name || user.email}</span>
            <span className="text-[10px] text-muted-foreground">{user.role.toUpperCase()}</span>
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={handleLogout}
          className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          title="Sign out"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Logout</span>
        </Button>
      </div>
    </header>
  );
}
