export type SessionState =
  | 'initializing'
  | 'running'
  | 'waiting_for_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'crashed';

export type SessionStatus = SessionState;

export interface ResourceLimits {
  cpuPercent?: number;
  memoryMb?: number;
  timeoutMs?: number;
  maxFileSize?: number;
  maxProcesses?: number;
  maxOpenFiles?: number;
}

export interface SandboxConfigRef {
  profile: 'strict' | 'standard' | 'permissive';
  networkPolicy?: 'none' | 'localhost' | 'outbound' | 'full';
}

export interface SessionConfig {
  projectRoot: string;
  adapter: string;
  prompt?: string;
  env?: Record<string, string>;
  timeout?: number;
  resourceLimits?: ResourceLimits;
  sandbox?: SandboxConfigRef;
  approvalMode?: 'auto' | 'ask' | 'never';
  model?: string;
  maxTurns?: number;
  metadata?: Record<string, unknown>;
}

export interface Session {
  id: string;
  projectId: string;
  adapterId: string;
  state: SessionState;
  processId?: number;
  startTime: Date;
  endTime?: Date;
  sandboxId?: string;
  sequenceNumber: number;
  lastEventAt?: Date;
  error?: SessionError;
  metadata: Record<string, unknown>;
}

export interface SessionError {
  code: string;
  message: string;
  stack?: string;
  fatal: boolean;
  retryable: boolean;
}

export interface SessionHandle {
  session: Session;
  unsubscribe: () => void;
}

export interface SessionFilter {
  projectId?: string;
  adapterId?: string;
  state?: SessionState[];
  startedAfter?: Date;
  startedBefore?: Date;
  limit?: number;
  offset?: number;
}

export interface SessionSummary {
  id: string;
  state: SessionState;
  adapterId: string;
  projectId: string;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  eventCount: number;
  lastEventType?: string;
}

export const SESSION_ID_PREFIX = 'sess_';
export const SESSION_ID_LENGTH = 24;

export function isTerminalState(state: SessionState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'crashed';
}

export function isValidSessionId(id: string): boolean {
  return id.startsWith(SESSION_ID_PREFIX) && id.length === SESSION_ID_PREFIX.length + SESSION_ID_LENGTH;
}

export function calculateDuration(session: Pick<Session, 'startTime' | 'endTime'>): number {
  const end = session.endTime ?? new Date();
  return end.getTime() - session.startTime.getTime();
}

export function createSessionSummary(
  session: Session,
  eventCount: number,
  lastEventType?: string,
): SessionSummary {
  const result: SessionSummary = {
    id: session.id,
    state: session.state,
    adapterId: session.adapterId,
    projectId: session.projectId,
    startTime: session.startTime,
    eventCount,
  };
  if (session.endTime !== undefined) {
    result.endTime = session.endTime;
    result.durationMs = calculateDuration(session);
  }
  if (lastEventType !== undefined) {
    result.lastEventType = lastEventType;
  }
  return result;
}
