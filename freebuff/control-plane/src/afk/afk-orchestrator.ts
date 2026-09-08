import { classifyEvent, mergeNotificationPreferences } from '@freebuff/attention-engine';

import type { IDatabase } from '../db/types';
import type { ConnectionRegistry } from '../tunnel/connection-registry';
import type { StoredEvent } from '../types';

import { notificationForEvent } from './notification-templates';
import type { PushSender } from './push-sender';
import { SummaryGenerator } from './summary-generator';

export class AfkOrchestrator {
  constructor(
    private readonly db: IDatabase,
    private readonly registry: ConnectionRegistry,
    private readonly pushSender: PushSender,
    private readonly summaries = new SummaryGenerator(db),
  ) {}

  async handleEvent(stored: StoredEvent): Promise<void> {
    const session = await this.db.sessions.findById(stored.sessionId);
    if (!session) return;
    const user = await this.db.users.findById(session.userId);
    const preferences = mergeNotificationPreferences(user?.notificationPreferences);
    const level = classifyEvent(stored.envelope, session.trustProfile, preferences);
    const completionSummary =
      stored.envelope.eventType === 'session.completed' && session.trustProfile === 'trusted-afk'
        ? await this.summaries.generate(session.id)
        : undefined;
    const notification = notificationForEvent(
      level,
      completionSummary
        ? {
            ...stored.envelope,
            payload: { ...asPayload(stored.envelope.payload), summary: completionSummary.text },
          }
        : stored.envelope,
    );
    if (!notification) return;

    const isForeground = this.registry
      .getClientsSubscribedToSession(session.id)
      .some((client) => client.userId === session.userId && client.socket.readyState === 1);

    // A supervised user actively viewing this session already receives the
    // event over WebSocket. Do not duplicate it as a push notification.
    if (session.trustProfile === 'supervised' && isForeground) return;

    await this.pushSender.sendToUser(session.userId, notification);
  }
}

function asPayload(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
