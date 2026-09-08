import type { AttentionLevel, EventEnvelope } from '@freebuff/protocol';

export interface PushNotification {
  title: string;
  body: string;
  tag: string;
  urgency: 'very-low' | 'normal' | 'high';
  data: {
    eventId: string;
    eventType: string;
    sessionId: string;
    deviceId?: string;
    attentionLevel: AttentionLevel;
    url: string;
  };
}

export function notificationForEvent(
  level: AttentionLevel,
  event: EventEnvelope,
): PushNotification | null {
  if (level === 'silent') return null;
  const detail = eventDetail(event);
  const common = {
    tag: `freebuff:${event.sessionId}:${event.eventType}`,
    data: {
      eventId: event.eventId,
      eventType: event.eventType,
      sessionId: event.sessionId,
      ...(event.deviceId ? { deviceId: event.deviceId } : {}),
      attentionLevel: level,
      url: `/sessions/${encodeURIComponent(event.sessionId)}`,
    },
  };

  switch (level) {
    case 'notify':
      return { ...common, title: titleForNotify(event), body: detail, urgency: 'normal' };
    case 'high_priority':
      return { ...common, title: titleForHighPriority(event), body: detail, urgency: 'high' };
    case 'critical':
      return { ...common, title: 'Critical security event', body: detail, urgency: 'high' };
  }
}

function titleForNotify(event: EventEnvelope): string {
  if (event.eventType === 'session.completed') return 'Task complete';
  if (event.eventType === 'session.cancelled') return 'Task cancelled';
  if (event.eventType === 'session.approval_denied') return 'Approval denied';
  return 'Task update';
}

function titleForHighPriority(event: EventEnvelope): string {
  if (event.eventType === 'session.approval_required') return `Approval needed: ${eventDetail(event)}`;
  if (event.eventType === 'session.completed') return 'AFK task complete';
  if (event.eventType === 'session.failed' || event.eventType === 'session.crashed') {
    return 'Task failed';
  }
  return 'Action required';
}

function eventDetail(event: EventEnvelope): string {
  const payload = asRecord(event.payload);
  const action = asRecord(payload['action']);
  if (event.eventType === 'session.approval_required') {
    const actionName = firstString(
      payload['description'],
      action['description'],
      payload['actionType'],
      action['type'],
      payload['capability'],
    ) ?? 'agent action';
    const resource = firstString(payload['resource'], payload['scope']);
    return resource && !actionName.includes(resource) ? `${actionName} to ${resource}` : actionName;
  }
  if (event.eventType === 'session.completed') {
    return firstString(payload['summary']) ?? 'The agent finished the task.';
  }
  if (event.eventType === 'session.failed' || event.eventType === 'session.crashed') {
    return firstString(payload['errorMessage'], payload['error'], payload['message'])
      ?? 'The agent could not complete the task.';
  }
  if (event.eventType === 'policy.violation') {
    return firstString(payload['description'], payload['message']) ?? 'A policy violation was blocked.';
  }
  return firstString(payload['description'], payload['message'], payload['summary'])
    ?? event.eventType.replaceAll('.', ' ');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
