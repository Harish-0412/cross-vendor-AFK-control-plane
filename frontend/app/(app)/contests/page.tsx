"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  Copy,
  Crown,
  FileDiff,
  FlaskConical,
  GitBranch,
  Loader2,
  MinusCircle,
  Scale,
  Swords,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

import {
  AgentPicker,
  HowItWorks,
  ProjectMachineFields,
  StateBadge,
  useProjectAndMachine,
} from "@/components/arena/shared";
import { DiffViewer } from "@/components/diff-viewer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api-client";
import { AGENT_VENDOR, agentLabel, arena, type Contest, type ContestEntry } from "@/lib/arena";
import { cn } from "@/lib/utils";

const ACTIVE = new Set(["running", "judging"]);
const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

export default function ContestsPage() {
  const picker = useProjectAndMachine();
  const [agents, setAgents] = useState<string[]>([]);
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);
  const [contests, setContests] = useState<Contest[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Contest | null>(null);

  const available = picker.agents;

  const refresh = useCallback(async () => {
    try {
      const list = await arena.contests();
      setContests(list);
    } catch {
      setContests([]);
    }
  }, []);

  const selected = contests?.find((contest) => contest.id === selectedId) ?? contests?.[0] ?? null;

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await arena.contest(id));
    } catch {
      setDetail(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selected) void loadDetail(selected.id);
  }, [selected?.id, selected?.updatedAt, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

  const anyActive = contests?.some((contest) => ACTIVE.has(contest.state));
  useEffect(() => {
    if (!anyActive) return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [anyActive, refresh]);

  const start = async () => {
    if (!picker.projectId || !picker.deviceId || agents.length < 2 || !task.trim()) return;
    setStarting(true);
    try {
      const contest = await arena.startContest({
        projectId: picker.projectId,
        deviceId: picker.deviceId,
        task: task.trim(),
        agents,
      });
      toast.success(`${agents.length} agents are on it`);
      setTask("");
      setSelectedId(contest.id);
      await refresh();
    } catch (error) {
      toast.error(errorText(error, "Could not start the contest"));
    } finally {
      setStarting(false);
    }
  };

  const act = async (work: () => Promise<Contest>, done: string) => {
    try {
      const updated = await work();
      setDetail(updated);
      toast.success(done);
      await refresh();
    } catch (error) {
      toast.error(errorText(error, "That did not work"));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <Swords className="h-6 w-6 text-primary" /> Contest
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
          Give one task to several vendors&apos; real coding agents at once — Claude Code, Codex,
          OpenCode — and keep the best result. The winner is decided by your own tests and a
          review from a different vendor, not by the agents themselves.
        </p>
      </div>

      <HowItWorks
        steps={[
          {
            icon: Copy,
            title: "Same task, separate copies",
            text: "Each agent works in its own copy of your repository, at the same time. Your folder is never touched.",
          },
          {
            icon: Scale,
            title: "Tested and cross-reviewed",
            text: "Your project's tests run on every result, and an agent from a different vendor reviews it without knowing who wrote it.",
          },
          {
            icon: GitBranch,
            title: "Take the winner as a branch",
            text: "Score = tests (60) + review (40). Apply the winner and it becomes a branch in your repository to merge.",
          },
        ]}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">New contest</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProjectMachineFields state={picker} />
          <div className="space-y-1.5">
            <Label>Competitors</Label>
            <AgentPicker
              available={available}
              selected={agents}
              onChange={setAgents}
              max={4}
              hint="Choose 2 to 4. Each runs on its own plan, and each result is reviewed by one of the others."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="contest-task">Task</Label>
            <Textarea
              id="contest-task"
              rows={4}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              placeholder="e.g. Add input validation to the signup form and cover it with tests"
            />
          </div>
          <Button
            onClick={() => void start()}
            disabled={starting || agents.length < 2 || !task.trim() || !picker.device?.online}
            className="gap-2"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Swords className="h-4 w-4" />}
            Start contest
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Contests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 p-2">
            {contests === null && <p className="p-2 text-sm text-muted-foreground">Loading…</p>}
            {contests?.length === 0 && <p className="p-2 text-sm text-muted-foreground">None yet.</p>}
            {contests?.map((contest) => (
              <button
                key={contest.id}
                type="button"
                onClick={() => setSelectedId(contest.id)}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left transition-colors",
                  selected?.id === contest.id ? "bg-primary/10" : "hover:bg-muted",
                )}
              >
                <p className="line-clamp-1 text-sm font-medium">{contest.task}</p>
                <div className="mt-1 flex items-center gap-2">
                  <StateBadge state={contest.state} />
                  {contest.winnerAgentId && (
                    <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                      <Crown className="h-3 w-3" /> {agentLabel(contest.winnerAgentId)}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        {detail ? (
          <ContestDetail
            contest={detail}
            onApply={(agentId) =>
              void act(() => arena.applyContest(detail.id, agentId), "Applied as a branch")
            }
            onCleanup={() => void act(() => arena.cleanupContest(detail.id), "Workspaces removed")}
            onCancel={() => void act(() => arena.cancelContest(detail.id), "Contest cancelled")}
          />
        ) : (
          <Card>
            <CardContent className="py-16 text-center text-sm text-muted-foreground">
              Start a contest to see the agents compete here.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function ContestDetail({
  contest,
  onApply,
  onCleanup,
  onCancel,
}: {
  contest: Contest;
  onApply: (agentId?: string) => void;
  onCleanup: () => void;
  onCancel: () => void;
}) {
  const [diffFor, setDiffFor] = useState<string | null>(null);
  const active = ACTIVE.has(contest.state);
  const winner = contest.entries.find((entry) => entry.agentId === contest.winnerAgentId);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            <StateBadge state={contest.state} />
            <span className="text-xs text-muted-foreground">
              {contest.projectName} · {new Date(contest.createdAt).toLocaleString()}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{contest.task}</p>

          {contest.state === "decided" && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Crown className="h-4 w-4 text-amber-500" />
                {winner ? `${agentLabel(winner.agentId)} wins` : "No winner"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{contest.decisionReason}</p>
              {contest.applied ? (
                <p className="mt-2 text-sm">
                  Applied as branch <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{contest.applied.branch}</code>.
                  Review and merge it in your repository.
                </p>
              ) : winner && !contest.cleanedUp ? (
                <Button size="sm" className="mt-3 gap-2" onClick={() => onApply()}>
                  <GitBranch className="h-4 w-4" /> Apply {agentLabel(winner.agentId)}&apos;s result as a branch
                </Button>
              ) : null}
            </div>
          )}
          {contest.error && <p className="text-sm text-destructive">{contest.error}</p>}

          <div className="flex flex-wrap gap-2">
            {active && (
              <Button size="sm" variant="outline" onClick={onCancel}>
                Cancel contest
              </Button>
            )}
            {!active && !contest.cleanedUp && (
              <Button size="sm" variant="ghost" className="gap-1.5" onClick={onCleanup}>
                <Trash2 className="h-3.5 w-3.5" /> Remove workspaces
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {contest.entries.map((entry, index) => (
          <EntryCard
            key={entry.agentId}
            entry={entry}
            letter={"ABCD"[index] ?? String(index + 1)}
            winner={entry.agentId === contest.winnerAgentId}
            canApply={contest.state === "decided" && !contest.applied && !contest.cleanedUp && entry.state === "done"}
            onApply={() => onApply(entry.agentId)}
            showDiff={diffFor === entry.agentId}
            onToggleDiff={() => setDiffFor(diffFor === entry.agentId ? null : entry.agentId)}
          />
        ))}
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  letter,
  winner,
  canApply,
  onApply,
  showDiff,
  onToggleDiff,
}: {
  entry: ContestEntry;
  letter: string;
  winner: boolean;
  canApply: boolean;
  onApply: () => void;
  showDiff: boolean;
  onToggleDiff: () => void;
}) {
  const tests = entry.evaluation?.tests;
  const review = entry.review;
  return (
    <Card className={cn(winner && "border-amber-500/40 shadow-md")}>
      <CardContent className="space-y-3 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-base font-semibold">
              {winner && <Crown className="h-4 w-4 text-amber-500" />}
              {agentLabel(entry.agentId)}
            </p>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Entry {letter} · {AGENT_VENDOR[entry.agentId] ?? "Agent"}
            </p>
          </div>
          <div className="text-right">
            {typeof entry.score === "number" ? (
              <p className="text-2xl font-bold tabular-nums">
                {entry.score}
                <span className="text-sm font-normal text-muted-foreground">/100</span>
              </p>
            ) : (
              <StateBadge state={entry.state} />
            )}
          </div>
        </div>

        {entry.scoreBreakdown && (
          <div className="space-y-1">
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div className="bg-emerald-500" style={{ width: `${entry.scoreBreakdown.tests}%` }} title="Tests" />
              <div className="bg-violet-500" style={{ width: `${entry.scoreBreakdown.review}%` }} title="Review" />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Tests {entry.scoreBreakdown.tests}/60 · Review {entry.scoreBreakdown.review}/40 ·{" "}
              {entry.scoreBreakdown.notes.join(" · ")}
            </p>
          </div>
        )}

        {entry.evaluation && (
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <p className="flex items-center gap-1.5">
              {!tests?.ran ? (
                <MinusCircle className="h-4 w-4 text-muted-foreground" />
              ) : tests.passed ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : (
                <XCircle className="h-4 w-4 text-destructive" />
              )}
              <span>
                {!tests?.ran ? "No tests to run" : tests.passed ? "Tests pass" : "Tests fail"}
                {tests?.summary && tests.ran && (
                  <span className="text-xs text-muted-foreground"> · {tests.summary}</span>
                )}
              </span>
            </p>
            <p className="flex items-center gap-1.5">
              <FileDiff className="h-4 w-4 text-muted-foreground" />
              {entry.evaluation.files.length} files ·{" "}
              <span className="text-emerald-600">+{entry.evaluation.added}</span>{" "}
              <span className="text-destructive">−{entry.evaluation.removed}</span>
            </p>
          </div>
        )}

        {review && review.state !== "skipped" && (
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p className="flex items-center gap-1.5 font-medium">
              <FlaskConical className="h-3.5 w-3.5 text-violet-500" />
              Reviewed by {agentLabel(review.reviewerAgentId)}
              {typeof review.score === "number" && (
                <span className="ml-auto font-semibold tabular-nums">{review.score}/10</span>
              )}
            </p>
            {review.state === "pending" || review.state === "running" ? (
              <p className="mt-1 text-xs text-muted-foreground">Reviewing…</p>
            ) : review.state === "failed" ? (
              <p className="mt-1 text-xs text-muted-foreground">{review.error}</p>
            ) : (
              <>
                {review.summary && <p className="mt-1 text-xs text-muted-foreground">{review.summary}</p>}
                {review.issues && review.issues.length > 0 && (
                  <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                    {review.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {entry.error && <p className="text-xs text-destructive">{entry.error}</p>}

        <div className="flex flex-wrap items-center gap-2">
          {typeof entry.score === "number" && <StateBadge state={entry.state} />}
          {entry.sessionId && (
            <Button asChild size="sm" variant="ghost" className="h-8 px-2 text-xs">
              <Link href={`/sessions/${entry.sessionId}`}>Watch the agent</Link>
            </Button>
          )}
          {entry.evaluation?.diff && (
            <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={onToggleDiff}>
              {showDiff ? "Hide changes" : "Show changes"}
            </Button>
          )}
          {canApply && !winner && (
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onApply}>
              Apply this one instead
            </Button>
          )}
        </div>

        {showDiff && entry.evaluation?.diff && (
          <DiffViewer patch={entry.evaluation.diff} maxHeight="420px" />
        )}
      </CardContent>
    </Card>
  );
}
