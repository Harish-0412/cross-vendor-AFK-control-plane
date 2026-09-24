"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { LayoutGrid, Plus } from "lucide-react";

import { SPRING, Stagger, StaggerItem } from "@/components/motion";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ALL_NAV_ITEMS, MOBILE_TAB_HREFS, isActivePath, type NavItem } from "@/lib/navigation";
import { useUiStore } from "@/lib/ui-store";
import { selectPendingApprovals, useWorkspace } from "@/lib/workspace-store";
import { cn } from "@/lib/utils";

const TABS = MOBILE_TAB_HREFS.map(
  (href) => ALL_NAV_ITEMS.find((item) => item.href === href) as NavItem,
);
const MORE_ITEMS = ALL_NAV_ITEMS.filter(
  (item) => !(MOBILE_TAB_HREFS as readonly string[]).includes(item.href),
);

/**
 * Phone navigation: a tab bar within thumb reach, a raised button for the one
 * action that matters most away from a desk — starting an agent — and the
 * rest of the app in a sheet you can drag away.
 */
export function MobileNav() {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const [moreOpen, setMoreOpen] = useState(false);
  const setLaunchOpen = useUiStore((state) => state.setLaunchOpen);
  const pending = useWorkspace((state) => selectPendingApprovals(state).length);
  const moreActive = MORE_ITEMS.some((item) => isActivePath(pathname, item.href));

  const [home, sessions, approvals] = TABS as [NavItem, NavItem, NavItem];

  return (
    <>
      <nav
        className="glass fixed inset-x-0 bottom-0 z-40 border-t border-border/70 pb-safe lg:hidden"
        aria-label="Primary"
      >
        <div className="relative mx-auto grid h-[64px] max-w-md grid-cols-5 items-center px-2">
          <Tab item={home} active={isActivePath(pathname, home.href)} reduce={reduce} />
          <Tab item={sessions} active={isActivePath(pathname, sessions.href)} reduce={reduce} />

          <div className="flex justify-center">
            <motion.button
              type="button"
              onClick={() => setLaunchOpen(true)}
              whileTap={reduce ? undefined : { scale: 0.9 }}
              transition={SPRING}
              className="-mt-7 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-gradient text-white shadow-[var(--glow-primary)] ring-4 ring-background"
              aria-label="Launch an agent session"
            >
              <Plus className="h-6 w-6" strokeWidth={2.4} />
            </motion.button>
          </div>

          <Tab
            item={approvals}
            active={isActivePath(pathname, approvals.href)}
            reduce={reduce}
            badge={pending}
          />

          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="relative flex h-full flex-col items-center justify-center gap-1"
            aria-label="More destinations"
          >
            {moreActive && <ActiveBackdrop reduce={reduce} />}
            <LayoutGrid
              className={cn(
                "relative h-[21px] w-[21px] transition-colors",
                moreActive ? "text-primary" : "text-muted-foreground",
              )}
            />
            <span
              className={cn(
                "relative text-[10.5px] font-medium",
                moreActive ? "text-foreground" : "text-muted-foreground",
              )}
            >
              More
            </span>
          </button>
        </div>
      </nav>

      <Drawer open={moreOpen} onOpenChange={setMoreOpen}>
        <DrawerContent className="rounded-t-3xl pb-safe">
          <DrawerHeader className="px-5 pb-1 pt-3 text-left!">
            <DrawerTitle className="text-lg">Everything else</DrawerTitle>
            <DrawerDescription>History, integrations, budgets and settings</DrawerDescription>
          </DrawerHeader>
          <Stagger className="grid grid-cols-3 gap-2.5 px-4 pb-6 pt-3" stagger={0.035}>
            {MORE_ITEMS.map((item) => {
              const active = isActivePath(pathname, item.href);
              return (
                <StaggerItem key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className={cn(
                      "flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-2xl border px-2 py-3 text-center transition-all active:scale-95",
                      active
                        ? "border-primary/30 bg-primary/10 text-foreground"
                        : "border-border/70 bg-card text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-10 w-10 items-center justify-center rounded-xl",
                        active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
                      )}
                    >
                      <item.icon className="h-5 w-5" />
                    </span>
                    <span className="text-[11.5px] font-semibold leading-tight text-foreground">
                      {item.short ?? item.name}
                    </span>
                  </Link>
                </StaggerItem>
              );
            })}
          </Stagger>
        </DrawerContent>
      </Drawer>
    </>
  );
}

function Tab({
  item,
  active,
  reduce,
  badge = 0,
}: {
  item: NavItem;
  active: boolean;
  reduce: boolean | null;
  badge?: number;
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className="relative flex h-full flex-col items-center justify-center gap-1"
    >
      {active && <ActiveBackdrop reduce={reduce} />}
      <span className="relative">
        <motion.span
          animate={active && !reduce ? { y: [0, -3, 0] } : { y: 0 }}
          transition={{ duration: 0.35 }}
          className="flex"
        >
          <item.icon
            className={cn(
              "h-[21px] w-[21px] transition-colors",
              active ? "text-primary" : "text-muted-foreground",
            )}
          />
        </motion.span>
        <AnimatePresence>
          {badge > 0 && (
            <motion.span
              key={badge}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={SPRING}
              className="attention-pulse absolute -right-2.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[9.5px] font-bold text-warning-foreground ring-2 ring-background [--pulse-color:color-mix(in_oklab,var(--warning)_60%,transparent)]"
            >
              {badge > 9 ? "9+" : badge}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span
        className={cn(
          "relative text-[10.5px] font-medium transition-colors",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {item.short ?? item.name}
      </span>
    </Link>
  );
}

/** The pill behind the active tab; shared, so it slides between tabs. */
function ActiveBackdrop({ reduce }: { reduce: boolean | null }) {
  return (
    <motion.span
      layoutId="mobile-tab-active"
      transition={reduce ? { duration: 0 } : SPRING}
      className="absolute inset-x-1.5 inset-y-1.5 rounded-2xl bg-primary/10"
    />
  );
}
