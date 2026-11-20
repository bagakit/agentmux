import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useLayoutEffect, useState } from 'react'
import { resolveGoalsPreferences, type ResolvedGoalsPreferences, type ResolvedGoalWorkflowPreferences } from '@agentmux/host/goals-preferences'
import { GoalsSettingsPane } from '../GoalsSettingsPane'
import { GoalWorkflowsSettingsPane } from '../GoalWorkflowsSettingsPane'
import type { SettingsModule, SettingsPaneProps } from '../settings-catalog'
import { saveConfigSlice } from '../save-config-slice'

const GoalsIcon = semanticIconComponent('navigation.goals')


async function saveGoals(preferences: ResolvedGoalsPreferences, expectedPreferences: ResolvedGoalsPreferences): Promise<void> {
  await saveConfigSlice((current, value: ResolvedGoalsPreferences) => ({ ...current, goals: { ...current.goals, ...value } }), preferences, expectedPreferences)
}

async function saveWorkflow(workflow: ResolvedGoalWorkflowPreferences, expected: ResolvedGoalWorkflowPreferences): Promise<void> {
  await saveConfigSlice((current, value: ResolvedGoalWorkflowPreferences) => ({ ...current, goals: { ...current.goals, workflow: value } }), workflow, expected)
}

function GoalsPane({ config, onNavigate, navigationRequest, onSubpageChange }: SettingsPaneProps) {
  const [lastView, setLastView] = useState(false)
  const workflow = navigationRequest ? navigationRequest.field?.startsWith('goal-workflow') === true : lastView
  const [visited, setVisited] = useState(() => ({ preferences: !workflow, workflows: workflow }))
  useLayoutEffect(() => {
    setLastView(workflow)
    onSubpageChange?.(workflow ? 'goal-workflows' : undefined)
    setVisited(previous => (workflow ? previous.workflows : previous.preferences) ? previous
      : { preferences: previous.preferences || !workflow, workflows: previous.workflows || workflow })
  }, [onSubpageChange, workflow])
  return <>
    {(visited.preferences || !workflow) ? <div hidden={workflow} inert={workflow}>
      <GoalsSettingsPane config={config} preferences={config.goals} onSave={saveGoals} onOpenPrompts={() => onNavigate('prompts')} />
    </div> : null}
    {(visited.workflows || workflow) ? <div hidden={!workflow} inert={!workflow}>
      <GoalWorkflowsSettingsPane config={config} onSave={saveWorkflow} />
    </div> : null}
  </>
}

export const goalsSettingsModule = {
  id: 'goals', archetype: 'preference', group: 'work', title: 'Goals', icon: GoalsIcon,
  selectionAnimation: true,
  description: 'Choose a starting view and keep your goals in sight.',
  keywords: 'work goals default view list board finished history common actions collapsed expanded prompt library requester supervisor PMO continue workflows',
  subpages: [{ field: 'goal-workflows', title: 'Workflows', description: 'Choose a plan template, reviewer and dispatch limits.' }],
  searchTargets: [
    { id: 'starting-view', title: 'Starting view', keywords: 'goals default list board' },
    { id: 'finished-goals', title: 'Show finished goals by default', keywords: 'done cancelled history' },
    { id: 'goal-supervisor', title: 'Supervisor for new goals', keywords: 'requesting agent PMO supervisor requester' },
    { id: 'goals-common-actions', title: 'Goals common actions', keywords: 'default custom requests order reference collapsed expanded prompt library' },
    { id: 'goal-workflow-template', title: 'Goal workflow template', keywords: 'execution review evidence synthesis' },
    { id: 'goal-workflow-reviewer', title: 'Independent Ticket review', keywords: 'reviewer Host Runtime Session delivery' },
    { id: 'goal-workflow-budget', title: 'Workflow dispatch limits', keywords: 'budget concurrency attempts slots' },
  ],
  savedSummary: config => { const saved = resolveGoalsPreferences(config.goals); return `${saved.defaultView === 'board' ? 'Board' : 'List'} · ${saved.showFinished ? 'Including finished' : 'Active goals'}` },
  Pane: GoalsPane
} as const satisfies SettingsModule
