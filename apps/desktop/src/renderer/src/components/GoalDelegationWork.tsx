import { Button } from '@agentmux/client-ui/components/Button'
import { GoalEvidence } from './GoalEvidence'
import { mintObjectId } from '@agentmux/core/object-id'
import { useRef, useState, Fragment, type ReactNode } from 'react'
import { delegationWorkerHostId } from '@agentmux/demand/delegations'
import { demandAgentReferenceLabel, goalSupervisorHostWitnesses } from '@agentmux/demand/relations'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { api } from '../lib/api'
import type { DemandRecord } from '../lib/global-demand-board'
import { goalDelegationRows } from '../lib/goal-delegation-presentation'
import { goalStartRows } from '../lib/goal-start-presentation'
import { GoalRequestReader } from './GoalRequestReader'
import { GoalStartWork } from './GoalStartWork'
import type { GoalNextStepSource } from '../lib/goal-presentation'
import { GoalExecutionResponsibility, GoalResponsibilitySummary } from './GoalResponsibilitySummary'
import { GoalContinuationAgent } from './GoalContinuationControl'
import { applyGoalDelegationResult, beginGoalDelegationRead, refreshGoalDelegations, useGoalDelegationObservation } from '../lib/goal-delegation-work'
import { useAppStore } from '../store'

