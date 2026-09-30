import { Wrench } from 'lucide-react'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { resolvePerformancePreferences, type PerformancePreferences } from '../../../../../shared/toolkit-preferences'
import { ToolkitSettingsPane } from '../ToolkitSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function savePerformance(performance: PerformancePreferences, expected: PerformancePreferences): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Settings are not loaded. Your draft is kept.')
  await api.config.save(
    { ...current, toolkit: { ...current.toolkit, performance } },
    { ...current, toolkit: { ...current.toolkit, performance: expected } }
  )
}

export const toolkitSettingsModule = {
  id: 'toolkit', group: 'preferences', title: 'Toolkit', icon: Wrench,
  description: 'Tools in your status bar. Observe without interrupting your work.',
  keywords: 'performance cpu memory rss process resource toolkit tool built in script status bar icon label',
  savedSummary(config) {
    const preferences = resolvePerformancePreferences(config)
    return preferences.enabled ? `Performance · ${preferences.statusBar === 'icon' ? 'Icon' : 'Icon and name'}` : 'Performance hidden'
  },
  Pane({ config, active }) {
    return <ToolkitSettingsPane performance={resolvePerformancePreferences(config)} active={active} onSave={savePerformance} />
  }
} as const satisfies SettingsModule
