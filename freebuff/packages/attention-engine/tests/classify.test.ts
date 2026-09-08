import { describe, expect, it } from 'vitest';
import type { EventEnvelope, EventType, NotificationPreferences } from '@freebuff/protocol';
import { classifyEvent } from '../src/classify';

const immediate: NotificationPreferences = {
  notifyDelivery: 'immediate',
  milestoneNotifications: true,
};

function event(eventType: EventType, occurredAt = new Date('2026-09-08T12:00:00Z')): EventEnvelope {
  return {
    eventId: 'evt_test',
    eventType,
    eventVersion: 1,
    sessionId: 'sess_test',
    sequence: 1,
    occurredAt,
    payload: {},
  };
}

describe('roadmap §11.2 attention table', () => {
  it.each([
    ['normal output', 'session.output', 'silent'],
    ['milestone', 'session.checkpoint', 'notify'],
    ['task complete', 'session.completed', 'notify'],
    ['task failed', 'session.failed', 'high_priority'],
    ['approval required', 'session.approval_required', 'high_priority'],
    ['security event', 'policy.violation', 'critical'],
  ] as const)('%s maps to %s', (_label, eventType, expected) => {
    expect(classifyEvent(event(eventType), 'default', immediate)).toBe(expected);
  });

  it('modulates milestone and completion attention for trusted AFK sessions', () => {
    const noMilestones = { ...immediate, milestoneNotifications: false };
    expect(classifyEvent(event('session.checkpoint'), 'supervised', noMilestones)).toBe('silent');
    expect(classifyEvent(event('session.checkpoint'), 'trusted-afk', noMilestones)).toBe('notify');
    expect(classifyEvent(event('session.completed'), 'supervised', immediate)).toBe('notify');
    expect(classifyEvent(event('session.completed'), 'trusted-afk', immediate)).toBe('high_priority');
  });

  it('suppresses notify at 03:00 during quiet hours but still emits critical', () => {
    const prefs: NotificationPreferences = {
      ...immediate,
      quietHours: { enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC' },
    };
    const atThree = new Date('2026-09-08T03:00:00Z');
    expect(classifyEvent(event('session.completed', atThree), 'supervised', prefs)).toBe('silent');
    expect(classifyEvent(event('policy.violation', atThree), 'supervised', prefs)).toBe('critical');
  });

  it('honors event mutes and digest delivery for notify-level events', () => {
    expect(classifyEvent(event('session.completed'), 'default', {
      ...immediate,
      eventMutes: { 'session.completed': true },
    })).toBe('silent');
    expect(classifyEvent(event('session.completed'), 'default', {
      ...immediate,
      notifyDelivery: 'digest',
    })).toBe('silent');
  });
});
