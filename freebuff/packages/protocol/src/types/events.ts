export type EventType =
  | 'session.created'
  | 'session.started'
  | 'session.status_changed'
  | 'session.output'
  | 'session.message'
  | 'session.tool_call'
  | 'session.tool_result'
  | 'session.tool_error'
  | 'session.file_changed'
  | 'session.approval_required'
  | 'session.approval_granted'
  | 'session.approval_denied'
  | 'session.checkpoint'
  | 'session.thinking'
  | 'session.completed'
  | 'session.failed'
  | 'session.cancelled'
  | 'session.crashed'
  | 'gateway.status'
  | 'sandbox.created'
  | 'sandbox.destroyed'
  | 'policy.violation'
  | 'system.error';

export interface EventEnvelope {
  eventId: string;
  eventType: EventType;
  eventVersion: number;
  sessionId: string;
  deviceId?: string;
  sequence: number;
  occurredAt: Date;
  correlationId?: string;
  parentEventId?: string;
  payload: unknown;
}

export interface SessionOutputPayload {
  stream: 'stdout' | 'stderr';
  content: string;
  timestamp: Date;
}

export interface SessionMessagePayload {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  thinking?: string;
  turnNumber?: number;
  metadata?: Record<string, unknown>;
}

export interface ToolCallPayload {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  timestamp: Date;
  durationMs?: number;
}

export interface ToolResultPayload {
  toolCallId: string;
  toolName: string;
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface FileChangedPayload {
  path: string;
  action: 'created' | 'modified' | 'deleted' | 'renamed';
  diff?: string;
  oldPath?: string;
  sizeBytes?: number;
  timestamp: Date;
}

export interface ApprovalRequiredPayload {
  approvalId: string;
  action: string;
  description: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  scope: string;
  affectedResources?: string[];
  requiresReason?: boolean;
  timeoutMs?: number;
  requestedAt: Date;
  toolCallId?: string;
}

export interface ApprovalDecisionPayload {
  approvalId: string;
  decision: 'granted' | 'denied';
  decidedAt: Date;
  decidedBy: string;
  reason?: string;
}

export interface SessionCompletedPayload {
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  summary: string;
  turnsCompleted: number;
  metrics: SessionMetrics;
}

export interface SessionFailedPayload {
  errorCode: string;
  errorMessage: string;
  stack?: string;
  fatal: boolean;
  durationMs: number;
}

export interface SessionCheckpointPayload {
  checkpointId: string;
  turnNumber: number;
  eventCount: number;
  timestamp: Date;
  digest: string;
}

export interface SessionThinkingPayload {
  phase: 'planning' | 'analyzing' | 'reflecting' | 'deciding' | 'executing';
  content?: string;
  progress?: number;
  estimatedRemainingMs?: number;
}

export interface SessionMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  fileOperations: number;
  approvalsRequested: number;
  approvalsGranted: number;
  approvalsDenied: number;
  cacheHits?: number;
  cacheMisses?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
}

export interface PolicyViolationPayload {
  policyId: string;
  policyName: string;
  severity: 'warning' | 'error' | 'critical';
  description: string;
  blocked: boolean;
  context?: Record<string, unknown>;
}

export const EVENT_VERSION = 1;
export const EVENT_ID_PREFIX = 'evt_';
export const EVENT_ID_LENGTH = 32;

export const SESSION_EVENT_TYPES: EventType[] = [
  'session.created',
  'session.started',
  'session.status_changed',
  'session.output',
  'session.message',
  'session.tool_call',
  'session.tool_result',
  'session.tool_error',
  'session.file_changed',
  'session.approval_required',
  'session.approval_granted',
  'session.approval_denied',
  'session.checkpoint',
  'session.thinking',
  'session.completed',
  'session.failed',
  'session.cancelled',
  'session.crashed',
];

export function isSessionEventType(type: EventType): boolean {
  return SESSION_EVENT_TYPES.includes(type);
}

export function isValidEventId(id: string): boolean {
  return id.startsWith(EVENT_ID_PREFIX) && id.length === EVENT_ID_PREFIX.length + EVENT_ID_LENGTH;
}

export function compareEvents(a: EventEnvelope, b: EventEnvelope): number {
  return a.sequence - b.sequence;
}

export function groupEventsBySession(events: EventEnvelope[]): Map<string, EventEnvelope[]> {
  const grouped = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    const existing = grouped.get(event.sessionId) ?? [];
    existing.push(event);
    grouped.set(event.sessionId, existing);
  }
  return grouped;
}
