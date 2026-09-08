"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Monitor, Activity, ShieldAlert, CheckCircle2 } from "lucide-react";

interface StatsGridProps {
  onlineDevices: number;
  totalDevices: number;
  activeSessions: number;
  pendingApprovals: number;
  completedSessions: number;
}

function useCountUp(target: number, duration = 900) {
  const [value, setValue] = useState(0);
  const prevRef = useRef(0);

  useEffect(() => {
    const from = prevRef.current;
    const start = performance.now();
    const delta = target - from;
    if (delta === 0) return;
    let raf: number;

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + delta * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else prevRef.current = target;
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

function StatValue({ raw, format }: { raw: string; format?: (v: number) => string }) {
  const [numStr, denomStr] = raw.split("/");
  const num = parseInt(numStr, 10) || 0;
  const denom = denomStr ? parseInt(denomStr, 10) || 0 : undefined;
  const animated = useCountUp(num);

  return (
    <div className="mt-2 text-2xl lg:text-3xl font-bold tracking-tight text-foreground font-mono tabular-nums">
      {format ? format(animated) : animated}
      {denom !== undefined && (
        <span className="text-muted-foreground/60 text-xl"> / {denom}</span>
      )}
    </div>
  );
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
      hoverBorder: "hover:border-blue-500/40",
    },
    {
      name: "Active Sessions",
      value: activeSessions.toString(),
      icon: Activity,
      color: "text-emerald-500",
      bg: "bg-emerald-500/10",
      hoverBorder: "hover:border-emerald-500/40",
    },
    {
      name: "Pending Approvals",
      value: pendingApprovals.toString(),
      icon: ShieldAlert,
      color: pendingApprovals > 0 ? "text-amber-500" : "text-muted-foreground",
      bg: pendingApprovals > 0 ? "bg-amber-500/10" : "bg-muted",
      hoverBorder: pendingApprovals > 0 ? "hover:border-amber-500/40" : "hover:border-border",
    },
    {
      name: "Completed Sessions",
      value: completedSessions.toString(),
      icon: CheckCircle2,
      color: "text-purple-500",
      bg: "bg-purple-500/10",
      hoverBorder: "hover:border-purple-500/40",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      {stats.map((stat, i) => (
        <motion.div
          key={stat.name}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.08 + i * 0.07, ease: [0.22, 1, 0.36, 1] }}
          whileHover={{ y: -3 }}
          className={`group flex flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm transition-colors duration-300 ${stat.hoverBorder} relative overflow-hidden`}
        >
          <div
            className={`pointer-events-none absolute -top-10 -right-10 h-24 w-24 rounded-full blur-2xl opacity-0 transition-opacity duration-500 group-hover:opacity-60 ${stat.bg}`}
          />
          <div className="flex items-center gap-2">
            <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${stat.bg} transition-transform duration-300 group-hover:scale-110`}>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </div>
            <span className="text-sm font-medium text-muted-foreground">{stat.name}</span>
          </div>
          <StatValue raw={stat.value} />
        </motion.div>
      ))}
    </div>
  );
}