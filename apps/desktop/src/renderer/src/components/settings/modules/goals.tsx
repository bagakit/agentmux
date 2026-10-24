import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveGoalsCommonActions, resolveGoalsPreferences, type GoalsPreferences } from '@agentmux/host/goals-preferences'
import { api } from '../../../lib/api'
import { useAppStore } from '../../../store'
import { GoalsSettingsPane } from '../GoalsSettingsPane'
import type { SettingsModule } from '../settings-catalog'

const GoalsIcon = semanticIconComponent('navigation.goals')


async function saveGoals(collapsed: boolean, expected: boolean, preferences: Required<GoalsPreferences>, expectedPreferences: Required<GoalsPreferences>): Promise<void> {
  const current = useAppStore.getState().config
  if (!current) throw new Error('Configuration is unavailable. Your Goals choice is kept; reload configuration and retry saving.')
  const directory = resolveGoalsCommonActions(current.goalsCommonActions)
  await api.config.save({ ...current, goals: { ...current.goals, ...preferences }, goalsCommonActions: { ...directory, collapsed } },
    { ...current, goals: { ...current.goals, ...expectedPreferences }, goalsCommonActions: { ...directory, collapsed: expected } })
}

export const goalsSettingsModule = {
  id: 'goals', group: 'work', title: 'Goals', icon: GoalsIcon,
  description: 'Choose a starting view and keep your goals in sight.',
  keywords: 'work goals default view list board finished history common actions collapsed expanded prompt library requester supervisor PMO continue',
  searchTargets: [
    { id: 'starting-view', title: 'Starting view', keywords: 'goals default list board' },
    { id: 'finished-goals', title: 'Show finished goals by default', keywords: 'done cancelled history' },
    { id: 'goal-supervisor', title: 'Supervisor for new goals', keywords: 'requesting agent PMO supervisor requester' },
    { id: 'common-actions', title: 'Common actions', keywords: 'collapsed expanded prompts' },
  ],
  savedSummary: config => { const saved = resolveGoalsPreferences(config.goals); return `${saved.defaultView === 'board' ? 'Board' : 'List'} · ${saved.showFinished ? 'Including finished' : 'Active goals'}` },
  Pane({ config, onClose }) {
    return <GoalsSettingsPane collapsed={config.goalsCommonActions?.collapsed} preferences={config.goals} onSave={saveGoals}
      onOpenGoals={() => { onClose(); useAppStore.getState().setMainSurface('board') }} />
  }
} as const satisfies SettingsModule
