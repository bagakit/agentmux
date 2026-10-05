import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveGoalsCommonActions, resolveGoalsPreferences, type GoalsPreferences } from '../../../../../shared/goals-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { GoalsSettingsPane } from '../GoalsSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const ThemeObjectGoalIcon = semanticIconComponent('object.goal')


async function saveGoals(collapsed: boolean, expected: boolean, preferences: Required<GoalsPreferences>, expectedPreferences: Required<GoalsPreferences>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Goals choice is kept; reload configuration and retry saving.')
  const directory = resolveGoalsCommonActions(current.goalsCommonActions)
  await api.config.save({ ...current, goals: { ...current.goals, ...preferences }, goalsCommonActions: { ...directory, collapsed } },
    { ...current, goals: { ...current.goals, ...expectedPreferences }, goalsCommonActions: { ...directory, collapsed: expected } })
}

export const goalsSettingsModule = {
  id: 'goals', group: 'work', title: 'Goals', icon: ThemeObjectGoalIcon,
  description: 'Choose a starting view and keep your goals in sight.',
  keywords: 'work goals default view list board finished history common actions collapsed expanded prompt library requester supervisor PMO continue',
  savedSummary: config => { const saved = resolveGoalsPreferences(config.goals); return `${saved.defaultView === 'board' ? 'Board' : 'List'} · ${saved.showFinished ? 'Including finished' : 'Active goals'}` },
  Pane({ config, onClose }) {
    return <GoalsSettingsPane collapsed={config.goalsCommonActions?.collapsed} preferences={config.goals} onSave={saveGoals}
      onOpenGoals={() => { onClose(); useAppStore.getState().setMainSurface('board') }} />
  }
} as const satisfies SettingsModule
