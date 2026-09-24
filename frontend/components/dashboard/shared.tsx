"use client";

/**
 * Pieces both dashboards are built from.
 *
 * The desktop and phone dashboards arrange things very differently, but the
 * facts they show — and how a session's state or a machine's status is worded
 * and coloured — must be identical, so those live here once.
 */
import Link from "next/link";
import { motion } from "motion/react";
import {
  Apple,
  ArrowRight,
  Link2,
  Monitor,
  MonitorUp,
  OctagonAlert,
  RefreshCw,
  Terminal,
  Wrench,
} from "lucide-react";

import { EASE_OUT, LiveDot } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { formatRelative, windowViews, type ProviderUsageEntry } from "@/lib/ai-integrations";
import {
  useFinishedSessions,
  useLiveSessions,
  usePendingApprovals,
  useWorkspace,
  type DeviceSummary,
  type SessionSummary,
} from "@/lib/workspace-store";
import { cn } from "@/lib/utils";

// ------------------------------------------------------------------- data

export function useDashboard() {
  const devices = useWorkspace((state) => state.devices);
  const loaded = useWorkspace((state) => state.loaded);
  const refreshing = useWorkspace((state) => state.refreshing);
  const refresh = useWorkspace((state) => state.refresh);
  const usage = useWorkspace((state) => state.usage.data);
  const approvals = usePendingApprovals();
  const live = useLiveSessions();
  const finished = useFinishedSessions();

  const online = devices.data.filter((device) => device.online);
  const deviceName = (id: string) =>
    devices.data.find((device) => device.id === id)?.friendlyName ?? `Machine ${id.slice(-6)}`;

  return {
    loaded,
    refreshing,
    refresh,
    devices: devices.data,
    devicesError: devices.error,
    online,
    approvals,
    live,
    finished,
    usage,
    deviceName,
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;

export function greeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** One sentence that says how things are, before any numbers. */
export function summary(d: Dashboard): { text: string; tone: "success" | "warning" | "danger" | "muted" } {
  if (d.devicesError && d.devices.length === 0)
    return { text: "The machine list could not be loaded", tone: "danger" };
  if (d.devices.length === 0) return { text: "Pair a machine to get started", tone: "muted" };
  if (d.approvals.length > 0)
    return {
      text: `${d.approvals.length} ${d.approvals.length === 1 ? "decision is" : "decisions are"} waiting for you`,
      tone: "warning",
    };
  if (d.online.length === 0) return { text: "Your machines are offline", tone: "danger" };
  if (d.live.length > 0)
    return {
      text: `${d.live.length} ${d.live.length === 1 ? "agent is" : "agents are"} working — nothing needs you`,
      tone: "success",
    };
  return { text: "All clear. Nothing is running and nothing needs you", tone: "success" };
}

// --------------------------------------------------------------- wording

const AGENT_NAMES: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  claude: "Claude Code",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  mock: "Mock agent",
};

export const agentLabel = (id: string) => AGENT_NAMES[id] ?? id;

export function sessionState(state: string): {
  label: string;
  tone: "success" | "warning" | "danger" | "muted" | "primary";
  live: boolean;
} {
  switch (state) {
    case "running":
      return { label: "Running", tone: "success", live: true };
    case "initializing":
      return { label: "Starting", tone: "primary", live: true };
    case "waiting_for_approval":
      return { label: "Needs you", tone: "warning", live: true };
    case "paused":
      return { label: "Paused", tone: "muted", live: false };
    case "completed":
      return { label: "Completed", tone: "success", live: false };
    case "failed":
    case "crashed":
      return { label: "Failed", tone: "danger", live: false };
    case "cancelled":
      return { label: "Stopped", tone: "muted", live: false };
    default:
      return { label: state.replaceAll("_", " "), tone: "muted", live: false };
  }
}

const TONE_PILL: Record<string, string> = {
  success: "border-success/25 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/12 text-warning",
  danger: "border-destructive/25 bg-destructive/10 text-destructive",
  muted: "border-border bg-muted text-muted-foreground",
  primary: "border-primary/25 bg-primary/10 text-primary",
};

export function StatePill({ state, className }: { state: string; className?: string }) {
  const s = sessionState(state);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        TONE_PILL[s.tone],
        className,
      )}
    >
      <LiveDot tone={s.tone} live={s.live} />
      {s.label}
    </span>
  );
}

export function PlatformIcon({ platform, className }: { platform: string; className?: string }) {
  if (platform === "darwin") return <Apple className={className} />;
  if (platform === "linux") return <Terminal className={className} />;
  return <Monitor className={className} />;
}

