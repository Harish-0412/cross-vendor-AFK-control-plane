"use client";

import { ShieldAlert, ArrowRight, CheckCircle } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export interface PendingApprovalItem {
  id: string;
  sessionId: string;
  deviceId: string;
  actionType: string;
  description: string;
  requestedAt: string;
  status: string;
}

interface AttentionNeededProps {
  approvals: PendingApprovalItem[];
  onRefresh?: () => void;
}

export function AttentionNeeded({ approvals }: AttentionNeededProps) {
  if (approvals.length === 0) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 text-emerald-500">
          <CheckCircle className="h-5 w-5" />
          <h2 className="text-base font-semibold tracking-tight">System Normal</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          No approvals are currently pending. All remote agents are running autonomously.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
          <ShieldAlert className="h-5 w-5" />
          <h2 className="text-lg font-semibold tracking-tight">Attention Needed ({approvals.length})</h2>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {approvals.map((approval) => (
          <div
            key={approval.id}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 shadow-sm"
          >
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-amber-500 animate-ping" />
                <span className="font-semibold text-foreground text-sm">
                  {approval.description || 'Agent requires user approval'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground ml-4 flex items-center gap-2">
                <span className="font-mono bg-muted px-1.5 py-0.5 rounded text-foreground/80">
                  {approval.actionType}
                </span>
                <span>•</span>
                <span>Session: {approval.sessionId.slice(0, 12)}...</span>
              </div>
            </div>

            <div className="flex items-center gap-2 sm:ml-auto">
              <Link href={`/sessions/${approval.sessionId}`}>
                <Button size="sm" className="gap-1 text-xs">
                  Review in Session <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
