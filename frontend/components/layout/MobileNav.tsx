"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Building2,
  FileCode2,
  FolderGit2,
  GitBranch,
  History,
  LayoutDashboard,
  Monitor,
  MoreHorizontal,
  Plug,
  ScrollText,
  Settings,
  ShieldAlert,
  Wallet,
  X,
} from "lucide-react";

const tabs = [
  { name: "Home", href: "/dashboard", icon: LayoutDashboard },
  { name: "Machines", href: "/devices", icon: Monitor },
  { name: "Approvals", href: "/approvals", icon: ShieldAlert },
  { name: "History", href: "/history", icon: History },
] as const;

const moreItems = [
  { name: "Live sessions", href: "/sessions", icon: Activity },
  { name: "Projects", href: "/projects", icon: FolderGit2 },
  { name: "AI integrations", href: "/integrations", icon: Plug },
  { name: "Organization", href: "/organization", icon: Building2 },
  { name: "Budgets", href: "/budgets", icon: Wallet },
  { name: "Agent routing", href: "/routing", icon: GitBranch },
  { name: "Policy", href: "/policy", icon: FileCode2 },
  { name: "Audit log", href: "/audit", icon: ScrollText },
  { name: "Settings", href: "/settings", icon: Settings },
] as const;

export function MobileNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const moreActive = moreItems.some((item) => isActive(item.href));

  return (
    <>
      {open && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {open && (
        <div className="fixed inset-x-3 bottom-[76px] z-50 overflow-hidden rounded-3xl border bg-card/95 shadow-2xl backdrop-blur-xl lg:hidden">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <p className="text-sm font-semibold">All tools</p>
              <p className="text-xs text-muted-foreground">
                Navigate your control plane
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 p-3">
            {moreItems.map((item) => {
              const active = isActive(item.href);
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`flex min-h-20 flex-col items-center justify-center gap-2 rounded-2xl px-2 py-3 text-center transition ${
                    active
                      ? "bg-blue-600/10 text-blue-700 dark:text-blue-300"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  <span className="text-[10px] font-semibold leading-tight">
                    {item.name}
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
        <div className="grid h-16 grid-cols-5 px-1">
          {tabs.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.name}
                href={item.href}
                className={`relative flex flex-col items-center justify-center gap-1 text-[10px] font-medium ${
                  active
                    ? "text-blue-700 dark:text-blue-300"
                    : "text-muted-foreground"
                }`}
              >
                {active && (
                  <span className="absolute top-0 h-0.5 w-8 rounded-full bg-blue-600" />
                )}
                <item.icon className="h-[18px] w-[18px]" />
                {item.name}
              </Link>
            );
          })}
          <button
            onClick={() => setOpen((value) => !value)}
            className={`relative flex flex-col items-center justify-center gap-1 text-[10px] font-medium ${
              open || moreActive
                ? "text-blue-700 dark:text-blue-300"
                : "text-muted-foreground"
            }`}
          >
            {(open || moreActive) && (
              <span className="absolute top-0 h-0.5 w-8 rounded-full bg-blue-600" />
            )}
            <MoreHorizontal className="h-[18px] w-[18px]" />
            More
          </button>
        </div>
      </nav>
    </>
  );
}
