import { useRef, useState } from 'react'
import { formatSessionAddress } from '@agentmux/core/sharing'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { api } from '../lib/api'
import type { DemandRecord } from '../lib/global-demand-board'
import { goalDelegationRows } from '../lib/goal-delegation-presentation'
import { goalStartRows } from '../lib/goal-start-presentation'
import { GoalStartWork } from './GoalStartWork'
import { GoalResponsibilitySummary } from './GoalResponsibilitySummary'
import { GoalContinuationAgent } from './GoalContinuationControl'
import { applyGoalDelegationResult, beginGoalDelegationRead, refreshGoalDelegations, useGoalDelegationObservation } from '../lib/goal-delegation-work'
import { useAppStore } from '../store'
import '../styles/goal-delegation.css'

/** Same original Goal reports and actions in Goal details and a Mote's current work. */
export function GoalDelegationWork({ demand, active = true, compact = false }: {
  demand: DemandRecord; active?: boolean; compact?: boolean
}) {
  const current = useAppStore(state => active ? state.demands[demand.id] ?? demand : demand)
  useGoalDelegationObservation(current, active)
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set()), [issue, setIssue] = useState<string | null>(null)
  const collecting = useRef(new Set<string>())
  const rows = goalDelegationRows(current)
  const starts = goalStartRows(current)
  if (compact || !rows.length && !starts.length) return <GoalResponsibilitySummary demand={current} compact={compact} active={active} />
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
  async function openAgent(agentSessionId: string) {
    try { await api.ui.openObjectLink(formatSessionAddress(agentSessionId)) }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  async function review() {
    try {
      const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION,
        requestId: crypto.randomUUID(), operation: 'focus', target: { kind: 'goal', goalId: demand.id }, inputPolicy: 'preserve' })
      if (result.operation === 'focus' && result.navigation.state === 'rejected') setIssue(result.issues.map(item => item.message).join(' '))
    } catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  return <><GoalResponsibilitySummary demand={current} active={active} /><section className="goal-delegation" aria-label="Delegated work">
    <div className="goal-delegation__heading"><strong>Delegated work</strong><button type="button" className="goals-button" onClick={() => void refresh()}>Refresh reports</button></div>
    {current.delegationObservationIssue || issue ? <p className="goals-service" role="status">{issue ?? current.delegationObservationIssue} Original Agents, tasks and last confirmed reports are kept.</p> : null}
    <GoalStartWork rows={starts} supervisorSessionId={current.supervisorSessionId} active={active} openAgent={openAgent} review={review} />
    {rows.map(row => <article className="goal-delegation__item" key={row.delegation.operationId}>
      <strong>{row.next}</strong>
      <p className="goal-delegation__identity">Agent <span><GoalContinuationAgent agentSessionId={row.delegation.workerAgentSessionId} hostId={row.delegation.hostId} active={active} size={14} /></span> · Follow-up {current.supervisorSessionId
        ? <span><GoalContinuationAgent agentSessionId={current.supervisorSessionId} active={active} size={14} /></span> : 'needs an assigned Supervisor'}</p>
      {row.report ? <p className="goal-delegation__summary">{row.report.grounding.summary}</p> : null}
      {row.issue && row.issue !== current.delegationObservationIssue ? <p className="goals-service" role="status">{row.issue}</p> : null}
      {row.attention?.state === 'confirmed' ? <details className="goal-delegation__notice"><summary>Supervisor reminder received</summary><p>{row.attention.reason} The report and human review remain separate.</p></details> : row.attention ? <p className="goals-service" role="status">Supervisor reminder {row.attention.state === 'prepared' ? 'prepared' : 'unknown'}. {row.attention.reason} Reminder receipt does not accept this Goal.
        {row.delegation.attention ? <button type="button" className="goals-button" onClick={() => void openAgent(row.delegation.attention!.supervisorAgentSessionId)}>Open original Supervisor</button> : null}
      </p> : null}
      <div className="goal-delegation__actions">
        {row.state === 'report' ? <button type="button" className="goals-button goals-button--primary" disabled={busy.has(row.delegation.operationId)}
          onClick={() => void collect(row.delegation.operationId, row.report!.replyMessageId)}>{busy.has(row.delegation.operationId) ? 'Collecting…' : 'Collect report'}</button> : null}
        {row.state === 'collected' ? <button type="button" className="goals-button goals-button--primary" onClick={() => void review()}>Review results</button> : null}
        <button type="button" className="goals-button" title={`Host ${row.delegation.hostId} · Session ${row.delegation.workerAgentSessionId}`}
          onClick={() => void openAgent(row.delegation.workerAgentSessionId)}>Open original Agent</button>
        <button type="button" className="goals-button" title={`Host ${row.delegation.hostId} · Session ${row.delegation.ownerAgentSessionId}`}
          onClick={() => void openAgent(row.delegation.ownerAgentSessionId)}>Open task owner</button>
      </div>
      <details className="goal-delegation__source"><summary>Task and source</summary>
        <dl><dt>Host</dt><dd>{row.delegation.hostId}</dd><dt>Owner</dt><dd>{row.delegation.ownerAgentSessionId}</dd>
          <dt>Worker</dt><dd>{row.delegation.workerAgentSessionId}</dd><dt>Original Run</dt><dd>{row.delegation.workerRunId}</dd>
          <dt>Source message</dt><dd>{row.delegation.sourceMessageId}</dd><dt>Thread</dt><dd>{row.delegation.threadId}</dd>
          {row.replyMessageId ? <><dt>Reply</dt><dd>{row.replyMessageId}</dd></> : null}
          {row.delegation.collection ? <><dt>Collected by</dt><dd>{row.delegation.collection.collector.kind} · {row.delegation.collection.collector.id}</dd>
            <dt>Collection</dt><dd>{row.delegation.collection.operationId}</dd></> : null}</dl>
        {row.delegation.attention ? <dl><dt>Reminder operation</dt><dd>{row.delegation.attention.operationId}</dd>
          <dt>Reminder intent</dt><dd>{row.delegation.attention.intentId}</dd><dt>Original Supervisor</dt><dd>{row.delegation.attention.supervisorAgentSessionId}</dd>
          <dt>Supervisor Run</dt><dd>{row.delegation.attention.supervisorRunId}</dd></dl> : null}
        <pre>{row.delegation.requestText ?? row.delegation.text}</pre>
        {row.report ? <div className="goal-delegation__checks"><p>{row.report.grounding.summary}</p>
          {row.report.grounding.checks.map(check => <div key={check.criterionId}><strong>{check.criterionId} · {check.outcome}</strong>
            {check.note ? <p>{check.note}</p> : null}{check.evidence.map(evidence => <span key={evidence}>{evidence}</span>)}</div>)}
        </div> : null}
      </details>
    </article>)}
  </section></>
}
