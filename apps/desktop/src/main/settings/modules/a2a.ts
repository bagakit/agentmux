import { A2A_NOTIFICATION_IDS, DEFAULT_A2A_NOTIFICATION, resolveA2ANotifications } from '../../../shared/a2a-preferences.js'
import { enumSetting, type ScalarSetting } from '../scalar-setting.js'

export const a2aSettings = [
  enumSetting('a2a.notifications', A2A_NOTIFICATION_IDS, DEFAULT_A2A_NOTIFICATION, resolveA2ANotifications,
    (config, notifications) => ({ ...config, a2a: { ...config.a2a, notifications } }))
] satisfies readonly ScalarSetting[]
