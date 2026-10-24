import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveA2ANotifications, type A2ANotificationPreference } from '../../../../../shared/a2a-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { A2ASettingsPane } from '../A2ASettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveNotifications(notifications: A2ANotificationPreference, expected: A2ANotificationPreference): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your A2A choice is kept; retry when configuration is available.')
  await api.config.save({ ...current, a2a: { ...current.a2a, notifications } }, { ...current, a2a: { ...current.a2a, notifications: expected } })
}

export const a2aSettingsModule = {
  id: 'a2a', group: 'message-tool', title: 'A2A',
  description: 'Incoming Agent messages and system notification preferences.',
  icon: semanticIconComponent('object.agent-messaging'),
  keywords: 'a2a agent message inbox arrival notification silent notify global 来信 提醒 静默',
  searchTargets: [{ id: 'a2a-notifications', title: 'Incoming message notifications', keywords: 'follow global silent notify banner sound' }],
  savedSummary: config => ({ 'follow-global': 'Follow global notifications', silent: 'Silent', notify: 'Notify for background messages' })[resolveA2ANotifications(config)],
  Pane({ config, onNavigate }) { return <A2ASettingsPane notifications={resolveA2ANotifications(config)} {...(config.notifications ? { globalNotifications: config.notifications } : {})} onSave={saveNotifications} onOpenNotifications={() => onNavigate('notifications')} /> }
} as const satisfies SettingsModule
