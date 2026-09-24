import {
  INTEGRATIONS,
  type AttentionLevel,
  type EventEnvelope,
  type UsageAlert,
} from '@odysseus/protocol';

import type { ApprovalRecord } from '../types';

export interface PushNotification {
  title: string;
  body: string;
  tag: string;
  urgency: 'very-low' | 'normal' | 'high';
  data: {
    eventId: string;
    eventType: string;
    /** Absent for notifications that are not about one session, such as a plan-limit warning. */
    sessionId?: string;
    deviceId?: string;
    attentionLevel: AttentionLevel;
    url: string;
  };
}

/**
 * "You have nearly used up a plan limit."
 *
 * The tag is keyed to the window's reset time, so a repeat for the same window
 * replaces the earlier notification instead of stacking another one up. Every
 * number in the body is one the provider reported; nothing is extrapolated.
 */
export function notificationForUsageAlert(alert: UsageAlert): PushNotification {
  const tool = INTEGRATIONS[alert.integration]?.name ?? alert.integration;
  const resetsIn = describeGapTo(alert.resetsAt);
  return {
    title: `${tool}: ${alert.usedPercent}% of your ${alert.windowLabel.toLowerCase()} used`,
    body: `${Math.max(0, 100 - alert.usedPercent)}% left${resetsIn ? `, resets ${resetsIn}` : ''}.`,
    tag: `odysseus:usage:${alert.integration}:${alert.window}:${alert.resetsAt}`,
    urgency: 'normal',
    data: {
      eventId: `usage_${alert.integration}_${alert.window}_${alert.resetsAt}`,
      eventType: 'usage.limit_warning',
      deviceId: alert.deviceId,
      attentionLevel: 'notify',
      url: '/budgets',
    },
  };
}

/** "in 3 hours" / "in 2 days", or '' when the reset time has already passed. */
function describeGapTo(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const units: [number, string][] = [
    [86_400_000, 'day'],
    [3_600_000, 'hour'],
    [60_000, 'minute'],
  ];
  for (const [size, unit] of units) {
    if (ms >= size) {
      const n = Math.round(ms / size);
      return `in ${n} ${unit}${n === 1 ? '' : 's'}`;
    }
  }
  return 'shortly';
}

export function notificationForEvent(
  level: AttentionLevel,
  event: EventEnvelope,
): PushNotification | null {
  if (level === 'silent') return null;
  const detail = eventDetail(event);
  const common = {
    tag: `odysseus:${event.sessionId}:${event.eventType}`,
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

export function approvalReminderNotification(approval: ApprovalRecord): PushNotification {
  const detail = approval.description || approval.actionType;
  return {
    title: `Approval still waiting: ${detail}`,
    body: 'Your agent is paused until this approval is decided.',
    tag: `odysseus:${approval.sessionId}:approval:${approval.id}`,
    urgency: 'high',
    data: {
      eventId: approval.id,
      eventType: 'session.approval_required',
      sessionId: approval.sessionId,
      deviceId: approval.deviceId,
      attentionLevel: 'high_priority',
      url: `/sessions/${encodeURIComponent(approval.sessionId)}`,
    },
  };
}

function titleForNotify(event: EventEnvelope): string {
  if (event.eventType === 'session.completed') return 'Task complete';
  if (event.eventType === 'session.cancelled') return 'Task cancelled';
  if (event.eventType === 'session.approval_denied') return 'Approval denied';
  return 'Task update';
}

function titleForHighPriority(event: EventEnvelope): string {
  if (event.eventType === 'session.approval_required')
    return `Approval needed: ${eventDetail(event)}`;
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
    const actionName =
      firstString(
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
    return (
      firstString(payload['errorMessage'], payload['error'], payload['message']) ??
      'The agent could not complete the task.'
    );
  }
  if (event.eventType === 'policy.violation') {
    return (
      firstString(payload['description'], payload['message']) ?? 'A policy violation was blocked.'
    );
  }
  return (
    firstString(payload['description'], payload['message'], payload['summary']) ??
    event.eventType.replaceAll('.', ' ')
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}
