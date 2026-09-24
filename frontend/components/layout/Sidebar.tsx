"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { useEffect } from "react";

import { LiveDot, SPRING } from "@/components/motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NAV_GROUPS, isActivePath } from "@/lib/navigation";
import { useRealtimeStore } from "@/lib/realtime";
import { useUiStore } from "@/lib/ui-store";
import { selectPendingApprovals, useWorkspace } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";

export const SIDEBAR_EXPANDED = 272;
export const SIDEBAR_COLLAPSED = 76;

/**
 * Desktop navigation.
 *
 * Collapses to an icon rail for people who want the width back; the choice is
 * remembered in this browser. The active item is marked by a single shared
 * highlight that slides between entries, so moving between pages reads as
 * movement rather than two unrelated repaints.
 */
export function Sidebar() {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const hydrate = useUiStore((state) => state.hydrateSidebar);
  const toggle = useUiStore((state) => state.toggleSidebar);
  const openCommand = useUiStore((state) => state.setCommandOpen);
  const pending = useWorkspace((state) => selectPendingApprovals(state).length);

  useEffect(() => hydrate(), [hydrate]);

  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED }}
      transition={reduce ? { duration: 0 } : SPRING}
      className="fixed inset-y-0 left-0 z-50 hidden flex-col border-r border-sidebar-border bg-sidebar/85 backdrop-blur-xl lg:flex"
    >
      {/* Brand */}
      <div className="flex h-[72px] shrink-0 items-center gap-3 px-[18px]">
        <Link
          href="/dashboard"
          className="group relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl shadow-md ring-1 ring-white/10 transition-transform duration-300 hover:scale-105"
          aria-label="Odysseus overview"
        >
          <Image src="/ares.png" alt="Odysseus" width={40} height={40} priority />
        </Link>
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="brand-text"
              initial={{ opacity: 0, x: -6 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -6 }}
              transition={{ duration: 0.18 }}
              className="min-w-0"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-[15px] font-semibold tracking-tight">Odysseus</span>
                <span className="rounded-md bg-brand-gradient px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-white">
                  AFK
                </span>
              </div>
              <p className="truncate text-[11px] text-muted-foreground">Agent control plane</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Search / command palette */}
      <div className="px-3 pb-2">
        <NavTooltip label="Search" shortcut="⌘K" show={collapsed}>
          <button
            type="button"
            onClick={() => openCommand(true)}
            className={cn(
              "group flex h-10 w-full items-center gap-2.5 rounded-xl border border-sidebar-border bg-background/60 text-sm text-muted-foreground transition-all hover:border-primary/40 hover:text-foreground hover:shadow-sm",
              collapsed ? "justify-center px-0" : "px-3",
            )}
          >
            <Search className="h-4 w-4 shrink-0" />
            {!collapsed && (
              <>
                <span className="flex-1 text-left">Search or jump to…</span>
                <kbd className="rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium">
                  ⌘K
                </kbd>
              </>
            )}
          </button>
        </NavTooltip>
      </div>

      {/* Navigation */}
      <nav className="no-scrollbar flex-1 overflow-y-auto px-3 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="pt-4">
            <div className="mb-1 h-5 px-3">
              <AnimatePresence initial={false}>
                {!collapsed ? (
                  <motion.p
                    key="label"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70"
                  >
                    {group.label}
                  </motion.p>
                ) : (
                  <motion.div
                    key="rule"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="mx-auto mt-2 h-px w-6 bg-sidebar-border"
                  />
                )}
              </AnimatePresence>
            </div>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActivePath(pathname, item.href);
                const badge = item.href === "/approvals" && pending > 0 ? pending : 0;
                return (
                  <li key={item.href}>
                    <NavTooltip label={item.name} show={collapsed} badge={badge}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group relative flex h-10 items-center gap-3 rounded-xl text-[13.5px] font-medium outline-none transition-colors",
                          collapsed ? "justify-center px-0" : "px-3",
                          active
                            ? "text-sidebar-accent-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {active && (
                          <motion.span
                            layoutId="sidebar-active"
                            transition={reduce ? { duration: 0 } : SPRING}
                            className="absolute inset-0 rounded-xl bg-sidebar-accent shadow-sm ring-1 ring-primary/15"
                          />
                        )}
                        {!active && (
                          <span className="absolute inset-0 rounded-xl bg-foreground/[0.04] opacity-0 transition-opacity group-hover:opacity-100" />
                        )}
                        <item.icon
                          className={cn(
                            "relative h-[18px] w-[18px] shrink-0 transition-transform duration-300 group-hover:scale-110",
                            active ? "text-primary" : "",
                          )}
                        />
                        {!collapsed && <span className="relative flex-1 truncate">{item.name}</span>}
                        <AnimatePresence>
                          {badge > 0 && (
                            <motion.span
                              key={badge}
                              initial={{ scale: 0.4, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ scale: 0.4, opacity: 0 }}
                              transition={SPRING}
                              className={cn(
                                "attention-pulse relative flex min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-[10px] font-bold text-warning-foreground [--pulse-color:color-mix(in_oklab,var(--warning)_60%,transparent)]",
                                collapsed ? "absolute -right-0.5 -top-0.5 h-4 min-w-4 px-1" : "h-5",
                              )}
                            >
                              {badge > 99 ? "99+" : badge}
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </Link>
                    </NavTooltip>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <ConnectionCard collapsed={collapsed} />

      <button
        type="button"
        onClick={toggle}
        className="mx-3 mb-3 flex h-9 items-center justify-center gap-2 rounded-xl text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <ChevronsRight className="h-4 w-4" />
        ) : (
          <>
            <ChevronsLeft className="h-4 w-4" /> Collapse
          </>
        )}
      </button>
    </motion.aside>
  );
}

