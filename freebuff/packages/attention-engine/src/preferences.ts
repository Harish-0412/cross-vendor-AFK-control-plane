import type { NotificationPreferences } from '@freebuff/protocol';

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  notifyDelivery: 'immediate',
  milestoneNotifications: false,
};

export function mergeNotificationPreferences(
  preferences?: Partial<NotificationPreferences>,
): NotificationPreferences {
  const merged: NotificationPreferences = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...preferences,
  };
  if (preferences?.eventMutes !== undefined) merged.eventMutes = preferences.eventMutes;
  if (preferences?.quietHours !== undefined) merged.quietHours = preferences.quietHours;
  return merged;
}
