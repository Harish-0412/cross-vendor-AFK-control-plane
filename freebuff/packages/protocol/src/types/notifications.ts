import type { EventType } from './events';

export type AttentionLevel = 'silent' | 'notify' | 'high_priority' | 'critical';

export interface QuietHours {
  enabled: boolean;
  /** Local wall-clock time in HH:mm format. */
  start: string;
  /** Local wall-clock time in HH:mm format. */
  end: string;
  /** IANA time zone. UTC is used when omitted or invalid. */
  timeZone?: string;
}

export interface NotificationPreferences {
  /** A true value mutes that event type. Critical security events cannot be muted. */
  eventMutes?: Partial<Record<EventType, boolean>>;
  quietHours?: QuietHours;
  /** Notify-level events are either delivered now or left for the digest. */
  notifyDelivery: 'immediate' | 'digest';
  /** Checkpoints and status milestones are optional outside trusted AFK mode. */
  milestoneNotifications: boolean;
}
