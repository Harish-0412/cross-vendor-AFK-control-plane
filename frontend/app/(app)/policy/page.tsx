"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { motion } from "motion/react";
import {
  ScrollText,
  ShieldCheck,
  ShieldX,
  Lock,
  Plus,
  Loader2,
  RefreshCw,
  Check,
  Zap,
  FileCode2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

interface PolicyVersionItem {
  id: string;
  version: string;
  description: string;
  ruleCount: number;
  createdAt: string;
  createdBy: string;
  isActive: boolean;
}

interface PolicyVersionDetail extends PolicyVersionItem {
  rules: Array<{
    id: string;
    description: string;
    match: {
      capability?: string;
      riskClass?: string;
      resourcePattern?: string;
      projectId?: string;
      trustProfile?: string;
    };
    effect: "allow" | "deny" | "require_approval";
    requiredRole?: string;
    priority: number;
  }>;
}

const EFFECT_STYLES: Record<string, { label: string; cls: string }> = {
  allow: { label: "Allow", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
  deny: { label: "Deny", cls: "bg-destructive/10 text-destructive border-destructive/20" },
  require_approval: { label: "Require Approval", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20" },
};

export default function PolicyPage() {
  const [versions, setVersions] = useState<PolicyVersionItem[]>([]);
  const [current, setCurrent] = useState<PolicyVersionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(true);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newDescription, setNewDescription] = useState("");
  const [ruleLines, setRuleLines] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PolicyVersionDetail>>({});

  const fetchPolicy = useCallback(async () => {
    try {
      const [versionsData, currentData] = await Promise.all([
        apiClient.get<PolicyVersionItem[]>("/api/v1/policy/versions"),
        apiClient.get<PolicyVersionDetail>("/api/v1/policy/versions/current").catch(() => null),
      ]);
      setVersions(versionsData || []);
      setCurrent(currentData);
      setIsAdmin(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setIsAdmin(false);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchPolicy();
  }, [fetchPolicy]);

  const activeVersion = useMemo(
    () => versions.find((v) => v.isActive) || current,
    [versions, current],
  );

  const handleActivate = async (versionId: string) => {
    setActivatingId(versionId);
    try {
      await apiClient.post(`/api/v1/policy/versions/${versionId}/activate`, {});
      toast.success("Policy version activated");
      void fetchPolicy();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to activate policy version";
      toast.error(msg);
    } finally {
      setActivatingId(null);
    }
  };

  const loadDetail = async (versionId: string) => {
    if (details[versionId]) {
      setExpandedId(expandedId === versionId ? null : versionId);
      return;
    }
    try {
      const detail = await apiClient.get<PolicyVersionDetail>(
        `/api/v1/policy/versions/${versionId}`,
      );
      setDetails((prev) => ({ ...prev, [versionId]: detail }));
      setExpandedId(versionId);
    } catch {
      toast.error("Could not load policy version details");
    }
  };

  const handleCreate = async () => {
    if (!newDescription.trim()) {
      toast.error("Description is required");
      return;
    }
    let rules: PolicyVersionDetail["rules"] = [];
    try {
      rules = ruleLines
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PolicyVersionDetail["rules"][number]);
    } catch {
      toast.error("One or more rules are not valid JSON");
      return;
    }

    setCreating(true);
    try {
      await apiClient.post("/api/v1/policy/versions", {
        description: newDescription.trim(),
        rules,
      });
      toast.success("Policy version created — activate it to make it current");
      setShowCreate(false);
      setNewDescription("");
      setRuleLines("");
      void fetchPolicy();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to create policy version";
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-5xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
            Policy Engine
          </h1>
          <p className="text-sm text-muted-foreground">
            Versioned, risk-class based rules that govern what your agents are allowed to do.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {isAdmin && (
            <Button size="sm" className="gap-1.5 text-xs" onClick={() => setShowCreate((v) => !v)}>
              <Plus className="h-3.5 w-3.5" /> New Version
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void fetchPolicy();
            }}
            disabled={refreshing}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </motion.div>

      {!isAdmin && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-xs text-amber-600 dark:text-amber-400"
        >
          <Lock className="h-4 w-4 shrink-0" />
          Read-only view — only admins can author or activate policy versions.
        </motion.div>
      )}

      {/* Active policy */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.05 }}
        className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent bg-card p-6 shadow-sm"
      >
        <div className="flex items-center gap-2 mb-3">
          <Zap className="h-4 w-4 text-primary" />
          <h2 className="text-base font-semibold tracking-tight">Active Policy</h2>
        </div>
        {activeVersion ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="rounded-md bg-primary/15 border border-primary/30 px-2 py-0.5 font-mono text-xs font-bold text-primary">
                {activeVersion.version}
              </span>
              <span className="text-xs text-muted-foreground font-mono">
                {activeVersion.ruleCount} rules
              </span>
              <span className="text-xs text-muted-foreground">
                · created {new Date(activeVersion.createdAt).toLocaleDateString()}
              </span>
            </div>
            <p className="text-sm text-foreground/80">{activeVersion.description}</p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No policy version is active yet. The engine is running on risk-class defaults.
          </p>
        )}
      </motion.div>

      {/* Create form */}
      {isAdmin && showCreate && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="rounded-2xl border border-border bg-card p-6 shadow-sm overflow-hidden"
        >
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
              <FileCode2 className="h-4 w-4 text-primary" /> Author New Policy Version
            </h2>
            <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-foreground/80">Description</label>
              <input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="e.g. Tighten write access for untrusted projects"
                className="h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-semibold text-foreground/80">
                Rules (one JSON object per line)
              </label>
              <textarea
                value={ruleLines}
                onChange={(e) => setRuleLines(e.target.value)}
                rows={5}
                placeholder={`{"id":"r1","description":"Block prod deploys","match":{"capability":"deployment.execute","riskClass":"critical"},"effect":"deny","priority":100}`}
                className="w-full resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={creating} className="gap-1.5">
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Create Version
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {/* Versions list */}
      <div className="flex flex-col gap-3">
        {versions.length === 0 && !isAdmin ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-12 text-center">
            <ScrollText className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-base font-semibold text-foreground">No policy versions</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              Policy versions will appear here once an administrator authors the first one.
            </p>
          </div>
        ) : (
          versions.map((v, i) => (
            <motion.div
              key={v.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: Math.min(i * 0.04, 0.4) }}
              className={`rounded-xl border bg-card shadow-sm overflow-hidden transition-all hover:shadow-md ${
                v.isActive ? "border-primary/40" : "border-border hover:border-primary/25"
              }`}
            >
              <div className="p-4">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={`flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs font-bold ${
                        v.isActive
                          ? "bg-primary/15 text-primary border-primary/30"
                          : "bg-muted text-muted-foreground border-border"
                      }`}
                    >
                      {v.isActive && <Check className="h-3 w-3" />}
                      {v.version}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">{v.ruleCount} rules</span>
                    <span className="text-xs text-muted-foreground">
                      · {new Date(v.createdAt).toLocaleString()}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs text-muted-foreground"
                      onClick={() => void loadDetail(v.id)}
                    >
                      {expandedId === v.id ? "Hide rules" : "View rules"}
                    </Button>
                    {isAdmin && !v.isActive && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs gap-1.5 text-primary border-primary/30"
                        onClick={() => void handleActivate(v.id)}
                        disabled={activatingId === v.id}
                      >
                        {activatingId === v.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Zap className="h-3.5 w-3.5" />
                        )}
                        Activate
                      </Button>
                    )}
                    {v.isActive && (
                      <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck className="h-3.5 w-3.5" /> Active
                      </span>
                    )}
                  </div>
                </div>
                <p className="mt-2 text-xs text-foreground/75">{v.description}</p>
              </div>

              {expandedId === v.id && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="border-t border-border bg-muted/30 p-4 flex flex-col gap-2"
                >
                  {(details[v.id]?.rules || []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No custom rules — evaluation uses built-in risk-class defaults.
                    </p>
                  ) : (
                    (details[v.id]?.rules || []).map((rule) => {
                      const eff = EFFECT_STYLES[rule.effect] || {
                        label: rule.effect,
                        cls: "bg-muted text-muted-foreground border-border",
                      };
                      return (
                        <div key={rule.id} className="rounded-lg bg-background border border-border/60 p-3">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-xs font-semibold text-foreground">
                              {rule.id}
                            </span>
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${eff.cls}`}>
                              {eff.label}
                            </span>
                            <span className="text-[10px] text-muted-foreground font-mono">
                              priority {rule.priority}
                            </span>
                          </div>
                          <p className="mt-1 text-xs text-foreground/70">{rule.description}</p>
                          <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] font-mono text-muted-foreground">
                            {rule.match.capability && (
                              <span className="rounded bg-primary/5 border border-primary/10 px-1.5 py-0.5">
                                cap: {rule.match.capability}
                              </span>
                            )}
                            {rule.match.riskClass && (
                              <span className="rounded bg-primary/5 border border-primary/10 px-1.5 py-0.5">
                                risk: {rule.match.riskClass}
                              </span>
                            )}
                            {rule.match.trustProfile && (
                              <span className="rounded bg-primary/5 border border-primary/10 px-1.5 py-0.5">
                                trust: {rule.match.trustProfile}
                              </span>
                            )}
                            {rule.match.resourcePattern && (
                              <span className="rounded bg-primary/5 border border-primary/10 px-1.5 py-0.5">
                                resource: {rule.match.resourcePattern}
                              </span>
                            )}
                            {rule.requiredRole && (
                              <span className="rounded bg-amber-500/5 border border-amber-500/15 px-1.5 py-0.5 text-amber-600 dark:text-amber-400">
                                needs: {rule.requiredRole}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </motion.div>
              )}
            </motion.div>
          ))
        )}
      </div>
    </div>
  );
}