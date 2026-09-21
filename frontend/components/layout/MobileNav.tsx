"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Monitor,
  Activity,
  ShieldAlert,
  MoreHorizontal,
  FolderGit2,
  Plug,
  Building2,
  Wallet,
  GitBranch,
  ScrollText,
  FileCode2,
  Settings,
  X, History, } from "lucide-react";

const primaryTabs = [
  { name: "Home", href: "/dashboard", icon: LayoutDashboard },
  { name: "Devices", href: "/devices", icon: Monitor },
  { name: "Sessions", href: "/sessions", icon: Activity },
  { name: "History", href: "/history", icon: History },
  { name: "Approvals", href: "/approvals", icon: ShieldAlert },
];

const moreItems = [
  { name: "Projects", href: "/projects", icon: FolderGit2 },
  { name: "Integrations", href: "/integrations", icon: Plug },
  { name: "Organization", href: "/organization", icon: Building2 },
  { name: "Budgets", href: "/budgets", icon: Wallet },
  { name: "Routing", href: "/routing", icon: GitBranch },
  { name: "Audit Log", href: "/audit", icon: ScrollText },
  { name: "Policy", href: "/policy", icon: FileCode2 },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function MobileNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const isMoreActive = moreItems.some(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/")
  );

  return (
    <>
      {/* Bottom sheet overlay */}
      {moreOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {/* Bottom sheet */}
      {moreOpen && (
        <div className="lg:hidden fixed bottom-16 inset-x-0 z-50 bg-card border-t border-border rounded-t-2xl shadow-2xl pb-2">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <span className="text-sm font-semibold text-foreground">More</span>
            <button
              onClick={() => setMoreOpen(false)}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-1 p-3">
            {moreItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setMoreOpen(false)}
                  className={`flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl transition-colors ${
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  <span className="text-[10px] font-medium text-center leading-tight">{item.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Fixed bottom nav bar */}
      <div className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-card/95 backdrop-blur-xl pb-safe">
        <div className="flex h-16 items-center justify-around px-2">
          {primaryTabs.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`flex flex-col items-center justify-center w-full h-full gap-1 ${
                  isActive ? "text-primary" : "text-foreground/60 hover:text-foreground"
                }`}
              >
                <item.icon className="h-5 w-5" />
                <span className="text-[10px] font-medium">{item.name}</span>
              </Link>
            );
          })}

          <button
            onClick={() => setMoreOpen((v) => !v)}
            className={`flex flex-col items-center justify-center w-full h-full gap-1 ${
              isMoreActive || moreOpen ? "text-primary" : "text-foreground/60 hover:text-foreground"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="text-[10px] font-medium">More</span>
          </button>
        </div>
      </div>
    </>
  );
}
