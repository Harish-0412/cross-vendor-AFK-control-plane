import type { Messaging } from 'firebase-admin/messaging';
// `web-push` is CJS with no ESM default export in its own type declarations
// (Node's esModuleInterop happily synthesizes one at runtime, which is why
// `import webPush from 'web-push'` worked, but it made eslint's
// import/default rule — checking the declared types, not runtime interop —
// correctly flag it as importing something that isn't really there). A
// namespace import is the form that's actually correct for a CJS module
// with no default export.
import * as webPush from 'web-push';
import type { PushSubscription } from 'web-push';

import { getFirebaseMessaging } from '../auth/firebase-admin';
import type { IDatabase } from '../db/types';

import type { PushNotification } from './notification-templates';

export interface WebPushTransport {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(subscription: PushSubscription, payload?: string): Promise<unknown>;
}

export interface PushSenderOptions {
  vapidSubject?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  webPushTransport?: WebPushTransport;
  messaging?: Messaging | null;
}

export interface PushDeliveryResult {
  subscriptionId: string;
  channel: 'web-push' | 'fcm';
  delivered: boolean;
  error?: string;
}

export class PushSender {
  private readonly webPushTransport: WebPushTransport;
  private readonly messaging: Messaging | null;
  private readonly webPushConfigured: boolean;

  constructor(
    private readonly db: IDatabase,
    options: PushSenderOptions = {},
  ) {
    this.webPushTransport = options.webPushTransport ?? webPush;
    this.messaging = options.messaging === undefined ? getFirebaseMessaging() : options.messaging;
    const subject =
      options.vapidSubject ?? process.env.VAPID_SUBJECT ?? 'mailto:admin@freebuff.dev';
    const publicKey = options.vapidPublicKey ?? process.env.VAPID_PUBLIC_KEY;
    const privateKey = options.vapidPrivateKey ?? process.env.VAPID_PRIVATE_KEY;
    this.webPushConfigured = Boolean(options.webPushTransport || (publicKey && privateKey));
    if (publicKey && privateKey) {
      this.webPushTransport.setVapidDetails(subject, publicKey, privateKey);
    }
  }

  async sendToUser(userId: string, notification: PushNotification): Promise<PushDeliveryResult[]> {
    const subscriptions = await this.db.pushSubscriptions.listByUser(userId);
    return Promise.all(
      subscriptions.map(async (subscription): Promise<PushDeliveryResult> => {
        try {
          if (subscription.channel === 'web-push') {
            if (!this.webPushConfigured || !subscription.endpoint || !subscription.keys) {
              throw new Error('Web Push is not configured');
            }
            await this.webPushTransport.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: subscription.keys,
              },
              JSON.stringify(notification),
            );
          } else {
            if (!this.messaging || !subscription.fcmToken) {
              throw new Error('Firebase Cloud Messaging is not configured');
            }
            await this.messaging.send({
              token: subscription.fcmToken,
              notification: { title: notification.title, body: notification.body },
              data: Object.fromEntries(
                Object.entries(notification.data).map(([key, value]) => [key, String(value)]),
              ),
              android: { priority: notification.urgency === 'high' ? 'high' : 'normal' },
            });
          }
          return {
            subscriptionId: subscription.id,
            channel: subscription.channel,
            delivered: true,
          };
        } catch (error) {
          return {
            subscriptionId: subscription.id,
            channel: subscription.channel,
            delivered: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
}
