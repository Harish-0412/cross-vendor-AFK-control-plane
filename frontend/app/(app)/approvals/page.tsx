"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldAlert, CheckCircle2, ArrowRight, RefreshCw, Clock, Bot, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";

interface ApprovalItem {
  id: string;
  sessionId: string;
  deviceId: string;
  actionType: string;
  description: string;
  status: string;
  requestedAt: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchApprovals = async () => {
    try {
      const data = await apiClient.get<ApprovalItem[]>("/api/v1/approvals");
      setApprovals(data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void fetchApprovals();

    const interval = setInterval(() => {
      void fetchApprovals();
    }, 10_000);

    const unsub = realtimeClient.subscribeAllEvents((msg) => {
      if (
        msg.eventType === "session.approval_required" ||
        msg.eventType === "session.approval_decided"
      ) {
        void fetchApprovals();
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, []);

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
            Pending Approvals
          </h1>
          <p className="text-sm text-muted-foreground">
            Review critical agent action requests requiring human consent.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setRefreshing(true);
            void fetchApprovals();
          }}
          disabled={refreshing}
          className="gap-1.5 text-xs self-start sm:self-auto"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {approvals.length === 0 && !loading ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-12 text-center shadow-sm">
          <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-3" />
          <h3 className="text-base font-semibold text-foreground">No Pending Approvals</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            All running agents are operating autonomously. When an agent requests permission to execute a privileged tool or operation, it will appear here.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {approvals.map((appr) => (
            <div
              key={appr.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-xl border border-amber-500/30 bg-card p-5 shadow-sm hover:border-amber-500/50 transition-all"
            >
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500 shrink-0 mt-0.5">
                  <ShieldAlert className="h-5 w-5" />
                </div>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm text-foreground">
                      {appr.description}
                    </span>
                    <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-xs font-mono font-semibold text-amber-600 dark:text-amber-400">
                      {appr.actionType}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5 flex-wrap">
                    <span className="flex items-center gap-1 font-mono">
                      <Bot className="h-3.5 w-3.5" />
                      Session: {appr.sessionId.slice(0, 14)}...
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Cpu className="h-3.5 w-3.5" />
                      Device: {appr.deviceId.slice(0, 10)}...
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" />
                      {new Date(appr.requestedAt).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:ml-auto">
                <Link href={`/sessions/${appr.sessionId}`}>
                  <Button size="sm" className="gap-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white">
                    Open Session Console <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
