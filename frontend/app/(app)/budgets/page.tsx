"use client";

import { useCallback, useEffect, useState } from "react";
import { Wallet, Plus, TrendingUp, AlertTriangle, Loader2, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api-client";
import { ProviderLimits } from "@/components/integrations/ProviderLimits";

/** A budget as the Control Plane stores it. */
interface BudgetLimit {
  id: string;
  scope: "session" | "project" | "organization";
  scopeId: string;
  tokenLimit?: number;
  costLimitUsd?: number;
  alertPercent: number;
}

/**
 * A budget and what has been recorded against it. `GET /api/v1/budgets` with
 * no query returns these for the signed-in user's personal organization.
 */
interface BudgetUsage {
  scope: BudgetLimit["scope"];
  scopeId: string;
  tokens: number;
  costUsd: number;
  limit?: BudgetLimit;
  exceeded: boolean;
  alertTriggered: boolean;
}

/** Everything recorded for the signed-in user over the last `days` days. */
interface SpendSummary {
  since: string;
  days: number;
  costUsd: number;
  dailyAverageUsd: number;
  tokens: number;
  subscriptionTokens: number;
}

type Status = "ok" | "warning" | "exceeded";

const emptyForm = { costLimitUsd: "", tokenLimit: "", alertPercent: "80" };

function formatUsd(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount);
}

function formatTokens(count: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(count);
}

/** The same thresholds the Control Plane applies to the budget as a whole. */
function statusOf(ratio: number, alertPercent: number): Status {
  if (ratio >= 1) return "exceeded";
  if (ratio >= alertPercent / 100) return "warning";
  return "ok";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong";
}

