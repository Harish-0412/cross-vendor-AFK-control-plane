import type { AgentCapabilities } from './agent';

export type OrganizationRole = 'owner' | 'admin' | 'member';
export type TaskKind = 'implementation' | 'test' | 'security_review' | 'planning' | 'general';
export type RoutingStrategy = 'least_loaded' | 'capability_first' | 'lowest_risk' | 'lowest_cost';

export interface AgentRouteCandidate {
  deviceId: string;
  gatewayId: string;
  agentId: string;
  online: boolean;
  activeSessions: number;
  capabilities?: Partial<AgentCapabilities>;
  estimatedCostUsd?: number;
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
  createdAt: Date;
}

export interface RiskAssessment {
  score: number;
  level: 'low' | 'medium' | 'high' | 'critical';
  factors: Array<{ name: string; weight: number; contribution: number }>;
  requiresApproval: boolean;
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
