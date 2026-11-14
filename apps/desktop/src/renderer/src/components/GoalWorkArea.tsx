import type { ReactNode } from 'react'
import type { DemandProjection } from '../lib/global-demand-board'
import { goalHasOriginalWork, goalNextStepFact } from '../lib/goal-presentation'
import { useAppStore } from '../store'
import { GoalDelegationWork } from './GoalDelegationWork'
import { GoalFiniteStartControl } from './GoalFiniteStartControl'

/** The original work and its original controls share one reading area, never another execution owner. */
export function GoalWorkArea({ demand, plan, onRevealResults, active = true, primary = true }: {
  demand: DemandProjection; plan?: ReactNode; onRevealResults?: (() => void) | undefined; active?: boolean; primary?: boolean
}) {
  const current = useAppStore(state => active ? state.demands[demand.id] ?? demand : demand)
  const intent = useAppStore(state => state.goalFiniteStartIntents[demand.id])
  const fact = goalNextStepFact(current, intent)
  const pending = intent ?? current.dispatches?.find(item => item.execution === 'finite' && item.stage !== 'confirmed')
  const hasWork = goalHasOriginalWork(current, intent)
  const finitePrimary = primary && (fact.source.kind === 'goal' || Boolean(pending && fact.source.kind === 'start' && fact.source.operationId === pending.operationId))
  const finite = <GoalFiniteStartControl demand={current} embedded primary={finitePrimary} conclusion={pending && fact.source.kind === 'start' && fact.source.operationId === pending.operationId ? fact.text : undefined} />
  const another = !current.dispatches?.some(item => item.execution === 'finite' && item.stage === 'confirmed')
    ? <details><summary>Start a one-time task</summary>{finite}</details> : finite
  return <section className="goal-work-area" data-goal-work-area={current.id} data-goal-work-context={hasWork ? 'recorded' : 'fresh'} aria-label="Goal work">
    <div className="goals-section-heading"><h2>Work</h2><span className="goals-caption">{hasWork ? 'Original execution and requests' : 'Ready when you are'}</span></div>
    {!hasWork ? plan : null}
    <GoalDelegationWork demand={current} active={active} embedded focus={fact.source} primary={primary && !finitePrimary}
      beforeRecords={pending || !hasWork ? finite : undefined} afterRecords={hasWork && !pending ? another : undefined} plan={hasWork ? plan : undefined} onRevealResults={onRevealResults} />
  </section>
}
