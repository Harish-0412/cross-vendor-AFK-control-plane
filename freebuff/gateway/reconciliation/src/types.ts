import type {
  EventEnvelope,
  SessionReconciliationState,
  ReconciliationRequest,
  ReconciliationResponse,
} from '@freebuff/protocol';

export type ReconciliationStep =
  | 'idle'
  | 'collecting_state'
  | 'sending_request'
  | 'awaiting_response'
  | 'replaying_events'
  | 'applying_updates'
  | 'finalizing'
  | 'complete'
  | 'error';

export type EventDurability = 'durable' | 'ephemeral';

export interface DurableEventClassification {
  eventType: string;
  durability: EventDurability;
  description: string;
}

export const DURABLE_EVENT_TYPES: DurableEventClassification[] = [
  {
    eventType: 'session.created',
    durability: 'durable',
    description: 'Session initialization event',
  },
  { eventType: 'session.started', durability: 'durable', description: 'Session started' },
  {
    eventType: 'session.status_changed',
    durability: 'durable',
    description: 'Session state transition',
  },
  {
    eventType: 'session.approval_required',
    durability: 'durable',
    description: 'Approval was requested',
  },
  {
    eventType: 'session.approval_granted',
    durability: 'durable',
    description: 'Approval was granted',
  },
  {
    eventType: 'session.approval_denied',
    durability: 'durable',
    description: 'Approval was denied',
  },
  {
    eventType: 'session.completed',
    durability: 'durable',
    description: 'Session ended in success',
  },
  { eventType: 'session.failed', durability: 'durable', description: 'Session ended in failure' },
  { eventType: 'session.cancelled', durability: 'durable', description: 'Session was cancelled' },
  { eventType: 'session.crashed', durability: 'durable', description: 'Session crashed' },
  { eventType: 'session.checkpoint', durability: 'durable', description: 'Checkpoint created' },
  { eventType: 'policy.violation', durability: 'durable', description: 'Security policy event' },
  { eventType: 'gateway.status', durability: 'durable', description: 'Gateway status audit' },
  { eventType: 'system.error', durability: 'durable', description: 'System error audit' },
];

export const EPHEMERAL_EVENT_TYPES: DurableEventClassification[] = [
  { eventType: 'session.output', durability: 'ephemeral', description: 'Streaming output chunks' },
  {
    eventType: 'session.message',
    durability: 'ephemeral',
    description: 'Streaming assistant messages',
  },
  {
    eventType: 'session.thinking',
    durability: 'ephemeral',
    description: 'Streaming thinking state',
  },
  {
    eventType: 'session.tool_call',
    durability: 'ephemeral',
    description: 'Streaming tool call progress',
  },
  {
    eventType: 'session.tool_result',
    durability: 'ephemeral',
    description: 'Streaming tool result',
  },
  { eventType: 'session.tool_error', durability: 'ephemeral', description: 'Streaming tool error' },
  { eventType: 'session.file_changed', durability: 'ephemeral', description: 'File change events' },
];

export interface UnrecoverableGap {
  sessionId: string | null;
  fromSequence: number;
  toSequence: number;
  reason: string;
  reportedAt: Date;
  eventTypesAffected?: string[] | undefined;
}

export interface GapAnalysis {
  gaps: UnrecoverableGap[];
  missingSequences: number[];
  replayableRange?: { from: number; to: number };
  globalSequenceGap?: { from: number; to: number };
}

export interface ReplayOptions {
  maxBatchSize?: number;
  orderingKey?: 'sequence' | 'occurredAt' | 'sessionThenSequence';
  applyInOrder?: boolean;
  haltOnError?: boolean;
  onlyDurable?: boolean | undefined;
}

export const DEFAULT_REPLAY_OPTIONS: Required<ReplayOptions> = {
  maxBatchSize: 100,
  orderingKey: 'sessionThenSequence',
  applyInOrder: true,
  haltOnError: false,
  onlyDurable: true,
};

export interface ReconciliationResult {
  success: boolean;
  sessionStatesCollected: number;
  eventsReplayed: number;
  sessionUpdatesApplied: number;
  unrecoverableGaps: UnrecoverableGap[];
  newAckBaseline: number;
  startedAt: Date;
  completedAt: Date;
  error?: string | undefined;
  warnings: string[];
}

export interface SessionStateProvider {
  listAllSessions(): Array<{
    sessionId: string;
    state: string;
    lastAckedSequence: number;
    lastEventAt?: Date | undefined;
    lastEventType?: string | undefined;
  }>;
  getLastAckedGlobalSequence(): number;
}

export interface SessionUpdateApplier {
  updateSessionState(sessionId: string, newState: string): Promise<boolean>;
  applyMissingApprovalDecision(sessionId: string, approvalDecision: unknown): Promise<boolean>;
  getAllSessionsCount(): number;
}

export interface EventStore {
  getEventsSince(
    sessionId: string | null,
    fromSequence: number,
    limit?: number,
    onlyDurable?: boolean,
  ): Promise<Array<{ sequence: number; envelope: EventEnvelope }>>;
  getHighestSequence(): Promise<number>;
  replayEvent(sessionId: string, envelope: EventEnvelope): Promise<boolean>;
  recordUnrecoverableGap(gap: UnrecoverableGap): void;
}

export interface ReconciliationEventListener {
  (event: ReconciliationEvent): void;
}

export interface ReconciliationEvent {
  type:
    | 'run_started'
    | 'run_completed'
    | 'run_failed'
    | 'step_changed'
    | 'gap_detected'
    | 'event_replayed'
    | 'update_applied'
    | 'warnings_raised'
    | 'unrecoverable_gap_recorded';
  timestamp: Date;
  step?: ReconciliationStep;
  previousStep?: ReconciliationStep;
  payload?: unknown;
  message?: string;
  error?: string | undefined;
}

export {
  type EventEnvelope,
  type SessionReconciliationState,
  type ReconciliationRequest,
  type ReconciliationResponse,
};
