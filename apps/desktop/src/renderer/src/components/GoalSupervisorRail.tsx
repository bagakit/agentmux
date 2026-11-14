import { useMemo, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { demandAgentReferenceLabel, goalSupervisorHostWitnesses } from '@agentmux/demand/relations'
import { delegationWorkerHostId, type DemandDelegation } from '@agentmux/demand/delegations'
import type { GoalPlanReviewer } from '@agentmux/demand/goal-plan'
import { Button } from '@agentmux/client-ui/components/Button'
import type { DemandProjection } from '../lib/global-demand-board'
import { useGoalAgentName } from '../lib/goal-discussion-recipient'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { GoalPatrolControl } from './GoalPatrolControl'
import { GoalContinuationAgent, GoalContinuationControl } from './GoalContinuationControl'
import '../styles/goal-supervisor-rail.css'

const DiscussionIcon = semanticIconComponent('object.conversation')
const SupervisorIcon = semanticIconComponent('object.workflow')
const ReviewIcon = semanticIconComponent('action.review-source')
const ForwardIcon = semanticIconComponent('navigation.forward')
const RECENT = 6
const coordinationTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
type RecordedAuthor = GoalPlanReviewer | { kind: 'recorded'; id: string }
type AttemptTarget = { nodeId: string; operationId: string; title: string }
type CoordinationEntry = {
  key: string; at: number; label: string; author: RecordedAuthor | null; sourceId: string
  sourceKind: 'Operation' | 'Record'; detail?: string | undefined; attempt?: AttemptTarget | undefined
}

function authorLabel(author: RecordedAuthor | null): string {
  if (!author) return 'Author not recorded'
  const role = { agent: 'Agent', user: 'User', device: 'Device', recorded: 'Recorded actor' }[author.kind]
  return `${role} ${author.id}${'hostId' in author && author.hostId ? ` · Host ${author.hostId}` : ''}${'runtimeId' in author && author.runtimeId ? ` · Runtime ${author.runtimeId}` : ''}`
}

function CoordinationAgentAuthor({ author }: { author: GoalPlanReviewer }) {
  const name = useGoalAgentName(author.id, author.hostId)
  const original = authorLabel(author)
  return <span className="goal-supervisor-rail__author" title={original}>{name ?? original}</span>
}

/** Original records provide authors and times; this reader never attributes them to today's Supervisor. */
function coordinationEntries(demand: DemandProjection): CoordinationEntry[] {
  const nodes = new Map(demand.plan?.nodes.map(node => [node.id, node]) ?? [])
  const attempts = new Map<string, DemandDelegation | null>()
  for (const delegation of demand.delegations ?? []) attempts.set(delegation.operationId, attempts.has(delegation.operationId) ? null : delegation)
  const target = (nodeId: string | undefined, operationId: string): AttemptTarget | undefined => {
    const node = nodeId ? nodes.get(nodeId) : undefined, delegation = attempts.get(operationId)
    return node && delegation?.planNodeId === node.id ? { nodeId: node.id, operationId, title: node.title } : undefined
  }
  const entries: CoordinationEntry[] = []
  for (const revision of demand.plan?.history ?? []) entries.push({ key: `plan:${revision.operationId}`, at: revision.revisedAt,
    label: `Plan revised · revision ${revision.revision}`, author: revision.author, sourceKind: 'Operation', sourceId: revision.operationId })
  for (const review of demand.plan?.reviews ?? []) entries.push({ key: `review:${review.operationId}`, at: review.reviewedAt,
    label: review.verdict === 'pass' ? 'Review passed' : 'Changes requested', author: review.reviewer, sourceKind: 'Operation', sourceId: review.operationId,
    attempt: target(review.nodeId, review.delegationOperationId) })
  for (const delegation of demand.delegations ?? []) {
    const attempt = target(delegation.planNodeId, delegation.operationId)
    const owner: GoalPlanReviewer = { kind: 'agent', id: delegation.ownerAgentSessionId, hostId: delegation.hostId,
      ...(delegation.runtimeIdentity ? { runtimeId: delegation.runtimeIdentity.ownerRuntimeId } : {}) }
    entries.push({ key: `delegation:${delegation.operationId}`, at: delegation.preparedAt, label: 'Work prepared', author: owner,
      sourceKind: 'Operation', sourceId: delegation.operationId, attempt })
    if (delegation.report) {
      const report = delegation.report, worker = report.authorAgentSessionId === delegation.workerAgentSessionId
      entries.push({ key: `report:${delegation.operationId}`, at: report.submittedAt, label: 'Delivery reported',
        author: { kind: 'agent', id: report.authorAgentSessionId, ...(worker ? { hostId: delegationWorkerHostId(delegation) } : {}),
          ...(worker && delegation.runtimeIdentity ? { runtimeId: delegation.runtimeIdentity.workerRuntimeId } : {}) },
        sourceKind: 'Operation', sourceId: report.operationId, attempt })
    }
    if (delegation.collection) entries.push({ key: `collection:${delegation.operationId}`, at: delegation.collection.collectedAt,
      label: 'Report collected', author: delegation.collection.collector, sourceKind: 'Operation', sourceId: delegation.collection.operationId, attempt })
  }
  for (const patrol of demand.patrols ?? []) {
    entries.push({ key: `patrol:${patrol.operationId}`, at: patrol.requestedAt, label: patrol.purpose === 'plan' ? 'Plan requested' : 'Inspection requested',
      author: patrol.requestedBy, sourceKind: 'Operation', sourceId: patrol.operationId })
    if (patrol.report) entries.push({ key: `patrol-report:${patrol.operationId}`, at: patrol.report.reportedAt,
      label: patrol.report.applied ? 'Inspection recorded' : 'Inspection reported · not applied',
      author: { kind: 'agent', id: patrol.report.authorAgentSessionId }, sourceKind: 'Operation', sourceId: patrol.report.operationId,
      detail: patrol.report.summary })
  }
  for (const decision of demand.decisions ?? []) entries.push({ key: `decision:${decision.id}`, at: decision.createdAt, label: 'Decision recorded',
    author: decision.actorId ? { kind: 'recorded', id: decision.actorId } : null, sourceKind: 'Record', sourceId: decision.id,
    detail: [decision.question && `Question: ${decision.question}`, decision.decision, decision.rationale && `Rationale: ${decision.rationale}`].filter(Boolean).join('\n\n') })
  return entries.sort((left, right) => right.at - left.at)
}

/** A workbench over the Goal owner's records and explicit actions. */
export function GoalSupervisorRail({ demand, onChooseSupervisor, onAddAssignee, planning, inspectionIsCurrent = false, currentDelivery, onOpenDiscussion, discussionBusy = false, onRevealAttempt }: {
  demand: DemandProjection
  onChooseSupervisor?: () => void
  onAddAssignee?: () => void
  planning?: ReactNode
  inspectionIsCurrent?: boolean
  currentDelivery?: AttemptTarget | undefined
  onOpenDiscussion?: (() => void) | undefined
  discussionBusy?: boolean
  onRevealAttempt(nodeId: string, operationId: string, trigger: HTMLButtonElement): void
}) {
  const active = useWorkbenchPresentationActive()
  const [progressOpened, setProgressOpened] = useState(false)
  const [all, setAll] = useState(false)
  const entries = useMemo(() => coordinationEntries(demand), [demand.plan, demand.delegations, demand.patrols, demand.decisions])
  const supervisor = demand.supervisorSessionId, hosts = goalSupervisorHostWitnesses(demand)
  const observation = demand.responsibility?.supervisor
  const diagnostic = observation && { ended: 'Supervisor Run ended', blocked: 'Supervisor needs attention', unknown: 'Supervisor observation unconfirmed', missing: 'Supervisor unassigned', available: '', busy: '' }[observation.state]
  const hostUnconfirmed = typeof supervisor === 'string' && hosts.length !== 1
  const showDiagnostic = diagnostic && (supervisor || observation?.state !== 'missing') && !(hostUnconfirmed && observation?.state === 'unknown')
  const rows = demand.responsibility?.executions ?? []
  const next = rows.find(row => row.nextOwner.kind === 'manager' && row.alert !== null)
    ?? rows.find(row => row.nextOwner.kind === 'manager' && row.phase !== 'closed')
    ?? rows.find(row => row.alert !== null) ?? rows.find(row => row.phase !== 'closed')
  const nextOwner = next ? { manager: 'Supervisor', worker: 'Executor', human: 'Human', external: 'External' }[next.nextOwner.kind] : undefined
  const needsAssignee = !supervisor && !demand.assigneeSessionIds?.length
  const editProgressSupervisor = needsAssignee ? onAddAssignee : onChooseSupervisor
  const shown = all ? entries : entries.slice(0, RECENT)
  return <section className="goal-supervisor-rail" aria-label="Goal Supervisor" data-goal-supervisor-rail={demand.id}>
    <header className="goal-supervisor-rail__heading"><h2><SupervisorIcon size={17} aria-hidden="true" />Supervisor</h2></header>
    <div className="goal-supervisor-rail__identity">
      <div className="goal-supervisor-rail__person">{supervisor ? typeof supervisor !== 'string' || hosts.length === 1
        ? <GoalContinuationAgent agentSessionId={supervisor} {...(typeof supervisor === 'string' ? { hostId: hosts[0]! } : {})} active={active} size={32} />
        : <strong title={demandAgentReferenceLabel(supervisor)}>{hosts.length ? 'Supervisor Host is conflicting' : 'Supervisor Host is unconfirmed'}</strong>
        : <strong>No Supervisor assigned</strong>}</div>
      {needsAssignee && onAddAssignee
        ? <Button type="button" className="goal-supervisor-rail__assign" onClick={onAddAssignee}>Add assignee</Button>
        : onChooseSupervisor ? <Button type="button" className="goal-supervisor-rail__assign" onClick={onChooseSupervisor}>
          {typeof supervisor === 'string' && hosts.length !== 1 ? 'Choose Supervisor' : <>{supervisor ? 'Change' : 'Assign'}<span className="goals-visually-hidden"> Supervisor</span></>}
        </Button> : null}
    </div>
    {showDiagnostic ? <p className="goal-supervisor-rail__issue" role="status">{diagnostic}</p> : null}
    {currentDelivery ? <button type="button" className="goal-supervisor-rail__review" onClick={event => onRevealAttempt(currentDelivery.nodeId, currentDelivery.operationId, event.currentTarget)}>
      <ReviewIcon size={16} aria-hidden="true" /><span>Awaiting review<small>{currentDelivery.title}</small></span><ForwardIcon size={14} aria-hidden="true" />
    </button> : null}
    {next && next.execution.operationId !== currentDelivery?.operationId ? <div className="goal-supervisor-rail__next" data-goal-supervisor-next={next.execution.operationId}>
      <span>{next.nextOwner.kind === 'manager' ? 'Supervisor’s next step' : `Waiting on · ${nextOwner}`}</span><p>{next.nextOwner.action}</p>
    </div> : !currentDelivery && (rows.length || demand.dispatches?.length || demand.delegations?.length) ? <p className="goal-supervisor-rail__empty">{demand.responsibility ? 'No open execution responsibility recorded.' : 'Current execution responsibility is unconfirmed.'}</p> : null}
    <GoalPatrolControl demand={demand} embedded primary={inspectionIsCurrent} />
    {planning}
    <details className="goal-supervisor-rail__progress" onToggle={event => { if (event.target === event.currentTarget && event.currentTarget.open) setProgressOpened(true) }}>
      <summary>Progress settings</summary>
      {progressOpened ? <GoalContinuationControl demand={demand} active={active}
        {...(editProgressSupervisor ? { onChooseSupervisor: editProgressSupervisor } : {})} /> : null}
    </details>
    {demand.delegationObservationIssue ? <p className="goal-supervisor-rail__issue" role="status">{demand.delegationObservationIssue}</p> : null}
    {onOpenDiscussion ? <Button type="button" className="goal-supervisor-rail__discussion" disabled={discussionBusy} onClick={onOpenDiscussion}><DiscussionIcon size={13} aria-hidden="true" />Open goal discussion</Button> : null}
    {typeof supervisor === 'string' || diagnostic ? <details className="goal-supervisor-rail__detail" data-goal-supervisor-source>
      <summary>Supervisor source</summary>
      {typeof supervisor === 'string' ? <p className="goal-supervisor-rail__source">{hosts.length === 1 ? `Host ${hosts[0]}` : hosts.length ? 'Supervisor Host is conflicting' : 'Supervisor Host is unconfirmed'} · Session {supervisor}</p> : null}
      {diagnostic ? <p>{observation?.reason}</p> : null}
    </details> : null}
    {entries.length ? <section className="goal-supervisor-rail__coordination" aria-label="Coordination history">
      <h3>Coordination timeline</h3>
      <ol className="goal-supervisor-rail__timeline">{shown.map(entry => <li key={entry.key} data-goal-coordination={entry.key}>
        <details className="goal-supervisor-rail__detail goal-supervisor-rail__record">
          <summary><strong className="goal-supervisor-rail__event-title">{entry.label}</strong></summary>
          {entry.detail ? <p>{entry.detail}</p> : null}
          <span className="goal-supervisor-rail__operation">{entry.sourceKind} · <code>{entry.sourceId}</code></span>
        </details>
        <div className="goal-supervisor-rail__event-head"><time dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString()}>{coordinationTime.format(entry.at)}</time><span aria-hidden="true">·</span>
          {entry.author?.kind === 'agent' && entry.author.hostId ? <CoordinationAgentAuthor author={entry.author} />
            : <span className="goal-supervisor-rail__author">{authorLabel(entry.author)}</span>}</div>
        {entry.attempt ? <button type="button" className="goal-supervisor-rail__attempt" data-goal-coordination-node={entry.attempt.nodeId} data-goal-coordination-attempt={entry.attempt.operationId}
          aria-label={`Read ${entry.attempt.title} · ${entry.label}`} onClick={event => onRevealAttempt(entry.attempt!.nodeId, entry.attempt!.operationId, event.currentTarget)}>{entry.attempt.title}<span aria-hidden="true">↗</span></button> : null}

      </li>)}</ol>
      {entries.length > RECENT ? <Button type="button" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show recent only' : `Show ${entries.length - RECENT} earlier`}</Button> : null}
    </section> : null}
  </section>
}
