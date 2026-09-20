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
  plan: OrchestrationPlan;
  state: OrchestrationRunState;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}
