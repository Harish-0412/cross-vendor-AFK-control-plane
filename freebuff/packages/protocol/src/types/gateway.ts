import type { AgentInfo } from './agent';
import type { EventSubscriber } from './commands';
import type { ProjectInfo, ProjectStats } from './project';
import type { Session, SessionConfig, SessionFilter, SessionSummary } from './session';

export interface GatewayStatus {
  version: string;
  gatewayId: string;
  deviceId: string;
  uptimeMs: number;
  startedAt: Date;
  activeSessions: number;
  totalSessions: number;
  failedSessions: number;
  agents: AgentInfo[];
  resources: ResourceUsage;
  sandbox: GatewaySandboxStatus;
  features: GatewayFeatures;
}

export interface ResourceUsage {
  cpuPercent: number;
  memoryMb: number;
  memoryTotalMb: number;
  memoryUsedMb: number;
  activeProcesses: number;
  diskUsagePercent: number;
  loadAverage: number[];
}

export interface GatewaySandboxStatus {
  available: boolean;
  active: number;
  totalCreated: number;
  totalDestroyed: number;
  orphansCleaned: number;
}

export interface GatewayFeatures {
  sandboxIsolation: boolean;
  secretRedaction: boolean;
  approvalWorkflow: boolean;
  checkpointRecovery: boolean;
  localApiServer: boolean;
  tunnelClient: boolean;
}

export interface GatewayCore {
  getStatus(): Promise<GatewayStatus>;
  shutdown(graceful?: boolean, timeoutMs?: number): Promise<void>;

  detectAgents(): Promise<AgentInfo[]>;
  listAgents(): Promise<AgentInfo[]>;
  getAgent(agentId: string): Promise<AgentInfo>;

  listProjects(): Promise<ProjectInfo[]>;
  getProject(projectId: string): Promise<ProjectInfo>;
  validateProject(projectRoot: string): Promise<import('./project').ProjectValidation>;
  registerProject(
    options: import('./project').ProjectRegistrationOptions,
  ): Promise<ProjectInfo>;
  removeProject(projectId: string): Promise<void>;
  getProjectStats(): Promise<ProjectStats>;

  createSession(config: SessionConfig): Promise<Session>;
  getSession(sessionId: string): Promise<Session>;
  listSessions(filter?: SessionFilter): Promise<Session[]>;
  listSessionSummaries(filter?: SessionFilter): Promise<SessionSummary[]>;
  stopSession(sessionId: string, reason?: string, force?: boolean): Promise<void>;
  sendInput(sessionId: string, input: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  submitApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void>;
  collectSessionDiff(sessionId: string): Promise<string>;
  cleanupSession(sessionId: string): Promise<void>;

  subscribeToEvents(subscriber: EventSubscriber): () => void;
  subscribeToSessionEvents(
    sessionId: string,
    subscriber: EventSubscriber,
  ): () => void;

  getGatewayId(): string;
  getDeviceId(): string;
}

export interface GatewayOptions {
  gatewayId?: string;
  deviceId?: string;
  projectRoots?: string[];
  allowedAdapters?: string[];
  sandboxEnabled?: boolean;
  apiServer?: {
    enabled: boolean;
    host?: string;
    port?: number;
    allowRemote?: boolean;
  };
  redaction?: {
    enabled: boolean;
    customPatterns?: Array<{ name: string; pattern: string; replacement?: string }>;
  };
  logLevel?: 'error' | 'warn' | 'info' | 'debug' | 'trace';
  shutdownTimeoutMs?: number;
}

export interface GatewayEvent {
  type:
    | 'gateway.started'
    | 'gateway.shutting_down'
    | 'gateway.shutdown'
    | 'agent.detected'
    | 'agent.removed'
    | 'project.registered'
    | 'project.removed'
    | 'error';
  timestamp: Date;
  payload?: unknown;
}

export const GATEWAY_VERSION = '0.1.0';
export const DEFAULT_API_HOST = '127.0.0.1';
export const DEFAULT_API_PORT = 5173;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000;

export const DEFAULT_GATEWAY_FEATURES: GatewayFeatures = {
  sandboxIsolation: true,
  secretRedaction: true,
  approvalWorkflow: true,
  checkpointRecovery: false,
  localApiServer: true,
  tunnelClient: false,
};
