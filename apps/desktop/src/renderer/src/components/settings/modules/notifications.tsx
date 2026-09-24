import { Bell } from 'lucide-react'
import { NOTIFICATION_TIERS, resolveNotificationModeId, resolveNotificationSound } from '../../../../../shared/notification-presentation'
import type { AppConfig } from '../../../../../shared/contracts'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { NotificationSettingsPane } from '../NotificationSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveNotifications(notifications: NonNullable<AppConfig['notifications']>, expected: NonNullable<AppConfig['notifications']>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) return
  await api.config.save({ ...current, notifications }, { ...current, notifications: expected })
}

export const notificationsSettingsModule = {
  id: 'notifications',
  group: 'preferences',
  title: 'Notifications',
  description: 'Choose when and how agents get your attention.',
  icon: Bell,
  keywords: 'notification alert attention dwell duration banner needs you done error until dismiss sound audio silent mute chime',
  savedSummary(config) {
    const mode = resolveNotificationModeId(config)
    const tier = NOTIFICATION_TIERS.find((candidate) => candidate.id === mode)!
    return mode === 'off' ? tier.label : `${tier.label} · ${resolveNotificationSound(config) ? 'Sound on' : 'Silent'}`
  },
  Pane({ config }) {
    return <NotificationSettingsPane notifications={config.notifications} onSave={saveNotifications} />
  }
} as const satisfies SettingsModule
