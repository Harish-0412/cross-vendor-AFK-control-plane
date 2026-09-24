"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock3,
  Cpu,
  Gauge,
  Link2,
  Monitor,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  XCircle,
} from "lucide-react";

import {
  AnimatedNumber,
  EASE_OUT,
  FadeIn,
  LiveDot,
  SPRING,
  Stagger,
  StaggerItem,
} from "@/components/motion";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/ai-integrations";
import { useAuthStore } from "@/lib/auth";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";

import {
  LoadError,
  Onboarding,
  PlatformIcon,
  SectionTitle,
  SkeletonBlock,
  StatePill,
  UsageBars,
  agentLabel,
  greeting,
  lastSeen,
  projectName,
  sessionStarted,
  summary,
  useDashboard,
  type Dashboard,
} from "./shared";

/**
 * The desktop overview: everything at once, arranged by urgency. What needs a
 * decision sits top-left where the eye lands first; the machines and plan
 * usage that explain it run down the right.
 */
export function DesktopDashboard() {
  const d = useDashboard();
  const user = useAuthStore((state) => state.user);
  const setLaunchOpen = useUiStore((state) => state.setLaunchOpen);
  const [now] = useState(() => Date.now());
  const state = summary(d);
  // With no machine list at all, every count below would be a guess dressed up
  // as a zero, so only the error is shown.
  const unreadable = Boolean(d.devicesError) && d.devices.length === 0;
  const firstRun = d.loaded && d.devices.length === 0 && !d.devicesError;

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      {/* Hero */}
      <FadeIn>
        <section className="gradient-border relative overflow-clip rounded-3xl border bg-card/80 px-8 py-7 shadow-sm backdrop-blur">
          <div className="aurora opacity-50" />
          <div className="relative flex flex-wrap items-end justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm font-medium text-muted-foreground">
                {greeting()}
                {user?.name ? `, ${user.name.split(" ")[0]}` : ""}
              </p>
              <h1 className="mt-1 text-3xl font-semibold tracking-tight xl:text-[34px]">
                {d.loaded ? (
                  <AnimatePresence mode="wait">
                    <motion.span
                      key={state.text}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.3, ease: EASE_OUT }}
                      className="inline-flex items-center gap-3"
                    >
                      <LiveDot
                        tone={state.tone}
                        live={state.tone === "warning" || state.tone === "success"}
                        className="scale-150"
                      />
                      {state.text}
                    </motion.span>
                  </AnimatePresence>
                ) : (
                  <SkeletonBlock className="h-9 w-[28rem]" />
                )}
              </h1>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => void d.refresh()}
                disabled={d.refreshing}
                className="h-10 w-10 rounded-xl bg-background/70"
                aria-label="Refresh"
              >
                <RefreshCw className={cn("h-4 w-4", d.refreshing && "animate-spin")} />
              </Button>
              <Button asChild variant="outline" className="h-10 gap-2 rounded-xl bg-background/70">
                <Link href="/devices/pair">
                  <Link2 className="h-4 w-4" /> Pair machine
                </Link>
              </Button>
              <Button
                onClick={() => setLaunchOpen(true)}
                className="h-10 gap-2 rounded-xl shadow-[var(--glow-primary)]"
              >
                <Play className="h-4 w-4 fill-current" /> Launch agent
              </Button>
            </div>
          </div>
        </section>
      </FadeIn>

      {unreadable ? (
        <LoadError
          message={d.devicesError ?? ""}
          onRetry={() => void d.refresh()}
          busy={d.refreshing}
        />
      ) : firstRun ? (
        <FadeIn delay={0.1}>
          <Onboarding />
        </FadeIn>
      ) : (
        <>
          <Kpis d={d} />

          <div className="grid gap-6 xl:grid-cols-3">
            <div className="flex flex-col gap-6 xl:col-span-2">
              <FadeIn delay={0.15}>
                <ApprovalsPanel d={d} />
              </FadeIn>
              <FadeIn delay={0.22}>
                <LiveSessionsPanel d={d} />
              </FadeIn>
            </div>
            <div className="flex flex-col gap-6">
              <FadeIn delay={0.18}>
                <MachinesPanel d={d} />
              </FadeIn>
              <FadeIn delay={0.25}>
                <section className="surface p-5">
                  <SectionTitle
                    title="Plan usage"
                    href="/budgets"
                    linkLabel="Budgets"
                    icon={<Gauge className="h-4 w-4 text-primary" />}
                  />
                  <div className="mt-4">
                    {d.loaded ? (
                      <UsageBars entries={d.usage} now={now} />
                    ) : (
                      <SkeletonBlock className="h-16" />
                    )}
                  </div>
                </section>
              </FadeIn>
              <FadeIn delay={0.32}>
                <ActivityPanel d={d} />
              </FadeIn>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- KPIs

function Kpis({ d }: { d: Dashboard }) {
  const cards = [
    {
      label: "Machines online",
      value: d.online.length,
      suffix: ` / ${d.devices.length}`,
      icon: Monitor,
      tint: "text-chart-5 bg-chart-5/12",
      ring: d.devices.length ? d.online.length / d.devices.length : 0,
      caption: d.devices.length === 0 ? "None paired" : d.online.length ? "Reachable now" : "All offline",
      href: "/devices",
    },
    {
      label: "Running now",
      value: d.live.length,
      icon: Activity,
      tint: "text-success bg-success/12",
      caption: d.live.length ? "Agents at work" : "Nothing running",
      href: "/sessions",
    },
    {
      label: "Needs you",
      value: d.approvals.length,
      icon: ShieldCheck,
      tint: d.approvals.length ? "text-warning bg-warning/15" : "text-muted-foreground bg-muted",
      caption: d.approvals.length ? "Waiting on a decision" : "All clear",
      href: "/approvals",
      urgent: d.approvals.length > 0,
    },
    {
      label: "Finished",
      value: d.finished.length,
      icon: CheckCircle2,
      tint: "text-chart-1 bg-chart-1/12",
      caption: "Completed, failed or stopped",
      href: "/sessions",
    },
  ];

  return (
    <Stagger className="grid grid-cols-2 gap-4 xl:grid-cols-4" stagger={0.07}>
      {cards.map((card) => (
        <StaggerItem key={card.label}>
          <Link
            href={card.href}
            className={cn(
              "surface surface-interactive group relative flex h-full flex-col gap-4 overflow-hidden p-5",
              card.urgent && "border-warning/40 shadow-[0_0_0_1px_color-mix(in_oklab,var(--warning)_25%,transparent)]",
            )}
          >
            {card.urgent && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_0%,color-mix(in_oklab,var(--warning)_22%,transparent),transparent_60%)]"
              />
            )}
            <div className="flex items-center justify-between">
              <span className={cn("flex h-10 w-10 items-center justify-center rounded-xl", card.tint)}>
                <card.icon className="h-5 w-5" />
              </span>
              {"ring" in card && typeof card.ring === "number" ? (
                <Ring value={card.ring} />
              ) : (
                <ArrowRight className="h-4 w-4 -translate-x-1 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
              )}
            </div>
            <div>
              <p className="text-3xl font-semibold tracking-tight tabular">
                {d.loaded ? <AnimatedNumber value={card.value} /> : <SkeletonBlock className="h-8 w-12" />}
                {d.loaded && card.suffix && (
                  <span className="text-lg font-medium text-muted-foreground">{card.suffix}</span>
                )}
              </p>
              <p className="mt-1 text-sm font-medium">{card.label}</p>
              <p className="text-xs text-muted-foreground">{card.caption}</p>
            </div>
          </Link>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/** A small progress ring that draws itself in. */
function Ring({ value }: { value: number }) {
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 36 36" className="h-9 w-9 -rotate-90" aria-hidden>
      <circle cx="18" cy="18" r={radius} className="fill-none stroke-muted" strokeWidth="3.5" />
      <motion.circle
        cx="18"
        cy="18"
        r={radius}
        className="fill-none stroke-success"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: circumference * (1 - value) }}
        transition={{ duration: 1.1, delay: 0.3, ease: EASE_OUT }}
      />
    </svg>
  );
}

// ------------------------------------------------------------------ panels

function ApprovalsPanel({ d }: { d: Dashboard }) {
  if (d.loaded && d.approvals.length === 0) {
    return (
      <section className="surface flex items-center gap-4 p-5">
        <motion.span
          initial={{ scale: 0.6, rotate: -20 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={SPRING}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-success/12 text-success"
        >
          <ShieldCheck className="h-6 w-6" />
        </motion.span>
        <div>
          <p className="font-semibold">Nothing needs your decision</p>
          <p className="text-sm text-muted-foreground">
            Agents that hit an action your policy guards will pause and show up here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="surface overflow-hidden border-warning/35 p-0">
      <div className="flex items-center justify-between border-b border-warning/20 bg-warning/[0.07] px-5 py-3.5">
        <SectionTitle
          title="Needs your decision"
          count={d.approvals.length}
          icon={<ShieldCheck className="h-4 w-4 text-warning" />}
        />
        <Link href="/approvals" className="text-xs font-medium text-muted-foreground hover:text-foreground">
          All approvals
        </Link>
      </div>
      <Stagger as="ul" className="divide-y" stagger={0.05}>
        {!d.loaded
          ? [0, 1].map((key) => (
              <li key={key} className="px-5 py-4">
                <SkeletonBlock className="h-10" />
              </li>
            ))
          : d.approvals.slice(0, 5).map((approval) => (
              <StaggerItem as="li" key={approval.id}>
                <Link
                  href={`/sessions/${approval.sessionId}`}
                  className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/40"
                >
                  <span className="attention-pulse flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning [--pulse-color:color-mix(in_oklab,var(--warning)_45%,transparent)]">
                    <ShieldCheck className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {approval.description || "An agent is asking for approval"}
                    </p>
                    <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                        {approval.actionType}
                      </span>
                      <span>{d.deviceName(approval.deviceId)}</span>
                      <span>·</span>
                      <span>{formatRelative(approval.requestedAt)}</span>
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-transform group-hover:translate-x-0.5">
                    Review <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </Link>
              </StaggerItem>
            ))}
      </Stagger>
    </section>
  );
}

function LiveSessionsPanel({ d }: { d: Dashboard }) {
  return (
    <section className="surface p-5">
      <SectionTitle
        title="Running now"
        count={d.live.length}
        href="/sessions"
        icon={<Activity className="h-4 w-4 text-success" />}
      />
      <div className="mt-4">
        {!d.loaded ? (
          <div className="space-y-3">
            <SkeletonBlock className="h-16" />
            <SkeletonBlock className="h-16" />
          </div>
        ) : d.live.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed py-10 text-center">
            <Bot className="h-8 w-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium">No agents are running</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              Launch one on an online machine and follow it from here.
            </p>
          </div>
        ) : (
          <Stagger as="ul" className="space-y-2.5" stagger={0.05}>
            {d.live.slice(0, 6).map((session) => (
              <StaggerItem as="li" key={session.id}>
                <Link
                  href={`/sessions/${session.id}`}
                  className="group relative flex items-center gap-4 overflow-hidden rounded-2xl border bg-background/50 p-4 transition-all hover:border-primary/35 hover:bg-background hover:shadow-md"
                >
                  {session.state === "running" && <span className="progress-sweep" aria-hidden />}
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all group-hover:bg-primary group-hover:text-primary-foreground">
                    <Bot className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{projectName(session.projectRoot)}</span>
                      <StatePill state={session.state} />
                    </div>
                    <p className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Sparkles className="h-3 w-3" /> {agentLabel(session.agentId)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Cpu className="h-3 w-3" /> {d.deviceName(session.deviceId)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="h-3 w-3" /> {sessionStarted(session)}
                      </span>
                    </p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </Link>
              </StaggerItem>
            ))}
          </Stagger>
        )}
      </div>
    </section>
  );
}

function MachinesPanel({ d }: { d: Dashboard }) {
  return (
    <section className="surface p-5">
      <SectionTitle
        title="Machines"
        count={d.devices.length}
        href="/devices"
        icon={<Monitor className="h-4 w-4 text-chart-5" />}
      />
      <div className="mt-4 space-y-2">
        {!d.loaded ? (
          <SkeletonBlock className="h-14" />
        ) : (
          d.devices.slice(0, 5).map((device) => (
            <Link
              key={device.id}
              href={`/devices/${device.id}`}
              className="group flex items-center gap-3 rounded-xl p-2.5 transition-colors hover:bg-muted/60"
            >
              <span
                className={cn(
                  "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
                  device.online ? "bg-success/12 text-success" : "bg-muted text-muted-foreground",
                )}
              >
                <PlatformIcon platform={device.platform} className="h-5 w-5" />
                <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-card">
                  <LiveDot tone={device.online ? "success" : "muted"} live={device.online} />
                </span>
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{device.friendlyName}</p>
                <p className="text-xs text-muted-foreground">
                  {device.online && device.activeSessionCount > 0
                    ? `${device.activeSessionCount} running`
                    : lastSeen(device)}
                </p>
              </div>
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

function ActivityPanel({ d }: { d: Dashboard }) {
  const events = d.finished.slice(0, 6);
  return (
    <section className="surface p-5">
      <SectionTitle title="Recent activity" href="/sessions" linkLabel="Sessions" />
      {events.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Finished sessions will appear here.</p>
      ) : (
        <ol className="relative mt-4 space-y-4 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-border">
          {events.map((session, index) => {
            const failed = session.state === "failed" || session.state === "crashed";
            const Icon = failed ? XCircle : CheckCircle2;
            return (
              <motion.li
                key={session.id}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.3 + index * 0.06, duration: 0.35, ease: EASE_OUT }}
                className="relative flex gap-3"
              >
                <span
                  className={cn(
                    "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-4 ring-card",
                    failed ? "bg-destructive/12 text-destructive" : "bg-success/12 text-success",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <Link href={`/sessions/${session.id}`} className="min-w-0 pt-0.5 hover:text-primary">
                  <p className="truncate text-sm font-medium">
                    {agentLabel(session.agentId)} · {projectName(session.projectRoot)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {failed ? "Failed" : session.state === "cancelled" ? "Stopped" : "Completed"}{" "}
                    {formatRelative(session.updatedAt ?? session.startedAt ?? session.createdAt)}
                  </p>
                </Link>
              </motion.li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
