/**
 * The app's destinations, defined once.
 *
 * The desktop sidebar, the phone's tab bar and "More" sheet, and the command
 * palette all read from here, so a new page appears in all three at once and
 * the labels cannot drift apart.
 */
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
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  name: string;
  /** Shorter label for the phone's tab bar. */
  short?: string;
  href: string;
  icon: LucideIcon;
  /** One line for the command palette. */
  hint: string;
  keywords?: string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operate",
    items: [
      {
        name: "Overview",
        short: "Home",
        href: "/dashboard",
        icon: LayoutDashboard,
        hint: "Everything at a glance",
        keywords: ["home", "dashboard"],
      },
      {
        name: "Machines",
        href: "/devices",
        icon: Monitor,
        hint: "Paired workstations and their status",
        keywords: ["devices", "pair", "workstation", "computer"],
      },
      {
        name: "Live sessions",
        short: "Sessions",
        href: "/sessions",
        icon: Activity,
        hint: "Agents running right now",
        keywords: ["agents", "running", "tasks"],
      },
      {
        name: "Approvals",
        href: "/approvals",
        icon: ShieldCheck,
        hint: "Anything waiting on your decision",
        keywords: ["approve", "deny", "pending", "review"],
      },
      {
        name: "History",
        href: "/history",
        icon: History,
        hint: "Past conversations from connected tools",
        keywords: ["conversations", "codex", "antigravity", "search"],
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        name: "Projects",
        href: "/projects",
        icon: FolderGit2,
        hint: "Repositories your agents work in",
        keywords: ["repos", "git"],
      },
      {
        name: "Integrations",
        href: "/integrations",
        icon: Plug,
        hint: "Connect Codex, Antigravity, Claude and more",
        keywords: ["connect", "codex", "openai", "github"],
      },
      {
        name: "Organization",
        href: "/organization",
        icon: Building2,
        hint: "Team and members",
        keywords: ["team", "members"],
      },
    ],
  },
  {
    label: "Control",
    items: [
      {
        name: "Budgets",
        href: "/budgets",
        icon: Wallet,
        hint: "Spend, plan limits and usage",
        keywords: ["usage", "cost", "limits", "tokens"],
      },
      {
        name: "Agent routing",
        short: "Routing",
        href: "/routing",
        icon: GitBranch,
        hint: "Which agent handles what",
        keywords: ["route"],
      },
      {
        name: "Policy",
        href: "/policy",
        icon: FileCode2,
        hint: "What agents may do without asking",
        keywords: ["rules", "permissions"],
      },
      {
        name: "Audit log",
        short: "Audit",
        href: "/audit",
        icon: ScrollText,
        hint: "Every decision, signed and chained",
        keywords: ["log", "history", "security"],
      },
      {
        name: "Settings",
        href: "/settings",
        icon: Settings,
        hint: "Account, notifications and security",
        keywords: ["preferences", "account", "notifications"],
      },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/**
 * The phone's bottom tabs, either side of the launch button; everything else
 * lives in the More sheet. These are the three things someone away from their
 * desk checks: is everything fine, what is running, what is waiting on me.
 */
export const MOBILE_TAB_HREFS = ["/dashboard", "/sessions", "/approvals"] as const;

export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function titleForPath(pathname: string): string {
  const match = ALL_NAV_ITEMS.find((item) => isActivePath(pathname, item.href));
  return match?.name ?? "Odysseus";
}
