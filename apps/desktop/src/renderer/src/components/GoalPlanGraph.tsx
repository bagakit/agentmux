import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { AgentMarkdown } from '@agentmux/client-ui/components/AgentMarkdown'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import type { GoalPlanNodeProjection } from '@agentmux/demand/goal-plan'
import { isCurrentGroundingAccepted } from '@agentmux/demand/goals'
import { Button } from '@agentmux/client-ui/components/Button'
import { demandAgentReferenceLabel, goalSupervisorHostWitnesses, type DemandAgentReference } from '@agentmux/demand/relations'
import { agentSessionPresentationIndex } from '../lib/session-presentation'
import { goalAgentPresentation } from '../lib/goal-agent-selection'
import { useGoalPlanPath } from './useGoalPlanPath'
import { goalPlanEdges, type GoalPlanBox, type GoalPlanEdge } from '../lib/goal-plan-routing'
export { goalPlanEdgePath } from '../lib/goal-plan-routing'
import { GoalPlanAssignment } from './GoalPlanAssignment'
import { AgentWorkModeBadge } from './AgentWorkModeBadge'
import { useAppStore } from '../store'
import type { DemandProjection, DemandRecord } from '../lib/global-demand-board'
import { useGoalAgentPresentation } from '../lib/goal-discussion-recipient'
import { GoalPlanReadingPlacement } from './GoalPlanReadingPlacement'
import { GoalPlanThread } from './GoalPlanThread'
import { delegationWorkerHostId, type DemandDelegation } from '@agentmux/demand/delegations'
import { GoalExecutionTimeline, type GoalTimelineOriginal } from './GoalExecutionTimeline'
import { GoalPlanDelivery, type GoalPlanReviewDraft } from './GoalPlanDelivery'
import { clearGoalPlanReviewDraft, editGoalPlanReviewDraft, goalPlanReviewDraftKey } from '../lib/goal-edit-drafts'
import { goalNextStepFact, type GoalNextStepFact } from '../lib/goal-presentation'
import { GoalPlanMark, goalPlanStateLabel, type GoalPlanNodePresentation } from './GoalPlanState'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { GoalContinuationAgent } from './GoalContinuationControl'
import { markWindowOverlayDismissal, wasWindowOverlayDismissed } from './WindowOverlayHost'

/** A node as its Goal owner derived it; `state` is null when the owner returned no derivation. */
export type GoalPlanReadingTarget = { nodeId: string; attemptId?: string; wholeGoal?: true; reviewOperationId?: string }
export type GoalPlanReveal = { target: GoalPlanReadingTarget; trigger?: HTMLButtonElement; restore?: () => void; restoreFocus?: () => void }
type GoalPlanSelection = GoalPlanReveal
export type GoalPlanNodeView = Omit<GoalPlanNodeProjection, 'state' | 'unknown' | 'predecessors' | 'claimBasis' | 'claimToken'> & GoalPlanNodePresentation & { team?: DemandAgentReference[]; teamRole?: 'Task target' | 'Executor'; targetOnly?: true; claimed?: true; claimable?: true }
/** A revision belongs to the saved breakdown. The whole Goal is revision-free. */
export type GoalPlanView = { revision: number | null; nodes: GoalPlanNodeView[]; next: string[]; progress: { done: number; total: number } | null }
export function goalPlanDeliveries(plan: GoalPlanView) {
  return plan.nodes.filter((item): item is GoalPlanNodeView & { delegation: DemandDelegation } => item.state === 'review' && Boolean(item.delegation?.report))
}
const ThemeObjectAgentIcon = semanticIconComponent('object.agent')
const StartIcon = semanticIconComponent('action.start')
const ForwardIcon = semanticIconComponent('navigation.forward')
const finishIcons = {
  Succeeded: semanticIconComponent('status.completed'),
  'Closed with gaps': semanticIconComponent('status.gap'),
  Unverified: semanticIconComponent('status.unknown'),
  Cancelled: semanticIconComponent('status.disabled'),
  Pending: semanticIconComponent('status.queued')
}

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
export function goalPlanProjection(demand: DemandRecord, nextStep?: GoalNextStepFact): GoalPlanView {
  const { plan, planState } = demand
  if (!plan?.nodes.length) {
    const fact = nextStep ?? goalNextStepFact(demand)
    const source = fact.source
    const confirmed = source.kind === 'start' ? demand.dispatches?.some(start => start.operationId === source.operationId && start.stage === 'confirmed') ||
      demand.startObservations?.some(observation => observation.operationId === source.operationId && observation.input.state === 'confirmed')
      : source.kind === 'delegation' && demand.delegations?.some(attempt => attempt.operationId === source.operationId && attempt.linkedAt !== undefined)
    const executor = (source.kind === 'start' || source.kind === 'delegation') && source.agentSessionId && source.hostId
      ? { agentSessionId: source.agentSessionId, hostId: source.hostId } : null
    return { revision: null, next: [], progress: null, nodes: [{
      node: { id: demand.id, title: demand.title, outcome: demand.alignment?.summary || demand.description,
        dependsOn: [], criterionIds: [], check: '', executor },
      wholeGoal: { conclusion: demand.status === 'cancelled' ? 'Cancelled' : source.kind === 'patrol' ? 'Whole goal' : fact.text, assignees: demand.assigneeSessionIds?.length ?? 0 },
      ...(executor && !confirmed ? { targetOnly: true as const } : {}),
      ...(source.kind === 'start' && source.agentReference ? { team: [source.agentReference], teamRole: confirmed ? 'Executor' as const : 'Task target' as const }
        : { team: demand.assigneeSessionIds ?? [] }),
      state: null, column: 0, delegation: null, attempts: 0, review: null, staleCriteria: [], unknown: []
    }] }
  }
  // A full plan revision can replace any executor. Only more recent, attributable claims identify a claimant.
  const claimed = new Map<string, { hostId?: string; id: string }>()
  for (const entry of plan.history) {
    if (!entry.change) claimed.clear()
    else if (entry.change.assignment.kind === 'claim') claimed.set(entry.change.nodeId, entry.author)
    else claimed.delete(entry.change.nodeId)
  }
  const claimSource = (node: GoalPlanNodeProjection['node']) => {
    const author = claimed.get(node.id)
    return author && author.hostId === node.executor?.hostId && author.id === node.executor?.agentSessionId ? { claimed: true as const } : {}
  }
  if (!planState) return { revision: plan.revision, next: [], progress: null,
    nodes: plan.nodes.map(node => ({ node, ...claimSource(node), state: null, column: 0, delegation: null, attempts: 0, review: null, staleCriteria: [], unknown: [] })) }
  const delegations = new Map((demand.delegations ?? []).map(item => [item.operationId, item]))
  return { revision: planState.revision, next: planState.next, progress: { done: planState.done, total: planState.total },
    nodes: planState.nodes.map((item, index) => {
      const delegation = item.attempt ? delegations.get(item.attempt.delegationOperationId) ?? null : null
      const review = delegation ? plan.reviews.filter(entry => entry.nodeId === item.id && entry.delegationOperationId === delegation.operationId).at(-1) ?? null : null
      return { node: plan.nodes[index]!, ...claimSource(plan.nodes[index]!),
        ...(plan.nodes[index]!.claimOpen && item.state === 'ready' && !item.attempt && demand.status !== 'done' && demand.status !== 'cancelled' ? { claimable: true as const } : {}), state: item.state, column: item.column, delegation, attempts: item.attempts, review, staleCriteria: item.staleCriteria, unknown: item.unknown }
    }) }
}

