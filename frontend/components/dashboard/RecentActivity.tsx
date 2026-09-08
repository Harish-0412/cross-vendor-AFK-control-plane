"use client";

import { CheckCircle2, Play, ShieldAlert, Monitor, Activity } from "lucide-react";
import Link from "next/link";
import type { SessionItem } from "./ActiveSessions";
import type { PendingApprovalItem } from "./AttentionNeeded";

interface RecentActivityProps {
  recentSessions: SessionItem[];
  approvals: PendingApprovalItem[];
  deviceCount: number;
}

export function RecentActivity({ recentSessions, approvals, deviceCount }: RecentActivityProps) {
  const events = [
    ...recentSessions.slice(0, 5).map((s) => ({
      id: s.id,
      title: s.state === 'completed' ? `Completed: ${s.id}` : `Session ${s.state}: ${s.id}`,
      time: new Date(s.startedAt || s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      icon: s.state === 'completed' ? CheckCircle2 : s.state === 'failed' ? ShieldAlert : Play,
      color: s.state === 'completed' ? "text-emerald-500" : s.state === 'failed' ? "text-destructive" : "text-blue-500",
      bg: s.state === 'completed' ? "bg-emerald-500/10" : s.state === 'failed' ? "bg-destructive/10" : "bg-blue-500/10",
      link: `/sessions/${s.id}`,
    })),
    ...approvals.slice(0, 3).map((a) => ({
      id: a.id,
      title: `Approval: ${a.actionType}`,
      time: new Date(a.requestedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      icon: ShieldAlert,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      link: `/sessions/${a.sessionId}`,
    })),
  ];

  if (events.length === 0) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-6 shadow-sm h-full">
        <h2 className="text-base font-semibold tracking-tight text-foreground">Activity Timeline</h2>
        <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground text-xs">
          <Activity className="h-6 w-6 mb-2 text-muted-foreground/50" />
          No recent activity logged yet.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-6 shadow-sm h-full">
      <h2 className="text-base font-semibold tracking-tight text-foreground">Activity Timeline</h2>
      <div className="flex flex-col gap-4">
        {events.map((evt, i) => (
          <div key={evt.id} className="flex items-start gap-3 relative">
            {i !== events.length - 1 && (
              <div className="absolute left-[15px] top-8 bottom-[-16px] w-[2px] bg-border/50" />
            )}
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${evt.bg} z-10 ring-4 ring-card`}
            >
              <evt.icon className={`h-4 w-4 ${evt.color}`} />
            </div>
            <div className="flex flex-col pt-1">
              <Link
                href={evt.link}
                className="text-xs font-semibold text-foreground hover:text-primary transition-colors font-mono line-clamp-1"
              >
                {evt.title}
              </Link>
              <span className="text-[10px] text-muted-foreground">{evt.time}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