/** Same original Goal reports and actions in Goal details and a Mote's current work. */
export function GoalDelegationWork({ demand, active = true, compact = false, embedded = false, primary = true, focus, beforeRecords, afterRecords, overview, onRevealResults }: {
  demand: DemandRecord; active?: boolean; compact?: boolean; embedded?: boolean; primary?: boolean; focus?: GoalNextStepSource | undefined; beforeRecords?: ReactNode; afterRecords?: ReactNode; overview?: ReactNode; onRevealResults?: (() => void) | undefined
}) {
  const current = useAppStore(state => active ? state.demands[demand.id] ?? demand : demand)
  useGoalDelegationObservation(current, active)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set()), [issue, setIssue] = useState<string | null>(null)
  const collecting = useRef(new Set<string>())
  const rows = goalDelegationRows(current)
  const starts = goalStartRows(current)
  const supervisorHosts = goalSupervisorHostWitnesses(current)
  const supervisorHost = supervisorHosts.length === 1 ? supervisorHosts[0] : undefined
  const represented = new Set([...starts.map(row => `start:${row.start.operationId}`), ...rows.map(row => `delegation:${row.delegation.operationId}`)])
  const responsibilities = new Map(current.responsibility?.executions.map(row => [`${row.execution.kind}:${row.execution.operationId}`, row]))
  if (compact || !embedded && !rows.length && !starts.length) return <GoalResponsibilitySummary demand={current} compact={compact} active={active} />
  async function refresh() {
    await refreshGoalDelegations(demand.id)
    if (!useAppStore.getState().demands[demand.id]?.delegationObservationIssue) setIssue(null)
  }
  async function collect(operationId: string, replyMessageId: string) {
    if (collecting.current.has(operationId)) return
    const source = useAppStore.getState().demands[demand.id]
    const original = source?.delegations?.find(item => item.operationId === operationId)
    const report = original?.report ?? source?.delegationObservations?.find(item => item.operationId === operationId)?.recoverableReport
    if (!original || report?.replyMessageId !== replyMessageId || original.collection) {
      setIssue('The original report changed. Refresh this Goal before collecting.'); return
    }
    // Stable identity for this original report, including a lost receipt or Renderer restart.
    const collectionOperationId = `goal-collect:${demand.id}:${operationId}:${replyMessageId}`
    collecting.current.add(operationId); setBusy(new Set(collecting.current))
    const request = beginGoalDelegationRead()
    try {
      const result = await api.demands.delegation('goal.collect', { goalId: demand.id, operationId,
        collection: { operationId: collectionOperationId, replyMessageId } })
      applyGoalDelegationResult(result, request); setIssue(null)
    } catch (error) {
      setIssue('Collection is unconfirmed. Keep this original report and check its receipt. ' + (error instanceof Error ? error.message : String(error)))
    } finally {
      collecting.current.delete(operationId); setBusy(new Set(collecting.current)); await refreshGoalDelegations(demand.id)
      const confirmed = useAppStore.getState().demands[demand.id]?.delegations?.find(item => item.operationId === operationId)?.collection
      if (confirmed?.operationId === collectionOperationId && confirmed.replyMessageId === replyMessageId) setIssue(null)
    }
  }
  async function openAgent(agentSessionId: string, hostId = 'local') {
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(),
        operation: 'focus', target: { kind: 'focus-agent', hostId, agentSessionId }, inputPolicy: 'preserve' })
      if (result.operation === 'focus' && result.navigation.state === 'rejected') setIssue(result.issues.map(item => item.message).join(' '))
    }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  async function review() {
    if (onRevealResults) { onRevealResults(); return }
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: mintObjectId(), operation: 'focus', target: { kind: 'goal', goalId: demand.id }, inputPolicy: 'preserve' })
      if (result.operation === 'focus' && result.navigation.state === 'rejected') setIssue(result.issues.map(item => item.message).join(' '))
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  const startRecords = starts.map(row => ({ key: `start:${row.start.operationId}`, element: <GoalStartWork key={row.start.operationId} rows={[row]} supervisorSessionId={current.supervisorSessionId} active={active} openAgent={openAgent} review={review} embedded={embedded} responsibilities={embedded ? responsibilities : undefined} focus={focus} primary={primary} /> }))
  const planTitles = new Map(current.plan?.nodes.map(node => [node.id, node.title]))
  const delegationRecords = rows.map(row => ({ key: `delegation:${row.delegation.operationId}`, element: <article className="goal-delegation__item" key={row.delegation.operationId} tabIndex={-1} aria-label={row.next} data-goal-work-operation={row.delegation.operationId} data-goal-work-kind="delegation" data-goal-attempt={row.previousAttempt ? 'previous' : undefined}>
      {embedded && row.delegation.planNodeId && planTitles.has(row.delegation.planNodeId) ? <p className="goal-work-area__plan-task" data-goal-work-node={row.delegation.planNodeId}>
        Plan task · {planTitles.get(row.delegation.planNodeId)}
      </p> : null}
      {row.previousAttempt ? <span className="goals-caption">Previous attempt</span> : null}
      <strong data-goal-current-conclusion={focus?.kind === 'delegation' && focus.operationId === row.delegation.operationId ? true : undefined} data-goal-current-source={focus?.kind === 'delegation' && focus.operationId === row.delegation.operationId ? 'delegation' : undefined}>{row.next}</strong>
      <p className="goal-delegation__identity">Agent <span><GoalContinuationAgent agentSessionId={row.delegation.workerAgentSessionId} hostId={delegationWorkerHostId(row.delegation)} active={active} size={14} /></span> · Follow-up {current.supervisorSessionId
        ? supervisorHost ? <span><GoalContinuationAgent agentSessionId={current.supervisorSessionId} hostId={supervisorHost} active={active} size={14} /></span>
          : <span title={demandAgentReferenceLabel(current.supervisorSessionId)}>Supervisor reference · {typeof current.supervisorSessionId === 'string' ? 'Host unconfirmed' : demandAgentReferenceLabel(current.supervisorSessionId)}</span> : 'needs an assigned Supervisor'}</p>
      {embedded ? <GoalExecutionResponsibility row={responsibilities.get(`delegation:${row.delegation.operationId}`)} /> : null}
      {row.report ? <p className="goal-delegation__summary">{row.report.grounding.summary}</p> : null}
      {row.issue && row.issue !== current.delegationObservationIssue ? <p className="goals-service" role="status">{row.issue}</p> : null}
      {row.attention?.state === 'confirmed' ? <details className="goal-delegation__notice"><summary>Supervisor reminder received</summary><p>{row.attention.reason} The report and human review remain separate.</p></details> : row.attention ? <p className="goals-service" role="status">Supervisor reminder {row.attention.state === 'prepared' ? 'prepared' : 'unknown'}. {row.attention.reason} Reminder receipt does not accept this Goal.
        {row.delegation.attention ? <Button type="button" onClick={() => void openAgent(row.delegation.attention!.supervisorAgentSessionId, row.delegation.attention!.hostId)}>Open original Supervisor</Button> : null}
      </p> : null}
      <div className="goal-delegation__actions">
        {row.state === 'report' ? <button type="button" className={!embedded || primary && focus?.kind === 'delegation' && focus.operationId === row.delegation.operationId ? 'primary-button' : 'small-button'} disabled={busy.has(row.delegation.operationId)}
          onClick={() => void collect(row.delegation.operationId, row.report!.replyMessageId)}>{busy.has(row.delegation.operationId) ? 'Collecting…' : 'Collect report'}</button> : null}
        {row.state === 'collected' ? <button type="button" className={!embedded || primary && focus?.kind === 'delegation' && focus.operationId === row.delegation.operationId ? 'primary-button' : 'small-button'} onClick={() => void review()}>Review results</button> : null}
        <button type="button" className={embedded && primary && focus?.kind === 'delegation' && focus.operationId === row.delegation.operationId && !['report', 'collected'].includes(row.state) ? 'primary-button' : 'small-button'} title={`Host ${delegationWorkerHostId(row.delegation)} · Session ${row.delegation.workerAgentSessionId}`}
          onClick={() => void openAgent(row.delegation.workerAgentSessionId, delegationWorkerHostId(row.delegation))}>Open original Agent</button>
        <Button type="button" title={`Host ${row.delegation.hostId} · Session ${row.delegation.ownerAgentSessionId}`}
          onClick={() => void openAgent(row.delegation.ownerAgentSessionId, row.delegation.hostId)}>Open task owner</Button>
      </div>
      <GoalRequestReader text={row.delegation.requestText ?? row.delegation.text} details={<>
        <dl><dt>Owner Host</dt><dd>{row.delegation.hostId}</dd><dt>Worker Host</dt><dd>{delegationWorkerHostId(row.delegation)}</dd><dt>Owner</dt><dd>{row.delegation.ownerAgentSessionId}</dd>
          <dt>Worker</dt><dd>{row.delegation.workerAgentSessionId}</dd><dt>Original Run</dt><dd>{row.delegation.workerRunId}</dd>
          <dt>Source message</dt><dd>{row.delegation.sourceMessageId}</dd><dt>Thread</dt><dd>{row.delegation.threadId}</dd>
          {row.replyMessageId ? <><dt>Reply</dt><dd>{row.replyMessageId}</dd></> : null}
          {row.delegation.collection ? <><dt>Collected by</dt><dd>{row.delegation.collection.collector.kind} · {row.delegation.collection.collector.id}</dd>
            <dt>Collection</dt><dd>{row.delegation.collection.operationId}</dd></> : null}</dl>
        {row.delegation.attention ? <dl><dt>Reminder operation</dt><dd>{row.delegation.attention.operationId}</dd>
          <dt>Reminder intent</dt><dd>{row.delegation.attention.intentId}</dd><dt>Original Supervisor</dt><dd>{row.delegation.attention.supervisorAgentSessionId}</dd>
          <dt>Supervisor Run</dt><dd>{row.delegation.attention.supervisorRunId}</dd></dl> : null}
        </>}>
        {row.report ? <div className="goal-delegation__checks"><p>{row.report.grounding.summary}</p>
          {row.report.grounding.checks.map(check => <div key={check.criterionId}><strong>{check.criterionId} · {check.outcome}</strong>
            {check.note ? <p>{check.note}</p> : null}<GoalEvidence evidence={check.evidence} criterion={check.criterionId} /></div>)}
        </div> : null}
      </GoalRequestReader>
    </article> }))
  const records = [...startRecords, ...delegationRecords]
  const focusedKey = focus?.kind === 'start' || focus?.kind === 'delegation' ? `${focus.kind}:${focus.operationId}` : null
  const others = records.filter(record => record.key !== focusedKey)
  const attentionKeys = new Set([...starts.filter(row => row.state !== 'working').map(row => `start:${row.start.operationId}`), ...rows.filter(row => ['unknown', 'exited', 'question', 'report', 'collected'].includes(row.state)).map(row => `delegation:${row.delegation.operationId}`)])
  const needsAttention = others.filter(record => attentionKeys.has(record.key) || responsibilities.get(record.key)?.alert).length
  const recordNodes = embedded ? [
    ...records.filter(record => record.key === focusedKey).map(record => <Fragment key={record.key}>{record.element}</Fragment>),
    overview ? <div key="goal-overview" className="goal-work-area__overview">{overview}</div> : null,
    ...(others.length ? [<div key="original-executions" className="goal-work-area__records"><details><summary data-goal-other-work>{others.length} original {others.length === 1 ? 'execution' : 'executions'}{needsAttention ? ` · ${needsAttention} to check` : ''}</summary>{others.map(record => <Fragment key={record.key}>{record.element}</Fragment>)}</details><Button type="button" onClick={() => void refresh()}>Refresh reports</Button></div>] : [])
  ] : records.map(record => <Fragment key={record.key}>{record.element}</Fragment>)
  const responsibility = <GoalResponsibilitySummary demand={current} active={active} embedded={embedded} represented={embedded ? represented : undefined} primary={embedded ? primary && focus?.kind === 'patrol' : undefined} />
  return <>{beforeRecords}{responsibility}{rows.length || starts.length || current.delegationObservationIssue || issue || embedded && overview ? <section id={`goal-work-${demand.id}`} tabIndex={-1} className="goal-delegation" aria-label={embedded ? 'Original work records' : 'Delegated work'}>
    <div className="goal-delegation__heading">{!embedded ? <strong>Delegated work</strong> : null}{(!embedded || !others.length) && (rows.length || starts.length) ? <Button type="button" onClick={() => void refresh()}>Refresh reports</Button> : null}</div>
    {current.delegationObservationIssue || issue ? <p className="goals-service" role="status">{issue ?? current.delegationObservationIssue} Original Agents, tasks and last confirmed reports are kept.</p> : null}
    {recordNodes}

  </section> : null}{afterRecords}</>
}
