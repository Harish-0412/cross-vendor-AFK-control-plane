"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

import { RUN_STATE_LABEL, RunDetail } from "@/components/orchestrations/RunDetail";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, apiClient } from "@/lib/api-client";
import { ACTIVE_RUN_STATES, orchestrations, type OrchestrationRun } from "@/lib/orchestrations";

interface Project {
  id: string;
  name: string;
  root: string;
}

function message(error: unknown, fallback: string): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return fallback;
}

export default function OrchestrationsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("");
  const [maxFixAttempts, setMaxFixAttempts] = useState(2);
  const [runs, setRuns] = useState<OrchestrationRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await orchestrations.list();
      setRuns(Array.isArray(list) ? list : []);
      setLoadError(null);
    } catch (error) {
      setLoadError(message(error, "Could not load agent runs"));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const list = await apiClient.get<Project[]>("/api/v1/projects");
        const safe = Array.isArray(list) ? list : [];
        setProjects(safe);
        if (safe[0]) setProjectId((current) => current || safe[0]!.id);
      } catch {
        setProjects([]);
      }
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const selected = useMemo(
    () => runs.find((run) => run.id === selectedId) ?? runs[0] ?? null,
    [runs, selectedId],
  );
  const anyActive = runs.some((run) => ACTIVE_RUN_STATES.has(run.state));

  // While something is running, keep the picture current. Steps last minutes,
  // so a few seconds between checks is plenty.
  useEffect(() => {
    if (!anyActive) return;
    const timer = window.setInterval(() => void refresh(), 4_000);
    return () => window.clearInterval(timer);
  }, [anyActive, refresh]);

  const start = async () => {
    if (!projectId || !goal.trim()) return;
    setStarting(true);
    try {
      const run = await orchestrations.start({ projectId, goal: goal.trim(), maxFixAttempts });
      setRuns((previous) => [run, ...previous.filter((item) => item.id !== run.id)]);
      setSelectedId(run.id);
      setGoal("");
      toast.success("The planner is on it");
    } catch (error) {
      toast.error(message(error, "Could not start the run"));
    } finally {
      setStarting(false);
    }
  };

  const act = async (action: "advance" | "cancel", run: OrchestrationRun) => {
    setBusy(true);
    try {
      const updated = await orchestrations[action](run.id);
      setRuns((previous) => previous.map((item) => (item.id === updated.id ? updated : item)));
      if (action === "cancel") toast.info("Run cancelled");
    } catch (error) {
      toast.error(message(error, "That did not work"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Agent team</h1>
        <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
          Describe a goal. A planner agent breaks it into steps, builders make the changes, a
          tester runs the tests and a reviewer checks the work — all on your own machines, with
          your own Claude Code, Codex, Antigravity, OpenCode or Freebuff. Failed tests and review
          findings go back to a builder automatically.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New goal</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {projects.length === 0 && !loading ? (
            <p className="text-sm text-muted-foreground">
              Register a project first on the{" "}
              <Link href="/projects" className="font-medium text-primary underline-offset-4 hover:underline">
                Projects
              </Link>{" "}
              page — agents work inside a project folder on a paired machine.
            </p>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
                <div className="space-y-1.5">
                  <Label htmlFor="orch-project">Project</Label>
                  <select
                    id="orch-project"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
                  >
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name} — {project.root}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="orch-attempts">Fix attempts</Label>
                  <select
                    id="orch-attempts"
                    value={maxFixAttempts}
                    onChange={(event) => setMaxFixAttempts(Number(event.target.value))}
                    className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-40 dark:bg-input/30"
                  >
                    {[0, 1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n === 0 ? "None — stop on failure" : `Up to ${n}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="orch-goal">Goal</Label>
                <Textarea
                  id="orch-goal"
                  value={goal}
                  maxLength={4000}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="e.g. Add rate limiting to the login endpoint and cover it with tests"
                  className="min-h-24"
                />
              </div>
              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Every step is an ordinary session: your policy, approvals and budgets apply to
                  each one. Relevant past conversations you imported are added as context.
                </p>
                <Button
                  onClick={() => void start()}
                  disabled={starting || !projectId || !goal.trim()}
                  className="gap-2"
                >
                  {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Start
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {loadError && (
        <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading runs…
        </div>
      ) : runs.length === 0 ? (
        !loadError && (
          <p className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No runs yet. Give the team a goal above.
          </p>
        )
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
          <nav aria-label="Runs" className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedId(run.id)}
                className={`w-full rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  selected?.id === run.id ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/50"
                }`}
              >
                <p className="line-clamp-2 text-sm font-medium text-foreground">{run.goal ?? run.plan.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {RUN_STATE_LABEL[run.state]} · {new Date(run.createdAt).toLocaleString()}
                </p>
              </button>
            ))}
          </nav>
          {selected && <RunDetail run={selected} busy={busy} onAct={(action) => void act(action, selected)} />}
        </div>
      )}
    </div>
  );
}
