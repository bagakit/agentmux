import { useGoalAgentName } from '../lib/goal-discussion-recipient'
import { useRef, useState } from 'react'
import type { DemandRecord } from '../lib/global-demand-board'
import { api } from '../lib/api'
import { applyGoalDelegationResult, beginGoalDelegationRead, refreshGoalDelegations } from '../lib/goal-delegation-work'
import { useAppStore } from '../store'
import { GoalAgentPicker, type GoalRelationSave } from './GoalAgentPicker'
import { requestAgentConversationFloatingOpen, setAgentConversationFloatingMessage } from '../lib/pmo-teams-topic-floating'

async function operation(kind: string, original: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([kind, ...original])))
  return kind + '-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
const labels = { prepared: '请求已保存 · 等待 PMO 输入', delivered: '已投递 · 等待实际巡查', unknown: '原输入回执待确认', missing: '请求已保存 · 尚未投递', stale: '原巡查范围已变化', reported: '巡查已回填' }

/** One explicit action targets the original business owner; navigation and input are separate. */
export function GoalPatrolControl({ demand, compact = false }: { demand: DemandRecord; compact?: boolean }) {
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const [supervisorGoalId, setSupervisorGoalId] = useState<string | null>(null)
  const flight = useRef(false), scope = useRef(demand.id); scope.current = demand.id
  const patrol = demand.patrols?.at(-1), observed = patrol && demand.patrolObservations?.find(item => item.operationId === patrol.operationId)
  const pending = Boolean(patrol && !patrol.report && observed?.state !== 'stale')
  const manager = demand.responsibility?.supervisor, attempt = patrol?.attempts.at(-1)
  const targetSessionId = pending ? patrol?.supervisorAgentSessionId ?? null : demand.supervisorSessionId ?? manager?.agentSessionId ?? null
  const targetHostId = attempt?.target.agentSessionId === targetSessionId ? attempt.target.hostId : manager?.agentSessionId === targetSessionId ? manager.hostId : undefined
  const targetName = useGoalAgentName(targetSessionId, targetHostId)
  const latestReport = [...demand.patrols ?? []].reverse().find(item => item.report)
  const entryContext = { kind: 'goal-patrol' as const, goalId: demand.id, scope: demand.responsibility?.scope ?? null,
    afterReportOperationId: latestReport?.report?.operationId ?? null }
  const attention = demand.responsibility?.executions.some(row => row.alert !== null) || Boolean(demand.responsibility?.executions.length && manager && !['available', 'busy'].includes(manager.state))
  if (!attention && !patrol) return null
  async function run(action: () => Promise<void>, expectedEntry?: number) {
    if (flight.current) return
    flight.current = true; const goalId = demand.id; setBusy(true); setIssue(null)
    try { await action() }
    catch (e) { const message = (e instanceof Error ? e.message : String(e)) + ' 原请求与工作保留；读取原巡查核对。'
      if (expectedEntry !== undefined) setAgentConversationFloatingMessage(targetSessionId, message, expectedEntry)
      if (scope.current === goalId) setIssue(message) }
    finally { flight.current = false; if (scope.current === goalId) setBusy(false); void refreshGoalDelegations(goalId) }
  }
  async function request(expectedEntry: number) {
    const goalId = demand.id, basis = demand.responsibility?.scope
    if (!basis) { const message = '执行责任依据尚未确认，尚未提交巡查；正在读取原执行责任，请核对后再试。'; setIssue(message); setAgentConversationFloatingMessage(targetSessionId, message, expectedEntry); return }
    const operationId = await operation('goal-patrol-request', [goalId, basis, patrol?.report?.operationId ?? null]), cut = beginGoalDelegationRead()
    const result = await api.demands.delegation('goal.patrol', { goalId, operationId })
    applyGoalDelegationResult(result, cut)
    const saved = result.patrols?.find(item => item.operationId === operationId) ?? result.patrols?.find(item => !item.report && item.expectedScope === basis)
    // This click explicitly starts work. Only an authoritative ended original Run
    // may use the existing same-Session Core recovery, and only never-attempted input continues.
    if (manager?.state === 'ended' && saved?.supervisorAgentSessionId === targetSessionId && !saved.report && !saved.attempts.some(item => item.attemptedAt)) {
      const state = useAppStore.getState(), originals = state.sessions.filter(session => session.kind === 'agent' && session.control.agentSessionId === targetSessionId && (!targetHostId || session.control.hostId === targetHostId))
      const original = originals.length === 1 ? originals[0] : undefined
      if (!original || original.kind !== 'agent') { setAgentConversationFloatingMessage(targetSessionId, '原管理 Run 已结束；原 Session 恢复元数据尚未确认。请求与工作面保留，请读取原 Session 后接续原巡查。', expectedEntry); return }
      setAgentConversationFloatingMessage(targetSessionId, '原管理 Run 已结束，正在通过 Core 恢复同一 Session；巡查尚未投递。', expectedEntry)
      const recoveryId = await operation('goal-patrol-resume', [goalId, saved.operationId, original.control.run.runId])
      const recovered = await state.recoverSession(original.id, recoveryId, { preserveView: true })
      if (!recovered || recovered.kind !== 'agent' || recovered.control.agentSessionId !== targetSessionId || recovered.control.hostId !== original.control.hostId ||
        recovered.processState !== 'running' || recovered.control.run.runId === original.control.run.runId) {
        setAgentConversationFloatingMessage(targetSessionId, '原 Session 的恢复尚未确认。原请求与工作面保留；读取原恢复状态后接续，未重投任何原输入。', expectedEntry); return
      }
      const continuationId = await operation('goal-patrol-continue', [goalId, saved.operationId, recovered.control.run.runId]), continuationCut = beginGoalDelegationRead()
      applyGoalDelegationResult(await api.demands.delegation('goal.patrol.continue', { goalId, patrolOperationId: saved.operationId,
        operationId: continuationId, expectedRunId: recovered.control.run.runId }), continuationCut)
    }
    setAgentConversationFloatingMessage(targetSessionId, undefined, expectedEntry)
  }
  async function continueOriginal() {
    if (!patrol || !manager?.runId || manager.agentSessionId !== patrol.supervisorAgentSessionId) return
    const operationId = await operation('goal-patrol-continue', [demand.id, patrol.operationId, manager.runId]), cut = beginGoalDelegationRead()
    applyGoalDelegationResult(await api.demands.delegation('goal.patrol.continue', { goalId: demand.id, patrolOperationId: patrol.operationId, operationId, expectedRunId: manager.runId }), cut)
  }
  const saveSupervisor: GoalRelationSave = async (patch, expectedUpdatedAt) => {
    await useAppStore.getState().updateDemand(demand.id, patch, undefined, expectedUpdatedAt)
    return true
  }
  const needsSupervisor = !manager || !['available', 'busy'].includes(manager.state)
  const canContinue = pending && patrol?.supervisorAgentSessionId && manager?.agentSessionId === patrol.supervisorAgentSessionId && manager.runId &&
    manager.state !== 'ended' && manager.state !== 'unknown' && !patrol.attempts.some(a => a.attemptedAt) && (!attempt || attempt.target.runId !== manager.runId)
  const openConversation = targetSessionId ? <button type="button" className="goals-button" onClick={() => requestAgentConversationFloatingOpen(targetSessionId, targetHostId, undefined, undefined, entryContext)}>{compact ? '打开原对话' : targetName ? `打开 ${targetName} 的对话` : '打开原负责人对话'}</button> : null
  return <div className={`goal-patrol${compact ? ' goal-patrol--compact' : ''}`} aria-label="PMO 巡查" onClick={event => event.stopPropagation()}>
    <div className="goal-patrol__actions">
      <button type="button" className={`goals-button${pending ? '' : ' goals-button--primary'}`} aria-busy={busy}
        aria-label={pending ? '核对原巡查' : targetName ? `请 ${targetName} 巡查` : '请求原负责人巡查'} onClick={() => {
        const entry = requestAgentConversationFloatingOpen(targetSessionId, targetHostId,
          pending ? observed?.reason ?? '原巡查请求已保存；正在读取原回执。' : '正在请求原 PMO 巡查；实际工作状态以原 Agent 为准。', undefined, entryContext)
        void run(pending ? () => refreshGoalDelegations(demand.id) : () => request(entry), entry)
      }}>{busy ? '核对原巡查…' : compact ? pending ? '核对原巡查' : '请求巡查' : pending ? '巡查请求已保存' : targetName ? `请 ${targetName} 巡查` : '请求原负责人巡查'}</button>
      {!compact && patrol ? <button type="button" className="goals-button" disabled={busy} onClick={() => void run(() => refreshGoalDelegations(demand.id))}>读取原巡查</button> : null}
      {canContinue ? <button type="button" className="goals-button" disabled={busy} onClick={() => void run(continueOriginal)}>接续原巡查</button> : null}
      {!compact || needsSupervisor ? openConversation : null}
      {needsSupervisor ? <button type="button" className="goals-button" onClick={() => setSupervisorGoalId(demand.id)}>选择 Supervisor</button> : null}
    </div>
    {observed ? <p className="goal-patrol__feedback" role="status"><strong>{labels[observed.state]}</strong>{!compact || !['delivered', 'reported'].includes(observed.state) ? <span>{observed.reason}</span> : null}</p> : null}
    {observed?.state === 'missing' ? <p className="goal-patrol__feedback">原 PMO 尚未确认，巡查尚未开始。恢复原 PMO 后接续原巡查，或明确选择 Supervisor；选择不会自动发送。</p> : null}
    {manager?.state === 'ended' ? <p className="goal-patrol__feedback">原管理 Run 已结束；打开原 PMO 恢复同一 Session，再接续或回报实际巡查。</p> : null}
    {patrol?.report ? <p className="goal-patrol__feedback"><span className="goal-patrol__report-summary">{patrol.report.summary}</span><span>下一步：{patrol.report.nextOwner.agentSessionId ?? patrol.report.nextOwner.kind} · {patrol.report.nextOwner.action}</span></p> : null}
    {issue ? <p className="goal-patrol__feedback" role="status">{issue}</p> : null}
    {supervisorGoalId === demand.id ? <GoalAgentPicker key={demand.id} demand={demand} role="supervisor" onSave={saveSupervisor} onClose={() => setSupervisorGoalId(null)} /> : null}
    {patrol || compact && targetSessionId && !needsSupervisor ? <details className="goal-patrol__source"><summary>{compact ? '巡查详情' : '原巡查与输入'}</summary>
      {compact ? <div className="goal-patrol__secondary">
        {patrol ? <button type="button" className="goals-button" disabled={busy} onClick={() => void run(() => refreshGoalDelegations(demand.id))}>读取原巡查</button> : null}
        {!needsSupervisor ? openConversation : null}
      </div> : null}
      {patrol ? <dl><dt>巡查 operation</dt><dd>{patrol.operationId}</dd>
      {patrol.attempts.map(a => <div key={a.operationId}><dt>原输入</dt><dd>{a.operationId}</dd><dt>PMO Host / Session / Run</dt><dd>{a.target.hostId} / {a.target.agentSessionId} / {a.target.runId}</dd><dt>尝试</dt><dd>{a.attemptedAt ? '已尝试 · 只对账' : a.supersededAt ? '显式接续 · 原引用保留' : '尚未尝试'}</dd></div>)}
      {patrol.report ? <><dt>实际回报 Run</dt><dd>{patrol.report.reportingRunId}</dd><dt>业务回填</dt><dd>{patrol.report.applied ? '已应用；人的接受仍独立' : '仅留历史；未覆盖当前工作'}</dd></> : null}</dl> : null}
    </details> : null}
  </div>
}