/**
 * Edges are measured from the rendered cards, so they follow wrapping titles and opened details.
 * Only this graph's own layout changes trigger a re-measure; no global listener is installed.
 */
function useEdges(root: React.RefObject<HTMLElement | null>, projection: GoalPlanView): { edges: GoalPlanEdge[]; width: number; height: number; scrollable: boolean } {
  const [state, setState] = useState<{ edges: GoalPlanEdge[]; width: number; height: number; scrollable: boolean }>({ edges: [], width: 0, height: 0, scrollable: false })
  useLayoutEffect(() => {
    const element = root.current
    if (!element) return
    const cards = element.querySelectorAll<HTMLElement>('[data-goal-plan-node]')
    const start = element.querySelector<HTMLElement>('[data-goal-plan-boundary="start"]')!
    const finish = element.querySelector<HTMLElement>('[data-goal-plan-boundary="finish"]')!
    const measure = () => {
      const box = element.getBoundingClientRect()
      const content = element.querySelector<HTMLOListElement>('.goal-plan__columns')!
      // Absolute SVG coordinates begin at the canvas padding edge, just inside its border.
      const offsetX = element.scrollLeft - box.left - element.clientLeft
      const offsetY = element.scrollTop - box.top - element.clientTop
      const anchor = (card: HTMLElement, column: number): GoalPlanBox => {
        const rect = card.getBoundingClientRect()
        return { left: rect.left + offsetX, right: rect.right + offsetX, top: rect.top + offsetY, bottom: rect.bottom + offsetY, column }
      }
      const byId = new Map([...cards].map(card => [card.dataset.goalPlanNode!, card]))
      const tasks = projection.nodes.map(({ node, column, state }) => ({
        id: node.id, dependsOn: node.dependsOn, live: state === 'ready' || state === 'changes', box: anchor(byId.get(node.id)!, column)
      }))
      const lastColumn = tasks.reduce((last, task) => Math.max(last, task.box.column), 0)
      const edges = goalPlanEdges(tasks, anchor(start, -1), anchor(finish, lastColumn + 1))
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
    observer.observe(start)
    observer.observe(finish)
    for (const card of cards) observer.observe(card)
    return () => observer.disconnect()
  }, [root, projection])
  return state
}

function TeamAssignment({ team, role = 'Assigned', compact = false }: { team: DemandAgentReference[]; role?: string | undefined; compact?: boolean }) {
  const first = team[0]!
  const session = useAppStore(state => typeof first === 'string'
    ? goalAgentPresentation(agentSessionPresentationIndex(state.sessions).get(first) ?? [], first) : undefined)
  const presentation = useGoalAgentPresentation(session?.control.agentSessionId, session?.control.hostId)
  const name = presentation.name ?? (typeof first === 'string' ? first : first.execution.agentSessionId)
  return <span className="goal-plan-node__who" title={`${role} · ${team.map(demandAgentReferenceLabel).join(', ')}`}><ThemeObjectAgentIcon size={11} aria-hidden="true" />
    {compact && role !== 'Executor' ? <span className="goal-plan-node__role">{role} ·</span> : null}
    <span className="goal-plan-node__name">{name}{team.length > 1 ? ` +${team.length - 1}` : ''}</span>{compact ? null : <span className="goal-node-assignment__qualifier">{role}</span>}</span>
}

function NodeExecutor({ item, compact = false }: { item: GoalPlanNodeView; compact?: boolean }) {
  const executor = item.delegation ? { hostId: delegationWorkerHostId(item.delegation), agentSessionId: item.delegation.workerAgentSessionId } : item.node.executor
  const presentation = useGoalAgentPresentation(executor?.agentSessionId, executor?.hostId)
  const hosts = useAppStore(state => state.config?.hosts)
  if (!executor) {
    if (item.team?.length) return <TeamAssignment team={item.team} role={item.teamRole ?? 'Assigned'} compact={compact} />
    const available = item.claimable
    return <span className="goal-plan-node__who goal-plan-node__who--open" data-claim-open={available || undefined}>{available ? 'Open to claim' : item.state === null ? 'Executor unconfirmed' : 'Unassigned'}</span>
  }
  const assignment = item.targetOnly || item.delegation && item.delegation.linkedAt === undefined ? 'Task target' :
    !item.wholeGoal && !item.delegation ? (item.claimed ? 'Claimed' : 'Assigned') : null
  const detail = assignment === 'Task target' ? 'Dispatch unconfirmed' : assignment ? `${assignment} · Awaiting dispatch` : null
  if (compact) return <span className="goal-plan-node__who" title={`${executor.agentSessionId} · ${executor.hostId}${detail ? ` · ${detail}` : ''}`}><ThemeObjectAgentIcon size={11} aria-hidden="true" />
    {assignment ? <span className="goal-plan-node__role">{assignment} ·</span> : null}
    <span className="goal-plan-node__name">{presentation.name ?? executor.agentSessionId}</span></span>
  const host = hosts?.find(host => host.id === executor.hostId)
  const toolsHost = presentation.toolExecution && hosts?.find(host => host.id === presentation.workPlacement?.resourceHostId)
  const place = presentation.toolExecution ? `Tools · ${toolsHost?.label ?? presentation.workPlacement?.resourceHostId ?? 'Host unknown'}`
    : presentation.hostId ? `${host?.kind === 'ssh' ? 'Remote' : 'Agent'} · ${host?.label ?? presentation.hostId}`
      : `Agent · ${host?.label ?? executor.hostId} · position unknown`
  return <span className="goal-plan-node__who" title={`${executor.agentSessionId} · ${executor.hostId}${presentation.toolExecution ? ` · ${presentation.toolExecution.workspacePath}` : ''}`}>
    <ThemeObjectAgentIcon size={11} aria-hidden="true" /><span className="goal-plan-node__name">{presentation.name ?? executor.agentSessionId}</span>{detail ? <span className="goal-node-assignment__qualifier">{detail}</span> : null}<AgentWorkModeBadge source={presentation.hostId && presentation.workspacePath ? {hostId: presentation.hostId, workspacePath: presentation.workspacePath, toolExecution: presentation.toolExecution ?? undefined, workPlacement: presentation.workPlacement} : undefined} hosts={hosts} embedded /><span className="goal-plan-node__place">{place}</span>
  </span>
}

function GoalPlanNodeButton({ item, expanded, readingId, dependencyNames, onToggle }: {
  item: GoalPlanNodeView; expanded: boolean; readingId: string; dependencyNames: string[]
  onToggle(trigger: HTMLButtonElement): void
}) {
  const description = useId()
  return <button type="button" className="goal-plan-node__head" aria-label={item.node.title} aria-describedby={description}
    data-goal-review-delivery={item.state === 'review' && item.delegation?.report ? item.node.id : undefined}
    aria-expanded={expanded} aria-controls={expanded ? readingId : undefined} onClick={event => onToggle(event.currentTarget)}>
    <span className="goal-plan-node__heading"><GoalPlanMark item={item} /><span className="goal-plan-node__title">{item.node.title}</span></span>
    <span className="goal-plan-node__metadata" id={description}>
      {!item.wholeGoal ? <span className="goal-plan-node__state" {...(item.unknown.length ? { 'data-goal-plan-unknown': item.unknown.join(' ') } : {})}>
        {item.state === 'ready' ? 'Ready' : item.state === 'waiting' ? 'Waiting' : goalPlanStateLabel(item)}</span> : null}
      <NodeExecutor item={item} compact />
    </span>
    {dependencyNames.length ? <span className={`goal-plan-node__depends${item.state === 'waiting' ? ' goal-plan-node__depends--waiting' : ''}`}>
      Depends on · <DependencyNames names={dependencyNames} />
    </span> : null}
  </button>
}

function DependencyNames({ names }: { names: string[] }) {
  return <>{names.map((name, index) => <Fragment key={index}>{index ? ', ' : ''}<span className="goal-plan-dependency">{name}</span></Fragment>)}</>
}

function NodeDetail({ demand, item, historical, dependencyNames, onIssue, draft, onDraft, previousDrafts, onReadGoal, onConfirmed, onOpenGoalWork }: { demand: DemandProjection; item: GoalPlanNodeView; historical: boolean; dependencyNames: string[];
  onOpenGoalWork?: (() => void) | undefined;
  onIssue(message: string | null): void; draft?: GoalPlanReviewDraft | undefined; onDraft(value: GoalPlanReviewDraft): void; previousDrafts: Readonly<Record<string, GoalPlanReviewDraft>>; onReadGoal(): void; onConfirmed(request: NonNullable<GoalPlanReviewDraft['request']>): void }) {
  const open = async (agentSessionId: string, hostId: string) => {
    try {
      onIssue(null)
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(),
        operation: 'focus', target: { kind: 'focus-agent', hostId, agentSessionId }, inputPolicy: 'preserve' })
      if (result.operation === 'focus' && result.navigation.state === 'rejected') onIssue(result.issues.map(issue => issue.message).join(' '))
    }
    catch (error) { onIssue(error instanceof Error ? error.message : String(error)) }
  }
  const facts = <dl className="goal-plan-node__facts">
      {item.wholeGoal ? <>
        {item.team?.length && !item.node.executor ? <div><dt>{item.teamRole ?? 'Goal team'}</dt><dd><TeamAssignment team={item.team} role={item.teamRole} />{item.teamRole !== 'Executor' ? ' · Executor unconfirmed' : ''}</dd></div> : null}
        <div><dt>Status</dt><dd>{item.wholeGoal.conclusion}</dd></div>
        {demand.alignment?.criteria.length ? <div><dt>Success criteria</dt><dd><ul>{demand.alignment.criteria.map(criterion => <li key={criterion.id}>{criterion.text}</li>)}</ul></dd></div> : null}
      </> : <div><dt>Check</dt><dd><code>{item.node.check}</code></dd></div>}
      {!item.delegation?.report && (item.delegation || item.node.executor) ? <div><dt>{item.targetOnly || item.delegation && item.delegation.linkedAt === undefined ? 'Task target' : item.wholeGoal || item.delegation ? 'Executor' : 'Assigned agent'}</dt><dd><NodeExecutor item={item} /></dd></div> : null}
      {dependencyNames.length ? <div><dt>Depends on</dt><dd title={item.node.dependsOn.join(', ')}><DependencyNames names={dependencyNames} /></dd></div> : null}
      {item.delegation ? <div><dt>Thread</dt><dd><code>{item.delegation.threadId}</code>{item.attempts > 1 ? ` · attempt ${item.attempts}` : ''}</dd></div> : null}
      {item.unknown.includes('criteria') ? <div><dt>Criteria</dt><dd className="goal-plan-node__stale">{item.staleCriteria.length
        ? `Changed or unavailable in the current goal: ${item.staleCriteria.join(', ')}` : 'Covers no success criterion of the current goal. Revise the plan to name what this node delivers.'}</dd></div> : null}
      {item.unknown.includes('dispatch-link') ? <div><dt>Delivery</dt><dd className="goal-plan-node__stale">The original delegation link is unconfirmed. Read its receipt before acting; it is never resent automatically.</dd></div> : null}
    </dl>
  const actions = item.delegation ? <div className="goal-plan-node__actions">
      <Button type="button" data-goal-plan-open="executor" onClick={() => void open(item.delegation!.workerAgentSessionId, delegationWorkerHostId(item.delegation!))}>Open executor</Button>
      <Button type="button" data-goal-plan-open="owner" onClick={() => void open(item.delegation!.ownerAgentSessionId, item.delegation!.hostId)}>Open owner</Button>
    </div> : null
  return <div className="goal-plan-node__detail" data-goal-plan-detail={item.node.id}>
    {item.node.outcome ? item.wholeGoal && !demand.alignment?.summary
      ? <div className="goals-intent__reading"><AgentMarkdown content={item.node.outcome} className="goals-intent__prose" readOnly /></div>
      : <p className="goal-plan-node__outcome">{item.node.outcome}</p> : null}
    {item.delegation?.report ? <GoalPlanDelivery key={item.delegation.operationId} demand={demand} item={item} historical={historical} author={<NodeExecutor item={item} />} context={<>{facts}{actions}</>} draft={draft} onDraft={onDraft} previousDrafts={previousDrafts} onReadGoal={onReadGoal} onConfirmed={onConfirmed} /> : <>
      {facts}{actions}
      {item.delegation ? <GoalPlanThread key={JSON.stringify([item.delegation.hostId, item.delegation.sourceMessageId])} delegation={item.delegation} /> : null}
    </>}
    {!item.wholeGoal && !historical && demand.plan ? <GoalPlanAssignment demand={demand} item={item} /> : null}
    {item.wholeGoal && onOpenGoalWork ? <div className="goal-plan-node__actions"><Button type="button" onClick={onOpenGoalWork}>View current work</Button></div> : null}
  </div>
}

