import type {
  AttentionLevel,
  EventEnvelope,
  EventType,
  NotificationPreferences,
  QuietHours,
  TrustProfile,
} from '@freebuff/protocol';

const BASE_LEVELS: Record<EventType, AttentionLevel> = {
  'session.created': 'silent',
  'session.started': 'silent',
  'session.status_changed': 'notify',
  'session.output': 'silent',
  'session.message': 'silent',
  'session.tool_call': 'silent',
  'session.tool_result': 'silent',
  'session.tool_error': 'high_priority',
  'session.file_changed': 'silent',
  'session.approval_required': 'high_priority',
  'session.approval_granted': 'silent',
  'session.approval_denied': 'notify',
  'session.checkpoint': 'notify',
  'session.thinking': 'silent',
  'session.completed': 'notify',
  'session.failed': 'high_priority',
  'session.cancelled': 'notify',
  'session.crashed': 'high_priority',
  'gateway.status': 'notify',
  'sandbox.created': 'silent',
  'sandbox.destroyed': 'silent',
  'policy.violation': 'critical',
  'system.error': 'high_priority',
};

const MILESTONE_EVENTS = new Set<EventType>([
  'session.status_changed',
  'session.checkpoint',
  'gateway.status',
]);

/** Pure Phase 7 attention classification. No persistence or delivery occurs here. */
export function classifyEvent(
  event: EventEnvelope,
  trustProfile: TrustProfile,
  preferences: NotificationPreferences,
): AttentionLevel {
  let level = BASE_LEVELS[event.eventType];

  if (MILESTONE_EVENTS.has(event.eventType)) {
    const shouldNotify = preferences.milestoneNotifications || trustProfile === 'trusted-afk';
    if (!shouldNotify) level = 'silent';
  }

  // A deliberately unattended session makes completion actionable enough to
  // rise above an ordinary notification; supervised sessions keep the base table.
  if (trustProfile === 'trusted-afk' && event.eventType === 'session.completed') {
    level = 'high_priority';
  }

  // Security events are never hidden by user mutes, digests, or quiet hours.
  if (level !== 'critical' && preferences.eventMutes?.[event.eventType] === true) {
    return 'silent';
  }

  if (level === 'notify' && preferences.notifyDelivery === 'digest') {
    return 'silent';
  }

  if (level !== 'critical' && isWithinQuietHours(event.occurredAt, preferences.quietHours)) {
    return 'silent';
  }

  return level;
}

function isWithinQuietHours(occurredAt: Date, quietHours?: QuietHours): boolean {
  if (!quietHours?.enabled) return false;
  const start = parseWallClock(quietHours.start);
  const end = parseWallClock(quietHours.end);
  if (start === null || end === null) return false;

  const date = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return false;

  let current: number;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: quietHours.timeZone ?? 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
    current = hour * 60 + minute;
  } catch {
    current = date.getUTCHours() * 60 + date.getUTCMinutes();
  }

  if (start === end) return true;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function parseWallClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
