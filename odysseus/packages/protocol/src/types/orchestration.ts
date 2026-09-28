import type { AgentCapabilities } from './agent';
import type { Capability } from './policy';

export type OrganizationRole = 'owner' | 'admin' | 'member';
export type TaskKind = 'implementation' | 'test' | 'security_review' | 'planning' | 'general';
export type RoutingStrategy = 'least_loaded' | 'capability_first' | 'lowest_risk' | 'lowest_cost';

/**
 * How much of an agent's subscription is left on one machine: the plan
 * window closest to running out (a 5-hour or weekly limit), not dollars.
 */
export interface AgentQuota {
  agentId: string;
  deviceId: string;
  /** `unknown` when nothing has reported on this agent's plan. */
  state: 'available' | 'low' | 'exhausted' | 'unknown';
  /** The window closest to running out. */
  window?: {
    /** "5-hour limit", "Weekly limit". */
    label: string;
    /** Absent when the provider said only that the limit was hit. */
    usedPercent?: number;
    resetsAt: string;
  };
  /** Where the figure came from: the provider's own numbers, or a limit message. */
  source: 'provider' | 'limit-hit' | 'none';
  /** One sentence, e.g. "5-hour limit reached; resets 14:20". */
  detail: string;
  observedAt?: string;
}

/** How an agent has done on one project: finished sessions, tests and reviews of its work. */
export interface AgentTrackRecord {
  agentId: string;
  projectId: string;
  successes: number;
  failures: number;
  samples: number;
  /** Smoothed success rate, 0–1; 0.5 with no history. */
  score: number;
  /** "7 of 9 went well: sessions, tests and reviews". */
  summary: string;
}

export interface AgentRouteCandidate {
  deviceId: string;
  gatewayId: string;
  agentId: string;
  online: boolean;
  activeSessions: number;
  capabilities?: Partial<AgentCapabilities>;
  estimatedCostUsd?: number;
  quota?: AgentQuota;
  trackRecord?: AgentTrackRecord;
}

export interface RoutingRequest {
  taskKind: TaskKind;
  projectId: string;
  requiredAgentId?: string;
  requiredCapabilities?: Array<keyof AgentCapabilities>;
  strategy?: RoutingStrategy;
  maxRiskScore?: number;
  maxEstimatedCostUsd?: number;
}

export interface RoutingDecision {
  id: string;
  request: RoutingRequest;
  selected: AgentRouteCandidate | null;
  alternatives: AgentRouteCandidate[];
  reasons: string[];
  /** Agents that were otherwise eligible but left out, and why (an exhausted plan). */
  skipped?: Array<{ agentId: string; deviceId: string; reason: string }>;
  createdAt: Date;
}

export interface RiskAssessment {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  factors: Array<{
    name: string;
    weight: number;
    contribution: number;
    /** What the factor saw, in words a person can read on a phone. */
    detail?: string;
  }>;
  requiresApproval: boolean;
}

/** A concrete thing an agent wants to do, as the risk engine sees it. */
export interface ActionDescriptor {
  capability: Capability;
  /** The shell command, for `process.exec`. */
  command?: string;
  /** What the capability acts on: a file path, branch, repository or URL. */
  resource?: string;
  /** Git push modifier. */
  force?: boolean;
  /** The project's root, so paths inside it can be told from paths outside it. */
  projectRoot?: string;
  /** Branches the project protects. `main` and `master` always count. */
  protectedBranches?: string[];
}

/** The risk of one concrete action: what it does, and whether it can be undone. */
export interface ActionRiskAssessment extends RiskAssessment {
  /** False when nothing inside the project (git, a rebuild) can take it back. */
  reversible: boolean;
  /** One sentence for the approval card, e.g. "Pushes to protected branch main. Cannot be undone." */
  summary: string;
}

export type BudgetScope = 'session' | 'project' | 'organization';

export interface BudgetLimit {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  tokenLimit?: number;
  costLimitUsd?: number;
  alertPercent: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BudgetUsage {
  scope: BudgetScope;
  scopeId: string;
  tokens: number;
  costUsd: number;
  limit?: BudgetLimit;
  exceeded: boolean;
  alertTriggered: boolean;
}

export type OrchestrationStepState =
  'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'skipped';
export type OrchestrationRunState =
  'planned' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';

/** A problem the reviewer agent found in a step's changes. */
export interface ReviewFinding {
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  file?: string;
  line?: number;
}

/**
 * What a finished step produced, extracted from its session's events. This is
 * what later steps are told about, so each agent builds on the work before it
 * instead of starting cold.
 */
export interface StepOutcome {
  /** The agent's final words, trimmed to a bounded size. */
  summary: string;
  filesChanged: string[];
  /** Test steps: whether the test agent reported PASS. */
  testsPassed?: boolean;
  /** Review steps: the reviewer's verdict and findings. */
  verdict?: 'approve' | 'changes_requested';
  findings?: ReviewFinding[];
}

export interface OrchestrationStep {
  id: string;
  title: string;
  taskKind: TaskKind;
  prompt: string;
  dependsOn: string[];
  requiredAgentId?: string;
  state: OrchestrationStepState;
  sessionId?: string;
  routingDecision?: RoutingDecision;
  risk?: RiskAssessment;
  error?: string;
  outcome?: StepOutcome;
  /**
   * Why the orchestrator added this step itself: the planner's plan, a fix
   * for failing tests, or a fix for review findings. Absent for steps the
   * user wrote.
   */
  origin?: 'planner' | 'test_fix' | 'review_fix' | 'guarantee';
  /** For fix loops: which attempt this is, starting at 1. */
  attempt?: number;
  /** The agent that ran the step, once it has been dispatched. */
  agentId?: string;
  /** Imported conversations the context agent put in this step's prompt. */
  contextConversationIds?: string[];
  startedAt?: Date;
  finishedAt?: Date;
}

export interface OrchestrationPlan {
  id: string;
  projectId: string;
  title: string;
  steps: OrchestrationStep[];
  createdAt: Date;
}

export interface OrchestrationRun {
  id: string;
  organizationId: string;
  userId: string;
  /** Planned runs: the goal the planner agent turned into steps. */
  goal?: string;
  /** How many times a failing test or review may send work back to a builder. */
  maxFixAttempts?: number;
  /** Set when the run stopped, in words a person can act on. */
  error?: string;
  plan: OrchestrationPlan;
  state: OrchestrationRunState;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}
