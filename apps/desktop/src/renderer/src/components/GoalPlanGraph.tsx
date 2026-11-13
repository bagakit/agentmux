import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { projectGoalPlan, type GoalPlanNodeProjection, type GoalPlanNodeState, type GoalPlanProjection } from '@agentmux/demand/goal-plan'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { useGoalAgentPresentation } from '../lib/goal-discussion-recipient'
import { GoalPlanThread } from './GoalPlanThread'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'

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
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')

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

/** A smooth left-to-right connector between two node anchors, in the graph's own coordinates. */
export function goalPlanEdgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const bend = Math.max(24, (to.x - from.x) / 2)
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`
}

type Edge = { from: string; to: string; d: string; live: boolean }

/**
 * Edges are measured from the rendered cards, so they follow wrapping titles and opened details.
 * Only this graph's own layout changes trigger a re-measure; no global listener is installed.
 */
function useEdges(root: React.RefObject<HTMLElement | null>, projection: GoalPlanProjection, layoutKey: string): { edges: Edge[]; width: number; height: number } {
  const [state, setState] = useState<{ edges: Edge[]; width: number; height: number }>({ edges: [], width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      const content = element.querySelector<HTMLOListElement>('.goal-plan__columns')!
      const anchor = (id: string) => element.querySelector<HTMLElement>(`[data-goal-plan-node="${CSS.escape(id)}"] .goal-plan-node__head`)
      const edges: Edge[] = []
      for (const item of projection.nodes) for (const dependency of item.node.dependsOn) {
        const source = anchor(dependency), target = anchor(item.node.id)
        if (!source || !target) continue
        const a = source.getBoundingClientRect(), b = target.getBoundingClientRect()
        const sourceCard = source.closest<HTMLElement>('.goal-plan-node')!.getBoundingClientRect(), targetCard = target.closest<HTMLElement>('.goal-plan-node')!.getBoundingClientRect()
        const from = { x: sourceCard.right - box.left + element.scrollLeft, y: a.top + a.height / 2 - box.top }
        const to = { x: targetCard.left - box.left + element.scrollLeft, y: b.top + b.height / 2 - box.top }
        if (to.x <= from.x) continue
        edges.push({ from: dependency, to: item.node.id, d: goalPlanEdgePath(from, to), live: item.state === 'ready' || item.state === 'changes' })
      }
      // Measure content, not scrollHeight: the previous absolute SVG also contributes to scrolling.
      const width = Math.max(element.clientWidth, content.scrollWidth), height = content.offsetTop + content.offsetHeight
      setState(previous => JSON.stringify(previous.edges) === JSON.stringify(edges) && previous.width === width && previous.height === height
        ? previous : { edges, width, height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const card of element.querySelectorAll('.goal-plan-node')) observer.observe(card)
    return () => observer.disconnect()
  }, [root, projection, layoutKey])
  return state
}

function NodeExecutor({ item }: { item: GoalPlanNodeProjection }) {
  const executor = item.delegation ? { hostId: delegationWorkerHostId(item.delegation), agentSessionId: item.delegation.workerAgentSessionId } : item.node.executor
  const presentation = useGoalAgentPresentation(executor?.agentSessionId, executor?.hostId)
  const hosts = useAppStore(state => state.config?.hosts)
  if (!executor) return <span className="goal-plan-node__who goal-plan-node__who--open">Unassigned</span>
  const host = hosts?.find(host => host.id === executor.hostId)
  const toolsHost = presentation.toolExecution && hosts?.find(host => host.id === presentation.toolExecution!.resourceHostId)
  const place = presentation.toolExecution ? `Tools · ${toolsHost?.label ?? presentation.toolExecution.resourceHostId}`
    : presentation.hostId ? `${host?.kind === 'ssh' ? 'Remote' : 'Agent'} · ${host?.label ?? presentation.hostId}`
      : `Agent · ${host?.label ?? executor.hostId} · position unknown`
  return <span className="goal-plan-node__who" title={`${executor.agentSessionId} · ${executor.hostId}${presentation.toolExecution ? ` · ${presentation.toolExecution.workspacePath}` : ''}`}>
    <ThemeObjectAgentIcon size={11} aria-hidden="true" /><span className="goal-plan-node__name">{presentation.name ?? executor.agentSessionId}</span><span className="goal-plan-node__place">{place}</span>
  </span>
}

function NodeDetail({ item, dependencyNames, onIssue }: { item: GoalPlanNodeProjection; dependencyNames: string[]; onIssue(message: string | null): void }) {
  const report = item.delegation?.report
  const open = async (agentSessionId: string, hostId: string) => {
    try {
      onIssue(null)
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(),
        operation: 'focus', target: { kind: 'focus-agent', hostId, agentSessionId }, inputPolicy: 'preserve' })
      if (result.operation === 'focus' && result.navigation.state === 'rejected') onIssue(result.issues.map(issue => issue.message).join(' '))
    }
    catch (error) { onIssue(error instanceof Error ? error.message : String(error)) }
  }
  return <div className="goal-plan-node__detail" data-goal-plan-detail={item.node.id}>
    <p className="goal-plan-node__outcome">{item.node.outcome}</p>
    <dl className="goal-plan-node__facts">
      <div><dt>Check</dt><dd><code>{item.node.check}</code></dd></div>
      {dependencyNames.length ? <div><dt>Depends on</dt><dd title={item.node.dependsOn.join(', ')}>{dependencyNames.join(', ')}</dd></div> : null}
      {item.delegation ? <div><dt>Thread</dt><dd><code>{item.delegation.threadId}</code>{item.attempts > 1 ? ` · attempt ${item.attempts}` : ''}</dd></div> : null}
      {report ? <div><dt>Report</dt><dd>{report.grounding.summary}</dd></div> : null}
      {item.review ? <div><dt>{item.staleCriteria.length ? 'Previous review' : 'Review'}</dt><dd data-goal-plan-verdict={item.review.verdict}>{item.review.verdict === 'pass' ? 'Passed' : 'Changes requested'} by {item.review.reviewer.id}
        {item.review.verdict === 'pass' ? <> · <code>{item.review.check.command}</code> → {item.review.check.result}</> : <> · {item.review.note}</>}</dd></div> : null}
      {item.review?.check.evidence.length ? <div><dt>Evidence</dt><dd>{item.review.check.evidence.map(location => <p key={location}>{location}</p>)}</dd></div> : null}
      {item.staleCriteria.length ? <div><dt>Criteria</dt><dd className="goal-plan-node__stale">Changed or unavailable in the current goal: {item.staleCriteria.join(', ')}</dd></div> : null}
    </dl>
    {item.delegation ? <div className="goal-plan-node__actions">
      <button type="button" className="small-button" data-goal-plan-open="executor" onClick={() => void open(item.delegation!.workerAgentSessionId, delegationWorkerHostId(item.delegation!))}>Open executor</button>
      <button type="button" className="small-button" data-goal-plan-open="owner" onClick={() => void open(item.delegation!.ownerAgentSessionId, item.delegation!.hostId)}>Open owner</button>
    </div> : null}
    {item.delegation ? <GoalPlanThread key={JSON.stringify([item.delegation.hostId, item.delegation.sourceMessageId])} delegation={item.delegation} /> : null}
  </div>
}

/**
 * The plan reads left to right by dependency: each node sits one column past its deepest
 * dependency, joined to what it depends on by a smooth connector. State comes only from the
 * shared plan projection; this view never decides it.
 */
export function GoalPlanGraph({ demand, onOpenDiscussion }: { demand: Pick<DemandProjection, 'id' | 'plan' | 'delegations' | 'alignment'>; onOpenDiscussion?: () => void }) {
  const projection = useMemo(() => goalPlanProjection(demand), [demand.plan, demand.delegations, demand.alignment])
  const [open, setOpen] = useState<string | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const reading = useRef<HTMLDivElement>(null), readingId = useId()
  const empty: GoalPlanProjection = { revision: 0, nodes: [], done: 0, total: 0, next: [] }
  const { edges, width, height } = useEdges(canvas, projection ?? empty, open ?? '')
  useLayoutEffect(() => { if (open) reading.current?.scrollIntoView?.({ block: 'nearest' }) }, [open])
  if (!projection) return onOpenDiscussion ? <section className="goal-plan goal-plan--empty" aria-label="Goal plan">
    <div className="goals-inline-actions"><ThemeObjectWorkflowIcon size={14} aria-hidden="true" /><span className="goals-caption">Plan</span>
      <button type="button" className="small-button" onClick={onOpenDiscussion}>Plan in goal discussion</button></div>
  </section> : null
  const columns = goalPlanColumns(projection), highlight = goalPlanHighlight(projection)
  const byId = new Map(projection.nodes.map(item => [item.node.id, item]))
  const selected = open ? byId.get(open) : undefined
  const ratio = projection.total ? projection.done / projection.total : 0
  return <section className="goal-plan" aria-label="Goal plan" data-goal-plan-revision={projection.revision}>
    <div className="goals-section-heading">
      <h2><ThemeObjectWorkflowIcon size={14} aria-hidden="true" /> Plan</h2>
      <span className="goals-caption" data-goal-plan-progress>{projection.done} of {projection.total} done · revision {projection.revision}</span>
    </div>
    <div className="goal-plan__progress" aria-hidden="true"><span style={{ transform: `scaleX(${ratio})` }} /></div>
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
    <div className="goal-plan__canvas" ref={canvas}>
      <svg className="goal-plan__edges" width={width} height={height} aria-hidden="true">
        {edges.map(edge => <path key={`${edge.from}>${edge.to}`} d={edge.d} data-goal-plan-edge={`${edge.from}>${edge.to}`} className={edge.live ? 'goal-plan__edge goal-plan__edge--live' : 'goal-plan__edge'} />)}
      </svg>
      <ol className="goal-plan__columns">
        {columns.map((column, index) => <li key={index} className="goal-plan__column" data-goal-plan-column={index}>
          <ol className="goal-plan__nodes">
            {column.map(item => {
              const Icon = STATE_ICONS[item.state], expanded = open === item.node.id
              return <li key={item.node.id} className={`goal-plan-node${item.node.id === highlight ? ' goal-plan-node--next' : ''}`}
                data-goal-plan-node={item.node.id} data-goal-plan-state={item.state} {...(item.node.dependsOn.length ? { 'data-goal-plan-depends': item.node.dependsOn.join(' ') } : {})}>
                <button type="button" className="goal-plan-node__head" aria-expanded={expanded} aria-controls={expanded ? readingId : undefined} onClick={() => setOpen(expanded ? null : item.node.id)}>
                  <span className="goal-plan-node__mark" data-goal-plan-state={item.state} aria-hidden="true"><Icon size={12} strokeWidth={1.8} animation="none" /></span>
                  <span className="goal-plan-node__title">{item.node.title}</span>
                </button>
                <span className="goal-plan-node__state">{item.staleCriteria.length ? 'Criteria need review' : GOAL_PLAN_STATE_LABELS[item.state]}</span>
                {item.node.dependsOn.length ? <span className={`goal-plan-node__depends${item.state === 'waiting' ? ' goal-plan-node__depends--waiting' : ''}`}>
                  Depends on · {item.node.dependsOn.map(id => byId.get(id)!.node.title).join(', ')}
                </span> : null}
                <NodeExecutor item={item} />
              </li>
            })}
          </ol>
        </li>)}
      </ol>
    </div>
    {selected ? <div className="goal-plan__reading" ref={reading} id={readingId}>
      <div className="goals-section-heading"><h3>{selected.node.title}</h3><button type="button" className="small-button" onClick={() => {
        canvas.current?.querySelector<HTMLButtonElement>(`[data-goal-plan-node="${CSS.escape(selected.node.id)}"] .goal-plan-node__head`)?.focus()
        setOpen(null)
      }}>Back to node</button></div>
      <NodeDetail key={selected.node.id} item={selected} dependencyNames={selected.node.dependsOn.map(id => byId.get(id)!.node.title)} onIssue={setIssue} />
    </div> : null}
  </section>
}

/** A compact ring for the Goal row: done over live nodes, from the same projection. */
export function GoalPlanRing({ demand }: { demand: Pick<DemandProjection, 'plan' | 'delegations' | 'alignment'> }) {
  const projection = useMemo(() => goalPlanProjection(demand), [demand.plan, demand.delegations, demand.alignment])
  if (!projection || !projection.total) return null
  const circumference = 2 * Math.PI * 6, done = projection.done / projection.total
  return <span className="goal-plan-ring" data-goal-plan-ring={`${projection.done}/${projection.total}`} aria-label={`Plan ${projection.done} of ${projection.total} done`}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" className="goal-plan-ring__track" />
      <circle cx="8" cy="8" r="6" className="goal-plan-ring__done" strokeDasharray={`${circumference * done} ${circumference}`} transform="rotate(-90 8 8)" />
    </svg>
    <span>{projection.done}/{projection.total}</span>
  </span>
}
