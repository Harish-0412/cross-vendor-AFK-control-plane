"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  GitMerge,
  ListChecks,
  Loader2,
  Medal,
  Trophy,
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api-client";
import {
  AGENT_VENDOR,
  agentLabel,
  arena,
  type Benchmark,
  type BenchmarkAttempt,
  type BenchmarkTask,
  type Leaderboard,
} from "@/lib/arena";
import { cn } from "@/lib/utils";

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

const MEDAL = ["text-amber-500", "text-slate-400", "text-orange-700"];

function minutesText(minutes: number): string {
  if (!minutes) return "—";
  if (minutes < 1) return `${Math.max(1, Math.round(minutes * 60))}s`;
  return `${minutes.toFixed(1)} min`;
}

export default function LeaderboardPage() {
  const picker = useProjectAndMachine();
  const [agents, setAgents] = useState<string[]>([]);
  const [changes, setChanges] = useState(5);
  const [preview, setPreview] = useState<BenchmarkTask[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [benchmarks, setBenchmarks] = useState<Benchmark[]>([]);

  const available = picker.agents;

  const load = useCallback(async () => {
    if (!picker.projectId) return;
    try {
      const [nextBoard, list] = await Promise.all([
        arena.leaderboard(picker.projectId),
        arena.benchmarks(picker.projectId),
      ]);
      setBoard(nextBoard);
      setBenchmarks(list);
    } catch (error) {
      toast.error(errorText(error, "Could not load the leaderboard"));
    }
  }, [picker.projectId]);

  useEffect(() => {
    setPreview(null);
    void load();
  }, [load]);

  const running = benchmarks.find((benchmark) => benchmark.state === "running");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  const loadPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(await arena.previewBenchmark(picker.projectId, picker.deviceId, changes));
    } catch (error) {
      toast.error(errorText(error, "Could not read the project history"));
    } finally {
      setPreviewing(false);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await arena.startBenchmark({ projectId: picker.projectId, deviceId: picker.deviceId, agents, changes });
      toast.success("Benchmark started");
      setPreview(null);
      await load();
    } catch (error) {
      toast.error(errorText(error, "Could not start the benchmark"));
    } finally {
      setStarting(false);
    }
  };

  const prefer = async (agentId: string) => {
    try {
      await arena.prefer(picker.projectId, agentId);
      toast.success(`${agentLabel(agentId)} is now the default agent for ${picker.project?.name ?? "this project"}`);
      await load();
    } catch (error) {
      toast.error(errorText(error, "Could not save"));
    }
  };

  const latest = running ?? benchmarks[0];
  // Before the preview the history is unknown: only "up to" can be promised.
  const runs = agents.length * (preview?.length ?? changes);
  const runsLabel = agents.length ? ` (${preview ? "" : "up to "}${runs} runs)` : "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
          <Trophy className="h-6 w-6 text-primary" /> Leaderboard
        </h1>
        <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
          Which agent is best at <em>your</em> code? Odysseus replays changes your team already
          merged and grades each agent with the tests that shipped with them — a benchmark built
          from your own repository instead of a public one.
        </p>
      </div>

      <HowItWorks
        steps={[
          {
            icon: GitMerge,
            title: "Replays your merged changes",
            text: "Each agent starts from the commit before a real change, with that change's title and description as its task.",
          },
          {
            icon: ListChecks,
            title: "Graded by the real tests",
            text: "The tests that came with the real change are run on the agent's code. It also counts how many of the same files it touched.",
          },
          {
            icon: Medal,
            title: "Ranked on your code",
            text: "Agents are ranked by how many changes they solved. Make the winner this project's default agent in one click.",
          },
        ]}
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            Ranking {picker.project ? `for ${picker.project.name}` : ""}
          </CardTitle>
          <CardDescription>
            {board && board.tasks > 0
              ? `From ${board.tasks} replayed change${board.tasks === 1 ? "" : "s"}; a re-run replaces the earlier result for the same change.`
              : "Run a benchmark below to rank the agents on this project."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!board || board.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No results yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Agent</th>
                    <th className="py-2 pr-3">Solved</th>
                    <th className="py-2 pr-3" title="Share of the real change's files the agent also changed">
                      Same files
                    </th>
                    <th className="py-2 pr-3">Avg. time</th>
                    <th className="py-2 pr-3">Failed runs</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {board.rows.map((row) => (
                    <tr key={row.agentId} className="border-b last:border-0">
                      <td className="py-3 pr-3">
                        {row.rank <= 3 ? (
                          <Medal className={cn("h-5 w-5", MEDAL[row.rank - 1])} />
                        ) : (
                          <span className="pl-1 font-semibold text-muted-foreground">{row.rank}</span>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        <p className="font-semibold">{agentLabel(row.agentId)}</p>
                        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                          {AGENT_VENDOR[row.agentId] ?? "Agent"}
                        </p>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-emerald-500"
                              style={{ width: `${Math.round(row.solveRate * 100)}%` }}
                            />
                          </div>
                          <span className="tabular-nums">
                            {row.solved}/{row.attempted}{" "}
                            <span className="text-muted-foreground">({Math.round(row.solveRate * 100)}%)</span>
                          </span>
                        </div>
                      </td>
                      <td className="py-3 pr-3 tabular-nums">{Math.round(row.averageOverlap * 100)}%</td>
                      <td className="py-3 pr-3 tabular-nums">{minutesText(row.averageMinutes)}</td>
                      <td className="py-3 pr-3 tabular-nums">{row.failed}</td>
                      <td className="py-3 text-right">
                        {board.preferredAgentId === row.agentId ? (
                          <span className="text-xs font-semibold text-primary">Default for this project</span>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => void prefer(row.agentId)}>
                            Make default
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Run a benchmark</CardTitle>
          <CardDescription>
            Uses your agents&apos; plans: every change is attempted by every agent you pick, two at a time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProjectMachineFields state={picker} />
          <div className="space-y-1.5">
            <Label>Agents</Label>
            <AgentPicker available={available} selected={agents} onChange={setAgents} max={4} />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="bench-changes">Changes to replay</Label>
              <select
                id="bench-changes"
                value={changes}
                onChange={(event) => {
                  setChanges(Number(event.target.value));
                  setPreview(null);
                }}
                className="h-10 rounded-xl border border-input bg-background px-3 text-sm"
              >
                {[3, 5, 10].map((count) => (
                  <option key={count} value={count}>
                    Last {count}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="outline" onClick={() => void loadPreview()} disabled={previewing || !picker.device?.online}>
              {previewing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Show which changes
            </Button>
            <Button
              onClick={() => void start()}
              disabled={starting || agents.length === 0 || !picker.device?.online || Boolean(running)}
              className="gap-2"
            >
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trophy className="h-4 w-4" />}
              Start{runsLabel}
            </Button>
          </div>
          {running && (
            <p className="text-xs text-muted-foreground">A benchmark is already running for this project.</p>
          )}

          {preview && (
            <div className="rounded-xl border">
              {preview.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  No suitable changes found: the history needs commits that change code, with fewer than 40 files each.
                </p>
              ) : (
                <ul className="divide-y">
                  {preview.map((task) => (
                    <li key={task.commit} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{task.title}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {task.commit.slice(0, 8)} · {task.files.length} files · {task.linesChanged} lines
                        </p>
                      </div>
                      {task.testFiles.length > 0 ? (
                        <span className="shrink-0 text-xs text-emerald-600 dark:text-emerald-400">
                          Graded by {task.testFiles.length} test file{task.testFiles.length === 1 ? "" : "s"} it shipped with
                        </span>
                      ) : (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                          <AlertTriangle className="h-3 w-3" /> No tests came with it: graded by the existing suite
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {latest && <BenchmarkProgress benchmark={latest} onCancel={() => void arena.cancelBenchmark(latest.id).then(load)} />}
    </div>
  );
}

function BenchmarkProgress({ benchmark, onCancel }: { benchmark: Benchmark; onCancel: () => void }) {
  const cell = (task: BenchmarkTask, agentId: string): BenchmarkAttempt | undefined =>
    benchmark.attempts.find((attempt) => attempt.changeCommit === task.commit && attempt.agentId === agentId);
  const finished = benchmark.attempts.filter((attempt) => attempt.state === "done" || attempt.state === "failed").length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">
            {benchmark.state === "running" ? "Benchmark in progress" : "Latest benchmark"}
          </CardTitle>
          <div className="flex items-center gap-2">
            <StateBadge state={benchmark.state} />
            <span className="text-xs text-muted-foreground">
              {finished}/{benchmark.attempts.length} runs finished
            </span>
            {benchmark.state === "running" && (
              <Button size="sm" variant="outline" className="h-8" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
              <th className="py-2 pr-3">Change</th>
              {benchmark.agents.map((agentId) => (
                <th key={agentId} className="py-2 pr-3">
                  {agentLabel(agentId)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {benchmark.tasks.map((task) => (
              <tr key={task.commit} className="border-b last:border-0">
                <td className="max-w-[18rem] py-2.5 pr-3">
                  <p className="truncate font-medium">{task.title}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">{task.commit.slice(0, 8)}</p>
                </td>
                {benchmark.agents.map((agentId) => (
                  <td key={agentId} className="py-2.5 pr-3">
                    <AttemptCell attempt={cell(task, agentId)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function AttemptCell({ attempt }: { attempt: BenchmarkAttempt | undefined }) {
  if (!attempt) return <span className="text-muted-foreground">—</span>;
  const body =
    attempt.state === "done" ? (
      attempt.solved ? (
        <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" /> Solved
        </span>
      ) : (
        <span className="flex items-center gap-1 text-destructive">
          <XCircle className="h-4 w-4" /> Not solved
        </span>
      )
    ) : attempt.state === "failed" ? (
      <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400" title={attempt.error}>
        <AlertTriangle className="h-4 w-4" /> Did not finish
      </span>
    ) : attempt.state === "queued" || attempt.state === "cancelled" ? (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Circle className="h-4 w-4" /> {attempt.state === "queued" ? "Queued" : "Cancelled"}
      </span>
    ) : (
      <span className="flex items-center gap-1 text-primary">
        <Loader2 className="h-4 w-4 animate-spin" /> {attempt.state === "evaluating" ? "Testing" : "Working"}
      </span>
    );
  return (
    <div className="space-y-0.5">
      {attempt.sessionId ? (
        <Link href={`/sessions/${attempt.sessionId}`} className="hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
      {attempt.state === "done" && (
        <p className="text-[11px] text-muted-foreground">
          {attempt.testSummary || (attempt.testsRan ? "" : "no tests ran")}
          {typeof attempt.fileOverlap === "number" ? ` · ${Math.round(attempt.fileOverlap * 100)}% same files` : ""}
        </p>
      )}
    </div>
  );
}