/**
 * The plan reads left to right by dependency: each node sits one column past its deepest
 * dependency, joined to what it depends on by a smooth connector. State comes only from the
 * Goal owner's derivation; this view never decides it.
 */
export function GoalPlanGraph({ demand, projection: provided, planLink, planningLink, onOpenGoalWork, onOpenTimelineRecord, currentDelegation, reveal }: {
  demand: DemandProjection
  projection?: GoalPlanView; planLink?: ReactNode; onOpenGoalWork?: (() => void) | undefined
  onOpenTimelineRecord: (target: GoalTimelineOriginal, restoreFocus: () => void) => boolean
  currentDelegation?: DemandDelegation | undefined
  planningLink?: ReactNode; reveal?: GoalPlanReveal | null
}) {
  const projection = useMemo(() => provided ?? goalPlanProjection(demand), [demand, provided])
  const wholeGoal = projection.revision === null
  const firstDelivery = goalPlanDeliveries(projection)[0]
  const [selection, setSelection] = useState<GoalPlanSelection | null>()
  const defaultNode = firstDelivery?.node.id, defaultAttempt = firstDelivery?.delegation.operationId
  const selectedTarget = selection === undefined && defaultNode && defaultAttempt ? { nodeId: defaultNode, attemptId: defaultAttempt } : selection?.target
  const open = Boolean(selectedTarget && 'wholeGoal' in selectedTarget && selectedTarget.wholeGoal) === wholeGoal ? selectedTarget?.nodeId : undefined
  const [issue, setIssue] = useState<string | null>(null)
  const [readingState, setReadingState] = useState(false)
  const [showAssignments, setShowAssignments] = useState(false)
  const assignmentsId = useId()
  const retainedReviews = useAppStore(state => state.goalEditDrafts[demand.id]?.planReviews)
  const [reviewNotices, setReviewNotices] = useState<Record<string, Pick<GoalPlanReviewDraft, 'pending' | 'issue' | 'reread'>>>({})
  const canvas = useRef<HTMLDivElement>(null)
  const inlineReader = useRef<HTMLLIElement>(null), readingId = useId(), arrowId = useId()
  const readingHeading = useRef<HTMLHeadingElement>(null)
  const { edges, width, height, scrollable } = useEdges(canvas, projection)
  useGoalPlanPath(canvas, projection.nodes, edges, open)
  useLayoutEffect(() => {
    if (!reveal) return
    setSelection(current => {
      if (reveal.trigger || current?.target.nodeId !== reveal.target.nodeId || current.target.wholeGoal) return reveal
      const latest = projection.nodes.find(item => item.node.id === reveal.target.nodeId)?.delegation?.operationId
      // The same live reader keeps its placement and focused draft when opened by a link.
      return current.target.attemptId === undefined || current.target.attemptId === latest ? current : reveal
    })
  }, [reveal])
  useLayoutEffect(() => {
    // Retain the first automatic choice while its report becomes reviewed or new work arrives.
    if (defaultNode && defaultAttempt) setSelection(current => current === undefined ? { target: { nodeId: defaultNode, attemptId: defaultAttempt } } : current)
  }, [defaultNode, defaultAttempt])
  useLayoutEffect(() => {
    const viewport = canvas.current
    const card = open && viewport?.querySelector(`[data-goal-plan-node="${CSS.escape(open)}"]`)
    if ((!selection?.trigger && reveal?.target.nodeId !== open) || !viewport || !card) return
    const bounds = viewport.getBoundingClientRect(), selected = card.getBoundingClientRect()
    if (selected.bottom > bounds.bottom) viewport.scrollTop += selected.bottom - bounds.bottom
    else if (selected.top < bounds.top) viewport.scrollTop += selected.top - bounds.top
    if (selected.right > bounds.right) viewport.scrollLeft += selected.right - bounds.right
    else if (selected.left < bounds.left) viewport.scrollLeft += selected.left - bounds.left
  }, [open, selection, reveal])
  useLayoutEffect(() => {
    if (!selection?.trigger) return
    const heading = readingHeading.current
    const card = heading?.closest('.goal-plan-node__reader-slot')?.previousElementSibling
    if (card) card.scrollIntoView?.({ block: 'start' })
    else heading?.scrollIntoView?.({ block: 'nearest' })
    heading?.focus({ preventScroll: true })
  }, [selection])
  function supersedePendingTicketRead() {
    const pending = useAppStore.getState().goalReadingEntry
    if (pending?.goalId === demand.id && pending.phase === 'pending') useAppStore.setState({ goalReadingEntry: null })
  }
  function select(next: GoalPlanSelection) {
    supersedePendingTicketRead()
    setSelection(next)
  }
  function toggleNode(item: GoalPlanNodeView, trigger: HTMLButtonElement) {
    const attemptId = item.delegation?.operationId
    if (selection?.trigger && open === item.node.id && selection.target.attemptId === attemptId) closeNode(item.node.id)
    else select({ target: { nodeId: item.node.id, ...(attemptId ? { attemptId } : {}), ...(item.wholeGoal ? { wholeGoal: true } : {}) }, trigger })
  }
  function closeNode(id: string) {
    supersedePendingTicketRead()
    const target = selection?.trigger?.isConnected ? selection.trigger
      : canvas.current?.querySelector<HTMLButtonElement>(`[data-goal-plan-node="${CSS.escape(id)}"] .goal-plan-node__head`)
    if (selection?.restoreFocus) selection.restoreFocus()
    else if (target) {
      if (selection?.restore) { selection.restore(); requestAnimationFrame(() => target.focus()) }
      else target.focus()
    }
    setSelection(null)
  }
  async function readState() {
    setReadingState(true); setIssue(null)
    try { await useAppStore.getState().refreshDemand(demand.id) }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
    finally { setReadingState(false) }
  }
  const stateIssue = demand.planStateIssue ?? (!wholeGoal && !projection.progress
    ? "Node states are unavailable: this Goal's Host returned the plan without them. Read this Goal again; update that Host if the state remains unavailable. The plan itself is unchanged." : undefined)
  const stateService = stateIssue ? <p className="goals-service" role="status" data-goal-plan-states-unavailable>{stateIssue}{' '}
    <Button type="button" disabled={readingState} onClick={() => void readState()}>{readingState ? 'Reading Goal…' : 'Read Goal again'}</Button>
  </p> : null
  const columns = goalPlanColumns(projection), highlight = goalPlanHighlight(projection)
  const byId = new Map(projection.nodes.map(item => [item.node.id, item]))
  const selectedNode = open ? byId.get(open) : undefined
  const attemptId = open ? selectedTarget?.attemptId : undefined
  const attempts = selectedNode ? (demand.delegations ?? []).filter(attempt => attempt.planNodeId === selectedNode.node.id) : []
  const exact = attemptId ? attempts.find(attempt => attempt.operationId === attemptId) : undefined
  const historical = Boolean(attemptId && selectedNode?.delegation?.operationId !== attemptId)
  const selectedReviewId = open ? selectedTarget?.reviewOperationId : undefined
  const selectedReview = selectedReviewId && exact ? demand.plan?.reviews.find(review => review.operationId === selectedReviewId && review.nodeId === open && review.delegationOperationId === exact.operationId) : undefined
  const selectedAttempt = selectedNode && historical ? { ...selectedNode, state: null, delegation: exact ?? null,
    attempts: exact ? attempts.indexOf(exact) + 1 : 0, unknown: [], staleCriteria: [],
    review: exact ? demand.plan?.reviews.filter(entry => entry.nodeId === selectedNode.node.id && entry.delegationOperationId === exact.operationId).at(-1) ?? null : null }
    : selectedNode
  const selected = selectedAttempt && selectedReviewId ? { ...selectedAttempt, review: selectedReview ?? null } : selectedAttempt
  const handoff = selectedNode && !wholeGoal ? selected?.delegation : currentDelegation
  const handoffTitle = handoff?.planNodeId ? byId.get(handoff.planNodeId)?.node.title : demand.title
  const reviewKey = selected?.delegation && goalPlanReviewDraftKey(selected.node.id, selected.delegation.operationId)
  const reviewNoticeKey = JSON.stringify([demand.id, reviewKey])
  const { progress } = projection
  const accepted = isCurrentGroundingAccepted(demand.alignment, demand.grounding)
  const finishState = demand.status === 'cancelled' ? 'Cancelled' : demand.status !== 'done' ? 'Pending'
    : !accepted ? 'Unverified' : demand.grounding?.checks.some(check => check.outcome === 'gap') ? 'Closed with gaps' : 'Succeeded'
  const FinishIcon = finishIcons[finishState]
  return <section className={`goal-plan${wholeGoal || progress ? '' : ' goal-plan--unavailable'}`} aria-label="Goal plan" data-goal-plan-revision={projection.revision ?? undefined}>
    <div className="goals-section-heading">
      <div className="goal-plan__heading">
        <h2>Execution plan</h2>
        {!wholeGoal ? <span className="goals-caption" data-goal-plan-progress>Revision {projection.revision}</span> : null}
      </div>
      <div className="goal-plan__tools">
        {projection.nodes.length > 1 ? <Button type="button" className="goal-plan__assignment-toggle" aria-expanded={showAssignments} aria-controls={assignmentsId}
          onClick={() => setShowAssignments(value => !value)}>Assignments</Button> : null}
        {planLink}
        {planningLink}
      </div>
    </div>
    {stateService}
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
    {projection.nodes.length > 1 ? <div className="goal-plan__assignments" id={assignmentsId} hidden={!showAssignments}>
      <nav aria-label="Task assignments">
        {projection.nodes.map(item => <button key={item.node.id} type="button"
          aria-current={open === item.node.id ? 'true' : undefined} onClick={event => toggleNode(item, event.currentTarget)}>
          <GoalPlanMark item={item} /><strong>{item.node.title}</strong>
          <span className="goal-plan__assignment-fact"><NodeExecutor item={item} compact /><span>{goalPlanStateLabel(item)}</span></span>
        </button>)}
      </nav>
    </div> : null}
    <div className="goal-plan__workbench">
    <div className="goal-plan__stage">
    {handoff && handoffTitle !== undefined ? <GoalPlanHandoff demand={demand} attempt={handoff} task={handoffTitle} /> : null}
    <div className="goal-plan__canvas" data-single-task={projection.nodes.length === 1 || undefined} ref={canvas} tabIndex={0} aria-label="Execution graph">
      <svg className="goal-plan__edges" width={width} height={height} aria-hidden="true">
        <defs><marker id={arrowId} markerWidth="6" markerHeight="6" refX="6" refY="3" orient="auto" viewBox="0 0 6 6"><path d="M0 0 L6 3 L0 6 Z" fill="context-stroke" /></marker></defs>
        {edges.map(edge => <path key={JSON.stringify([edge.boundary, edge.from, edge.to])} d={edge.d} markerEnd={`url(#${arrowId})`}
          data-goal-edge-from={edge.from} data-goal-edge-to={edge.to}
          data-goal-plan-edge={edge.boundary ? undefined : `${edge.from}>${edge.to}`} data-goal-boundary-edge={edge.boundary}
          className={edge.live ? 'goal-plan__edge goal-plan__edge--live' : 'goal-plan__edge'} />)}
      </svg>
      <ol className="goal-plan__columns" style={{ '--goal-plan-columns': columns.length } as CSSProperties} data-single-column={columns.length === 1 || undefined}>
        <li className="goal-plan__boundary" data-goal-plan-boundary="start">
          <span className="goal-plan__boundary-mark"><StartIcon size={13} aria-hidden="true" /></span><strong>Start</strong>
        </li>
        {columns.map((column, index) => <li key={index} className="goal-plan__column" data-goal-plan-column={index}>
          {progress && !wholeGoal && (columns.length > 1 || column.length > 1) ? <div className="goal-plan__depth">
            <span>Level {index + 1}</span>{column.length > 1 ? <span>{column.length} tasks</span> : null}
          </div> : null}
          <ol className="goal-plan__nodes">
            {column.map(item => {
              const state = item.wholeGoal ? 'goal' : item.state ?? 'unavailable', expanded = open === item.node.id
              return <Fragment key={item.node.id}><li className={`goal-plan-node${!open && item.node.id === highlight ? ' goal-plan-node--next' : ''}`}
                data-goal-plan-node={item.node.id} data-goal-plan-origin={item.wholeGoal ? item.node.id : undefined} data-goal-plan-state={state} {...(item.node.dependsOn.length ? { 'data-goal-plan-depends': item.node.dependsOn.join(' ') } : {})}>
                <GoalPlanNodeButton item={item} expanded={expanded} readingId={readingId}
                  dependencyNames={item.node.dependsOn.map(id => byId.get(id)!.node.title)} onToggle={trigger => toggleNode(item, trigger)} />
              </li>
                {expanded && selection?.trigger ? <li ref={inlineReader} className="goal-plan-node__reader-slot" data-goal-reader-for={item.node.id} /> : null}
              </Fragment>
            })}
          </ol>
        </li>)}
        <li className="goal-plan__boundary" data-goal-plan-boundary="finish" data-goal-finish-state={finishState}>
          <span className="goal-plan__boundary-mark"><FinishIcon size={14} aria-hidden="true" /></span>
          <span className="goal-plan__boundary-label"><strong>Finish</strong><small>{finishState}</small></span>
        </li>
      </ol>
    </div>
    {scrollable ? <p className="goal-plan__scroll-hint">Scroll to explore the full plan</p> : null}
    {selected ? <GoalPlanReadingPlacement canvas={canvas} inline={inlineReader} target={selected.node.id} explicit={Boolean(selection?.trigger)}>
      <div className="goal-plan__reading" id={readingId} onKeyDown={event => {
        if (selection?.restoreFocus && event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented && !wasWindowOverlayDismissed(event.nativeEvent)) {
          markWindowOverlayDismissal(event.nativeEvent)
          event.stopPropagation()
          closeNode(selected.node.id)
        }
      }}>
      <div className="goal-plan__reading-header"><GoalPlanMark item={selected} /><h3 ref={readingHeading} tabIndex={-1}>{selected.node.title}</h3>
        {!historical && !selected.wholeGoal ? <span className="goal-plan__reading-status" data-goal-plan-state={selected.state ?? undefined}>{goalPlanStateLabel(selected)}</span> : null}
        <Button type="button" onClick={() => closeNode(selected.node.id)}>{selection?.restoreFocus ? 'Back to event' : 'Back to node'}</Button></div>
      {historical ? <p className="goals-caption" role={!exact ? 'status' : undefined}>{exact ? 'Previous attempt' : 'The selected original attempt is unavailable.'}</p> : null}
      {selectedReviewId && !selectedReview ? <p className="goals-caption" role="status">The selected original review is unavailable.</p> : null}
      {(!historical || exact) ? <NodeDetail key={JSON.stringify([demand.address?.runtimeId, demand.address?.namespace, demand.id, selected.node.id, attemptId])} demand={demand} item={selected} historical={historical} dependencyNames={selected.node.dependsOn.map(id => byId.get(id)!.node.title)} onIssue={setIssue} onOpenGoalWork={onOpenGoalWork}
        draft={reviewKey && retainedReviews?.[reviewKey] ? { ...retainedReviews[reviewKey], ...reviewNotices[reviewNoticeKey] } : undefined} onDraft={value => {
          editGoalPlanReviewDraft(demand.id, selected.node.id, selected.delegation!.operationId, value)
          const { pending, issue, reread } = value
          setReviewNotices(previous => ({ ...previous, [reviewNoticeKey]: { pending, issue, reread } }))
        }}
        previousDrafts={Object.fromEntries((demand.delegations ?? []).filter(attempt => attempt.planNodeId === selected.node.id).flatMap(attempt => {
          const draft = retainedReviews?.[goalPlanReviewDraftKey(selected.node.id, attempt.operationId)]
          return draft ? [[attempt.operationId, draft]] : []
        }))} onReadGoal={() => void readState()} onConfirmed={request => {
          clearGoalPlanReviewDraft(request.goalId, request.review.nodeId, request.review.delegationOperationId, request.review.operationId)
          setReviewNotices(previous => { if (!previous[reviewNoticeKey]) return previous; const { [reviewNoticeKey]: _notice, ...retained } = previous; return retained })
        }} /> : null}
    </div></GoalPlanReadingPlacement> : null}
    <GoalExecutionTimeline demand={demand} nodes={projection.nodes} selected={open ? selectedTarget ?? null : null} onSelect={select} onOpenRecord={onOpenTimelineRecord} />
    </div>
    </div>
  </section>
}

