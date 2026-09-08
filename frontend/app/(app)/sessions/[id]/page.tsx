"use client";

import { useEffect, useState, useRef, use, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { EventEnvelope, SessionState } from "@freebuff/protocol";
import {
  ArrowLeft,
  Bot,
  Cpu,
  Folder,
  Play,
  Pause,
  StopCircle,
  Clock,
  Terminal,
  Send,
  Loader2,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  ArrowDown,
  RefreshCw,
  Wrench,
  AlertCircle,
  FileCheck2,
  FlaskConical,
  ShieldCheck,
  Lock,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient, ApiError } from "@/lib/api-client";
import { realtimeClient } from "@/lib/realtime";
import { toast } from "sonner";

const MAX_EVENT_BUFFER = 2000;

interface StoredEventRecord {
  id: string;
  sessionId: string;
  deviceId: string;
  sequence: number;
  eventType: string;
  envelope: EventEnvelope;
  storedAt: string;
}

interface SessionDetail {
  id: string;
  userId: string;
  deviceId: string;
  agentId: string;
  projectRoot: string;
  state: SessionState;
  trustProfile?: string;
  startedAt: string;
  completedAt?: string | null;
  error?: string | null;
  tokensUsed?: number | null;
}

interface DeviceSummary {
  id: string;
  friendlyName: string;
  platform: string;
  online: boolean;
}

interface SessionSummary {
  sessionId: string;
  generatedAt: string;
  fixedTests: number;
  modifiedFiles: number;
  addedTests: number;
  approvalsRequired: string[];
  workingTreeClean: boolean;
  lines: string[];
  text: string;
}

const SESSION_TRUST_PROFILES = [
  { value: "default", label: "Default", desc: "Standard autonomy with approval checkpoints" },
  { value: "supervised", label: "Supervised", desc: "Extra checkpoints — every medium-risk+ action asks" },
  { value: "trusted-afk", label: "Trusted AFK", desc: "Full autonomy for long unattended runs (Phase 7)" },
  { value: "read-only", label: "Read-only", desc: "Inspect only — write-class actions denied outright" },
  { value: "locked", label: "Locked", desc: "Observation only — every capability denied until unlocked" },
];

export default function LiveSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const resolvedParams = use(params);
  const router = useRouter();
  const sessionId = resolvedParams.id;

  const [session, setSession] = useState<SessionDetail | null>(null);
  const [device, setDevice] = useState<DeviceSummary | null>(null);
  const [events, setEvents] = useState<StoredEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [promptInput, setPromptInput] = useState("");
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  // Auto-scroll lock
  const [isAutoScrollLocked, setIsAutoScrollLocked] = useState(true);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  // Duration timer
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Fetch session & initial events history
  const fetchSessionAndEvents = useCallback(async () => {
    try {
      const sess = await apiClient.get<SessionDetail>(`/api/v1/sessions/${sessionId}`);
      setSession(sess);

      // Fetch device details
      if (sess.deviceId) {
        apiClient
          .get<DeviceSummary>(`/api/v1/devices/${sess.deviceId}`)
          .then((d) => setDevice(d))
          .catch(() => {});
      }

      // Fetch event log history
      const history = await apiClient.get<StoredEventRecord[]>(
        `/api/v1/sessions/${sessionId}/events?fromSequence=0`,
      );
      setEvents((history || []).slice(-MAX_EVENT_BUFFER));
    } catch {
      toast.error("Failed to load session details");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void fetchSessionAndEvents();

    // Subscribe to live events via WebSocket
    const unsub = realtimeClient.subscribeSession(sessionId, (envelope: EventEnvelope) => {
      const newEventRecord: StoredEventRecord = {
        id: envelope.eventId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        deviceId: String(envelope.deviceId || ""),
        sequence: envelope.sequence || 0,
        eventType: envelope.eventType,
        envelope,
        storedAt: envelope.occurredAt
          ? new Date(envelope.occurredAt).toISOString()
          : new Date().toISOString(),
      };

      setEvents((prev) => {
        // Prevent duplicate events
        if (prev.some((e) => e.id === newEventRecord.id)) return prev;
        const next = [...prev, newEventRecord];
        return next.length > MAX_EVENT_BUFFER ? next.slice(-MAX_EVENT_BUFFER) : next;
      });

      // Update local session state on state change events
      if (envelope.eventType === "session.status_changed") {
        const p = envelope.payload as { state?: SessionState };
        if (p?.state) {
          setSession((prev) => (prev ? { ...prev, state: p.state! } : prev));
        }
      }
    });

    return () => {
      unsub();
    };
  }, [sessionId, fetchSessionAndEvents]);

  // Handle auto-scroll
  useEffect(() => {
    if (isAutoScrollLocked && scrollAnchorRef.current) {
      scrollAnchorRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events, isAutoScrollLocked]);

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    setIsAutoScrollLocked(isAtBottom);
  };

  const scrollToBottom = () => {
    setIsAutoScrollLocked(true);
    if (scrollAnchorRef.current) {
      scrollAnchorRef.current.scrollIntoView({ behavior: "smooth" });
    }
  };

  // Timer logic for running session
  useEffect(() => {
    if (!session) return;
    const start = new Date(session.startedAt).getTime();
    const isFinished =
      session.state === "completed" || session.state === "failed" || session.state === "cancelled";

    if (isFinished && session.completedAt) {
      const end = new Date(session.completedAt).getTime();
      setElapsedSeconds(Math.max(0, Math.floor((end - start) / 1000)));
      return;
    }

    const updateTimer = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    updateTimer();

    if (!isFinished) {
      const timer = setInterval(updateTimer, 1000);
      return () => clearInterval(timer);
    }
  }, [session]);

  const formatTimer = (totalSec: number) => {
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const hrs = Math.floor(min / 60);
    if (hrs > 0) return `${hrs}h ${min % 60}m ${sec}s`;
    return `${min}m ${sec < 10 ? "0" : ""}${sec}s`;
  };

  // Session Control Actions
  const handleSendPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInput.trim() || sendingPrompt) return;

    setSendingPrompt(true);
    try {
      await apiClient.post(`/api/v1/sessions/${sessionId}/prompt`, {
        message: promptInput.trim(),
      });
      setPromptInput("");
      toast.success("Instruction forwarded to agent");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to send prompt";
      toast.error(msg);
    } finally {
      setSendingPrompt(false);
    }
  };

  const handlePause = async () => {
    setActionLoading(true);
    try {
      await apiClient.post(`/api/v1/sessions/${sessionId}/pause`, {});
      setSession((prev) => (prev ? { ...prev, state: "paused" } : prev));
      toast.info("Session paused");
    } catch (err) {
      toast.error("Failed to pause session");
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async () => {
    setActionLoading(true);
    try {
      await apiClient.post(`/api/v1/sessions/${sessionId}/resume`, {});
      setSession((prev) => (prev ? { ...prev, state: "running" } : prev));
      toast.success("Session resumed");
    } catch (err) {
      toast.error("Failed to resume session");
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      await apiClient.post(`/api/v1/sessions/${sessionId}/cancel`, {
        reason: "Cancelled by user from web console",
        force: true,
      });
      setSession((prev) => (prev ? { ...prev, state: "cancelled" } : prev));
      setShowCancelConfirm(false);
      toast.warning("Session cancelled");
    } catch (err) {
      toast.error("Failed to cancel session");
    } finally {
      setActionLoading(false);
    }
  };

  // Phase 7.5 — "While you were away" summary
  const toggleSummary = async () => {
    setShowSummary((v) => !v);
    if (!summary && !summaryLoading) {
      setSummaryLoading(true);
      try {
        const data = await apiClient.get<SessionSummary>(`/api/v1/sessions/${sessionId}/summary`);
        setSummary(data);
      } catch {
        toast.error("Failed to generate session summary");
      } finally {
        setSummaryLoading(false);
      }
    }
  };

  // Phase 7.1 — activate a trust profile on this session (e.g. trusted-afk)
  const handleProfileChange = async (profile: string) => {
    if (!session) {
      setProfileMenuOpen(false);
      return;
    }
    if (profile === session.trustProfile) {
      setProfileMenuOpen(false);
      return;
    }
    setSavingProfile(true);
    try {
      await apiClient.patch(`/api/v1/sessions/${sessionId}/trust-profile`, { trustProfile: profile });
      setSession((prev) => (prev ? { ...prev, trustProfile: profile } : prev));
      const meta = SESSION_TRUST_PROFILES.find((p) => p.value === profile);
      toast.success(profile === "trusted-afk"
        ? "AFK mode activated — the agent now runs with full autonomy"
        : `Trust profile set to ${meta?.label ?? profile}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Failed to update trust profile";
      toast.error(msg);
    } finally {
      setSavingProfile(false);
      setProfileMenuOpen(false);
    }
  };

  const getStatusBadge = (state: SessionState | string) => {
    switch (state) {
      case "running":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            RUNNING
          </span>
        );
      case "waiting_for_approval":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-600 dark:text-amber-400 border border-amber-500/20">
            <span className="h-2 w-2 rounded-full bg-amber-500 animate-ping" />
            NEEDS APPROVAL
          </span>
        );
      case "paused":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-600 dark:text-blue-400 border border-blue-500/20">
            PAUSED
          </span>
        );
      case "completed":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground border border-border">
            COMPLETED
          </span>
        );
      case "failed":
      case "cancelled":
        return (
          <span className="flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs font-semibold text-destructive border border-destructive/20">
            {state.toUpperCase()}
          </span>
        );
      default:
        return (
          <span className="rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground">
            {String(state).toUpperCase()}
          </span>
        );
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-[500px] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Connecting to session console...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <h2 className="text-xl font-bold">Session Not Found</h2>
        <p className="text-sm text-muted-foreground mt-2">
          The requested agent session could not be located.
        </p>
        <Link href="/sessions" className="mt-4">
          <Button variant="outline" size="sm">
            Back to Sessions
          </Button>
        </Link>
      </div>
    );
  }

  const isSessionActive =
    session.state === "running" ||
    session.state === "waiting_for_approval" ||
    session.state === "paused" ||
    session.state === "initializing";

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)] max-w-7xl mx-auto gap-4">
      {/* Session Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-card border border-border rounded-xl p-4 shadow-sm shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/sessions">
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex flex-col">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-bold font-mono text-foreground">{session.id}</span>
              {getStatusBadge(session.state)}
              <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded text-foreground/80 font-medium">
                {session.agentId}
              </span>

              {/* Phase 7.1 — active trust profile, switchable in-flight */}
              <div className="relative">
                <button
                  onClick={() => setProfileMenuOpen((v) => !v)}
                  disabled={savingProfile || !isSessionActive}
                  title={isSessionActive ? "Change trust profile" : "Session has ended"}
                  className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition-all ${
                    session.trustProfile === "trusted-afk"
                      ? "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400"
                      : session.trustProfile === "locked"
                        ? "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400"
                        : session.trustProfile === "read-only"
                          ? "border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : "border-border bg-muted/40 text-muted-foreground"
                  } ${isSessionActive ? "hover:border-primary/50 cursor-pointer" : "opacity-70 cursor-not-allowed"}`}
                >
                  {session.trustProfile === "trusted-afk" ? <Sparkles className="h-3 w-3" />
                    : session.trustProfile === "locked" ? <Lock className="h-3 w-3" />
                    : <ShieldCheck className="h-3 w-3" />}
                  {SESSION_TRUST_PROFILES.find((p) => p.value === session.trustProfile)?.label ??
                    session.trustProfile ?? "default"}
                  {savingProfile ? <Loader2 className="h-3 w-3 animate-spin" /> : isSessionActive && <ChevronDown className="h-3 w-3" />}
                </button>

                {profileMenuOpen && (
                  <div className="absolute left-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-border bg-card p-2 shadow-2xl shadow-black/10">
                    <p className="px-2 pt-1 pb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                      Trust profile
                    </p>
                    {SESSION_TRUST_PROFILES.map((p) => {
                      const active = session.trustProfile === p.value;
                      return (
                        <button
                          key={p.value}
                          onClick={() => void handleProfileChange(p.value)}
                          className={`flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                            active
                              ? "bg-primary/10 text-primary"
                              : "text-foreground hover:bg-muted"
                          }`}
                        >
                          <span className="flex items-center gap-1.5 text-xs font-semibold">
                            {active && <ShieldCheck className="h-3 w-3" />}
                            {p.label}
                          </span>
                          <span className="text-[10px] text-muted-foreground leading-snug">{p.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1 flex-wrap">
              <span className="flex items-center gap-1">
                <Cpu className="h-3.5 w-3.5" />
                {device?.friendlyName || session.deviceId}
              </span>
              <span>•</span>
              <span className="flex items-center gap-1 font-mono text-[11px] max-w-xs truncate">
                <Folder className="h-3.5 w-3.5" />
                {session.projectRoot}
              </span>
            </div>
          </div>
        </div>

        {/* Right side stats & action buttons */}
        <div className="flex items-center gap-3 flex-wrap sm:justify-end">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-muted text-xs font-mono text-foreground">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{formatTimer(elapsedSeconds)}</span>
          </div>

          {/* Phase 7.5 — "While you were away" summary */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void toggleSummary()}
            className="gap-1.5 text-xs"
            title="Generate a structured summary of what happened"
          >
            {summaryLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileCheck2 className="h-3.5 w-3.5" />
            )}
            {showSummary ? "Hide Summary" : "Summary"}
          </Button>

          {session.tokensUsed !== undefined && session.tokensUsed !== null && (
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-muted text-xs font-mono text-muted-foreground">
              <span>{session.tokensUsed.toLocaleString()} tokens</span>
            </div>
          )}

          {isSessionActive && (
            <div className="flex items-center gap-2">
              {session.state === "running" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePause}
                  disabled={actionLoading}
                  className="gap-1 text-xs"
                >
                  <Pause className="h-3.5 w-3.5" /> Pause
                </Button>
              ) : session.state === "paused" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResume}
                  disabled={actionLoading}
                  className="gap-1 text-xs text-emerald-600 border-emerald-500/30"
                >
                  <Play className="h-3.5 w-3.5" /> Resume
                </Button>
              ) : null}

              <Button
                variant="destructive"
                size="sm"
                onClick={() => setShowCancelConfirm(true)}
                disabled={actionLoading}
                className="gap-1 text-xs bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground border-none"
              >
                <StopCircle className="h-3.5 w-3.5" /> Abort
              </Button>
            </div>
          )}

          <Button
            variant="ghost"
            size="icon"
            onClick={fetchSessionAndEvents}
            className="h-8 w-8 text-muted-foreground"
            title="Refresh stream"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Phase 7.5 — "While you were away" summary panel */}
      {showSummary && (
        <div className="shrink-0 max-h-[45vh] overflow-y-auto rounded-xl border border-violet-500/30 bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              <h3 className="text-sm font-bold tracking-tight text-foreground">While you were away</h3>
            </div>
            {summary?.generatedAt && (
              <span className="text-[10px] font-mono text-muted-foreground">
                {new Date(summary.generatedAt).toLocaleString()}
              </span>
            )}
          </div>
          {summaryLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Aggregating events and audit trail…
            </div>
          ) : summary ? (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col items-center gap-0.5 rounded-lg border border-emerald-500/20 bg-emerald-500/5 py-2">
                  <span className="text-lg font-bold font-mono text-emerald-600 dark:text-emerald-400">
                    {summary.fixedTests}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Tests fixed
                  </span>
                </div>
                <div className="flex flex-col items-center gap-0.5 rounded-lg border border-blue-500/20 bg-blue-500/5 py-2">
                  <span className="text-lg font-bold font-mono text-blue-600 dark:text-blue-400">
                    {summary.modifiedFiles}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Files changed
                  </span>
                </div>
                <div className="flex flex-col items-center gap-0.5 rounded-lg border border-violet-500/20 bg-violet-500/5 py-2">
                  <span className="text-lg font-bold font-mono text-violet-600 dark:text-violet-400">
                    {summary.addedTests}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                    Tests added
                  </span>
                </div>
              </div>

              {summary.approvalsRequired.length > 0 && (
                <div className="flex flex-col gap-1 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
                  {summary.approvalsRequired.map((desc, i) => (
                    <span key={i} className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <ShieldAlert className="h-3 w-3 shrink-0" /> {desc}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-muted/40 p-2.5 font-mono text-xs text-foreground/80 whitespace-pre-wrap">
                {summary.text}
              </div>

              <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                <FlaskConical className="h-3 w-3" />
                Structured aggregation over the tamper-evident event + audit trail — not an LLM summary.
              </p>
            </div>
          ) : null}
        </div>
      )}

      {/* Main Console & Live Stream View */}
      <div className="relative flex-1 min-h-0 rounded-xl border border-border bg-[#0d1117] text-gray-200 overflow-hidden flex flex-col shadow-inner">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-[#161b22] border-b border-[#30363d] text-xs font-mono text-gray-400 select-none">
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-primary" />
            <span>Agent Event Stream</span>
            <span className="text-[10px] text-gray-500">
              ({events.length} / {MAX_EVENT_BUFFER} buffered)
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[11px]">
              <span
                className={`h-2 w-2 rounded-full ${
                  isSessionActive ? "bg-emerald-500 animate-pulse" : "bg-gray-500"
                }`}
              />
              {isSessionActive ? "Live" : "Ended"}
            </span>
          </div>
        </div>

        {/* Scrollable Event Log Area */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-2.5 selection:bg-primary/30"
        >
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center text-gray-500">
              <Terminal className="h-8 w-8 mb-2 opacity-50" />
              <p>Waiting for agent event stream...</p>
              <p className="text-[10px] text-gray-600 mt-1">
                Output, thoughts, and tool executions will appear here in real time.
              </p>
            </div>
          ) : (
            events.map((evt) => (
              <EventRenderer key={evt.id} record={evt} />
            ))
          )}
          <div ref={scrollAnchorRef} />
        </div>

        {/* Resume Auto-Scroll Button */}
        {!isAutoScrollLocked && (
          <button
            onClick={scrollToBottom}
            className="absolute bottom-16 right-6 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-primary-foreground shadow-lg text-xs font-sans font-semibold hover:bg-primary/90 transition-all animate-bounce"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Resume Auto-scroll
          </button>
        )}

        {/* Sticky Action / Prompt Bar */}
        <div className="p-3 bg-[#161b22] border-t border-[#30363d]">
          <form onSubmit={handleSendPrompt} className="flex items-center gap-2">
            <Input
              type="text"
              placeholder={
                isSessionActive
                  ? "Type instruction or message to agent..."
                  : "Session has ended. Commands cannot be submitted."
              }
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              disabled={!isSessionActive || sendingPrompt}
              className="bg-[#0d1117] border-[#30363d] text-white text-xs font-mono focus-visible:ring-primary h-9"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!isSessionActive || !promptInput.trim() || sendingPrompt}
              className="h-9 px-4 gap-1.5 text-xs shrink-0"
            >
              {sendingPrompt ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" /> Send
                </>
              )}
            </Button>
          </form>
        </div>
      </div>

      {/* Cancel Confirmation Modal */}
      {showCancelConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border border-destructive/30 bg-card p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-destructive">
              <AlertCircle className="h-6 w-6" />
              <h3 className="text-lg font-bold">Abort Agent Session?</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to stop session <strong>{session.id}</strong>? Any currently executing CLI agent process on the remote machine will be forcefully terminated.
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowCancelConfirm(false)}
                disabled={actionLoading}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={handleCancel}
                disabled={actionLoading}
              >
                {actionLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : "Abort Session"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * EventRenderer: Polymorphic renderer for various protocol event types
 */
function EventRenderer({ record }: { record: StoredEventRecord }) {
  const { eventType, envelope, storedAt } = record;
  const payload = (envelope.payload || {}) as Record<string, unknown>;
  const timeStr = new Date(storedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  // 1. Terminal stdout / stderr
  if (eventType === "session.output") {
    const stream = String(payload.stream || "stdout");
    const content = String(payload.content || "");
    const isErr = stream === "stderr";

    return (
      <div className="flex items-start gap-2 group hover:bg-[#161b22]/50 py-0.5 px-1 rounded transition-colors">
        <span className="text-gray-500 text-[10px] select-none shrink-0 w-16">{timeStr}</span>
        <span
          className={`select-none text-[10px] uppercase font-bold shrink-0 px-1 rounded ${
            isErr ? "bg-red-950 text-red-400" : "bg-emerald-950 text-emerald-400"
          }`}
        >
          {stream}
        </span>
        <pre className={`flex-1 whitespace-pre-wrap break-all ${isErr ? "text-red-300" : "text-gray-200"}`}>
          {content}
        </pre>
      </div>
    );
  }

  // 2. Agent Chat Message / Utterance
  if (eventType === "session.message") {
    const role = String(payload.role || "agent");
    const text = String(payload.content || payload.message || "");
    const isUser = role === "user";

    return (
      <div
        className={`flex flex-col gap-1 p-3 rounded-lg border ${
          isUser
            ? "bg-primary/10 border-primary/30 text-white ml-8"
            : "bg-[#161b22] border-[#30363d] text-gray-200 mr-8"
        }`}
      >
        <div className="flex items-center justify-between text-[11px] font-sans">
          <span className="font-semibold capitalize flex items-center gap-1.5">
            {isUser ? "You" : "Agent"}
          </span>
          <span className="text-gray-500">{timeStr}</span>
        </div>
        <p className="text-xs whitespace-pre-wrap">{text}</p>
      </div>
    );
  }

  // 3. Tool Call & Tool Result
  if (eventType === "session.tool_call" || eventType === "session.tool_result") {
    const toolName = String(payload.toolName || payload.name || "tool");
    const args: unknown = payload.arguments ?? payload.input;
    const result: unknown = payload.result ?? payload.output;
    const renderValue = (value: unknown): string =>
      typeof value === "string" ? value : JSON.stringify(value, null, 2);

    return (
      <div className="flex flex-col rounded-lg border border-[#30363d] bg-[#161b22] p-2.5 my-1">
        <div className="flex items-center justify-between text-xs mb-1">
          <div className="flex items-center gap-1.5 text-amber-400 font-semibold">
            <Wrench className="h-3.5 w-3.5" />
            <span>{eventType === "session.tool_call" ? `Invoke: ${toolName}` : `Result: ${toolName}`}</span>
          </div>
          <span className="text-[10px] text-gray-500">{timeStr}</span>
        </div>
        {args !== undefined && args !== null && (
          <pre className="text-[11px] bg-[#0d1117] p-2 rounded border border-[#30363d] text-gray-300 overflow-x-auto">
            {renderValue(args)}
          </pre>
        )}
        {result !== undefined && result !== null && (
          <pre className="text-[11px] bg-[#0d1117] p-2 rounded border border-[#30363d] text-emerald-400 overflow-x-auto mt-1">
            {renderValue(result)}
          </pre>
        )}
      </div>
    );
  }

  // 4. Approval Required Banner
  if (eventType === "session.approval_required") {
    const actionType = String(payload.actionType || "command");
    const desc = String(payload.description || "Agent requires approval to continue");

    return (
      <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3.5 my-1 text-amber-300">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-400" />
            <span className="font-bold text-xs">APPROVAL REQUIRED</span>
          </div>
          <span className="text-[10px] text-amber-400/80">{timeStr}</span>
        </div>
        <p className="text-xs text-white">{desc}</p>
        <div className="flex items-center gap-2 text-[11px]">
          <span className="bg-amber-950/80 px-2 py-0.5 rounded border border-amber-500/30 font-mono">
            {actionType}
          </span>
        </div>
      </div>
    );
  }

  // 5. Status Transition
  if (eventType === "session.status_changed") {
    const nextState = String(payload.state || "unknown");
    return (
      <div className="flex items-center justify-center my-1">
        <div className="flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-[#161b22] border border-[#30363d] text-[11px] text-gray-400">
          <span>State changed to:</span>
          <span className="font-bold font-mono text-primary uppercase">{nextState}</span>
          <span className="text-[10px] text-gray-500">• {timeStr}</span>
        </div>
      </div>
    );
  }

  // Fallback generic event log
  return (
    <div className="flex items-start gap-2 text-gray-400 text-[11px] py-0.5">
      <span className="text-gray-600 text-[10px] select-none w-16">{timeStr}</span>
      <span className="bg-[#161b22] px-1 rounded text-gray-400 font-mono text-[10px]">
        {eventType}
      </span>
      <pre className="text-gray-400 truncate flex-1">{JSON.stringify(payload)}</pre>
    </div>
  );
}
