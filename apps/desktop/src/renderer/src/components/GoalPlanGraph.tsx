import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { GoalPlanNodeProjection, GoalPlanNodeState, GoalPlanUnknownReason } from '@agentmux/demand/goal-plan'
import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { useAppStore } from '../store'
import type { DemandProjection } from '../lib/global-demand-board'
import { useGoalAgentPresentation } from '../lib/goal-discussion-recipient'
import { GoalPlanThread } from './GoalPlanThread'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import { GoalPlanRequest } from './GoalPlanRequest'

/** One distinct glyph per node state, so a node still reads without its color. */
const STATE_ICON_NAMES = {
  waiting: 'status.queued', ready: 'action.start', working: 'status.working', review: 'action.review-source',
  changes: 'status.gap', done: 'status.completed', cancelled: 'status.disabled', unknown: 'status.unknown'
} as const satisfies Record<GoalPlanNodeState, string>
const STATE_ICONS = Object.fromEntries(Object.entries(STATE_ICON_NAMES).map(([state, name]) => [state, semanticIconComponent(name)])) as
  Record<GoalPlanNodeState, ReturnType<typeof semanticIconComponent>>
export const GOAL_PLAN_STATE_LABELS: Record<Exclude<GoalPlanNodeState, 'unknown'>, string> = {
  waiting: 'Waiting on dependencies', ready: 'Ready to start', working: 'In progress', review: 'Awaiting review',
  changes: 'Changes requested', done: 'Done', cancelled: 'Cancelled'
}
const UNKNOWN_LABELS: Record<GoalPlanUnknownReason, string> = { criteria: 'Criteria need review', 'dispatch-link': 'Delivery unconfirmed' }
/** A node as its Goal owner derived it; `state` is null when the owner returned no derivation. */
export type GoalPlanNodeView = Omit<GoalPlanNodeProjection, 'state'> & { state: GoalPlanNodeState | null }
/** `progress` is null when the owner returned its plan without the derivation. */
export type GoalPlanView = { revision: number; nodes: GoalPlanNodeView[]; next: string[]; progress: { done: number; total: number } | null }
/** An unknown node names every reason it needs reconciliation; other states read as themselves. */
export function goalPlanStateLabel(item: Pick<GoalPlanNodeView, 'state' | 'unknown'>): string {
  return item.state === null ? 'State unavailable' : item.state === 'unknown' ? item.unknown.map(reason => UNKNOWN_LABELS[reason]).join(' · ') : GOAL_PLAN_STATE_LABELS[item.state]
}
const ThemeObjectWorkflowIcon = semanticIconComponent('object.workflow')
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const ThemeObjectGoalIcon = semanticIconComponent('object.goal')

/** Columns by dependency depth; within a column the plan order is kept. */
export function goalPlanColumns(projection: GoalPlanView): GoalPlanNodeView[][] {
  const columns: GoalPlanNodeView[][] = []
  for (const item of projection.nodes) (columns[item.column] ??= []).push(item)
  return columns
}

/** The first runnable node in reading order is the one place the page highlights. */
export function goalPlanHighlight(projection: GoalPlanView): string | null {
  return projection.nodes.find(item => item.state === 'changes')?.node.id ?? projection.next[0] ?? null
}

/**
 * The plan as its Goal owner derived it. The view only joins each node, its current attempt and
 * that attempt's review by the owner's identities. Without the owner's derivation no node state
 * is shown, and the nodes keep plan order in one column.
 */