export default function BudgetsPage() {
  // null until loaded, and after a failed load: never shown as "no budgets".
  const [budgets, setBudgets] = useState<BudgetUsage[] | null>(null);
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    const [budgetRes, summaryRes] = await Promise.allSettled([
      apiClient.get<BudgetUsage[]>("/api/v1/budgets"),
      apiClient.get<SpendSummary>("/api/v1/budgets/summary"),
    ]);
    if (budgetRes.status === "fulfilled") setBudgets(budgetRes.value);
    if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
    const failed = [budgetRes, summaryRes].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    setLoadError(failed ? errorMessage(failed.reason) : null);
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  const hasLimit = form.costLimitUsd.trim() !== "" || form.tokenLimit.trim() !== "";

  const setAddDialog = (open: boolean) => {
    setAddOpen(open);
    if (!open) {
      setForm(emptyForm);
      setFormError(null);
    }
  };

  const handleAdd = async () => {
    if (!hasLimit) return;
    setSubmitting(true);
    setFormError(null);
    try {
      // The Control Plane validates the numbers and says what is wrong.
      await apiClient.post<BudgetLimit>("/api/v1/budgets", {
        ...(form.costLimitUsd.trim() ? { costLimitUsd: Number(form.costLimitUsd) } : {}),
        ...(form.tokenLimit.trim() ? { tokenLimit: Number(form.tokenLimit) } : {}),
        ...(form.alertPercent.trim() ? { alertPercent: Number(form.alertPercent) } : {}),
      });
      setAddDialog(false);
      await load();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const statusColor: Record<Status, string> = {
    ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    exceeded: "bg-destructive/10 text-destructive border-destructive/20",
  };

  const progressColor: Record<Status, string> = {
    ok: "bg-emerald-500",
    warning: "bg-amber-500",
    exceeded: "bg-destructive",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Budgets</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Monitor and control AI token spend</p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Budget
        </Button>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Plan limits</h2>
          <p className="text-sm text-muted-foreground">
            Remaining usage on subscription plans, as your connected tools recorded it. These are not dollar costs.
          </p>
        </div>
        <ProviderLimits />
      </section>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {loadError && (
            <Card className="border-destructive/40">
              <CardContent className="flex items-center gap-2 py-4 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Could not load budgets: {loadError}
              </CardContent>
            </Card>
          )}

          {summary && (
            <section className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Last {summary.days} days</h2>
                <p className="text-sm text-muted-foreground">
                  Everything recorded for you, including history synced from your tools.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <Card>
                  <CardContent className="p-5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10">
                        <Wallet className="h-5 w-5 text-violet-500" />
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Total spent</p>
                        <p className="text-xl font-bold">{formatUsd(summary.costUsd)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
                        <TrendingUp className="h-5 w-5 text-blue-500" />
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Daily average</p>
                        <p className="text-xl font-bold">{formatUsd(summary.dailyAverageUsd)}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
                        <Coins className="h-5 w-5 text-amber-500" />
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Tokens</p>
                        <p className="text-xl font-bold">{formatTokens(summary.tokens)}</p>
                        {summary.subscriptionTokens > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {formatTokens(summary.subscriptionTokens)} on subscription plans, no dollar cost
                          </p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </section>
          )}

          {budgets && (
            <section className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Your budgets</h2>
                <p className="text-sm text-muted-foreground">
                  Limits on your personal organization. Once one is used up, orchestration runs stop before their next
                  step. Only sessions on the organization&apos;s projects count toward it, not synced history.
                </p>
              </div>
              {budgets.length === 0 ? (
                <Card className="border-dashed">
                  <CardContent className="flex flex-col items-center justify-center py-16 gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Wallet className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <div className="text-center">
                      <p className="font-medium text-foreground">No budgets configured</p>
                      <p className="text-sm text-muted-foreground mt-1">Set spending limits to prevent runaway AI costs</p>
                    </div>
                    <Button onClick={() => setAddOpen(true)} variant="outline" className="gap-2">
                      <Plus className="h-4 w-4" />
                      Add your first budget
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {budgets.map((usage) => {
                    const limit = usage.limit;
                    if (!limit) return null;
                    const status: Status = usage.exceeded ? "exceeded" : usage.alertTriggered ? "warning" : "ok";
                    const meters = [
                      ...(limit.costLimitUsd
                        ? [{
                            label: "Dollars",
                            used: formatUsd(usage.costUsd),
                            cap: formatUsd(limit.costLimitUsd),
                            ratio: usage.costUsd / limit.costLimitUsd,
                          }]
                        : []),
                      ...(limit.tokenLimit
                        ? [{
                            label: "Tokens",
                            used: formatTokens(usage.tokens),
                            cap: formatTokens(limit.tokenLimit),
                            ratio: usage.tokens / limit.tokenLimit,
                          }]
                        : []),
                    ];
                    const title =
                      meters.length === 2 ? "Spending and token limit" : limit.costLimitUsd ? "Spending limit" : "Token limit";
                    return (
                      <Card key={limit.id} className={status === "exceeded" ? "border-destructive/40" : ""}>
                        <CardHeader className="pb-3">
                          <div className="flex items-start justify-between gap-2">
                            <CardTitle className="text-base">{title}</CardTitle>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {status !== "ok" && (
                                <AlertTriangle className={`h-4 w-4 ${status === "exceeded" ? "text-destructive" : "text-amber-500"}`} />
                              )}
                              <Badge variant="outline" className={`text-[10px] ${statusColor[status]}`}>
                                {status}
                              </Badge>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Personal organization · warning at {limit.alertPercent}%
                          </p>
                        </CardHeader>
                        <CardContent className="pt-0 space-y-3">
                          {meters.map((meter) => (
                            <div key={meter.label} className="space-y-1.5">
                              <div className="flex items-center justify-between text-xs">
                                <span className="text-muted-foreground">{meter.label}</span>
                                <span className="font-medium">
                                  {meter.used} / {meter.cap}
                                </span>
                              </div>
                              <div className="relative h-2 rounded-full bg-muted overflow-hidden">
                                <div
                                  className={`absolute left-0 top-0 h-full rounded-full transition-all ${progressColor[statusOf(meter.ratio, limit.alertPercent)]}`}
                                  style={{ width: `${Math.min(100, meter.ratio * 100)}%` }}
                                />
                              </div>
                              <p className="text-right text-xs text-muted-foreground">{(meter.ratio * 100).toFixed(1)}%</p>
                            </div>
                          ))}
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