/** "C:\\Users\\me\\projects\\app" → "app"; the last folder is the recognisable part. */
export function projectName(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

export function lastSeen(device: DeviceSummary): string {
  if (device.online) return "Online now";
  const when = device.lastSeenAt ?? device.connectedAt;
  return when ? `Last seen ${formatRelative(when)}` : "Never connected";
}

export function sessionStarted(session: SessionSummary): string {
  return formatRelative(session.startedAt || session.createdAt);
}

// ---------------------------------------------------------------- blocks

/** A section heading with an optional link on the right. */
export function SectionTitle({
  title,
  count,
  href,
  linkLabel = "View all",
  icon,
}: {
  title: string;
  count?: number;
  href?: string;
  linkLabel?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
        {icon}
        {title}
        {typeof count === "number" && count > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold tabular text-muted-foreground">
            {count}
          </span>
        )}
      </h3>
      {href && (
        <Link
          href={href}
          className="group inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {linkLabel}
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}
    </div>
  );
}

/** Plan usage as small bars: each window's share used, and when it resets. */
export function UsageBars({ entries, now }: { entries: ProviderUsageEntry[]; now: number }) {
  const rows = entries.flatMap((entry) =>
    entry.snapshot.provider === "codex"
      ? windowViews(entry.snapshot, now).map((window) => ({
          key: `${entry.deviceId}:${window.name}`,
          label: `Codex · ${window.label}`,
          window,
        }))
      : [],
  );
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Connect Codex with usage access to see your plan limits here.{" "}
        <Link href="/integrations" className="font-medium text-primary hover:underline">
          Integrations
        </Link>
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {rows.map(({ key, label, window }, index) => {
        const reset = window.resetSinceReading;
        const pct = reset ? 0 : window.usedPercent;
        const tone = pct >= 80 ? "bg-destructive" : pct >= 60 ? "bg-warning" : "bg-primary";
        return (
          <div key={key} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="font-medium">{label}</span>
              <span className="tabular text-muted-foreground">
                {reset ? "reset since reading" : `${pct}% used`}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              {reset ? (
                <div className="h-full w-full rounded-full border border-dashed border-border" />
              ) : (
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.9, delay: 0.15 + index * 0.08, ease: EASE_OUT }}
                  className={cn("h-full rounded-full", tone)}
                />
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {reset
                ? "Current usage appears when Codex next runs"
                : `Resets ${formatRelative(window.resetsAt, now)}`}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** First run: what to do, in order. */
export function Onboarding({ compact = false }: { compact?: boolean }) {
  const steps = [
    {
      icon: Link2,
      title: "Pair your computer",
      body: "Run `pnpm pair` on it, then enter the code here and check the words match.",
    },
    {
      icon: Wrench,
      title: "Start the gateway",
      body: "`pnpm gateway` keeps your machine reachable. Your code never leaves it.",
    },
    {
      icon: MonitorUp,
      title: "Work from anywhere",
      body: "Launch agents, answer approvals and follow sessions from this app.",
    },
  ];
  return (
    <section className="relative overflow-clip rounded-3xl border bg-card shadow-sm">
      <div className="aurora opacity-60" />
      <div
        className={cn(
          "relative grid gap-8",
          compact ? "p-5" : "p-8 lg:grid-cols-[1.1fr_0.9fr] lg:p-10",
        )}
      >
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary backdrop-blur">
            First-time setup
          </span>
          <h2
            className={cn(
              "mt-4 font-semibold tracking-tight",
              compact ? "text-2xl" : "text-3xl lg:text-4xl",
            )}
          >
            Connect the computer that runs your{" "}
            <span className="text-gradient">coding agents</span>
          </h2>
          <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
            Credentials and source code stay on your workstation. This app only sees the session
            activity you choose to sync.
          </p>
          <Button asChild size="lg" className="mt-6 h-11 gap-2 rounded-xl shadow-[var(--glow-primary)]">
            <Link href="/devices/pair">
              Pair a machine <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <ol className="grid gap-3 self-center">
          {steps.map((step, index) => (
            <motion.li
              key={step.title}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + index * 0.1, duration: 0.45, ease: EASE_OUT }}
              className="flex gap-4 rounded-2xl border bg-background/70 p-4 backdrop-blur"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <step.icon className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-sm font-semibold">
                  {index + 1}. {step.title}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {step.body.split("`").map((part, i) =>
                    i % 2 ? (
                      <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
                        {part}
                      </code>
                    ) : (
                      part
                    ),
                  )}
                </span>
              </span>
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** The machine list failed — distinct from "you have none", which means pair one. */
export function LoadError({ message, onRetry, busy }: { message: string; onRetry: () => void; busy: boolean }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-3xl border border-destructive/30 bg-destructive/[0.05] p-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex gap-3">
        <OctagonAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div>
          <p className="font-semibold">Could not load your machines</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing has been unpaired — the control plane could not be read: {message}
          </p>
        </div>
      </div>
      <Button variant="outline" onClick={onRetry} disabled={busy} className="shrink-0 gap-2">
        <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} /> Try again
      </Button>
    </div>
  );
}

/** Placeholder with the same outline as the content it stands in for. */
export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}
