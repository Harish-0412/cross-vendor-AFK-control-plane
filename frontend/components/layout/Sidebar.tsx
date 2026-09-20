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
  FolderGit2,
  Plug,
  Building2,
  Wallet,
  GitBranch,
} from "lucide-react";

const primaryItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Devices", href: "/devices", icon: Monitor },
  { name: "Sessions", href: "/sessions", icon: Activity },
  { name: "Approvals", href: "/approvals", icon: ShieldAlert },
];

const workspaceItems = [
  { name: "Projects", href: "/projects", icon: FolderGit2 },
  { name: "Integrations", href: "/integrations", icon: Plug },
  { name: "Organization", href: "/organization", icon: Building2 },
];

const intelligenceItems = [
  { name: "Budgets", href: "/budgets", icon: Wallet },
  { name: "Routing", href: "/routing", icon: GitBranch },
];

const governanceItems = [
  { name: "Audit Log", href: "/audit", icon: ScrollText },
  { name: "Policy", href: "/policy", icon: FileCode2 },
  { name: "Settings", href: "/settings", icon: Settings },
];

function NavGroup({
  label,
  items,
  pathname,
}: {
  label?: string;
  items: { name: string; href: string; icon: React.ComponentType<{ className?: string }> }[];
  pathname: string;
}) {
  return (
    <div className="space-y-0.5">
      {label && (
        <span className="px-3 pb-1 pt-3 block text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60">
          {label}
        </span>
      )}
      {items.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
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
    </div>
  );
}

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
            <span className="font-semibold text-foreground tracking-tight text-sm">Odysseus AFK</span>
            <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-mono">Control Plane</span>
          </div>
        </Link>
      </div>

      <nav className="flex flex-1 flex-col overflow-y-auto p-3 gap-1">
        <NavGroup items={primaryItems} pathname={pathname} />

        <div className="mt-2 border-t border-border pt-2">
          <NavGroup label="Workspace" items={workspaceItems} pathname={pathname} />
        </div>

        <div className="mt-2 border-t border-border pt-2">
          <NavGroup label="Intelligence" items={intelligenceItems} pathname={pathname} />
        </div>

        <div className="mt-2 border-t border-border pt-2">
          <NavGroup label="Governance" items={governanceItems} pathname={pathname} />
        </div>
      </nav>
    </div>
  );
}