/**
 * The link to the Control Plane, as it actually is. This used to say "Control
 * plane ready" unconditionally — including while the socket was down.
 */
function ConnectionCard({ collapsed }: { collapsed: boolean }) {
  const status = useRealtimeStore((state) => state.status);
  const devices = useWorkspace((state) => state.devices.data);
  const online = devices.filter((device) => device.online).length;

  const tone = status === "connected" ? "success" : status === "offline" ? "danger" : "warning";
  const title =
    status === "connected"
      ? "Live"
      : status === "offline"
        ? "Offline"
        : status === "reconnecting"
          ? "Reconnecting"
          : "Connecting";
  const detail =
    status === "connected"
      ? devices.length === 0
        ? "No machines paired yet"
        : `${online} of ${devices.length} machine${devices.length === 1 ? "" : "s"} online`
      : status === "offline"
        ? "Live updates paused"
        : "Restoring live updates";

  if (collapsed) {
    return (
      <NavTooltip label={`${title} · ${detail}`} show>
        <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-sidebar-border">
          <LiveDot tone={tone} live={status !== "offline"} />
        </div>
      </NavTooltip>
    );
  }

  return (
    <div className="gradient-border mx-3 mb-2 overflow-hidden rounded-2xl bg-gradient-to-br from-primary/[0.07] to-transparent p-3.5">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <LiveDot tone={tone} live={status !== "offline"} />
        {title}
      </div>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

function NavTooltip({
  children,
  label,
  shortcut,
  badge,
  show,
}: {
  children: React.ReactElement;
  label: string;
  shortcut?: string;
  badge?: number;
  show: boolean;
}) {
  if (!show) return children;
  return (
    <Tooltip delayDuration={80}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} className="flex items-center gap-2">
        {label}
        {badge ? (
          <span className="rounded-full bg-warning px-1.5 text-[10px] font-bold text-warning-foreground">
            {badge}
          </span>
        ) : null}
        {shortcut && <kbd className="font-mono text-[10px] opacity-70">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  );
}
