import { compactReferenceId } from '@agentmux/client-ui/display-name'
import { demandAgentReferenceLabel } from '@agentmux/demand/relations'
import { sameDemandExecution, type DemandExecutionReference } from '@agentmux/demand/responsibility'
import type { GoalResponsibilityRow } from '@agentmux/core/goal-responsibility'
import { useGoalAgentPresentation } from '../lib/goal-discussion-recipient'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useId, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@agentmux/client-ui/components/Button'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { currentDemandIndex, currentDemandKey } from '../lib/goal-current-work'
import { goalNextStepFact, type GoalNextStepSource, type GoalStage } from '../lib/goal-presentation'
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
/** The four lifecycle reading positions and the two independent conditions all use the list's owner-derived grouping. */
export function GoalBoardWorkflow({ groups, selected, onSelect }: { groups: readonly GoalGroup[]; selected: GoalStage | null; onSelect(stage: GoalStage | null): void }) {
  const counts = new Map(groups.map(group => [group.stage, group.goals.length]))
  const stageButton = (stage: GoalStage) => {
    const count = counts.get(stage) ?? 0
    return <button key={stage} type="button" className="goals-flow__step" data-goal-flow-stage={stage} aria-pressed={selected === stage}
      aria-label={`${GOAL_GROUP_LABELS[stage]}, ${count} ${count === 1 ? 'goal' : 'goals'}`} onClick={() => onSelect(stage)}>
      <GoalStageMark stage={stage} size={13} /><span>{GOAL_GROUP_LABELS[stage]}</span><strong>{count}</strong>
    </button>
  }
  return <nav className="goals-flow" aria-label="Filter goals by workflow stage" onKeyDown={event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key) || event.altKey || event.metaKey || event.ctrlKey) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }}>
    <button type="button" className="goals-flow__all" data-goal-flow-all aria-label="Show all workflow stages" aria-pressed={selected === null} onClick={() => onSelect(null)}>
      Workflow<span>All</span>
    </button>
    <div className="goals-flow__path">{(['define', 'agents', 'you', 'finished'] as const).map(stage => <div className="goals-flow__stop" key={stage}>
      {stageButton(stage)}
    </div>)}</div>
    <div className="goals-flow__conditions">{(['attention', 'unknown'] as const).map(stageButton)}</div>
  </nav>
}

function boardExecution(source: GoalNextStepSource): DemandExecutionReference | undefined {
  if (source.kind === 'delegation') return source
  if (source.kind !== 'start' || !source.runId) return
  const { kind, operationId, runId } = source
  if (source.agentReference) return { kind, operationId, runId, target: source.agentReference }
  if (source.hostId) return { kind, operationId, runId, hostId: source.hostId, agentSessionId: source.agentSessionId }
}

function BoardNextOwner({ row, demand }: { row: GoalResponsibilityRow; demand: DemandProjection }) {
  const { nextOwner, execution } = row
  const manager = demand.responsibility?.supervisor
  const host = nextOwner.kind === 'manager' && nextOwner.agentSessionId === manager?.agentSessionId ? manager?.hostId :
    nextOwner.kind === 'worker' && !('target' in execution) && nextOwner.agentSessionId === execution.agentSessionId ? execution.hostId : undefined
  const reference = nextOwner.agentReference
  const recipient = useGoalAgentPresentation(reference ?? nextOwner.agentSessionId, host ?? undefined)
  const owner = nextOwner.kind === 'human' ? 'You' : nextOwner.kind === 'external' ? 'External' : reference
    ? `${compactReferenceId(reference.execution.agentSessionId)} @ ${compactReferenceId(reference.execution.runtimeId)}` :
      recipient.name ?? (nextOwner.agentSessionId ? compactReferenceId(nextOwner.agentSessionId) : 'Unconfirmed')
  return <span className="goals-board__next-owner" title={reference ? demandAgentReferenceLabel(reference) : nextOwner.action}>
    Next <strong>{owner}</strong>
  </span>
}

/** One Goal reading unit shared by the list and board. */
export function GoalRow({ demand, selected, selectedSessionId, acknowledgementFailed, stageChanged, onSelect, compact = false, board = false }: { board?: boolean; demand: DemandProjection; selected: boolean; selectedSessionId: string | null; acknowledgementFailed: boolean; stageChanged: boolean; onSelect: () => void; compact?: boolean }) {
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
  const original = board && !acknowledgementFailed ? boardExecution(fact.source) : undefined
  const responsibility = original && demand.responsibility?.executions.find(row => sameDemandExecution(original, row.execution))
  return <div role="button" tabIndex={0} className={`goals-row${!demand.alignment ? ' goals-row--undefined' : ''}${selected ? ' goals-row--selected' : ''}${compact ? ' goals-row--compact' : ''}`} data-demand-id={demand.id} data-demand-status={demand.status} {...(stageChanged ? { 'data-goal-stage-changed': true } : {})} {...(execution.context === 'Current execution' ? { 'data-session-context': true } : {})} aria-pressed={selected} aria-describedby={demand.supervisorSessionId || demand.assigneeSessionIds?.length ? teamDescriptionId : undefined} aria-label={`Open goal ${demand.title}. ${nextStep}`} onClick={onSelect} onKeyDown={(event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() }
  }}>
    <GoalStageMark stage={stage} cancelled={demand.status === 'cancelled'} />
    <div className="goals-row__copy">
      <strong title={demand.title}>{demand.title}</strong>
      <span className="goals-row__next">{nextStep}</span>
      <div className="goals-row__footer">
        <div className="goals-row__facts">
          {responsibility ? <BoardNextOwner row={responsibility} demand={demand} /> : null}
          <GoalPlanRing demand={demand} />
          {demand.projectName ? <span className="goals-row__project" title={demand.projectName}>{demand.projectName}</span> : null}
          {execution.context ? <span>{execution.context}</span> : null}
          {execution.unconfirmed ? <span>{execution.unconfirmed} linked {execution.unconfirmed === 1 ? 'Session' : 'Sessions'} unconfirmed</span> : null}
        </div>
        <GoalAgentGroup demand={demand} descriptionId={teamDescriptionId} board={board} />
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
        <header className="goals-board__heading"><h2>Work status</h2>
          {empty.length ? <details className="goals-board__empty-states" aria-label="Empty work statuses">
            <summary>{empty.length} empty {empty.length === 1 ? 'status' : 'statuses'}</summary>
            <div>{empty.map(status => <span key={status} data-empty-status={status}>{DEMAND_STATUS_LABELS[status]} <strong>0</strong></span>)}</div>
          </details> : null}
        </header>
        <div className="goals-board__lanes">{occupied.map(status => <section className="goals-board-column" key={status} data-status={status} aria-label={`${DEMAND_STATUS_LABELS[status]} goals`}>
          <header><strong>{DEMAND_STATUS_LABELS[status]}</strong><span>{columns[status].length}</span></header>{columns[status].map(renderRow)}
        </section>)}</div>
      </div>
}
