import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useId, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@agentmux/client-ui/components/Button'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { currentDemandIndex, currentDemandKey } from '../lib/goal-current-work'
import { goalNextStepFact } from '../lib/goal-presentation'
import { GOAL_GROUP_LABELS, GoalStageMark, type GoalGroup } from '../lib/goal-groups'
import { DEMAND_STATUS_LABELS, type DemandProjection, type DemandStatus } from '../lib/global-demand-board'
import { useAppStore } from '../store'
import { GoalResponsibilitySummary } from './GoalResponsibilitySummary'
import { GoalPlanRing } from './GoalPlanGraph'
import { GoalAgentGroup } from './GoalAgentGroup'
import { SurfaceState } from './SurfaceState'
import goalsArtUrl from '@agentmux/client-ui/brand/illustrations/concepts/goals-companions.png'

const ThemeStatusSelectedIcon = semanticIconComponent('status.selected')
const ThemeNavigationDisclosureIcon = semanticIconComponent('navigation.disclosure')
/** One Goal reading unit shared by the list and board. */
export function GoalRow({ demand, selected, selectedSessionId, acknowledgementFailed, stageChanged, onSelect, compact = false }: { demand: DemandProjection; selected: boolean; selectedSessionId: string | null; acknowledgementFailed: boolean; stageChanged: boolean; onSelect: () => void; compact?: boolean }) {
  const teamDescriptionId = useId()
  const execution = useAppStore(useShallow((state) => {
    if (!demand.sessionIds.length && !selectedSessionId) return { unconfirmed: 0, context: null }
    const byId = agentSessionPresentationIndex(state.sessions)
    let unconfirmed = 0
    for (const id of demand.sessionIds) {
      const matches = typeof id === 'string' ? byId.get(id) : undefined
      const original = matches?.[0]?.control
      if (!original || matches?.some(({ control }) => control.hostId !== original.hostId || control.agentSessionId !== original.agentSessionId)) unconfirmed++
    }
    const focused = selectedSessionId ? byId.get(selectedSessionId) : undefined
    const source = focused?.length === 1 && focused[0]?.kind === 'agent' ? focused[0] : undefined
    const work = source ? currentDemandIndex(state.demands).get(currentDemandKey(source.control.hostId, source.control.agentSessionId)) : undefined
    const fact = work?.goals.find(goal => goal.goalId === demand.id)
    const context = !fact ? null : work?.state === 'current' && fact.confirmed ? 'Current execution'
      : fact.confirmed ? work?.state === 'ambiguous' ? fact.attributionAmbiguous ? 'Multiple original executions' : 'Multiple confirmed Goals' : 'Last confirmed input · input unconfirmed' : 'Input unconfirmed'
    return { unconfirmed, context }
  }))
  const retainedStart = useAppStore(state => state.goalFiniteStartIntents[demand.id])
  const fact = goalNextStepFact(demand, retainedStart)
  const nextStep = acknowledgementFailed ? 'Acknowledgement unconfirmed' : fact.text
  const stage = acknowledgementFailed ? 'you' : fact.stage
  return <div role="button" tabIndex={0} className={`goals-row${!demand.alignment ? ' goals-row--undefined' : ''}${selected ? ' goals-row--selected' : ''}${compact ? ' goals-row--compact' : ''}`} data-demand-id={demand.id} data-demand-status={demand.status} {...(stageChanged ? { 'data-goal-stage-changed': true } : {})} {...(execution.context === 'Current execution' ? { 'data-session-context': true } : {})} aria-pressed={selected} aria-describedby={demand.supervisorSessionId || demand.assigneeSessionIds?.length ? teamDescriptionId : undefined} aria-label={`Open goal ${demand.title}. ${nextStep}`} onClick={onSelect} onKeyDown={(event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() }
  }}>
    <GoalStageMark stage={stage} />
    <div className="goals-row__copy">
      <strong title={demand.title}>{demand.title}</strong>
      <span className="goals-row__next">{nextStep}</span>
      <div className="goals-row__footer">
        <div className="goals-row__facts">
          <GoalPlanRing demand={demand} />
          {demand.projectName ? <span className="goals-row__project" title={demand.projectName}>{demand.projectName}</span> : null}
          {execution.context ? <span>{execution.context}</span> : null}
          {execution.unconfirmed ? <span>{execution.unconfirmed} linked {execution.unconfirmed === 1 ? 'Session' : 'Sessions'} unconfirmed</span> : null}
        </div>
        <GoalAgentGroup demand={demand} descriptionId={teamDescriptionId} />
      </div>
      {!compact ? <GoalResponsibilitySummary demand={demand} compact /> : null}
    </div>
    {selected ? <ThemeStatusSelectedIcon className="goals-row__selected" size={13} aria-label="Selected goal" /> : <ThemeNavigationDisclosureIcon className="goals-row__open" size={14} aria-hidden="true" />}
  </div>
}

