import { memo, useState } from 'react'
import { Target } from 'lucide-react'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import * as DropdownMenu from './HoverDropdownMenu'
import { useAppStore } from '../store'
import { currentDemandIndex, currentDemandKey } from '../lib/goal-current-work'
import '../styles/region-current-demand.css'

/** Original business facts only; neither terminal output nor Session status selects a Goal. */
export const RegionCurrentDemand = memo(function RegionCurrentDemand({ agentSessionId, hostId }: { agentSessionId: string; hostId: string }) {
  const work = useAppStore(state => currentDemandIndex(state.demands).get(currentDemandKey(hostId, agentSessionId)))
  const execute = useAppStore(state => state.executeControl), [failure, setFailure] = useState<string | null>(null)
  if (!work) return null
  const label = work.state === 'current' ? work.goals[0]!.title : work.state === 'ambiguous' ? `${work.goals.length} Goals · work is ambiguous` : 'Goal input unconfirmed'
  const open = async (goalId: string) => {
    try {
      await execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(), operation: 'focus', target: { kind: 'goal', goalId }, inputPolicy: 'preserve' })
      setFailure(null)
    } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
  }
  return <div className="region-current-demand" data-current-demand-state={work.state}>
    {work.state === 'current' ? <button type="button" title={`Current Goal: ${label}`} aria-label={`Open current Goal ${label}`} onClick={() => void open(work.goals[0]!.goalId)}>
      <Target size={12} aria-hidden="true" /><span>{label}</span>
    </button> : <DropdownMenu.Root><DropdownMenu.Trigger title={label} aria-label={label}>
      <Target size={12} aria-hidden="true" /><span>{label}</span>
    </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="tab-context-menu region-current-demand-menu" align="end" sideOffset={4}>
      <DropdownMenu.Label>{work.state === 'ambiguous' ? 'Multiple confirmed Goals; choose the exact work' : 'Original input is not yet confirmed'}</DropdownMenu.Label>
      {work.goals.map(goal => <DropdownMenu.Item key={goal.goalId} className="tab-context-menu__item" onSelect={() => void open(goal.goalId)}>
        <span><strong>{goal.title}</strong><span>{goal.confirmed ? 'Last confirmed input' : 'No confirmed input'}{goal.pending ? ` · ${goal.pending}` : ''}</span></span>
      </DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
    {failure ? <span role="status" className="region-current-demand__failure">{failure}</span> : null}
  </div>
})