export function goalPlanProjection(demand: Pick<DemandProjection, 'plan' | 'planState' | 'delegations'>): GoalPlanView | null {
  const { plan, planState } = demand
  if (!plan) return null
  if (!planState) return { revision: plan.revision, next: [], progress: null,
    nodes: plan.nodes.map(node => ({ node, state: null, column: 0, delegation: null, attempts: 0, review: null, staleCriteria: [], unknown: [] })) }
  const delegations = new Map((demand.delegations ?? []).map(item => [item.operationId, item]))
  return { revision: planState.revision, next: planState.next, progress: { done: planState.done, total: planState.total },
    nodes: planState.nodes.map((item, index) => {
      const delegation = item.attempt ? delegations.get(item.attempt.delegationOperationId) ?? null : null
      const review = delegation ? plan.reviews.filter(entry => entry.nodeId === item.id && entry.delegationOperationId === delegation.operationId).at(-1) ?? null : null
      return { node: plan.nodes[index]!, state: item.state, column: item.column, delegation, attempts: item.attempts, review, staleCriteria: item.staleCriteria, unknown: item.unknown }
    }) }
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
function useEdges(root: React.RefObject<HTMLElement | null>, projection: GoalPlanView, layoutKey: string): { edges: Edge[]; width: number; height: number; scrollable: boolean } {
  const [state, setState] = useState<{ edges: Edge[]; width: number; height: number; scrollable: boolean }>({ edges: [], width: 0, height: 0, scrollable: false })
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
        const from = { x: sourceCard.right - box.left + element.scrollLeft, y: a.top + a.height / 2 - box.top + element.scrollTop }
        const to = { x: targetCard.left - box.left + element.scrollLeft, y: b.top + b.height / 2 - box.top + element.scrollTop }
        if (to.x <= from.x) continue
        edges.push({ from: dependency, to: item.node.id, d: goalPlanEdgePath(from, to), live: item.state === 'ready' || item.state === 'changes' })
      }
      // Measure content, not scrollHeight: the previous absolute SVG also contributes to scrolling.
      const width = Math.max(element.clientWidth, content.scrollWidth), height = content.offsetTop + content.offsetHeight
      const scrollable = width > element.clientWidth + 1 || height > element.clientHeight + 1
      setState(previous => JSON.stringify(previous.edges) === JSON.stringify(edges) && previous.width === width && previous.height === height && previous.scrollable === scrollable
        ? previous : { edges, width, height, scrollable })
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

function NodeExecutor({ item }: { item: GoalPlanNodeView }) {
  const executor = item.delegation ? { hostId: delegationWorkerHostId(item.delegation), agentSessionId: item.delegation.workerAgentSessionId } : item.node.executor
  const presentation = useGoalAgentPresentation(executor?.agentSessionId, executor?.hostId)
  const hosts = useAppStore(state => state.config?.hosts)
  if (!executor) return <span className="goal-plan-node__who goal-plan-node__who--open">Unassigned</span>
  const host = hosts?.find(host => host.id === executor.hostId)
  const toolsHost = presentation.toolExecution && hosts?.find(host => host.id === presentation.workPlacement?.resourceHostId)
  const place = presentation.toolExecution ? `Tools · ${toolsHost?.label ?? presentation.workPlacement?.resourceHostId ?? 'Host unknown'}`
    : presentation.hostId ? `${host?.kind === 'ssh' ? 'Remote' : 'Agent'} · ${host?.label ?? presentation.hostId}`
      : `Agent · ${host?.label ?? executor.hostId} · position unknown`
  return <span className="goal-plan-node__who" title={`${executor.agentSessionId} · ${executor.hostId}${presentation.toolExecution ? ` · ${presentation.toolExecution.workspacePath}` : ''}`}>
    <ThemeObjectAgentIcon size={11} aria-hidden="true" /><span className="goal-plan-node__name">{presentation.name ?? executor.agentSessionId}</span><AgentWorkModeBadge source={presentation.hostId && presentation.workspacePath ? {hostId: presentation.hostId, workspacePath: presentation.workspacePath, toolExecution: presentation.toolExecution ?? undefined, workPlacement: presentation.workPlacement} : undefined} hosts={hosts} embedded /><span className="goal-plan-node__place">{place}</span>
  </span>
}

function DependencyNames({ names }: { names: string[] }) {
  return <>{names.map((name, index) => <Fragment key={index}>{index ? ', ' : ''}<span className="goal-plan-dependency">{name}</span></Fragment>)}</>
}

function NodeDetail({ item, dependencyNames, onIssue }: { item: GoalPlanNodeView; dependencyNames: string[]; onIssue(message: string | null): void }) {
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
      {dependencyNames.length ? <div><dt>Depends on</dt><dd title={item.node.dependsOn.join(', ')}><DependencyNames names={dependencyNames} /></dd></div> : null}
      {item.delegation ? <div><dt>Thread</dt><dd><code>{item.delegation.threadId}</code>{item.attempts > 1 ? ` · attempt ${item.attempts}` : ''}</dd></div> : null}
      {report ? <div><dt>Report</dt><dd>{report.grounding.summary}</dd></div> : null}
      {item.review ? <div><dt>{item.staleCriteria.length ? 'Previous review' : 'Review'}</dt><dd data-goal-plan-verdict={item.review.verdict}>{item.review.verdict === 'pass' ? 'Passed' : 'Changes requested'} by {item.review.reviewer.id}
        {item.review.verdict === 'pass' ? <> · <code>{item.review.check.command}</code> → {item.review.check.result}</> : <> · {item.review.note}</>}</dd></div> : null}
      {item.review?.check.evidence.length ? <div><dt>Evidence</dt><dd>{item.review.check.evidence.map(location => <p key={location}>{location}</p>)}</dd></div> : null}
      {item.unknown.includes('criteria') ? <div><dt>Criteria</dt><dd className="goal-plan-node__stale">{item.staleCriteria.length
        ? `Changed or unavailable in the current goal: ${item.staleCriteria.join(', ')}` : 'Covers no success criterion of the current goal. Revise the plan to name what this node delivers.'}</dd></div> : null}
      {item.unknown.includes('dispatch-link') ? <div><dt>Delivery</dt><dd className="goal-plan-node__stale">The original delegation link is unconfirmed. Read its receipt before acting; it is never resent automatically.</dd></div> : null}
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
 * Goal owner's derivation; this view never decides it.
 */
export function GoalPlanGraph({ demand, onRequestPlan, pending = false, busy = false }: {
  demand: DemandProjection
  onRequestPlan?: () => void; pending?: boolean; busy?: boolean
}) {
  const projection = useMemo(() => goalPlanProjection(demand), [demand.plan, demand.planState, demand.delegations])
  const [open, setOpen] = useState<string | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [readingState, setReadingState] = useState(false)
  const canvas = useRef<HTMLDivElement>(null)
  const reading = useRef<HTMLDivElement>(null), readingId = useId()
  const empty: GoalPlanView = { revision: 0, nodes: [], next: [], progress: null }
  const { edges, width, height, scrollable } = useEdges(canvas, projection ?? empty, open ?? '')
  useLayoutEffect(() => { if (open) reading.current?.scrollIntoView?.({ block: 'nearest' }) }, [open])
  const requestAction = onRequestPlan ? <GoalPlanRequest demand={demand} onRequest={onRequestPlan} pending={pending} busy={busy} /> : null
  async function readState() {
    setReadingState(true); setIssue(null)
    try { await useAppStore.getState().refreshDemand(demand.id) }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setReadingState(false) }
  }
  const stateIssue = demand.planStateIssue ?? (projection && !projection.progress
    ? "Node states are unavailable: this Goal's Host returned the plan without them. Read this Goal again; update that Host if the state remains unavailable. The plan itself is unchanged." : undefined)
  const stateService = stateIssue ? <p className="goals-service" role="status" data-goal-plan-states-unavailable>{stateIssue}{' '}
    <button type="button" className="small-button" disabled={readingState} onClick={() => void readState()}>{readingState ? 'Reading Goal…' : 'Read Goal again'}</button>
  </p> : null
  if (!projection) return <section className="goal-plan goal-plan--empty" aria-label="Goal plan" data-goal-plan-empty>
    <div className="goals-section-heading"><h2><ThemeObjectWorkflowIcon size={14} aria-hidden="true" /> Execution plan</h2><span className="goals-caption">Starting point</span></div>
    {stateService}{issue ? <p className="goals-service" role="status">{issue}</p> : null}
    <div className="goal-plan__origin">
      <article className="goal-plan__goal" data-goal-plan-origin={demand.id} aria-label="Goal starting point">
        <span className="goal-plan__goal-icon" aria-hidden="true"><ThemeObjectGoalIcon size={24} /></span>
        <div className="goal-plan__goal-body"><p className="goal-plan__goal-label">Goal <span>Starting point</span></p><h3>{demand.title}</h3></div>
      </article>
      <div className="goal-plan__empty-body"><p className="goal-plan__empty-title">No execution plan yet</p>
      <p className="goals-muted">{demand.alignment ? 'Shape the tasks, dependencies and checks.' : 'Clarify the outcome and success criteria first.'}</p>
      <div className="goals-inline-actions">{requestAction}
      </div>
      </div>
    </div>
  </section>
  const columns = goalPlanColumns(projection), highlight = goalPlanHighlight(projection)
  const byId = new Map(projection.nodes.map(item => [item.node.id, item]))
  const selected = open ? byId.get(open) : undefined
  const { progress } = projection, ratio = progress?.total ? progress.done / progress.total : 0
  return <section className={`goal-plan${progress ? '' : ' goal-plan--unavailable'}`} aria-label="Goal plan" data-goal-plan-revision={projection.revision}>
    <div className="goals-section-heading">
      <h2><ThemeObjectWorkflowIcon size={14} aria-hidden="true" /> Execution plan</h2>
      <span className="goals-caption" data-goal-plan-progress>{progress ? `${progress.done} of ${progress.total} done · ` : ''}revision {projection.revision}</span>
    </div>
    {requestAction ? <div className="goals-inline-actions goal-plan__revise">{requestAction}</div> : null}
    {progress ? <div className="goal-plan__progress" aria-hidden="true"><span style={{ transform: `scaleX(${ratio})` }} /></div> : stateService}
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
    <div className="goal-plan__canvas" ref={canvas} tabIndex={0} aria-label="Execution graph">
      <svg className="goal-plan__edges" width={width} height={height} aria-hidden="true">
        {edges.map(edge => <path key={`${edge.from}>${edge.to}`} d={edge.d} data-goal-plan-edge={`${edge.from}>${edge.to}`} className={edge.live ? 'goal-plan__edge goal-plan__edge--live' : 'goal-plan__edge'} />)}
      </svg>
      <ol className="goal-plan__columns">
        {columns.map((column, index) => <li key={index} className="goal-plan__column" data-goal-plan-column={index}>
          <ol className="goal-plan__nodes">
            {column.map(item => {
              const Icon = STATE_ICONS[item.state ?? 'unknown'], state = item.state ?? 'unavailable', expanded = open === item.node.id
              return <li key={item.node.id} className={`goal-plan-node${item.node.id === highlight ? ' goal-plan-node--next' : ''}`}
                data-goal-plan-node={item.node.id} data-goal-plan-state={state} {...(item.node.dependsOn.length ? { 'data-goal-plan-depends': item.node.dependsOn.join(' ') } : {})}>
                <button type="button" className="goal-plan-node__head" aria-expanded={expanded} aria-controls={expanded ? readingId : undefined} onClick={() => setOpen(expanded ? null : item.node.id)}>
                  <span className="goal-plan-node__mark" data-goal-plan-state={state} aria-hidden="true"><Icon size={12} strokeWidth={1.8} animation="none" /></span>
                  <span className="goal-plan-node__title">{item.node.title}</span>
                </button>
                <span className="goal-plan-node__state" {...(item.unknown.length ? { 'data-goal-plan-unknown': item.unknown.join(' ') } : {})}>{goalPlanStateLabel(item)}</span>
                {item.node.dependsOn.length ? <span className={`goal-plan-node__depends${item.state === 'waiting' ? ' goal-plan-node__depends--waiting' : ''}`}>
                  Depends on · <DependencyNames names={item.node.dependsOn.map(id => byId.get(id)!.node.title)} />
                </span> : null}
                <NodeExecutor item={item} />
              </li>
            })}
          </ol>
        </li>)}
      </ol>
    </div>
    {scrollable ? <p className="goal-plan__scroll-hint">Scroll to explore the full plan</p> : null}
    {selected ? <div className="goal-plan__reading" ref={reading} id={readingId}>
      <div className="goals-section-heading"><h3>{selected.node.title}</h3><button type="button" className="small-button" onClick={() => {
        canvas.current?.querySelector<HTMLButtonElement>(`[data-goal-plan-node="${CSS.escape(selected.node.id)}"] .goal-plan-node__head`)?.focus()
        setOpen(null)
      }}>Back to node</button></div>
      <NodeDetail key={selected.node.id} item={selected} dependencyNames={selected.node.dependsOn.map(id => byId.get(id)!.node.title)} onIssue={setIssue} />
    </div> : null}
  </section>
}

/** A compact ring for the Goal row: done over live nodes, from the owner's derivation. */
export function GoalPlanRing({ demand }: { demand: Pick<DemandProjection, 'plan' | 'planState' | 'delegations'> }) {
  const progress = useMemo(() => goalPlanProjection(demand)?.progress, [demand.plan, demand.planState, demand.delegations])
  if (!progress?.total) return null
  const circumference = 2 * Math.PI * 6, done = progress.done / progress.total
  return <span className="goal-plan-ring" data-goal-plan-ring={`${progress.done}/${progress.total}`} aria-label={`Plan ${progress.done} of ${progress.total} done`}>
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" className="goal-plan-ring__track" />
      <circle cx="8" cy="8" r="6" className="goal-plan-ring__done" strokeDasharray={`${circumference * done} ${circumference}`} transform="rotate(-90 8 8)" />
    </svg>
    <span>{progress.done}/{progress.total}</span>
  </span>
}
