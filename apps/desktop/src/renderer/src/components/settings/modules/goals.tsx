import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { resolveGoalsPreferences, type GoalsPreferences } from '@agentmux/host/goals-preferences'
import { GoalsSettingsPane } from '../GoalsSettingsPane'
import type { SettingsModule } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const GoalsIcon = semanticIconComponent('navigation.goals')


async function saveGoals(preferences: Required<GoalsPreferences>, expectedPreferences: Required<GoalsPreferences>): Promise<void> {
  await saveConfigSlice((current, value: Required<GoalsPreferences>) => ({ ...current, goals: { ...current.goals, ...value } }), preferences, expectedPreferences)
}

export const goalsSettingsModule = {
  id: 'goals', archetype: 'preference', group: 'work', title: 'Goals', icon: GoalsIcon,
  selectionAnimation: true,
  description: 'Choose a starting view and keep your goals in sight.',
  keywords: 'work goals default view list board finished history common actions collapsed expanded prompt library requester supervisor PMO continue',
  searchTargets: [
    { id: 'starting-view', title: 'Starting view', keywords: 'goals default list board' },
    { id: 'finished-goals', title: 'Show finished goals by default', keywords: 'done cancelled history' },
    { id: 'goal-supervisor', title: 'Supervisor for new goals', keywords: 'requesting agent PMO supervisor requester' },
    { id: 'goals-common-actions', title: 'Goals common actions', keywords: 'default custom requests order reference collapsed expanded prompt library' },
  ],
  savedSummary: config => { const saved = resolveGoalsPreferences(config.goals); return `${saved.defaultView === 'board' ? 'Board' : 'List'} · ${saved.showFinished ? 'Including finished' : 'Active goals'}` },
  Pane({ config, onNavigate }) {
    return <GoalsSettingsPane config={config} preferences={config.goals} onSave={saveGoals}
      onOpenPrompts={() => onNavigate('prompts')} />
  }
} as const satisfies SettingsModule
