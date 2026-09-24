/**
 * Orchestration runs: a goal handed to a team of agents on the user's own
 * machines — a planner, builders, a tester and a reviewer.
 */
import { apiClient } from "./api-client";

export type TaskKind = "planning" | "implementation" | "test" | "security_review" | "general";
export type StepState = "pending" | "running" | "completed" | "failed" | "blocked" | "skipped";
export type RunState =
  | "planned"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface ReviewFinding {
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  file?: string;
  line?: number;
}

export interface OrchestrationStep {
  id: string;
  title: string;
  taskKind: TaskKind;
  prompt: string;
  dependsOn: string[];
  requiredAgentId?: string;
  state: StepState;
  sessionId?: string;
  agentId?: string;
  error?: string;
  origin?: "planner" | "test_fix" | "review_fix" | "guarantee";
  attempt?: number;
  contextConversationIds?: string[];
  startedAt?: string;
  finishedAt?: string;
  risk?: { level: string; score: number };
  outcome?: {
    summary: string;
    filesChanged: string[];
    testsPassed?: boolean;
    verdict?: "approve" | "changes_requested";
    findings?: ReviewFinding[];
  };
}

export interface OrchestrationRun {
  id: string;
  goal?: string;
  state: RunState;
  error?: string;
  maxFixAttempts?: number;
  plan: { title: string; projectId: string; steps: OrchestrationStep[] };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export const orchestrations = {
  list: (projectId?: string) =>
    apiClient.get<OrchestrationRun[]>(
      `/api/v1/orchestrations${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  get: (id: string) => apiClient.get<OrchestrationRun>(`/api/v1/orchestrations/${id}`),
  start: (input: { projectId: string; goal: string; maxFixAttempts: number; plannerAgentId?: string }) =>
    apiClient.post<OrchestrationRun>("/api/v1/orchestrations", input),
  advance: (id: string) => apiClient.post<OrchestrationRun>(`/api/v1/orchestrations/${id}/advance`, {}),
  cancel: (id: string) => apiClient.post<OrchestrationRun>(`/api/v1/orchestrations/${id}/cancel`, {}),
};

export const ROLE_LABEL: Record<TaskKind, string> = {
  planning: "Planner",
  implementation: "Builder",
  test: "Tester",
  security_review: "Reviewer",
  general: "Agent",
};

export const ORIGIN_LABEL: Record<NonNullable<OrchestrationStep["origin"]>, string> = {
  planner: "From the plan",
  test_fix: "Fixing failed tests",
  review_fix: "Fixing review findings",
  guarantee: "Added automatically",
};

export const ACTIVE_RUN_STATES = new Set<RunState>(["planned", "running", "waiting_for_approval"]);

/** Steps in the order they can run: each after everything it depends on. */
export function orderSteps(steps: OrchestrationStep[]): OrchestrationStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const placed = new Set<string>();
  const ordered: OrchestrationStep[] = [];
  const visit = (step: OrchestrationStep, seen: Set<string>) => {
    if (placed.has(step.id) || seen.has(step.id)) return;
    seen.add(step.id);
    for (const dep of step.dependsOn) {
      const parent = byId.get(dep);
      if (parent) visit(parent, seen);
    }
    placed.add(step.id);
    ordered.push(step);
  };
  for (const step of steps) visit(step, new Set());
  return ordered;
}
