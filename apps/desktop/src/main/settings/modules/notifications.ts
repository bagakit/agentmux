import { NOTIFICATION_TIERS, DEFAULT_NOTIFICATION_MODE_ID, DEFAULT_NOTIFICATION_SOUND, resolveNotificationModeId, resolveNotificationSound } from '../../../shared/notification-presentation.js'
import { booleanSetting, enumSetting } from '../scalar-setting.js'
import type { ScalarSetting } from '../scalar-setting.js'

export const notificationsSettings = [
  enumSetting('notifications.mode', NOTIFICATION_TIERS.map((tier) => tier.id), DEFAULT_NOTIFICATION_MODE_ID,
    resolveNotificationModeId,
    (config, mode) => ({ ...config, notifications: { ...config.notifications, mode } })),
  booleanSetting('notifications.sound', DEFAULT_NOTIFICATION_SOUND, resolveNotificationSound,
    (config, sound) => ({ ...config, notifications: { mode: resolveNotificationModeId(config), ...config.notifications, sound } })),
] satisfies readonly ScalarSetting[]