/** The arrow describes one recorded handoff, independently of the plan's task dependencies. */
function GoalPlanHandoff({ demand, attempt, task }: { demand: DemandProjection; attempt: DemandDelegation; task: string }) {
  const active = useWorkbenchPresentationActive()
  const workerHost = delegationWorkerHostId(attempt)
  if (attempt.ownerAgentSessionId === attempt.workerAgentSessionId && attempt.hostId === workerHost) return null

  const supervisor = demand.supervisorSessionId
  const hosts = typeof supervisor === 'string' && supervisor === attempt.ownerAgentSessionId ? goalSupervisorHostWitnesses(demand) : []
  const isSupervisor = typeof supervisor === 'string' ? hosts.length === 1 && hosts[0] === attempt.hostId
    : supervisor?.execution.agentSessionId === attempt.ownerAgentSessionId && supervisor.execution.runtimeId === attempt.runtimeIdentity?.ownerRuntimeId
  const owner = { id: attempt.ownerAgentSessionId, host: attempt.hostId, role: isSupervisor ? 'Supervisor' : 'Task owner' }
  const worker = { id: attempt.workerAgentSessionId, host: workerHost, role: 'Executor' }
  const reported = attempt.report?.authorAgentSessionId === worker.id
  const phase = reported ? 'Delivery reported' : attempt.linkedAt !== undefined ? 'Dispatch linked' : 'Dispatch prepared'
  const [from, to] = reported ? [worker, owner] : [owner, worker]
  const participant = (actor: typeof owner) => <div className="goal-plan-handoff__agent">
    <small>{actor.role}</small>
    <GoalContinuationAgent agentSessionId={actor.id} hostId={actor.host} active={active} size={18} />
  </div>
  return <aside className="goal-plan-handoff" aria-label="Task handoff" data-goal-handoff={attempt.operationId}>
    <span className="goal-plan-handoff__task" title={task}>{task}</span>
    <div className="goal-plan-handoff__flow">
      {participant(from)}
      <span className="goal-plan-handoff__transfer">
        <span>{phase}<span className="goals-visually-hidden"> to</span></span><ForwardIcon size={13} aria-hidden="true" />
      </span>
      {participant(to)}
    </div>
  </aside>
}

/** A compact ring for the Goal row: done over live nodes, from the owner's derivation. */
export function GoalPlanRing({ demand }: { demand: Pick<DemandProjection, 'plan' | 'planState'> }) {
  const progress = demand.plan ? demand.planState : undefined
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
