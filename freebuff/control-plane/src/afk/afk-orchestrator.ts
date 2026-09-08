import { classifyEvent, mergeNotificationPreferences } from '@freebuff/attention-engine';

import type { IDatabase } from '../db/types';
import type { StoredEvent } from '../types';
import type { ConnectionRegistry } from '../tunnel/connection-registry';
import { notificationForEvent } from './notification-templates';
import type { PushSender } from './push-sender';

export class AfkOrchestrator {
  constructor(
    private readonly db: IDatabase,
    private readonly registry: ConnectionRegistry,
    private readonly pushSender: PushSender,
  ) {}

  async handleEvent(stored: StoredEvent): Promise<void> {
    const session = await this.db.sessions.findById(stored.sessionId);
    if (!session) return;
    const user = await this.db.users.findById(session.userId);
    const preferences = mergeNotificationPreferences(user?.notificationPreferences);
    const level = classifyEvent(stored.envelope, session.trustProfile, preferences);
    const notification = notificationForEvent(level, stored.envelope);
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
