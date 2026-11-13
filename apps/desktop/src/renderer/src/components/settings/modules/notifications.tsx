import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { NOTIFICATION_TIERS, resolveNotificationModeId, resolveNotificationSound } from '../../../../../shared/notification-presentation'
import type { AppConfig } from '../../../../../shared/contracts'
import { NotificationSettingsPane } from '../NotificationSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const ThemeObjectNotificationsIcon = semanticIconComponent('object.notifications')


async function saveNotifications(notifications: NonNullable<AppConfig['notifications']>, expected: NonNullable<AppConfig['notifications']>): Promise<void> {
  await saveConfigSlice((current, value: NonNullable<AppConfig['notifications']>) => ({ ...current, notifications: value }), notifications, expected)
}

export const notificationsSettingsModule = {
  id: 'notifications', archetype: 'preference',
  group: 'preferences',
  title: 'Notifications',
  description: 'Desktop banner duration and sound. In-app issues and Focus requests stay available.',
  icon: ThemeObjectNotificationsIcon,
  keywords: 'notification alert attention dwell duration banner needs you done error until dismiss sound audio silent mute chime',
  searchTargets: [
    { id: 'notification-dwell', title: 'Desktop banner duration', keywords: 'notification dwell banner attention duration dismiss' },
    { id: 'notification-sound', title: 'Sound', keywords: 'system notification audio silent mute' },
  ],
  savedSummary(config) {
    const mode = resolveNotificationModeId(config)
    const tier = NOTIFICATION_TIERS.find((candidate) => candidate.id === mode)!
    return mode === 'off' ? tier.label : `${tier.label} · ${resolveNotificationSound(config) ? 'Sound on' : 'Silent'}`
  },
  Pane({ config }) {
    return <NotificationSettingsPane notifications={config.notifications} onSave={saveNotifications} />
  }
} as const satisfies SettingsModule
