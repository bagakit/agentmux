import { Clock3 } from 'lucide-react'
import { resolveFocusRecentActivityHours, type FocusRecentActivityHours } from '../../../../../shared/focus-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { FocusSettingsPane } from '../FocusSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveRecentActivityHours(recentActivityHours: FocusRecentActivityHours, expected: FocusRecentActivityHours): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Focus choice is kept; reload configuration and retry saving.')
  await api.config.save({ ...current, focus: { ...current.focus, recentActivityHours } },
    { ...current, focus: { ...current.focus, recentActivityHours: expected } })
}

export const focusSettingsModule = {
  id: 'focus',
  group: 'preferences',
  title: 'Focus',
  description: 'How long task activity keeps a project near the front.',
  icon: Clock3,
  keywords: 'recent activity hours window project lanes timeline time ruler time zone',
  savedSummary: config => `${resolveFocusRecentActivityHours(config.focus?.recentActivityHours)} hours of recent activity`,
  Pane({ config }) {
    return <FocusSettingsPane recentActivityHours={config.focus?.recentActivityHours} onSave={saveRecentActivityHours} />
  }
} as const satisfies SettingsModule
