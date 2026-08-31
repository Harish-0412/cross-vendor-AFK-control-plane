import { v4 as uuidv4 } from 'uuid';
import { AgentEvent, NormalizedEvent, EventType } from '../types';

export function generateEventId(): string {
  return `evt_${uuidv4().replace(/-/g, '').slice(0, 24)}`;
}

export function parseJsonLine(line: string): any | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function normalizeOpenCodeEvent(raw: any, sessionId: string, sequence: number): NormalizedEvent | null {
  if (!raw || !raw.event) return null;
  
  const eventMap: Record<string, EventType> = {
    'session.start': 'session.started',
    'message': 'assistant.message',
    'tool_call': 'tool.call',
    'tool_result': 'tool.result',
    'file_change': 'file.write',
    'approval_request': 'approval.requested',
    'session.complete': 'session.completed',
    'session.error': 'session.failed',
    'turn': 'metrics.usage'
  };
  
  const eventType = eventMap[raw.event];
  if (!eventType) return null;
  
  return {
    eventId: generateEventId(),
    eventType,
    sessionId,
    sequence,
    timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date(),
    payload: raw.data || raw,
    rawEvent: raw
  };
}

export function normalizeMockEvent(raw: any, sessionId: string, sequence: number): NormalizedEvent | null {
  if (!raw || !raw.type) return null;
  
  const eventMap: Record<string, EventType> = {
    'started': 'session.started',
    'planning': 'assistant.thinking',
    'message': 'assistant.message',
    'tool_call': 'tool.call',
    'file_changed': 'file.write',
    'approval_required': 'approval.requested',
    'completed': 'session.completed',
    'failed': 'session.failed',
    'cancelled': 'session.cancelled'
  };
  
  const eventType = eventMap[raw.type];
  if (!eventType) return null;
  
  return {
    eventId: generateEventId(),
    eventType,
    sessionId,
    sequence,
    timestamp: new Date(),
    payload: raw.data || {},
    rawEvent: raw
  };
}

export function normalizeAntigravityEvent(raw: any, sessionId: string, sequence: number): NormalizedEvent | null {
  if (!raw || !raw.event_type) return null;
  
  const eventType = raw.event_type as EventType;
  
  return {
    eventId: raw.event_id || generateEventId(),
    eventType,
    sessionId,
    sequence: raw.sequence || sequence,
    timestamp: raw.timestamp ? new Date(raw.timestamp) : new Date(),
    payload: raw.payload || {},
    rawEvent: raw
  };
}

export function normalizeClaudeCodeEvent(raw: any, sessionId: string, sequence: number): NormalizedEvent | null {
  if (!raw || !raw.type) return null;
  
  const eventMap: Record<string, EventType> = {
    'session_start': 'session.started',
    'user_message': 'user.message',
    'assistant_message': 'assistant.message',
    'tool_use': 'tool.call',
    'tool_result': 'tool.result',
    'file_read': 'file.read',
    'file_write': 'file.write',
    'file_edit': 'file.edit',
    'bash_command': 'bash.exec',
    'approval_request': 'approval.requested',
    'session_end': 'session.completed',
    'error': 'error'
  };
  
  const eventType = eventMap[raw.type];
  if (!eventType) return null;
  
  return {
    eventId: generateEventId(),
    eventType,
    sessionId,
    sequence,
    timestamp: new Date(),
    payload: raw.data || raw,
    rawEvent: raw
  };
}

export function createFreebuffEventEnvelope(event: NormalizedEvent, deviceId: string): any {
  return {
    event_id: event.eventId,
    event_type: event.eventType,
    event_version: 1,
    session_id: event.sessionId,
    device_id: deviceId,
    sequence: event.sequence,
    occurred_at: event.timestamp.toISOString(),
    correlation_id: event.payload.correlation_id,
    payload: event.payload
  };
}

export function parseAgentOutput(
  agent: string,
  line: string,
  sessionId: string,
  sequence: number
): NormalizedEvent | null {
  const parsed = parseJsonLine(line);
  if (!parsed) return null;
  
  switch (agent) {
    case 'opencode':
      return normalizeOpenCodeEvent(parsed, sessionId, sequence);
    case 'mock':
      return normalizeMockEvent(parsed, sessionId, sequence);
    case 'antigravity':
      return normalizeAntigravityEvent(parsed, sessionId, sequence);
    case 'claude-code':
      return normalizeClaudeCodeEvent(parsed, sessionId, sequence);
    default:
      return null;
  }
}

export function filterEventsByType(events: NormalizedEvent[], types: EventType[]): NormalizedEvent[] {
  return events.filter(e => types.includes(e.eventType));
}

export function getEventsSince(events: NormalizedEvent[], sequence: number): NormalizedEvent[] {
  return events.filter(e => e.sequence > sequence);
}

export function groupEventsByTurn(events: NormalizedEvent[]): NormalizedEvent[][] {
  const groups: NormalizedEvent[][] = [];
  let currentGroup: NormalizedEvent[] = [];
  
  for (const event of events) {
    currentGroup.push(event);
    if (event.eventType === 'assistant.message' || event.eventType === 'session.completed') {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }
  
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  
  return groups;
}

export function extractToolCalls(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter(e => e.eventType === 'tool.call');
}

export function extractFileOperations(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter(e => 
    e.eventType === 'file.read' ||
    e.eventType === 'file.write' ||
    e.eventType === 'file.edit' ||
    e.eventType === 'file.delete'
  );
}

export function extractApprovalRequests(events: NormalizedEvent[]): NormalizedEvent[] {
  return events.filter(e => e.eventType === 'approval.requested');
}

export function calculateMetrics(events: NormalizedEvent[]): {
  totalEvents: number;
  eventTypes: Record<string, number>;
  duration: number;
  toolCalls: number;
  fileOperations: number;
  approvals: number;
  errors: number;
} {
  const eventTypes: Record<string, number> = {};
  let toolCalls = 0;
  let fileOperations = 0;
  let approvals = 0;
  let errors = 0;
  
  for (const event of events) {
    eventTypes[event.eventType] = (eventTypes[event.eventType] || 0) + 1;
    
    if (event.eventType === 'tool.call') toolCalls++;
    if (event.eventType.startsWith('file.')) fileOperations++;
    if (event.eventType === 'approval.requested') approvals++;
    if (event.eventType === 'error' || event.eventType === 'session.failed') errors++;
  }
  
  const timestamps = events.map(e => e.timestamp.getTime());
  const duration = timestamps.length > 0 ? Math.max(...timestamps) - Math.min(...timestamps) : 0;
  
  return {
    totalEvents: events.length,
    eventTypes,
    duration,
    toolCalls,
    fileOperations,
    approvals,
    errors
  };
}