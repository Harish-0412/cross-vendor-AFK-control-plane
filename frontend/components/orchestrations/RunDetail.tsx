"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  CircleSlash,
  Hammer,
  Loader2,
  MessagesSquare,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  TestTube2,
  Workflow,
  XCircle,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { agentLabel } from "@/lib/dashboard-model";
import {
  ACTIVE_RUN_STATES,
  ORIGIN_LABEL,
  ROLE_LABEL,
  orderSteps,
  type OrchestrationRun,
  type OrchestrationStep,
  type StepState,
  type TaskKind,
} from "@/lib/orchestrations";

const ROLE_ICON: Record<TaskKind, LucideIcon> = {
  planning: Workflow,
  implementation: Hammer,
  test: TestTube2,
  security_review: ShieldCheck,
  general: Bot,
};

const STEP_STATE: Record<StepState, { label: string; icon: LucideIcon; tone: string }> = {
  pending: { label: "Waiting", icon: CircleDashed, tone: "text-muted-foreground" },
  running: { label: "Working", icon: Loader2, tone: "text-primary" },
  completed: { label: "Done", icon: CheckCircle2, tone: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "Failed", icon: XCircle, tone: "text-destructive" },
  blocked: { label: "Blocked", icon: ShieldAlert, tone: "text-amber-600 dark:text-amber-400" },
  skipped: { label: "Skipped", icon: CircleSlash, tone: "text-muted-foreground" },
};

export const RUN_STATE_LABEL: Record<OrchestrationRun["state"], string> = {
  planned: "Starting",
  running: "Working",
  waiting_for_approval: "Waiting for your approval",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** One run: its goal, state, and every step with what its agent reported. */
export function RunDetail({
  run,
  busy,
  onAct,
}: {
  run: OrchestrationRun;
  busy: boolean;
  onAct: (action: "advance" | "cancel") => void;
}) {
  const steps = orderSteps(run.plan.steps);
  const active = ACTIVE_RUN_STATES.has(run.state);
  const waitingOnMachine = run.plan.steps.some((step) => step.state === "blocked" && !step.sessionId);
  const done = run.plan.steps.filter((step) => step.state === "completed").length;

  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="text-base leading-snug">{run.goal ?? run.plan.title}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {RUN_STATE_LABEL[run.state]} · {done} of {run.plan.steps.length} steps done
            </p>
          </div>
          {active && (
            <div className="flex shrink-0 gap-2">
              {waitingOnMachine && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("advance")} className="gap-1.5">
                  <RefreshCw className="h-3.5 w-3.5" /> Try again
                </Button>
              )}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct("cancel")} className="gap-1.5">
                <Square className="h-3.5 w-3.5" /> Cancel
              </Button>
            </div>
          )}
        </div>
        {run.state === "waiting_for_approval" && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            A step needs your approval before it can start.{" "}
            <Link href="/approvals" className="font-medium underline underline-offset-4">
              Open approvals
            </Link>
          </p>
        )}
        {run.error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {run.error}
          </p>
        )}
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function StepRow({ step }: { step: OrchestrationStep }) {
  const [open, setOpen] = useState(false);
  const RoleIcon = ROLE_ICON[step.taskKind];
  const state = STEP_STATE[step.state];
  const StateIcon = state.icon;
  const outcome = step.outcome;
  const blockingFindings = outcome?.findings?.filter((f) => f.severity === "high" || f.severity === "critical") ?? [];

  return (
    <li className="rounded-xl border border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <RoleIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-foreground">{step.title}</span>
            <Badge variant="secondary">{ROLE_LABEL[step.taskKind]}</Badge>
            {step.agentId && <Badge variant="outline">{agentLabel(step.agentId)}</Badge>}
            {step.origin && <Badge variant="outline">{ORIGIN_LABEL[step.origin]}</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {outcome?.testsPassed !== undefined && (
              <span className={outcome.testsPassed ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                Tests {outcome.testsPassed ? "passed" : "failed"}
              </span>
            )}
            {outcome?.verdict && (
              <span className={outcome.verdict === "approve" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                {outcome.verdict === "approve" ? "Approved" : `Changes requested (${blockingFindings.length} serious)`}
              </span>
            )}
            {!!outcome?.filesChanged.length && (
              <span>
                {outcome.filesChanged.length} file{outcome.filesChanged.length === 1 ? "" : "s"} changed
              </span>
            )}
            {!!step.contextConversationIds?.length && (
              <span className="inline-flex items-center gap-1">
                <MessagesSquare className="h-3 w-3" aria-hidden />
                {step.contextConversationIds.length} past conversation
                {step.contextConversationIds.length === 1 ? "" : "s"} used
              </span>
            )}
            {step.error && step.state !== "completed" && <span className="text-destructive">{step.error}</span>}
          </div>
        </div>
        <span className={`flex shrink-0 items-center gap-1 text-xs font-medium ${state.tone}`}>
          <StateIcon className={`h-3.5 w-3.5 ${step.state === "running" ? "animate-spin" : ""}`} aria-hidden />
          {state.label}
        </span>
        <ChevronDown
          className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Task</p>
            <p className="mt-1 whitespace-pre-wrap text-foreground">{step.prompt}</p>
          </div>
          {outcome?.summary && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What the agent reported</p>
              <p className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2 font-mono text-xs text-foreground">
                {outcome.summary}
              </p>
            </div>
          )}
          {!!outcome?.findings?.length && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Review findings</p>
              <ul className="mt-1 space-y-1">
                {outcome.findings.map((finding, index) => (
                  <li key={index} className="text-xs">
                    <Badge variant={finding.severity === "high" || finding.severity === "critical" ? "destructive" : "outline"}>
                      {finding.severity}
                    </Badge>{" "}
                    {finding.file && (
                      <code className="text-muted-foreground">
                        {finding.file}
                        {finding.line ? `:${finding.line}` : ""}
                      </code>
                    )}{" "}
                    {finding.summary}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!outcome?.filesChanged.length && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files changed</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{outcome.filesChanged.join(", ")}</p>
            </div>
          )}
          {step.sessionId && (
            <Link href={`/sessions/${step.sessionId}`} className="inline-block text-xs font-medium text-primary underline-offset-4 hover:underline">
              Open the full session
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
