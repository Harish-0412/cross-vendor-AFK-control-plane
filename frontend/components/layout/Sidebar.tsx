"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Monitor,
  Activity,
  ShieldAlert,
  Shield,
  Settings,
  ScrollText,
  FileCode2,
} from "lucide-react";

export const navigationItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Devices", href: "/devices", icon: Monitor },
  { name: "Sessions", href: "/sessions", icon: Activity },
  { name: "Approvals", href: "/approvals", icon: ShieldAlert },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 lg:border-r lg:border-border lg:bg-card">
      <div className="flex h-16 shrink-0 items-center px-6 border-b border-border">
        <Link href="/dashboard" className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Shield className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <span className="font-semibold text-foreground tracking-tight text-sm">FreeBuff AFK</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-mono">Control Plane</span>
          </div>
        </Link>
      </div>
      <nav className="flex flex-1 flex-col overflow-y-auto p-4 space-y-1">
        {navigationItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary/10 text-primary font-semibold"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              }`}
            >
              <item.icon className="h-4 w-4 flex-shrink-0" />
              {item.name}
            </Link>
          );
        })}

        <div className="mt-6 pt-4 border-t border-border space-y-1">
          <span className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            Governance
          </span>
          <Link
            href="/audit"
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              pathname.startsWith("/audit")
                ? "bg-primary/10 text-primary font-semibold"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <ScrollText className="h-4 w-4 flex-shrink-0" />
            Audit Log
          </Link>
          <Link
            href="/policy"
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              pathname.startsWith("/policy")
                ? "bg-primary/10 text-primary font-semibold"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <FileCode2 className="h-4 w-4 flex-shrink-0" />
            Policy
          </Link>
          <Link
            href="/settings"
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              pathname.startsWith("/settings")
                ? "bg-primary/10 text-primary font-semibold"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            <Settings className="h-4 w-4 flex-shrink-0" />
            Settings
          </Link>
        </div>
      </nav>
    </div>
  );
}
