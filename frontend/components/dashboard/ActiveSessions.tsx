"use client";

import Link from "next/link";
import { Activity, ArrowRight, Bot, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface SessionItem {
  id: string;
  deviceId: string;
  agentId: string;
  projectRoot: string;
  state: string;
  startedAt: string;
  createdAt: string;
  tokensUsed?: number;
  error?: string;
}

interface ActiveSessionsProps {
  sessions: SessionItem[];
  deviceMap: Record<string, string>; // deviceId -> friendlyName
}

export function ActiveSessions({ sessions, deviceMap }: ActiveSessionsProps) {
  const getStatusPill = (state: string) => {
    switch (state) {
      case "running":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            Running
          </span>
        );
      case "waiting_for_approval":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-ping" />
            Waiting Approval
          </span>
        );
      case "paused":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 py-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 border border-blue-500/20">
            Paused
          </span>
        );
      case "failed":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-0.5 text-xs font-medium text-destructive border border-destructive/20">
            Failed
          </span>
        );
      case "completed":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground border border-border">
            Completed
          </span>
        );
      default:
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
            {state}
          </span>
        );
    }
  };

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 p-8 text-center shadow-sm">
        <Activity className="h-8 w-8 text-muted-foreground mb-2" />
        <h3 className="text-sm font-semibold text-foreground">No active sessions</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          No agent tasks are currently running. Start a session from a device or click Launch Session.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 md:p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold tracking-tight">Active Sessions ({sessions.length})</h2>
        </div>
        <Link href="/sessions">
          <Button variant="ghost" size="sm" className="text-xs text-muted-foreground hover:text-foreground">
            View all
          </Button>
        </Link>
      </div>

      <div className="flex flex-col divide-y divide-border">
        {sessions.map((sess) => {
          const deviceName = deviceMap[sess.deviceId] || sess.deviceId.slice(0, 10);
          const startedDate = new Date(sess.startedAt || sess.createdAt);

          return (
            <div
              key={sess.id}
              className="group flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 first:pt-0 last:pb-0 rounded-lg -mx-2 px-2 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary shrink-0 mt-0.5 transition-all duration-300 group-hover:bg-primary group-hover:text-primary-foreground group-hover:scale-105">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-foreground font-mono">
                      {sess.id}
                    </span>
                    {getStatusPill(sess.state)}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Cpu className="h-3 w-3" />
                      {deviceName}
                    </span>
                    <span>•</span>
                    <span className="font-mono bg-muted px-1.5 py-0.2 rounded text-[11px]">
                      {sess.agentId}
                    </span>
                    <span>•</span>
                    <span>Started {startedDate.toLocaleTimeString()}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:ml-auto">
                <Link href={`/sessions/${sess.id}`}>
                  <Button size="sm" variant="outline" className="gap-1 text-xs">
                    Monitor <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
