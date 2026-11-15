import type { Ref } from 'react'
import type { DemandProjection } from '../lib/global-demand-board'
import { goalHasOriginalWork, goalNextStepFact } from '../lib/goal-presentation'
import { useAppStore } from '../store'
import { GoalDelegationWork } from './GoalDelegationWork'
import { GoalFiniteStartControl } from './GoalFiniteStartControl'
import { readGoalFiniteStartIntent } from '../lib/goal-finite-start'

/** The original work and its original controls share one reading area, never another execution owner. */
export function GoalWorkArea({ demand, sectionRef, onRevealResults, active = true, primary = true }: {
  demand: DemandProjection; sectionRef?: Ref<HTMLElement>; onRevealResults?: (() => void) | undefined; active?: boolean; primary?: boolean
}) {
  const current = useAppStore(state => active ? state.demands[demand.id] ?? demand : demand)
  const rawIntent = useAppStore(state => state.goalFiniteStartIntents[demand.id])
  const intent = readGoalFiniteStartIntent(rawIntent, demand.id)
  const fact = goalNextStepFact(current, rawIntent)
  const pending = (intent?.phase === 'selecting-access' ? undefined : intent) ?? current.dispatches?.find(item => item.execution === 'finite' && item.stage !== 'confirmed')
  const hasWork = goalHasOriginalWork(current, rawIntent)
  const hasPlan = Boolean(current.plan?.nodes.length)
  const originalInput = rawIntent !== undefined || Boolean(pending)
  const finitePrimary = primary && (fact.source.kind === 'goal' && (!hasPlan || originalInput) || Boolean(pending && fact.source.kind === 'start' && fact.source.operationId === pending.operationId))
  const finite = <GoalFiniteStartControl demand={current} active={active} embedded primary={finitePrimary} conclusion={pending && fact.source.kind === 'start' && fact.source.operationId === pending.operationId ? fact.text : undefined} />
  const showOriginalInput = hasWork && originalInput
  const discloseNewTask = !originalInput && (hasWork || hasPlan) && !current.dispatches?.some(item => item.execution === 'finite' && item.stage === 'confirmed')
  const next = discloseNewTask
    ? <details><summary>Start a one-time task</summary>{finite}</details> : finite
  return <section ref={sectionRef} tabIndex={-1} data-goal-reading-section="execution" className="goal-work-area" data-goal-work-area={current.id} data-goal-work-context={hasWork ? 'recorded' : 'fresh'} aria-label="Execution records">
    <div className="goals-section-heading"><h2>Execution records</h2></div>
    <GoalDelegationWork demand={current} active={active} embedded focus={fact.source} primary={primary && !finitePrimary}
      beforeRecords={showOriginalInput ? finite : undefined} afterRecords={showOriginalInput ? undefined : next} onRevealResults={onRevealResults} />
  </section>
}
