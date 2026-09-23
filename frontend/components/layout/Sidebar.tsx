"use client";

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
  Plug,
  ScrollText,
  Settings,
  ShieldAlert,
  Sparkles,
  Wallet,
} from "lucide-react";

const groups = [
  {
    label: "Operate",
    items: [
      { name: "Overview", href: "/dashboard", icon: LayoutDashboard },
      { name: "Machines", href: "/devices", icon: Monitor },
      { name: "Live sessions", href: "/sessions", icon: Activity },
      { name: "Approvals", href: "/approvals", icon: ShieldAlert },
      { name: "Conversation history", href: "/history", icon: History },
    ],
  },
  {
    label: "Workspace",
    items: [
      { name: "Projects", href: "/projects", icon: FolderGit2 },
      { name: "AI integrations", href: "/integrations", icon: Plug },
      { name: "Organization", href: "/organization", icon: Building2 },
    ],
  },
  {
    label: "Control",
    items: [
      { name: "Budgets", href: "/budgets", icon: Wallet },
      { name: "Agent routing", href: "/routing", icon: GitBranch },
      { name: "Policy", href: "/policy", icon: FileCode2 },
      { name: "Audit log", href: "/audit", icon: ScrollText },
      { name: "Settings", href: "/settings", icon: Settings },
    ],
  },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-50 hidden w-72 flex-col border-r border-slate-200/80 bg-white/90 backdrop-blur-xl dark:border-white/[0.07] dark:bg-slate-950/90 lg:flex">
      <div className="flex h-[76px] shrink-0 items-center border-b border-slate-200/70 px-5 dark:border-white/[0.07]">
        <Link href="/dashboard" className="group flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-blue-600 to-indigo-700 text-white shadow-lg shadow-blue-600/20">
            <Sparkles className="h-5 w-5 transition-transform duration-300 group-hover:scale-110" />
            <div className="absolute inset-x-2 top-0 h-px bg-white/60" />
          </div>
          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[15px] font-semibold tracking-tight text-slate-950 dark:text-white">
                Odysseus
              </span>
              <span className="rounded bg-blue-600/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                AFK
              </span>
            </div>
            <p className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-400">
              Agent control plane
            </p>
          </div>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {groups.map((group, groupIndex) => (
          <div
            key={group.label}
            className={
              groupIndex === 0
                ? "pb-4"
                : "border-t border-slate-200/70 py-4 dark:border-white/[0.06]"
            }
          >
            <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400 dark:text-slate-500">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.name}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all ${
                      active
                        ? "bg-blue-600/[0.09] text-blue-700 dark:bg-blue-400/10 dark:text-blue-300"
                        : "text-slate-600 hover:bg-slate-100 hover:text-slate-950 dark:text-slate-400 dark:hover:bg-white/[0.05] dark:hover:text-white"
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-blue-600 dark:bg-blue-400" />
                    )}
                    <item.icon
                      className={`h-[17px] w-[17px] shrink-0 ${active ? "text-blue-600 dark:text-blue-300" : "text-slate-400 transition-colors group-hover:text-slate-700 dark:group-hover:text-slate-200"}`}
                    />
                    {item.name}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="m-3 rounded-2xl border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.07] to-indigo-500/[0.03] p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-800 dark:text-slate-100">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          Control plane ready
        </div>
        <p className="mt-1.5 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
          Encrypted device tunnels and approval routing are active.
        </p>
      </div>
    </aside>
  );
}