/** The grouped list, the work-status board and the empty states of the same filtered collection. */
export function GoalsCollectionBody({ view, groups, columns, visibleStatuses, hasGoals, hasMatches, query, filterCount, hideStart, onClearConditions, onShowFinished, renderRow }: {
  view: 'list' | 'board'; groups: readonly GoalGroup[]; columns: Record<DemandStatus, DemandProjection[]>; visibleStatuses: readonly DemandStatus[]
  hasGoals: boolean; hasMatches: boolean; query: string; filterCount: number; hideStart: boolean
  onClearConditions(): void; onShowFinished(): void; renderRow(demand: DemandProjection): ReactNode
}) {
  const occupied = visibleStatuses.filter(status => columns[status].length > 0)
  const empty = visibleStatuses.filter(status => columns[status].length === 0)
  if (!hasMatches) {
    if (hasGoals) return <SurfaceState layout="inline" className="goals-empty" title="No goals match this view."
      description={query.trim() ? `No match for “${query.trim()}”${filterCount ? ' with the current filters' : ''}.` : 'The current filters hide these goals.'}
      actions={query.trim() || filterCount ? <Button type="button" onClick={onClearConditions}>Clear search & filters</Button> : <Button type="button" onClick={onShowFinished}>Show finished</Button>} />
    return <div className="goals-empty">{hideStart ? null : <div className="goals-empty__start">
      <img src={goalsArtUrl} alt="" aria-hidden="true" draggable={false} onError={event => { event.currentTarget.hidden = true }} />
      <div><strong>No goals yet</strong><p>Start from a common action above, or create a goal and shape it with the agent in its own discussion.</p></div>
    </div>}</div>
  }
  return view === 'list' ? <div className="goals-list">{groups.map(group => <section key={group.stage} className="goals-group" data-goal-group={group.stage} aria-labelledby={`goals-group-${group.stage}`}><h2 id={`goals-group-${group.stage}`} className="goals-group__heading"><GoalStageMark stage={group.stage} size={11} /><span>{GOAL_GROUP_LABELS[group.stage]}</span><span className="goals-group__count">{group.goals.length}</span></h2>{group.goals.map(renderRow)}</section>)}</div>
      : <div className="goals-board" aria-label="Goals by work status">
        {empty.length ? <div className="goals-board__empty-states" aria-label="Empty work statuses"><span>Empty</span>{empty.map(status => <span key={status} data-empty-status={status}>{DEMAND_STATUS_LABELS[status]} <strong>0</strong></span>)}</div> : null}
        <div className="goals-board__lanes">{occupied.map(status => <section className="goals-board-column" key={status} data-status={status} aria-label={`${DEMAND_STATUS_LABELS[status]} goals`}>
          <header><strong>{DEMAND_STATUS_LABELS[status]}</strong><span>{columns[status].length}</span></header>{columns[status].map(renderRow)}
        </section>)}</div>
      </div>
}
