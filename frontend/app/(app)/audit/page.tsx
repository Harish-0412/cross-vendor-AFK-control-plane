"use client";

import { useEffect, useState, useCallback } from "react";
import { motion } from "motion/react";
import {
  ShieldCheck,
  ShieldX,
  ScrollText,
  RefreshCw,
  Loader2,
  Fingerprint,
  Hash,
  User as UserIcon,
  Server,
  Cpu,
  TimerOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

interface AuditEvent {
  id: string;
  sequence: number;
  timestamp: string;
  actor: { type: "user" | "device" | "system"; id: string };
  sessionId?: string;
  deviceId?: string;
  action: string;
  decision: "allow" | "deny" | "require_approval" | "granted" | "denied" | "timeout";
  policyVersion?: string;
  matchedRules?: string[];
  previousHash: string;
  hash: string;
}

interface VerifyResult {
  valid: boolean;
  firstBrokenIndex?: number;
}

const DECISION_STYLES: Record<string, { label: string; cls: string }> = {
  allow: { label: "Allow", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
  granted: { label: "Granted", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
  deny: { label: "Deny", cls: "bg-destructive/10 text-destructive border-destructive/20" },
  denied: { label: "Denied", cls: "bg-destructive/10 text-destructive border-destructive/20" },
  require_approval: { label: "Needs Approval", cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20" },
  timeout: { label: "Timeout", cls: "bg-muted text-muted-foreground border-border" },
};

const ACTOR_ICONS: Record<string, typeof UserIcon> = {
  user: UserIcon,
  device: Server,
  system: Cpu,
};

export default function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [decisionFilter, setDecisionFilter] = useState("");
  const [accessDenied, setAccessDenied] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchAudit = useCallback(async () => {
    try {
      const qs = decisionFilter ? `?decision=${encodeURIComponent(decisionFilter)}&limit=200` : "?limit=200";
      const [data, verifyData] = await Promise.all([
        apiClient.get<AuditEvent[]>(`/api/v1/audit${qs}`),
        apiClient.get<VerifyResult>("/api/v1/audit/verify").catch(() => null),
      ]);
      setEvents(data || []);
      setVerify(verifyData);
      setAccessDenied(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setAccessDenied(true);
      } else {
        toast.error("Failed to load audit log");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [decisionFilter]);

  useEffect(() => {
    void fetchAudit();
  }, [fetchAudit]);

  const decisions = ["allow", "deny", "granted", "denied", "require_approval", "timeout"];

  if (loading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (accessDenied) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-12 text-center max-w-lg mx-auto mt-16"
      >
        <ShieldX className="h-10 w-10 text-destructive mb-3" />
        <h3 className="text-base font-semibold text-foreground">Restricted — Admin Only</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          The audit log contains tamper-evident records of every approval decision and pairing
          event. Only administrators and workspace owners can view or verify the chain.
        </p>
      </motion.div>
    );
  }

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl lg:text-3xl font-bold tracking-tight text-foreground">
            Audit Log
          </h1>
          <p className="text-sm text-muted-foreground">
            Tamper-evident, hash-chained record of approvals, pairings, and policy decisions.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${
              verify?.valid
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                : "bg-destructive/10 text-destructive border-destructive/20"
            }`}
            title="Hash-chain integrity verified against stored hashes"
          >
            {verify?.valid ? (
              <>
                <Fingerprint className="h-3.5 w-3.5" />
                Chain verified
              </>
            ) : (
              <>
                <ShieldX className="h-3.5 w-3.5" />
                Chain broken
                {verify?.firstBrokenIndex !== undefined && ` @ #${verify.firstBrokenIndex}`}
              </>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void fetchAudit();
            }}
            disabled={refreshing}
            className="gap-1.5 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </motion.div>

      {/* Decision filter */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          onClick={() => setDecisionFilter("")}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            decisionFilter === ""
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-background text-muted-foreground hover:text-foreground"
          }`}
        >
          All
        </button>
        {decisions.map((d) => (
          <button
            key={d}
            onClick={() => setDecisionFilter(d)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              decisionFilter === d
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background text-muted-foreground hover:text-foreground"
            }`}
          >
            {d.replace("_", " ")}
          </button>
        ))}
      </div>

      {events.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-12 text-center">
          <ScrollText className="h-10 w-10 text-muted-foreground mb-3" />
          <h3 className="text-base font-semibold text-foreground">No audit events</h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Approval decisions, device pairings, and policy activations will be recorded here with
            their hash-chain integrity.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {events.map((evt, i) => {
            const decisionStyle = DECISION_STYLES[evt.decision] || {
              label: evt.decision,
              cls: "bg-muted text-muted-foreground border-border",
            };
            const ActorIcon = ACTOR_ICONS[evt.actor.type] || UserIcon;
            const expanded = expandedId === evt.id;

            return (
              <motion.div
                key={evt.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(i * 0.03, 0.4) }}
                className="rounded-xl border border-border bg-card shadow-sm overflow-hidden hover:border-primary/30 hover:shadow-md transition-all"
              >
                <button
                  onClick={() => setExpandedId(expanded ? null : evt.id)}
                  className="w-full flex items-center gap-3 p-4 text-left"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <ActorIcon className="h-4 w-4" />
                  </div>
                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs font-semibold text-foreground">
                        #{evt.sequence}
                      </span>
                      <span className="rounded bg-primary/10 border border-primary/20 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                        {evt.action}
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${decisionStyle.cls}`}>
                        {decisionStyle.label}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                      <span className="font-mono">{evt.actor.id.slice(0, 14)}…</span>
                      {evt.sessionId && <span>· sess {evt.sessionId.slice(0, 10)}…</span>}
                      {evt.deviceId && <span>· dev {evt.deviceId.slice(0, 10)}…</span>}
                      <span>· {new Date(evt.timestamp).toLocaleString()}</span>
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-muted-foreground truncate max-w-[80px] hidden md:block">
                    {evt.hash.slice(0, 8)}…
                  </span>
                </button>

                {expanded && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="border-t border-border bg-muted/30 p-4 flex flex-col gap-3"
                  >
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Hash className="h-3.5 w-3.5" />
                      <span className="font-semibold">Hash chain</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[10px] break-all">
                      <div className="flex flex-col gap-1 rounded-lg bg-background border border-border/50 p-2">
                        <span className="text-muted-foreground">previousHash</span>
                        <span className="text-foreground/70">{evt.previousHash}</span>
                      </div>
                      <div className="flex flex-col gap-1 rounded-lg bg-background border border-border/50 p-2">
                        <span className="text-muted-foreground">hash</span>
                        <span className="text-foreground/70">{evt.hash}</span>
                      </div>
                    </div>
                    {evt.policyVersion && (
                      <div className="text-[11px] text-muted-foreground">
                        policyVersion: <span className="font-mono text-foreground/80">{evt.policyVersion}</span>
                      </div>
                    )}
                    {evt.matchedRules && evt.matchedRules.length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
                        <span className="text-muted-foreground">matched:</span>
                        {evt.matchedRules.map((r) => (
                          <span key={r} className="rounded bg-primary/5 border border-primary/10 px-1.5 py-0.5 font-mono">
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}