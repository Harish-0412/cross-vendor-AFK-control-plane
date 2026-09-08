import type { AgentMetadata, AgentInstallationResult, AgentValidationResult } from './agent';
import type { EventEnvelope } from './events';
import type { Session, SessionConfig, SessionState } from './session';

export type CommandType =
  | 'session.start'
  | 'session.stop'
  | 'session.pause'
  | 'session.resume'
  | 'session.message'
  | 'session.approve'
  | 'session.deny'
  | 'session.input'
  | 'session.diff_collection'
  | 'session.run_tests'
  | 'git.branch_create'
  | 'git.commit'
  | 'git.push'
  | 'git.status'
  | 'system.ping'
  | 'system.shutdown';

export interface CommandEnvelope {
  commandId: string;
  commandType: CommandType;
  commandVersion: number;
  sessionId?: string;
  targetAgentId?: string;
  issuedAt: Date;
  correlationId?: string;
  timeoutMs?: number;
  payload: unknown;
}

export interface CommandResult {
  commandId: string;
  success: boolean;
  executedAt: Date;
  completedAt: Date;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export interface StartSessionCommand {
  config: SessionConfig;
}

export interface StopSessionCommand {
  reason?: string;
  force?: boolean;
  timeoutMs?: number;
}

export interface SendMessageCommand {
  message: string;
  role?: 'user' | 'system';
  metadata?: Record<string, unknown>;
}

export interface ApprovalDecisionCommand {
  approvalId: string;
  decision: 'granted' | 'denied';
  reason?: string;
  decidedBy?: string;
}

export interface SessionInputCommand {
  data: string;
  stream: 'stdin' | 'control';
}

export interface GitBranchCreateCommand {
  sessionId: string;
  projectRoot: string;
  branch: string;
  fromRef?: string;
}

export interface GitCommitCommand {
  sessionId: string;
  projectRoot: string;
  message: string;
  files?: string[];
}

export interface GitPushCommand {
  sessionId: string;
  projectRoot: string;
  remote?: string;
  branch: string;
  force?: boolean;
}

export type EventStream = AsyncIterable<EventEnvelope> & {
  [Symbol.asyncIterator](): AsyncIterator<EventEnvelope>;
  unsubscribe(): void;
  closed: boolean;
};

export interface EventSubscriber {
  onEvent: (event: EventEnvelope) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
  filter?: (event: EventEnvelope) => boolean;
}

export interface AgentAdapter {
  metadata(): AgentMetadata;
  installOrDetect(): Promise<AgentInstallationResult>;
  validateEnvironment(): Promise<AgentValidationResult>;
  startSession(config: SessionConfig): Promise<string>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  sendInput(sessionId: string, data: string): Promise<void>;
  streamEvents(sessionId: string, subscriber?: Partial<EventSubscriber>): EventStream;
  requestApproval(
    sessionId: string,
    action: ApprovalAction,
  ): Promise<{ approved: boolean; reason?: string }>;
  submitApprovalDecision(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
  ): Promise<void>;
  abortSession(sessionId: string, reason: string, force?: boolean): Promise<void>;
  collectDiff(sessionId: string): Promise<string>;
  getState(sessionId: string): Promise<SessionState>;
  getSession(sessionId: string): Promise<Session | undefined>;
  cleanupSession(sessionId: string): Promise<void>;
  pauseSession?(sessionId: string): Promise<void>;
  resumeSession?(sessionId: string): Promise<void>;
  checkpointSession?(sessionId: string): Promise<string>;
  shutdown?(): Promise<void>;
}

export interface ApprovalAction {
  id: string;
  type: 'tool_call' | 'file_operation' | 'bash_exec' | 'network_request' | 'custom';
  description: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  details: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AdapterRegistry {
  register(adapter: AgentAdapter): void;
  unregister(adapterId: string): boolean;
  get(adapterId: string): AgentAdapter | undefined;
  list(): AgentAdapter[];
  has(adapterId: string): boolean;
  detectAll(): Promise<Array<{ adapter: AgentAdapter; available: boolean }>>;
}

export const COMMAND_VERSION = 1;
export const COMMAND_ID_PREFIX = 'cmd_';
export const COMMAND_ID_LENGTH = 24;

export function isValidCommandId(id: string): boolean {
  return (
    id.startsWith(COMMAND_ID_PREFIX) && id.length === COMMAND_ID_PREFIX.length + COMMAND_ID_LENGTH
  );
}
