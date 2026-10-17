import { DEFAULT_NOTIFICATION_MODE_ID, resolveNotificationModeId, resolveNotificationSound, type NotificationModeId, type NotificationSettings } from './notification-presentation'

export const A2A_NOTIFICATION_IDS = ['follow-global', 'silent', 'notify'] as const
export type A2ANotificationPreference = typeof A2A_NOTIFICATION_IDS[number]
export const DEFAULT_A2A_NOTIFICATION: A2ANotificationPreference = 'follow-global'
export type A2APreferences = { notifications?: A2ANotificationPreference }

export function resolveA2ANotifications(config?: { a2a?: A2APreferences | undefined } | null): A2ANotificationPreference {
  return config?.a2a?.notifications ?? DEFAULT_A2A_NOTIFICATION
}

/** User banners only. This never changes Core's Inbox or Agent reference notices. */
export function a2aNotificationPresentation(config: { a2a?: A2APreferences; notifications?: NotificationSettings } | null):
  { mode: NotificationModeId; sound: boolean } | null {
  const preference = resolveA2ANotifications(config), global = resolveNotificationModeId(config)
  if (preference === 'silent' || preference === 'follow-global' && global === 'off') return null
  return { mode: global === 'off' ? DEFAULT_NOTIFICATION_MODE_ID : global, sound: resolveNotificationSound(config) }
}
