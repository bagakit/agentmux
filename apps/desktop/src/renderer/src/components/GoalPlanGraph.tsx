import { useMemo, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { projectGoalPlan, type GoalPlanNodeProjection, type GoalPlanNodeState, type GoalPlanProjection } from '@agentmux/demand/goal-plan'
import type { DemandProjection } from '../lib/global-demand-board'
import { useGoalAgentName } from '../lib/goal-discussion-recipient'

/** One distinct glyph per node state, so a node still reads without its color. */
const STATE_ICON_NAMES = {
  waiting: 'status.queued', ready: 'action.start', working: 'status.working', review: 'action.review-source',
  changes: 'status.gap', done: 'status.completed', cancelled: 'status.disabled', unknown: 'status.unknown'
} as const satisfies Record<GoalPlanNodeState, string>
const STATE_ICONS = Object.fromEntries(Object.entries(STATE_ICON_NAMES).map(([state, name]) => [state, semanticIconComponent(name)])) as
  Record<GoalPlanNodeState, ReturnType<typeof semanticIconComponent>>
export const GOAL_PLAN_STATE_LABELS: Record<GoalPlanNodeState, string> = {
  waiting: 'Waiting on dependencies', ready: 'Ready to start', working: 'In progress', review: 'Awaiting review',
  changes: 'Changes requested', done: 'Done', cancelled: 'Cancelled', unknown: 'Delivery unconfirmed'
}
const ThemeObjectWorkflowIcon = semanticIconComponent('object.workflow')
const ThemeObjectThreadIcon = semanticIconComponent('object.conversation')

/** Columns by dependency depth; within a column the plan order is kept. */
export function goalPlanColumns(projection: GoalPlanProjection): GoalPlanNodeProjection[][] {
  const columns: GoalPlanNodeProjection[][] = []
  for (const item of projection.nodes) (columns[item.column] ??= []).push(item)
  return columns
}

/** The first runnable node in reading order is the one place the page highlights. */
export function goalPlanHighlight(projection: GoalPlanProjection): string | null {
  return projection.nodes.find(item => item.state === 'changes')?.node.id ?? projection.next[0] ?? null
}

export function goalPlanProjection(demand: Pick<DemandProjection, 'plan' | 'delegations' | 'alignment'>): GoalPlanProjection | null {
  return demand.plan ? projectGoalPlan(demand.plan, demand.delegations ?? [], demand.alignment?.criteria ?? []) : null
}

function NodeExecutor({ item }: { item: GoalPlanNodeProjection }) {
  const executor = item.delegation ? { hostId: item.delegation.hostId, agentSessionId: item.delegation.workerAgentSessionId } : item.node.executor
  const name = useGoalAgentName(executor?.agentSessionId, executor?.hostId)
  if (!executor) return <span className="goal-plan-node__who goal-plan-node__who--open">Unassigned</span>
  const place = executor.hostId === 'local' ? 'This Mac' : executor.hostId
  return <span className="goal-plan-node__who" title={`${executor.agentSessionId} · ${executor.hostId}`}>{name ?? executor.agentSessionId}<span aria-hidden="true"> · </span><span className="goal-plan-node__place">{place}</span></span>
}

function NodeDetail({ item }: { item: GoalPlanNodeProjection }) {
  const report = item.delegation?.report
  return <div className="goal-plan-node__detail" data-goal-plan-detail={item.node.id}>
    <p className="goal-plan-node__outcome">{item.node.outcome}</p>
    <dl className="goal-plan-node__facts">
      <div><dt>Check</dt><dd><code>{item.node.check}</code></dd></div>
      {item.node.dependsOn.length ? <div><dt>Depends on</dt><dd>{item.node.dependsOn.join(', ')}</dd></div> : null}
      {item.delegation ? <div><dt>Thread</dt><dd><ThemeObjectThreadIcon size={12} aria-hidden="true" /> {item.delegation.threadId}{item.attempts > 1 ? ` · attempt ${item.attempts}` : ''}</dd></div> : null}
      {report ? <div><dt>Report</dt><dd>{report.grounding.summary}</dd></div> : null}
      {item.review ? <div><dt>Review</dt><dd data-goal-plan-verdict={item.review.verdict}>{item.review.verdict === 'pass' ? 'Passed' : 'Changes requested'} by {item.review.reviewer.id}
        {item.review.verdict === 'pass' ? <> · <code>{item.review.check.command}</code> → {item.review.check.result}</> : <> · {item.review.note}</>}</dd></div> : null}
      {item.staleCriteria.length ? <div><dt>Criteria</dt><dd className="goal-plan-node__stale">No longer in the goal: {item.staleCriteria.join(', ')}</dd></div> : null}
    </dl>
  </div>
}

/**
 * The plan reads left to right by dependency: each node sits one column past its deepest
 * dependency. State comes only from the shared plan projection; this view never decides it.
 */
export function GoalPlanGraph({ demand }: { demand: Pick<DemandProjection, 'id' | 'plan' | 'delegations' | 'alignment'> }) {
  const projection = useMemo(() => goalPlanProjection(demand), [demand.plan, demand.delegations, demand.alignment])
  const [open, setOpen] = useState<string | null>(null)
  if (!projection) return null
  const columns = goalPlanColumns(projection), highlight = goalPlanHighlight(projection)
  const byId = new Map(projection.nodes.map(item => [item.node.id, item]))
  return <section className="goal-plan" aria-label="Goal plan" data-goal-plan-revision={projection.revision}>
    <div className="goals-section-heading">
      <h2><ThemeObjectWorkflowIcon size={14} aria-hidden="true" /> Plan</h2>
      <span className="goals-caption" data-goal-plan-progress>{projection.done} of {projection.total} done · revision {projection.revision}</span>
    </div>
    <div className="goal-plan__progress" aria-hidden="true"><span style={{ width: `${projection.total ? Math.round(projection.done / projection.total * 100) : 0}%` }} /></div>
    <ol className="goal-plan__columns">
      {columns.map((column, index) => <li key={index} className="goal-plan__column" data-goal-plan-column={index}>
        <ol className="goal-plan__nodes">
          {column.map(item => {
            const Icon = STATE_ICONS[item.state], expanded = open === item.node.id
            const waitsOn = item.node.dependsOn.filter(id => byId.get(id)?.state !== 'done')
            return <li key={item.node.id} className={`goal-plan-node${item.node.id === highlight ? ' goal-plan-node--next' : ''}`}
              data-goal-plan-node={item.node.id} data-goal-plan-state={item.state} {...(item.node.dependsOn.length ? { 'data-goal-plan-depends': item.node.dependsOn.join(' ') } : {})}>
              <button type="button" className="goal-plan-node__head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : item.node.id)}>
                <span className="goal-plan-node__mark" data-goal-plan-state={item.state} aria-hidden="true"><Icon size={12} strokeWidth={1.8} animation="none" /></span>
                <span className="goal-plan-node__title">{item.node.title}</span>
              </button>
              <span className="goal-plan-node__state">{GOAL_PLAN_STATE_LABELS[item.state]}{item.state === 'waiting' && waitsOn.length ? ` · ${waitsOn.join(', ')}` : ''}</span>
              <NodeExecutor item={item} />
              {expanded ? <NodeDetail item={item} /> : null}
            </li>
          })}
        </ol>
      </li>)}
    </ol>
  </section>
}
