import { memo } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import * as DropdownMenu from './HoverDropdownMenu'
import { useAppStore } from '../store'
import { currentDemandIndex, currentDemandKey } from '../lib/goal-current-work'
import { GOAL_RESPONSIBILITY_LABELS } from './GoalResponsibilitySummary'
import { useGoalNavigation } from '../lib/use-goal-navigation'
import '../styles/region-current-demand.css'

const ThemeObjectGoalIcon = semanticIconComponent('object.goal')


/** Original business facts only; neither terminal output nor Session status selects a Goal. */
export const RegionCurrentDemand = memo(function RegionCurrentDemand({ agentSessionId, hostId }: { agentSessionId: string; hostId: string }) {
  const work = useAppStore(state => currentDemandIndex(state.demands).get(currentDemandKey(hostId, agentSessionId)))
  const open = useGoalNavigation()
  if (!work) return null
  const fact = work.goals[0]
  const attributionAmbiguous = work.goals.some(goal => goal.attributionAmbiguous)
  const label = work.state === 'current' ? `${fact!.title}${fact?.phase ? ' · ' + GOAL_RESPONSIBILITY_LABELS[fact.phase] : ''}` : work.state === 'ambiguous'
    ? work.goals.length === 1 ? `${fact!.title} · execution is ambiguous` : `${work.goals.length} Goals · work is ambiguous` : 'Goal input unconfirmed'
  return <div className="region-current-demand" data-current-demand-state={work.state}>
    {work.state === 'current' ? <button type="button" title={`Current Goal: ${label}${fact?.nextAction ? '\n' + fact.nextAction : ''}`} aria-label={`Open current Goal ${label}`} onClick={() => void open(work.goals[0]!.goalId)}>
      <ThemeObjectGoalIcon size={12} aria-hidden="true" /><span>{label}</span>
    </button> : <DropdownMenu.Root><DropdownMenu.Trigger title={label} aria-label={label}>
      <ThemeObjectGoalIcon size={12} aria-hidden="true" /><span>{label}</span>
    </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu region-current-demand-menu" align="end" sideOffset={4}>
      <DropdownMenu.Label>{work.state === 'ambiguous' ? attributionAmbiguous ? 'Multiple original executions; inspect the exact work' : 'Multiple confirmed Goals; choose the exact work' : 'Original input is not yet confirmed'}</DropdownMenu.Label>
      {work.goals.map(goal => <DropdownMenu.Item key={goal.goalId} className="tab-context-menu__item" onSelect={() => void open(goal.goalId)}>
        <span><strong>{goal.title}</strong><span>{goal.phase ? GOAL_RESPONSIBILITY_LABELS[goal.phase] : goal.confirmed ? 'Last confirmed input' : 'No confirmed input'}{goal.pending ? ` · ${goal.pending}` : ''}{goal.nextAction ? ` · ${goal.nextAction}` : ''}</span></span>
      </DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
  </div>
})
