"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Gauge,
  History,
  Link2,
  Monitor,
  Play,
  Plug,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WifiOff,
} from "lucide-react";

import {
  AnimatedNumber,
  EASE_OUT,
  FadeIn,
  LiveDot,
  Pressable,
  Stagger,
  StaggerItem,
} from "@/components/motion";
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
 * The phone overview, built for a glance and a thumb.
 *
 * It answers one question first — do I need to do anything? — with one large
 * card and one large button. Everything else is a single column of cards you
 * scroll, with the swipeable rails for things that come in sets.
 */
export function MobileDashboard() {
  const d = useDashboard();
  const user = useAuthStore((state) => state.user);
  const [now] = useState(() => Date.now());
  // With no machine list at all, "all clear" and a row of zeros would be a
  // guess, so only the error is shown.
  const unreadable = Boolean(d.devicesError) && d.devices.length === 0;
  const firstRun = d.loaded && d.devices.length === 0 && !d.devicesError;

  return (
    <div className="flex flex-col gap-6">
      <FadeIn className="flex items-start justify-between gap-3 pt-1">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            {greeting()}
            {user?.name ? `, ${user.name.split(" ")[0]}` : ""}
          </p>
          <h1 className="mt-0.5 text-[26px] font-semibold leading-tight tracking-tight">
            {d.loaded ? summary(d).text : <SkeletonBlock className="h-8 w-56" />}
          </h1>
        </div>
        <motion.button
          type="button"
          whileTap={{ rotate: 180, scale: 0.9 }}
          onClick={() => void d.refresh()}
          disabled={d.refreshing}
          className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border bg-card shadow-sm"
          aria-label="Refresh"
        >
          <RefreshCw className={cn("h-4 w-4", d.refreshing && "animate-spin")} />
        </motion.button>
      </FadeIn>

      {unreadable ? (
        <LoadError
          message={d.devicesError ?? ""}
          onRetry={() => void d.refresh()}
          busy={d.refreshing}
        />
      ) : firstRun ? (
        <FadeIn delay={0.08}>
          <Onboarding compact />
        </FadeIn>
      ) : (
        <>
          <FadeIn delay={0.05}>
            <StatusCard d={d} />
          </FadeIn>

          <KpiRail d={d} />

          {d.approvals.length > 0 && <ApprovalCards d={d} />}

          <FadeIn delay={0.15}>
            <section className="space-y-3">
              <SectionTitle
                title="Running now"
                count={d.live.length}
                href="/sessions"
                icon={<Activity className="h-4 w-4 text-success" />}
              />
              {!d.loaded ? (
                <SkeletonBlock className="h-20 rounded-2xl" />
              ) : d.live.length === 0 ? (
                <p className="rounded-2xl border border-dashed p-5 text-center text-sm text-muted-foreground">
                  No agents are running.
                </p>
              ) : (
                <Stagger className="space-y-2.5" stagger={0.05}>
                  {d.live.slice(0, 5).map((session) => (
                    <StaggerItem key={session.id}>
                      <Pressable>
                        <Link
                          href={`/sessions/${session.id}`}
                          className="surface relative flex items-center gap-3 overflow-hidden p-4"
                        >
                          {session.state === "running" && <span className="progress-sweep" aria-hidden />}
                          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                            <Bot className="h-5 w-5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold">{projectName(session.projectRoot)}</p>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">
                              {agentLabel(session.agentId)} · {d.deviceName(session.deviceId)} ·{" "}
                              {sessionStarted(session)}
                            </p>
                            <StatePill state={session.state} className="mt-2" />
                          </div>
                          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
                        </Link>
                      </Pressable>
                    </StaggerItem>
                  ))}
                </Stagger>
              )}
            </section>
          </FadeIn>

          <FadeIn delay={0.2}>
            <section className="space-y-3">
              <SectionTitle
                title="Machines"
                count={d.devices.length}
                href="/devices"
                icon={<Monitor className="h-4 w-4 text-chart-5" />}
              />
              <div className="snap-rail no-scrollbar -mx-4 px-4 pb-1">
                {!d.loaded ? (
                  <SkeletonBlock className="h-28 w-60 rounded-2xl" />
                ) : (
                  d.devices.map((device) => (
                    <Pressable key={device.id} className="w-[72%] max-w-[260px]">
                      <Link
                        href={`/devices/${device.id}`}
                        className={cn(
                          "surface flex h-full flex-col gap-3 p-4",
                          device.online && "border-success/30",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={cn(
                              "flex h-10 w-10 items-center justify-center rounded-xl",
                              device.online
                                ? "bg-success/12 text-success"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            <PlatformIcon platform={device.platform} className="h-5 w-5" />
                          </span>
                          <LiveDot tone={device.online ? "success" : "muted"} live={device.online} />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{device.friendlyName}</p>
                          <p className="text-xs text-muted-foreground">
                            {device.online && device.activeSessionCount > 0
                              ? `${device.activeSessionCount} running`
                              : lastSeen(device)}
                          </p>
                        </div>
                      </Link>
                    </Pressable>
                  ))
                )}
                <Pressable className="w-[40%] max-w-[150px]">
                  <Link
                    href="/devices/pair"
                    className="flex h-full min-h-[112px] flex-col items-center justify-center gap-2 rounded-[calc(var(--radius)+6px)] border border-dashed text-sm font-medium text-muted-foreground"
                  >
                    <Link2 className="h-5 w-5" />
                    Pair new
                  </Link>
                </Pressable>
              </div>
            </section>
          </FadeIn>

          <FadeIn delay={0.25}>
            <section className="space-y-3">
              <SectionTitle title="Quick actions" />
              <div className="grid grid-cols-2 gap-2.5">
                <QuickAction icon={Play} label="Launch agent" launch />
                <QuickAction icon={History} label="History" href="/history" />
                <QuickAction icon={Plug} label="Integrations" href="/integrations" />
                <QuickAction icon={Gauge} label="Budgets" href="/budgets" />
              </div>
            </section>
          </FadeIn>

          <FadeIn delay={0.3}>
            <section className="surface space-y-4 p-4">
              <SectionTitle
                title="Plan usage"
                href="/budgets"
                linkLabel="Details"
                icon={<Gauge className="h-4 w-4 text-primary" />}
              />
              {d.loaded ? <UsageBars entries={d.usage} now={now} /> : <SkeletonBlock className="h-14" />}
            </section>
          </FadeIn>

          {d.finished.length > 0 && (
            <FadeIn delay={0.35}>
              <section className="space-y-3">
                <SectionTitle title="Recently finished" href="/sessions" />
                <ul className="surface divide-y overflow-hidden">
                  {d.finished.slice(0, 4).map((session) => {
                    const failed = session.state === "failed" || session.state === "crashed";
                    return (
                      <li key={session.id}>
                        <Link
                          href={`/sessions/${session.id}`}
                          className="flex items-center gap-3 px-4 py-3 active:bg-muted/60"
                        >
                          <CheckCircle2
                            className={cn("h-5 w-5 shrink-0", failed ? "text-destructive" : "text-success")}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">
                              {projectName(session.projectRoot)}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {agentLabel(session.agentId)} ·{" "}
                              {formatRelative(session.updatedAt ?? session.startedAt ?? session.createdAt)}
                            </span>
                          </span>
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            </FadeIn>
          )}
        </>
      )}
    </div>
  );
}

/** The answer to "do I need to do anything?", with the one action that follows. */
function StatusCard({ d }: { d: Dashboard }) {
  const setLaunchOpen = useUiStore((state) => state.setLaunchOpen);

  if (!d.loaded) return <SkeletonBlock className="h-40 rounded-3xl" />;

  const waiting = d.approvals.length;
  const offline = d.devices.length > 0 && d.online.length === 0;

  const variant = waiting > 0 ? "warning" : offline ? "offline" : "clear";
  const content = {
    warning: {
      icon: ShieldCheck,
      eyebrow: "Action needed",
      title: `${waiting} ${waiting === 1 ? "agent is" : "agents are"} waiting for you`,
      body: "They are paused until you decide.",
      cta: "Review now",
      href: waiting === 1 && d.approvals[0] ? `/sessions/${d.approvals[0].sessionId}` : "/approvals",
      className: "bg-gradient-to-br from-warning/25 via-warning/10 to-card border-warning/40",
      iconClass: "bg-warning text-warning-foreground",
    },
    offline: {
      icon: WifiOff,
      eyebrow: "Machines offline",
      title: "No machine is reachable",
      body: "Start the gateway on your computer to get back online.",
      cta: "View machines",
      href: "/devices",
      className: "bg-gradient-to-br from-destructive/20 via-destructive/5 to-card border-destructive/30",
      iconClass: "bg-destructive text-destructive-foreground",
    },
    clear: {
      icon: d.live.length ? Sparkles : CheckCircle2,
      eyebrow: d.live.length ? "Working" : "All clear",
      title: d.live.length
        ? `${d.live.length} ${d.live.length === 1 ? "agent is" : "agents are"} running`
        : "Everything is quiet",
      body: d.live.length ? "Nothing needs you right now." : "Start an agent and walk away.",
      cta: "Launch an agent",
      href: null,
      className: "bg-gradient-to-br from-primary/20 via-primary/5 to-card border-primary/25",
      iconClass: "bg-brand-gradient text-white",
    },
  }[variant];

  return (
    <AnimatePresence mode="wait">
      <motion.section
        key={variant}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ duration: 0.35, ease: EASE_OUT }}
        className={cn("relative overflow-hidden rounded-3xl border p-5 shadow-sm", content.className)}
      >
        <div className="flex items-start gap-4">
          <span
            className={cn(
              "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl shadow-md",
              content.iconClass,
              variant === "warning" && "attention-pulse [--pulse-color:color-mix(in_oklab,var(--warning)_50%,transparent)]",
            )}
          >
            <content.icon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {content.eyebrow}
            </p>
            <p className="mt-1 text-lg font-semibold leading-snug">{content.title}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{content.body}</p>
          </div>
        </div>
        {content.href ? (
          <Link
            href={content.href}
            className="mt-5 flex h-12 items-center justify-center gap-2 rounded-2xl bg-foreground text-sm font-semibold text-background shadow-md transition-transform active:scale-[0.98]"
          >
            {content.cta} <ArrowRight className="h-4 w-4" />
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setLaunchOpen(true)}
            className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-gradient text-sm font-semibold text-white shadow-[var(--glow-primary)] transition-transform active:scale-[0.98]"
          >
            <Play className="h-4 w-4 fill-current" /> {content.cta}
          </button>
        )}
      </motion.section>
    </AnimatePresence>
  );
}

function KpiRail({ d }: { d: Dashboard }) {
  const chips = [
    { label: "Online", value: d.online.length, of: d.devices.length, icon: Monitor, tone: "text-chart-5", href: "/devices" },
    { label: "Running", value: d.live.length, icon: Activity, tone: "text-success", href: "/sessions" },
    {
      label: "Waiting",
      value: d.approvals.length,
      icon: ShieldCheck,
      tone: d.approvals.length ? "text-warning" : "text-muted-foreground",
      href: "/approvals",
    },
    { label: "Finished", value: d.finished.length, icon: CheckCircle2, tone: "text-chart-1", href: "/sessions" },
  ];
  return (
    <Stagger className="snap-rail no-scrollbar -mx-4 px-4" stagger={0.05}>
      {chips.map((chip) => (
        <StaggerItem key={chip.label} className="w-[38%] min-w-[128px]">
          <Link href={chip.href} className="surface flex flex-col gap-2 p-3.5 active:scale-[0.97]">
            <chip.icon className={cn("h-5 w-5", chip.tone)} />
            <p className="text-2xl font-semibold tracking-tight tabular">
              {d.loaded ? <AnimatedNumber value={chip.value} /> : "–"}
              {"of" in chip && typeof chip.of === "number" && d.loaded && (
                <span className="text-base font-medium text-muted-foreground">/{chip.of}</span>
              )}
            </p>
            <p className="text-xs font-medium text-muted-foreground">{chip.label}</p>
          </Link>
        </StaggerItem>
      ))}
    </Stagger>
  );
}

function ApprovalCards({ d }: { d: Dashboard }) {
  return (
    <FadeIn delay={0.1}>
      <section className="space-y-3">
        <SectionTitle
          title="Needs your decision"
          count={d.approvals.length}
          href="/approvals"
          icon={<ShieldCheck className="h-4 w-4 text-warning" />}
        />
        <Stagger className="space-y-2.5" stagger={0.06}>
          {d.approvals.slice(0, 4).map((approval) => (
            <StaggerItem key={approval.id}>
              <div className="surface space-y-3 border-warning/35 p-4">
                <div className="flex items-start gap-3">
                  <span className="mt-1">
                    <LiveDot tone="warning" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold leading-snug">
                      {approval.description || "An agent is asking for approval"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">
                        {approval.actionType}
                      </span>{" "}
                      · {d.deviceName(approval.deviceId)} · {formatRelative(approval.requestedAt)}
                    </p>
                  </div>
                </div>
                <Link
                  href={`/sessions/${approval.sessionId}`}
                  className="flex h-11 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
                >
                  Review and decide <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </section>
    </FadeIn>
  );
}

function QuickAction({
  icon: Icon,
  label,
  href,
  launch = false,
}: {
  icon: typeof Play;
  label: string;
  href?: string;
  launch?: boolean;
}) {
  const setLaunchOpen = useUiStore((state) => state.setLaunchOpen);
  const inner = (
    <>
      <span
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-xl",
          launch ? "bg-brand-gradient text-white shadow-md" : "bg-muted text-foreground",
        )}
      >
        <Icon className={cn("h-5 w-5", launch && "fill-current")} />
      </span>
      <span className="text-sm font-semibold">{label}</span>
    </>
  );
  const className = "surface flex items-center gap-3 p-3.5";
  return (
    <Pressable>
      {launch ? (
        <button type="button" onClick={() => setLaunchOpen(true)} className={cn(className, "w-full text-left")}>
          {inner}
        </button>
      ) : (
        <Link href={href ?? "/"} className={className}>
          {inner}
        </Link>
      )}
    </Pressable>
  );
}
