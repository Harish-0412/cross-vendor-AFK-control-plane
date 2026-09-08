"use client";

import { useEffect, useState } from "react";
import { Wallet, Plus, TrendingUp, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api-client";

interface Budget {
  id: string;
  name: string;
  scope: "global" | "project" | "agent";
  scopeId?: string;
  limitUsd: number;
  usedUsd: number;
  period: "daily" | "weekly" | "monthly";
  status: "ok" | "warning" | "exceeded";
}

interface SpendSummary {
  totalUsd: number;
  dailyAverageUsd: number;
  topModelUsd: { model: string; usd: number }[];
}

function formatUsd(amount: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount);
}

export default function BudgetsPage() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [summary, setSummary] = useState<SpendSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", limitUsd: "", period: "monthly" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiClient.get<{ budgets: Budget[] }>("/api/v1/budgets"),
      apiClient.get<{ summary: SpendSummary }>("/api/v1/budgets/summary"),
    ])
      .then(([budgetRes, summaryRes]) => {
        setBudgets(budgetRes.budgets ?? []);
        setSummary(summaryRes.summary ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleAdd = async () => {
    if (!form.name.trim() || !form.limitUsd) return;
    setSubmitting(true);
    try {
      const res = await apiClient.post<{ budget: Budget }>("/api/v1/budgets", {
        name: form.name,
        limitUsd: parseFloat(form.limitUsd),
        period: form.period,
        scope: "global",
      });
      setBudgets((prev) => [...prev, res.budget]);
      setAddOpen(false);
      setForm({ name: "", limitUsd: "", period: "monthly" });
    } finally {
      setSubmitting(false);
    }
  };

  const statusColor: Record<Budget["status"], string> = {
    ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
    exceeded: "bg-destructive/10 text-destructive border-destructive/20",
  };

  const progressColor: Record<Budget["status"], string> = {
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

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {summary && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Card>
                <CardContent className="p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10">
                      <Wallet className="h-5 w-5 text-violet-500" />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Total spent</p>
                      <p className="text-xl font-bold">{formatUsd(summary.totalUsd)}</p>
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
                  <p className="text-xs text-muted-foreground mb-2">Top models</p>
                  <div className="space-y-1.5">
                    {summary.topModelUsd.slice(0, 3).map((m) => (
                      <div key={m.model} className="flex items-center justify-between text-xs">
                        <span className="font-mono truncate text-foreground/80">{m.model}</span>
                        <span className="font-medium shrink-0 ml-2">{formatUsd(m.usd)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

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
              {budgets.map((budget) => {
                const pct = Math.min(100, (budget.usedUsd / budget.limitUsd) * 100);
                return (
                  <Card key={budget.id} className={budget.status === "exceeded" ? "border-destructive/40" : ""}>
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-base">{budget.name}</CardTitle>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {budget.status !== "ok" && (
                            <AlertTriangle className={`h-4 w-4 ${budget.status === "exceeded" ? "text-destructive" : "text-amber-500"}`} />
                          )}
                          <Badge variant="outline" className={`text-[10px] ${statusColor[budget.status]}`}>
                            {budget.status}
                          </Badge>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground capitalize">{budget.period} · {budget.scope}</p>
                    </CardHeader>
                    <CardContent className="pt-0 space-y-3">
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Used</span>
                          <span className="font-medium">
                            {formatUsd(budget.usedUsd)} / {formatUsd(budget.limitUsd)}
                          </span>
                        </div>
                        <div className="relative h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className={`absolute left-0 top-0 h-full rounded-full transition-all ${progressColor[budget.status]}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="text-right text-xs text-muted-foreground">{pct.toFixed(1)}%</p>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Budget</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="budget-name">Budget name</Label>
              <Input
                id="budget-name"
                placeholder="Global monthly cap"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="budget-limit">Limit (USD)</Label>
              <Input
                id="budget-limit"
                type="number"
                min="0"
                step="0.01"
                placeholder="100.00"
                value={form.limitUsd}
                onChange={(e) => setForm((f) => ({ ...f, limitUsd: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Period</Label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={form.period}
                onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={submitting} className="gap-2">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Add Budget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
