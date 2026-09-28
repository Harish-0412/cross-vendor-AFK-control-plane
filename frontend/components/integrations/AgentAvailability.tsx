"use client";

import { useEffect, useState } from "react";
import { Loader2, Route } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "@/lib/api-client";

/** Mirrors `AgentQuota` from @odysseus/protocol. */
interface AgentQuota {
  agentId: string;
  deviceId: string;
  state: "available" | "low" | "exhausted" | "unknown";
  window?: { label: string; usedPercent?: number; resetsAt: string };
  source: "provider" | "limit-hit" | "none";
  detail: string;
}

const STATE: Record<AgentQuota["state"], { label: string; pill: string; bar: string }> = {
  exhausted: {
    label: "Out of plan",
    pill: "border-destructive/30 bg-destructive/10 text-destructive",
    bar: "bg-destructive",
  },
  low: {
    label: "Running low",
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
  },
  available: {
    label: "Available",
    pill: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
  },
  unknown: { label: "No data", pill: "border-border bg-muted text-muted-foreground", bar: "bg-muted-foreground" },
};

const ROUTING: Record<AgentQuota["state"], string> = {
  exhausted: "Skipped until it resets",
  low: "Used after the others",
  available: "Used normally",
  unknown: "Used normally",
};

/**
 * What the router does with each agent because of its subscription: skipped
 * while out of its plan window, used last while running low.
 */
export function AgentAvailability() {
  const [quotas, setQuotas] = useState<AgentQuota[] | null>(null);
  const [devices, setDevices] = useState<Record<string, string>>({});

  useEffect(() => {
    apiClient
      .get<AgentQuota[]>("/api/v1/quota")
      .then(setQuotas)
      .catch(() => setQuotas([]));
    apiClient
      .get<Array<{ id: string; friendlyName?: string }>>("/api/v1/devices")
      .then((list) =>
        setDevices(Object.fromEntries((list ?? []).map((device) => [device.id, device.friendlyName ?? device.id]))),
      )
      .catch(() => undefined);
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Route className="h-4 w-4" /> Agent availability
        </CardTitle>
        <CardDescription>
          How each agent&apos;s plan affects routing. An agent out of its window is skipped; one running low goes last.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {quotas === null ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        ) : quotas.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agents reported by your machines yet.</p>
        ) : (
          quotas.map((quota) => {
            const style = STATE[quota.state];
            const used = quota.window?.usedPercent;
            return (
              <div
                key={`${quota.deviceId}-${quota.agentId}`}
                className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">{quota.agentId}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      on {devices[quota.deviceId] ?? quota.deviceId}
                    </span>
                  </div>
                  <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${style.pill}`}>
                    {style.label}
                  </span>
                </div>
                {typeof used === "number" && (
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full rounded-full ${style.bar}`} style={{ width: `${Math.min(100, used)}%` }} />
                  </div>
                )}
                <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>{quota.detail}</span>
                  <span>{ROUTING[quota.state]}</span>
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
