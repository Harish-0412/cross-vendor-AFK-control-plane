"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "motion/react";
import {
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  ArrowRight,
  RefreshCw,
  Clock,
  Bot,
  Cpu,
  MessageSquareText,
  Mic,
  MicOff,
  Loader2,
  KeyRound,
  TimerOff,
  Ban,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiClient, ApiError } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";
import { toast } from "sonner";

interface ApprovalItem {
  id: string;
  sessionId: string;
  deviceId: string;
  actionType: string;
  description: string;
  details?: Record<string, unknown> | null;
  status: "pending" | "granted" | "denied" | "timeout" | "superseded";
  requestedAt: string;
  decidedAt?: string | null;
  decidedBy?: string | null;
  reason?: string | null;
  policyVersion?: string | null;
  matchedRules?: string[];
}

type TabKey = "pending" | "decided";

interface DecisionState {
  approvalId: string;
  submitting: boolean;
  showFeedback: boolean;
}

// Voice capture helper (Web Speech API — Subphase 4.4a)
function useVoiceCapture() {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const onResultRef = useRef<(text: string) => void>(() => {});

  const stop = () => {
    setListening(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  };

  const start = (onResult?: (text: string) => void) => {
    if (onResult) onResultRef.current = onResult;
    const w = window as unknown as {
      SpeechRecognition?: new () => { start: () => void; stop: () => void; onresult: (e: unknown) => void; onend: () => void; onerror: () => void };
      webkitSpeechRecognition?: new () => { start: () => void; stop: () => void; onresult: (e: unknown) => void; onend: () => void; onerror: () => void };
    };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      toast.info("Voice capture is not supported in this browser");
      return;
    }
    try {
      const rec = new Ctor();
      rec.onresult = (ev: unknown) => {
        const e = ev as { results: ArrayLike<ArrayLike<{ transcript: string }>> };
        const transcript = Array.from(e.results)
          .map((r) => r[0]?.transcript || "")
          .join(" ");
        if (transcript.trim()) onResultRef.current(transcript.trim());
      };
      rec.onend = () => setListening(false);
      rec.onerror = () => setListening(false);
      recognitionRef.current = rec;
      rec.start();
      setListening(true);
    } catch {
      toast.error("Could not start voice capture");
    }
  };

  return { listening, start, stop };
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("pending");
  const [decisionStates, setDecisionStates] = useState<Record<string, DecisionState>>({});
  const [feedbackInputs, setFeedbackInputs] = useState<Record<string, string>>({});

  const voice = useVoiceCapture();

  const fetchApprovals = useCallback(async () => {
    try {
      const data = await apiClient.get<ApprovalItem[]>("/api/v1/approvals");
      setApprovals(data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchApprovals();

    const interval = setInterval(() => {
      void fetchApprovals();
    }, 10_000);

    const unsub = realtimeClient.subscribeAllEvents((msg) => {
      if (
        msg.eventType === "session.approval_required" ||
        msg.eventType === "session.approval_decided" ||
        msg.eventType === "session.status_changed"
      ) {
        void fetchApprovals();
      }
    });

    return () => {
      clearInterval(interval);
      unsub();
    };
  }, [fetchApprovals]);

  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");

  const setDecisionState = (id: string, patch: Partial<DecisionState>) => {
    setDecisionStates((prev) => ({ ...prev, [id]: { ...prev[id], approvalId: id, ...patch } }));
  };

  const submitDecision = async (approval: ApprovalItem, approved: boolean) => {
    const st = decisionStates[approval.id];
    if (st?.submitting) return;
    setDecisionState(approval.id, { submitting: true });

    const feedback = approved ? undefined : (feedbackInputs[approval.id] || "").trim() || undefined;

    try {
      await apiClient.post(
        `/api/v1/sessions/${approval.sessionId}/approvals/${approval.id}/decision`,
        {
          approved,
          reason: approved ? "Approved by operator" : "Denied by operator",
          ...(feedback ? { feedback } : {}),
        },
      );

      toast.success(approved ? "Approval granted — agent may proceed" : "Approval denied");
      if (!approved && feedback) {
        toast.info("Your feedback was sent back to the agent as a message");
      }
      setFeedbackInputs((prev) => ({ ...prev, [approval.id]: "" }));
      setDecisionState(approval.id, { showFeedback: false });
      void fetchApprovals();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to submit decision";
      toast.error(msg);
    } finally {
      setDecisionState(approval.id, { submitting: false });
    }
  };

  const statusStyles: Record<string, { label: string; cls: string; icon?: typeof CheckCircle2 }> = {
    granted: { label: "Granted", cls: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20", icon: CheckCircle2 },
    denied: { label: "Denied", cls: "bg-destructive/10 text-destructive border-destructive/20", icon: XCircle },
    timeout: { label: "Timed Out", cls: "bg-muted text-muted-foreground border-border", icon: TimerOff },
    superseded: { label: "Superseded", cls: "bg-muted text-muted-foreground border-border", icon: Ban },
  };

  const getStatusBadge = (status: string) => {
    const s = statusStyles[status];
    if (!s) {
      return (
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground border border-border">
          {status}
        </span>
      );
    }
    const Icon = s.icon;
    return (
      <span className={`flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
        {Icon && <Icon className="h-3 w-3" />}
        {s.label}
      </span>
    );
  };

  const renderApprovalCard = (appr: ApprovalItem, index: number) => {
    const isPending = appr.status === "pending";
    const st = decisionStates[appr.id];

    return (
      <motion.div
        key={appr.id}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, x: isPending ? -40 : 40, scale: 0.97 }}
        transition={{ duration: 0.35, delay: Math.min(index * 0.05, 0.3), ease: [0.22, 1, 0.36, 1] }}
        className={`group relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-lg ${
          isPending
            ? "border-amber-500/30 hover:border-amber-500/50"
            : "border-border hover:border-border"
        }`}
      >
        {/* Accent glow for pending */}
        {isPending && (
          <div className="pointer-events-none absolute -top-20 -right-20 h-48 w-48 rounded-full bg-amber-500/10 blur-3xl opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
        )}

        <div className="flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <motion.div
                animate={isPending ? { scale: [1, 1.06, 1] } : {}}
                transition={{ repeat: isPending ? Infinity : 0, duration: 2.2 }}
                className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                  isPending ? "bg-amber-500/10 text-amber-500" : "bg-muted text-muted-foreground"
                }`}
              >
                {isPending ? <ShieldAlert className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
              </motion.div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-foreground">{appr.description}</span>
                  <span className="rounded-md bg-primary/10 border border-primary/20 px-2 py-0.5 text-[11px] font-mono font-semibold text-primary">
                    {appr.actionType}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1 font-mono">
                    <Bot className="h-3.5 w-3.5" />
                    {appr.sessionId.slice(0, 14)}…
                  </span>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Cpu className="h-3.5 w-3.5" />
                    {appr.deviceId.slice(0, 10)}…
                  </span>
                  <span>•</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3.5 w-3.5" />
                    {new Date(appr.requestedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>

                {appr.details && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {Object.entries(appr.details)
                      .slice(0, 3)
                      .map(([k, v]) => (
                        <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                          {k}={String(v)}
                        </span>
                      ))}
                  </div>
                )}

                {(appr.policyVersion || appr.matchedRules?.length) && (
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <KeyRound className="h-3 w-3" />
                    <span className="font-mono">policy {appr.policyVersion || "—"}</span>
                    {appr.matchedRules && appr.matchedRules.length > 0 && (
                      <span className="flex gap-1">
                        {appr.matchedRules.slice(0, 2).map((r) => (
                          <span key={r} className="rounded bg-primary/5 border border-primary/10 px-1 py-px font-mono">
                            {r}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {isPending ? (
                <>
                  <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-600 dark:text-amber-400 border border-amber-500/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-ping" />
                    Pending
                  </span>
                  <Link href={`/sessions/${appr.sessionId}`}>
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Open session console">
                      <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </>
              ) : (
                getStatusBadge(appr.status)
              )}
            </div>
          </div>

          {/* Decided info */}
          {!isPending && (
            <div className="flex flex-col gap-1 rounded-lg bg-muted/40 border border-border/50 p-3 text-xs">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <span className="text-muted-foreground">
                  {appr.decidedBy ? `Decided by ${appr.decidedBy.slice(0, 10)}…` : "Decided automatically"}
                  {appr.decidedAt && (
                    <span className="ml-1.5 text-muted-foreground/70">
                      · {new Date(appr.decidedAt).toLocaleString()}
                    </span>
                  )}
                </span>
              </div>
              {appr.reason && <p className="text-foreground/80">{appr.reason}</p>}
            </div>
          )}

          {/* Pending actions */}
          {isPending && (
            <div className="flex flex-col gap-3">
              <AnimatePresence>
                {st?.showFeedback && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-col gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                          <MessageSquareText className="h-3.5 w-3.5" />
                          Reject with feedback
                        </span>
                        <button
                          type="button"
                          onClick={() => setDecisionState(appr.id, { showFeedback: false })}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Your feedback is sent back to the agent as a session message so it can correct course.
                      </p>
                      <div className="relative">
                        <textarea
                          rows={2}
                          value={feedbackInputs[appr.id] || ""}
                          onChange={(e) =>
                            setFeedbackInputs((prev) => ({ ...prev, [appr.id]: e.target.value }))
                          }
                          placeholder="e.g. Don't touch the deploy script — only fix the auth module…"
                          className="w-full resize-none rounded-lg border border-input bg-background p-3 pr-10 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (voice.listening) {
                              voice.stop();
                            } else {
                              voice.start((text) => {
                                setFeedbackInputs((prev) => {
                                  const current = prev[appr.id] || "";
                                  return { ...prev, [appr.id]: current ? `${current} ${text}` : text };
                                });
                              });
                            }
                          }}
                          title="Capture feedback by voice (Web Speech API)"
                          className={`absolute right-2 bottom-2 flex h-7 w-7 items-center justify-center rounded-lg transition-colors ${
                            voice.listening
                              ? "bg-destructive text-white animate-pulse"
                              : "bg-muted text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {voice.listening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-xs"
                          onClick={() => submitDecision(appr, false)}
                          disabled={st?.submitting}
                        >
                          Deny without feedback
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          className="text-xs gap-1.5"
                          onClick={() => submitDecision(appr, false)}
                          disabled={st?.submitting}
                        >
                          {st?.submitting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <XCircle className="h-3.5 w-3.5" />
                          )}
                          Deny with feedback
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  size="sm"
                  className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                  onClick={() => submitDecision(appr, true)}
                  disabled={st?.submitting}
                >
                  {st?.submitting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  )}
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10 text-xs"
                  onClick={() => setDecisionState(appr.id, { showFeedback: !st?.showFeedback })}
                  disabled={st?.submitting}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Deny
                </Button>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    );
  };

  const tabs: Array<{ key: TabKey; label: string; count: number }> = [
    { key: "pending", label: "Pending", count: pending.length },
    { key: "decided", label: "Decided", count: decided.length },
  ];

  const list = activeTab === "pending" ? pending : decided;

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
            Approvals
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
      </motion.div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border pb-0 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`relative flex items-center gap-1.5 px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                activeTab === tab.key ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              {tab.count}
            </span>
            {activeTab === tab.key && (
              <motion.span
                layoutId="approval-tab-underline"
                className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full bg-primary"
              />
            )}
          </button>
        ))}
      </div>

      {list.length === 0 && !loading ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.35 }}
          className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card p-12 text-center shadow-sm"
        >
          <CheckCircle2 className="h-10 w-10 text-emerald-500 mb-3" />
          <h3 className="text-base font-semibold text-foreground">
            {activeTab === "pending" ? "No Pending Approvals" : "No Decided Approvals"}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            {activeTab === "pending"
              ? "All running agents are operating autonomously. When an agent requests permission to execute a privileged operation, it will appear here."
              : "Approvals you have granted or denied will be recorded here with full audit context."}
          </p>
        </motion.div>
      ) : (
        <motion.div layout className="flex flex-col gap-3">
          <AnimatePresence mode="popLayout">
            {list.map((appr, i) => renderApprovalCard(appr, i))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}