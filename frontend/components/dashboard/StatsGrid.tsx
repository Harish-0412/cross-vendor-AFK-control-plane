"use client";

import { Monitor, Activity, ShieldAlert, CheckCircle2 } from "lucide-react";

interface StatsGridProps {
  onlineDevices: number;
  totalDevices: number;
  activeSessions: number;
  pendingApprovals: number;
  completedSessions: number;
}

export function StatsGrid({
  onlineDevices,
  totalDevices,
  activeSessions,
  pendingApprovals,
  completedSessions,
}: StatsGridProps) {
  const stats = [
    {
      name: "Online Devices",
      value: `${onlineDevices} / ${totalDevices}`,
      icon: Monitor,
      color: "text-blue-500",
      bg: "bg-blue-500/10",
    },
    {
      name: "Active Sessions",
      value: activeSessions.toString(),
      icon: Activity,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
    },
    {
      name: "Pending Approvals",
      value: pendingApprovals.toString(),
      icon: ShieldAlert,
      color: pendingApprovals > 0 ? "text-amber-500" : "text-muted-foreground",
      bg: pendingApprovals > 0 ? "bg-amber-500/10" : "bg-muted",
    },
    {
      name: "Completed Sessions",
      value: completedSessions.toString(),
      icon: CheckCircle2,
      color: "text-purple-500",
      bg: "bg-purple-500/10",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.name}
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm"
        >
          <div className="flex items-center gap-2">
            <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${stat.bg}`}>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </div>
            <span className="text-sm font-medium text-muted-foreground">{stat.name}</span>
          </div>
          <div className="mt-2 text-2xl lg:text-3xl font-bold tracking-tight text-foreground font-mono">
            {stat.value}
          </div>
        </div>
      ))}
    </div>
  );
}
