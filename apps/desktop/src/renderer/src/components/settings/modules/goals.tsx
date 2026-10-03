import { Target } from 'lucide-react'
import { resolveGoalsCommonActions } from '../../../../../shared/goals-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { GoalsSettingsPane } from '../GoalsSettingsPane'
import type { SettingsModule } from '../settings-catalog'

async function saveCollapsed(collapsed: boolean, expected: boolean): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Goals choice is kept; reload configuration and retry saving.')
  const directory = resolveGoalsCommonActions(current.goalsCommonActions)
  await api.config.save({ ...current, goalsCommonActions: { ...directory, collapsed } },
    { ...current, goalsCommonActions: { ...directory, collapsed: expected } })
}

export const goalsSettingsModule = {
  id: 'goals', group: 'work', title: 'Goals', icon: Target,
  description: 'How common actions appear when you open Goals.',
  keywords: 'work goals common actions collapsed expanded prompt library',
  savedSummary: config => resolveGoalsCommonActions(config.goalsCommonActions).collapsed ? 'Common actions collapsed' : 'Common actions expanded',
  Pane({ config, onClose }) {
    return <GoalsSettingsPane collapsed={config.goalsCommonActions?.collapsed} onSave={saveCollapsed}
      onOpenGoals={() => { onClose(); useAppStore.getState().setMainSurface('board') }} />
  }
} as const satisfies SettingsModule
