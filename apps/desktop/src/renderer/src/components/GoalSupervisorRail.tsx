import { useMemo, useState } from 'react'
import { compactReferenceId } from '@agentmux/client-ui/display-name'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { demandAgentReferenceLabel, goalSupervisorHostWitnesses } from '@agentmux/demand/relations'
import { delegationWorkerHostId, type DemandDelegation } from '@agentmux/demand/delegations'
import type { GoalPlanReviewer } from '@agentmux/demand/goal-plan'
import { Button } from '@agentmux/client-ui/components/Button'
import type { DemandProjection } from '../lib/global-demand-board'
import { useGoalAgentName } from '../lib/goal-discussion-recipient'
import { useWorkbenchPresentationActive } from '../lib/workbench-presentation'
import { GoalContinuationAgent } from './GoalContinuationControl'
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

/** A reading rail over the Goal owner's existing records. It performs no Agent or Goal writes. */
export function GoalSupervisorRail({ demand, currentDelivery, onOpenDiscussion, discussionBusy = false, onRevealAttempt }: {
  demand: DemandProjection
  currentDelivery?: AttemptTarget | undefined
  onOpenDiscussion?: (() => void) | undefined
  discussionBusy?: boolean
  onRevealAttempt(nodeId: string, operationId: string, trigger: HTMLButtonElement): void
}) {
  const active = useWorkbenchPresentationActive()
  const [all, setAll] = useState(false)
  const entries = useMemo(() => coordinationEntries(demand), [demand.plan, demand.delegations, demand.patrols, demand.decisions])
  const supervisor = demand.supervisorSessionId, hosts = goalSupervisorHostWitnesses(demand)
  const rows = demand.responsibility?.executions ?? []
  const next = rows.find(row => row.nextOwner.kind === 'manager' && row.alert !== null)
    ?? rows.find(row => row.nextOwner.kind === 'manager' && row.phase !== 'closed')
    ?? rows.find(row => row.alert !== null) ?? rows.find(row => row.phase !== 'closed')
  const nextOwner = next ? { manager: 'Supervisor', worker: 'Executor', human: 'Human', external: 'External' }[next.nextOwner.kind] : undefined
  const shown = all ? entries : entries.slice(0, RECENT)
  return <section className="goal-supervisor-rail" aria-label="Goal Supervisor" data-goal-supervisor-rail={demand.id}>
    <header className="goal-supervisor-rail__heading"><h2><SupervisorIcon size={17} aria-hidden="true" />Supervisor</h2></header>
    <div className="goal-supervisor-rail__identity">
      {supervisor ? typeof supervisor !== 'string' || hosts.length === 1
        ? <GoalContinuationAgent agentSessionId={supervisor} {...(typeof supervisor === 'string' ? { hostId: hosts[0]! } : {})} active={active} size={32} />
        : <strong title={demandAgentReferenceLabel(supervisor)}>Session {compactReferenceId(supervisor)}</strong>
        : <strong>No Supervisor assigned</strong>}
    </div>
    {typeof supervisor === 'string' ? <p className="goal-supervisor-rail__source">{hosts.length === 1 ? `Host ${hosts[0]}` : hosts.length ? 'Supervisor Host is conflicting' : 'Supervisor Host is unconfirmed'}</p> : null}
    {demand.responsibility && !['available', 'busy'].includes(demand.responsibility.supervisor.state) ? <p className="goal-supervisor-rail__issue" role="status">{demand.responsibility.supervisor.reason}</p> : null}
    {currentDelivery ? <button type="button" className="goal-supervisor-rail__review" onClick={event => onRevealAttempt(currentDelivery.nodeId, currentDelivery.operationId, event.currentTarget)}>
      <ReviewIcon size={16} aria-hidden="true" /><span>Awaiting review<small>{currentDelivery.title}</small></span><ForwardIcon size={14} aria-hidden="true" />
    </button> : null}
    {next && next.execution.operationId !== currentDelivery?.operationId ? <div className="goal-supervisor-rail__next" data-goal-supervisor-next={next.execution.operationId}>
      <span>Next · {nextOwner}</span><p>{next.nextOwner.action}</p>
    </div> : !currentDelivery ? <p className="goal-supervisor-rail__empty">{demand.responsibility ? 'No open execution responsibility recorded.' : 'Execution responsibility has not been observed.'}</p> : null}
    {demand.delegationObservationIssue ? <p className="goal-supervisor-rail__issue" role="status">{demand.delegationObservationIssue}</p> : null}
    {onOpenDiscussion ? <Button type="button" className="goal-supervisor-rail__discussion" disabled={discussionBusy} onClick={onOpenDiscussion}><DiscussionIcon size={13} aria-hidden="true" />Open goal discussion</Button> : null}
    <section className="goal-supervisor-rail__coordination" aria-label="Coordination history">
      <h3>Coordination timeline</h3>
      {entries.length ? <ol className="goal-supervisor-rail__timeline">{shown.map(entry => <li key={entry.key} data-goal-coordination={entry.key}>
        <strong className="goal-supervisor-rail__event-title">{entry.label}</strong>
        <div className="goal-supervisor-rail__event-head"><time dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString()}>{coordinationTime.format(entry.at)}</time><span aria-hidden="true">·</span>
          {entry.author?.kind === 'agent' && entry.author.hostId ? <CoordinationAgentAuthor author={entry.author} />
            : <span className="goal-supervisor-rail__author">{authorLabel(entry.author)}</span>}</div>
        {entry.attempt ? <button type="button" className="goal-supervisor-rail__attempt" data-goal-coordination-node={entry.attempt.nodeId} data-goal-coordination-attempt={entry.attempt.operationId}
          aria-label={`Read ${entry.attempt.title} · ${entry.label}`} onClick={event => onRevealAttempt(entry.attempt!.nodeId, entry.attempt!.operationId, event.currentTarget)}>{entry.attempt.title}<span aria-hidden="true">↗</span></button> : null}
        {entry.detail ? <details className="goal-supervisor-rail__detail"><summary>Read record</summary><p>{entry.detail}</p></details> : null}
        <span className="goal-supervisor-rail__operation" title={`${entry.sourceKind} ${entry.sourceId}`} aria-label={`${entry.sourceKind} ${entry.sourceId}`}>{entry.sourceKind} · <code>{compactReferenceId(entry.sourceId)}</code></span>
      </li>)}</ol> : <p className="goal-supervisor-rail__empty">No coordination records yet.</p>}
      {entries.length > RECENT ? <Button type="button" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show recent only' : `Show ${entries.length - RECENT} earlier`}</Button> : null}
    </section>
  </section>
}
