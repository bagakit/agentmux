import { Button } from '@agentmux/client-ui/components/Button'
import { goalRequestFirstDestination, useGoalAgentName } from '../lib/goal-discussion-recipient'
import { useRef, useState } from 'react'
import type { DemandRecord } from '../lib/global-demand-board'
import { api } from '../lib/api'
import { applyGoalDelegationResult, beginGoalDelegationRead, refreshGoalDelegations } from '../lib/goal-delegation-work'
import { useAppStore } from '../store'
import { GoalAgentPicker, type GoalRelationSave } from './GoalAgentPicker'
import { bindAgentConversationFloatingTarget, readPmoTeamsTopicFloatingState, requestAgentConversationFloatingOpen, setAgentConversationFloatingMessage } from '../lib/pmo-teams-topic-floating'
import { goalSupervisorHostWitnesses } from '@agentmux/demand/relations'

async function operation(kind: string, original: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([kind, ...original])))
  return kind + '-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
const labels = { prepared: 'Inspection saved · Awaiting input', delivered: 'Delivered · Awaiting inspection', unknown: 'Original input unconfirmed', missing: 'Saved · Not delivered', stale: 'Inspection scope changed', reported: 'Inspection recorded', planned: 'Plan saved' }

/** One explicit action targets the original business owner; navigation and input are separate. */
export function GoalPatrolControl({ demand, compact = false, embedded = false, primary }: { demand: DemandRecord; compact?: boolean; embedded?: boolean; primary?: boolean | undefined }) {
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const [supervisorGoalId, setSupervisorGoalId] = useState<string | null>(null)
  const flight = useRef(false), scope = useRef(demand.id); scope.current = demand.id
  const patrol = demand.patrols?.filter(item => item.purpose !== 'plan').at(-1), observed = patrol && demand.patrolObservations?.find(item => item.operationId === patrol.operationId)
  const pending = Boolean(patrol && !patrol.report && observed?.state !== 'stale')
  const manager = demand.responsibility?.supervisor, attempt = patrol?.attempts.at(-1)
  const targetSessionId = pending ? attempt?.target.agentSessionId ?? patrol?.supervisorAgentSessionId ?? null : typeof demand.supervisorSessionId === 'string' ? demand.supervisorSessionId : demand.supervisorSessionId ? null : manager?.agentSessionId ?? null
  const supervisorHosts = goalSupervisorHostWitnesses(demand)
  const targetHostId = pending ? attempt?.target.hostId : (manager?.agentSessionId === targetSessionId ? manager.hostId : undefined) ??
    (targetSessionId === demand.supervisorSessionId && supervisorHosts.length === 1 ? supervisorHosts[0] : undefined)
  const targetName = useGoalAgentName(targetSessionId, targetHostId)
  const firstDestination = goalRequestFirstDestination(demand, pending ? patrol : undefined)
  const firstName = useGoalAgentName(firstDestination?.agentSessionId, firstDestination?.hostId)
  const firstHostName = useAppStore(state => firstDestination ? state.config?.hosts.find(host => host.id === firstDestination.hostId)?.label ?? firstDestination.hostId : null)
  const latestReport = [...demand.patrols ?? []].reverse().find(item => item.purpose !== 'plan' && item.report)
  const entryContext = { kind: 'goal-patrol' as const, goalId: demand.id, scope: demand.responsibility?.scope ?? null,
    afterReportOperationId: latestReport?.report?.operationId ?? null }
  const attention = demand.responsibility?.executions.some(row => row.alert !== null) || Boolean(demand.responsibility?.executions.length && manager && !['available', 'busy'].includes(manager.state))
  if (!attention && !patrol) return null
  function setEntryMessage(entry: number, message?: string) {
    const floating = readPmoTeamsTopicFloatingState()
    if (floating?.conversationEntry === entry) setAgentConversationFloatingMessage(floating.agentTarget?.agentSessionId ?? null, message, entry)
  }
  function bindOriginalTarget(entry: number, original: typeof patrol) {
    const target = original?.attempts.at(-1)?.target
    if (target) bindAgentConversationFloatingTarget(entry, target.agentSessionId, target.hostId)
  }
  async function readOriginal(entry: number) {
    await refreshGoalDelegations(demand.id)
    bindOriginalTarget(entry, useAppStore.getState().demands[demand.id]?.patrols?.find(item => item.operationId === patrol?.operationId))
  }
  async function run(action: () => Promise<void>, expectedEntry?: number) {
    if (flight.current) return
    flight.current = true; const goalId = demand.id; setBusy(true); setIssue(null)
    try { await action() }
    catch (e) { const message = (e instanceof Error ? e.message : String(e)) + ' 原请求与工作保留；读取原巡查核对。'
      if (expectedEntry !== undefined) setEntryMessage(expectedEntry, message)
      if (scope.current === goalId) setIssue(message) }
    finally { flight.current = false; if (scope.current === goalId) setBusy(false); void refreshGoalDelegations(goalId) }
  }
  async function request(expectedEntry: number) {
    const goalId = demand.id, basis = demand.responsibility?.scope
    if (!basis) { const message = '执行责任依据尚未确认，尚未提交巡查；正在读取原执行责任，请核对后再试。'; setIssue(message); setEntryMessage(expectedEntry, message); return }
    const operationId = await operation('goal-patrol-request', [goalId, basis, patrol?.report?.operationId ?? null]), cut = beginGoalDelegationRead()
    const result = await api.demands.delegation('goal.patrol', { goalId, operationId })
    applyGoalDelegationResult(result, cut)
    const saved = result.patrols?.find(item => item.purpose !== 'plan' && item.operationId === operationId) ?? result.patrols?.find(item => item.purpose !== 'plan' && !item.report && item.expectedScope === basis)
    bindOriginalTarget(expectedEntry, saved)
    // This click explicitly starts work. Only an authoritative ended original Run
    // may use the existing same-Session Core recovery, and only never-attempted input continues.
    if (manager?.state === 'ended' && saved?.supervisorAgentSessionId === targetSessionId && !saved.report && !saved.attempts.some(item => item.attemptedAt)) {
      const state = useAppStore.getState(), originals = targetHostId && manager.hostId === targetHostId && manager.runId ? state.sessions.filter(session => session.kind === 'agent' && session.control.agentSessionId === targetSessionId &&
        session.hostId === targetHostId && session.control.hostId === targetHostId && session.control.run.runId === manager.runId) : []
      const original = originals.length === 1 ? originals[0] : undefined
      if (!original || original.kind !== 'agent') { setEntryMessage(expectedEntry, '原管理 Run 已结束；原 Session 恢复元数据尚未确认。请求与工作面保留，请读取原 Session 后接续原巡查。'); return }
      setEntryMessage(expectedEntry, '原管理 Run 已结束，正在通过 Core 恢复同一 Session；巡查尚未投递。')
      const recoveryId = await operation('goal-patrol-resume', [goalId, saved.operationId, original.control.run.runId])
      const recovered = await state.recoverSession(original.id, recoveryId, { preserveView: true })
      if (!recovered || recovered.kind !== 'agent' || recovered.control.agentSessionId !== targetSessionId || recovered.control.hostId !== original.control.hostId ||
        recovered.processState !== 'running' || recovered.control.run.runId === original.control.run.runId) {
        setEntryMessage(expectedEntry, '原 Session 的恢复尚未确认。原请求与工作面保留；读取原恢复状态后接续，未重投任何原输入。'); return
      }
      const continuationId = await operation('goal-patrol-continue', [goalId, saved.operationId, recovered.control.run.runId]), continuationCut = beginGoalDelegationRead()
      applyGoalDelegationResult(await api.demands.delegation('goal.patrol.continue', { goalId, patrolOperationId: saved.operationId,
        operationId: continuationId, expectedRunId: recovered.control.run.runId }), continuationCut)
    }
    setEntryMessage(expectedEntry)
  }
  async function continueOriginal() {
    if (!patrol || !manager?.runId || manager.agentSessionId !== patrol.supervisorAgentSessionId || manager.agentSessionId !== targetSessionId || !targetHostId || manager.hostId !== targetHostId) return
    const operationId = await operation('goal-patrol-continue', [demand.id, patrol.operationId, manager.runId]), cut = beginGoalDelegationRead()
    applyGoalDelegationResult(await api.demands.delegation('goal.patrol.continue', { goalId: demand.id, patrolOperationId: patrol.operationId, operationId, expectedRunId: manager.runId }), cut)
  }
  async function sendFirstDestination(entry: number) {
    if (!patrol || !firstDestination) return
    const operationId = await operation('goal-patrol-continue', [demand.id, patrol.operationId, firstDestination.runId]), cut = beginGoalDelegationRead()
    const result = await api.demands.delegation('goal.patrol.continue', { goalId: demand.id, patrolOperationId: patrol.operationId, operationId, expectedRunId: firstDestination.runId })
    applyGoalDelegationResult(result, cut)
    bindOriginalTarget(entry, result.patrols?.find(item => item.operationId === patrol.operationId))
  }
  const saveSupervisor: GoalRelationSave = async (patch, expectedUpdatedAt) => {
    await useAppStore.getState().updateDemand(demand.id, patch, undefined, expectedUpdatedAt)
    return true
  }
  const needsSupervisor = !manager || !['available', 'busy'].includes(manager.state)
  const canContinue = pending && patrol?.supervisorAgentSessionId && manager?.agentSessionId === patrol.supervisorAgentSessionId && manager.agentSessionId === targetSessionId && manager.runId &&
    targetHostId && manager.hostId === targetHostId && manager.state !== 'ended' && manager.state !== 'unknown' && !patrol.attempts.some(a => a.attemptedAt) && (!attempt || attempt.target.runId !== manager.runId)
  const openConversation = targetSessionId ? <Button type="button" onClick={() => requestAgentConversationFloatingOpen(targetHostId ? targetSessionId : null, targetHostId,
    targetHostId ? undefined : 'The original Supervisor destination is unconfirmed. Check the retained inspection to read its destination.', undefined, entryContext)}>{targetName ? `Open ${targetName} conversation` : 'Open owner conversation'}</Button> : null
  return <div className={`goal-patrol${compact ? ' goal-patrol--compact' : ''}`} aria-label="PMO 巡查"
    data-goal-work-kind={embedded && patrol ? 'patrol' : undefined} data-goal-work-operation={embedded ? patrol?.operationId : undefined}
    tabIndex={embedded && patrol ? -1 : undefined} onClick={event => event.stopPropagation()}>
    <div className="goal-patrol__actions">
      <button type="button" className={(primary ?? !pending) && !needsSupervisor && !firstDestination ? 'primary-button' : 'small-button'} aria-busy={busy}
        aria-label={pending ? 'Check original inspection' : targetName ? `Request inspection from ${targetName}` : 'Request owner inspection'} onClick={() => {
        const entry = requestAgentConversationFloatingOpen(targetHostId ? targetSessionId : null, targetHostId,
          pending ? observed?.reason ?? '原巡查请求已保存；正在读取原回执。' : '正在请求原 PMO 巡查；实际工作状态以原 Agent 为准。', undefined, entryContext)
        void run(pending ? () => readOriginal(entry) : () => request(entry), entry)
      }}>{busy ? 'Checking original inspection…' : pending ? 'Check original inspection' : targetName ? `Request inspection from ${targetName}` : 'Request owner inspection'}</button>
      {!compact && !embedded && patrol ? <Button type="button" disabled={busy} onClick={() => void run(() => refreshGoalDelegations(demand.id))}>Read inspection</Button> : null}
      {canContinue ? <Button type="button" disabled={busy} onClick={() => void run(continueOriginal)}>Continue original inspection</Button> : null}
      {!embedded && (!compact || needsSupervisor) ? openConversation : null}
      {needsSupervisor ? <button type="button" className={primary && !firstDestination ? 'primary-button' : 'small-button'} onClick={() => setSupervisorGoalId(demand.id)}>Choose Supervisor</button> : null}
    </div>
    {firstDestination ? <div className="goals-inline-actions">
      <button type="button" className={primary ? 'primary-button' : 'small-button'} disabled={busy} onClick={() => {
        const entry = requestAgentConversationFloatingOpen(null, undefined, 'Confirming this inspection’s first Supervisor destination.', undefined, entryContext)
        void run(() => sendFirstDestination(entry), entry)
      }}>Send first inspection</button>
      <span className="goals-caption" title={`Host ${firstDestination.hostId} · Session ${firstDestination.agentSessionId} · Run ${firstDestination.runId}`}>First send to {firstName ?? 'the current Supervisor'} on {firstHostName}.</span>
    </div> : null}
    {observed ? <p className="goal-patrol__feedback" role="status"><strong data-goal-current-conclusion={primary ? true : undefined} data-goal-current-source={primary ? 'patrol' : undefined}>{labels[observed.state]}</strong>{!compact || !['delivered', 'reported'].includes(observed.state) ? <span>{observed.reason}</span> : null}</p> : null}
    {!embedded && observed?.state === 'missing' ? <p className="goal-patrol__feedback">原 PMO 尚未确认，巡查尚未开始。恢复原 PMO 后接续原巡查，或明确选择 Supervisor；选择不会自动发送。</p> : null}
    {!embedded && manager?.state === 'ended' ? <p className="goal-patrol__feedback">原管理 Run 已结束；打开原 PMO 恢复同一 Session，再接续或回报实际巡查。</p> : null}
    {patrol?.report ? <p className="goal-patrol__feedback"><span className="goal-patrol__report-summary">{patrol.report.summary}</span><span>Next: {patrol.report.nextOwner.agentSessionId ?? patrol.report.nextOwner.kind} · {patrol.report.nextOwner.action}</span></p> : null}
    {issue ? <p className="goal-patrol__feedback" role="status">{issue}</p> : null}
    {supervisorGoalId === demand.id ? <GoalAgentPicker key={demand.id} demand={demand} role="supervisor" onSave={saveSupervisor} onClose={() => setSupervisorGoalId(null)} /> : null}
    {patrol || embedded || compact && targetSessionId && !needsSupervisor ? <details className="goal-patrol__source"><summary>{compact ? 'Inspection details' : 'Original inspection and input'}</summary>
      {embedded ? <><div className="goal-patrol__secondary">{openConversation}</div>{manager ? <p>Supervisor: {manager.agentSessionId ?? 'Unassigned'} · {manager.state}. {manager.reason}</p> : null}{observed?.state === 'missing' ? <p>The original inspection has not started. Restore its original Supervisor or explicitly choose a Supervisor; selection never sends input.</p> : null}</> : null}
      {compact ? <div className="goal-patrol__secondary">
        {patrol ? <Button type="button" disabled={busy} onClick={() => void run(() => refreshGoalDelegations(demand.id))}>Read inspection</Button> : null}
        {!needsSupervisor ? openConversation : null}
      </div> : null}
      {patrol ? <dl><dt>Inspection operation</dt><dd>{patrol.operationId}</dd>
      {patrol.attempts.map(a => <div key={a.operationId}><dt>Original input</dt><dd>{a.operationId}</dd><dt>PMO Host / Session / Run</dt><dd>{a.target.hostId} / {a.target.agentSessionId} / {a.target.runId}</dd><dt>Attempt</dt><dd>{a.attemptedAt ? 'Attempted · Inspect only' : a.supersededAt ? 'Explicit continuation · Original reference kept' : 'Not attempted'}</dd></div>)}
      {patrol.report ? <><dt>Reporting Run</dt><dd>{patrol.report.reportingRunId}</dd><dt>Business update</dt><dd>{patrol.report.applied ? 'Applied · Human acceptance is separate' : 'History only · Current work was not overwritten'}</dd></> : null}</dl> : null}
    </details> : null}
  </div>
}
