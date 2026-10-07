import { useRef, useState } from 'react'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { formatSessionAddress } from '@agentmux/core/sharing'
import type { DemandRecord } from '../lib/global-demand-board'
import { api } from '../lib/api'
import { applyGoalDelegationResult, beginGoalDelegationRead, refreshGoalDelegations } from '../lib/goal-delegation-work'
import { useAppStore } from '../store'

async function operation(kind: string, original: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([kind, ...original])))
  return kind + '-' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
const labels = { prepared: '请求已保存 · 等待 PMO 输入', delivered: '已投递 · 等待实际巡查', unknown: '原输入回执待确认', missing: '请求已保存 · 管理者待接续', stale: '原巡查范围已变化', reported: '巡查已回填' }

/** One explicit action targets the original business owner; navigation and input are separate. */
export function GoalPatrolControl({ demand, compact = false }: { demand: DemandRecord; compact?: boolean }) {
  const [busy, setBusy] = useState(false), [issue, setIssue] = useState<string | null>(null)
  const flight = useRef(false), scope = useRef(demand.id); scope.current = demand.id
  const patrol = demand.patrols?.at(-1), observed = patrol && demand.patrolObservations?.find(item => item.operationId === patrol.operationId)
  const pending = Boolean(patrol && !patrol.report && observed?.state !== 'stale')
  const manager = demand.responsibility?.supervisor, attempt = patrol?.attempts.at(-1)
  const attention = demand.responsibility?.executions.some(row => row.alert !== null) || Boolean(demand.responsibility?.executions.length && manager && !['available', 'busy'].includes(manager.state))
  if (!attention && !patrol) return null
  async function run(action: () => Promise<void>) {
    if (flight.current) return
    flight.current = true; const goalId = demand.id; setBusy(true)
    try { await action(); if (scope.current === goalId) setIssue(null) }
    catch (e) { if (scope.current === goalId) setIssue((e instanceof Error ? e.message : String(e)) + ' 原请求与工作保留；读取原巡查核对。') }
    finally { await refreshGoalDelegations(goalId); flight.current = false; if (scope.current === goalId) setBusy(false) }
  }
  async function request() {
    const goalId = demand.id, basis = demand.responsibility?.scope
    if (!basis) { await refreshGoalDelegations(goalId); return }
    const operationId = await operation('goal-patrol-request', [goalId, basis, patrol?.report?.operationId ?? null]), cut = beginGoalDelegationRead()
    applyGoalDelegationResult(await api.demands.delegation('goal.patrol', { goalId, operationId }), cut)
  }
  async function continueOriginal() {
    if (!patrol || !manager?.runId || manager.agentSessionId !== patrol.supervisorAgentSessionId) return
    const operationId = await operation('goal-patrol-continue', [demand.id, patrol.operationId, manager.runId]), cut = beginGoalDelegationRead()
    applyGoalDelegationResult(await api.demands.delegation('goal.patrol.continue', { goalId: demand.id, patrolOperationId: patrol.operationId, operationId, expectedRunId: manager.runId }), cut)
  }
  async function chooseSupervisor() {
    await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: crypto.randomUUID(),
      operation: 'focus', target: { kind: 'goal', goalId: demand.id }, inputPolicy: 'preserve' })
  }
  const canContinue = pending && patrol?.supervisorAgentSessionId && manager?.agentSessionId === patrol.supervisorAgentSessionId && manager.runId &&
    manager.state !== 'ended' && manager.state !== 'unknown' && !patrol.attempts.some(a => a.attemptedAt) && (!attempt || attempt.target.runId !== manager.runId)
  return <div className="goal-patrol" aria-label="PMO 巡查" onClick={event => event.stopPropagation()}>
    <div className="goal-patrol__actions">
      <button type="button" className="goals-button goals-button--primary" disabled={busy || pending} onClick={() => void run(request)}>{busy ? '核对原巡查…' : pending ? '巡查请求已保存' : 'PMO 巡查'}</button>
      {patrol ? <button type="button" className="goals-button" disabled={busy} onClick={() => void run(() => refreshGoalDelegations(demand.id))}>读取原巡查</button> : null}
      {canContinue ? <button type="button" className="goals-button" disabled={busy} onClick={() => void run(continueOriginal)}>接续原巡查</button> : null}
      {manager?.agentSessionId ? <button type="button" className="goals-button" onClick={() => void run(async () => { await api.ui.openObjectLink(formatSessionAddress(manager.agentSessionId!)) })}>打开原 PMO</button>
        : <button type="button" className="goals-button" onClick={() => void run(chooseSupervisor)}>选择 Supervisor</button>}
    </div>
    {observed ? <p className="goal-patrol__feedback" role="status"><strong>{labels[observed.state]}</strong>{!compact ? <span>{observed.reason}</span> : null}</p> : null}
    {manager?.state === 'ended' ? <p className="goal-patrol__feedback">原管理 Run 已结束；打开原 PMO 恢复同一 Session，再接续或回报实际巡查。</p> : null}
    {patrol?.report ? <p className="goal-patrol__feedback">{patrol.report.summary}<span>下一步：{patrol.report.nextOwner.agentSessionId ?? patrol.report.nextOwner.kind} · {patrol.report.nextOwner.action}</span></p> : null}
    {issue ? <p className="goal-patrol__feedback" role="status">{issue}</p> : null}
    {!compact && patrol ? <details className="goal-patrol__source"><summary>原巡查与输入</summary><dl><dt>巡查 operation</dt><dd>{patrol.operationId}</dd>
      {patrol.attempts.map(a => <div key={a.operationId}><dt>原输入</dt><dd>{a.operationId}</dd><dt>PMO Host / Session / Run</dt><dd>{a.target.hostId} / {a.target.agentSessionId} / {a.target.runId}</dd><dt>尝试</dt><dd>{a.attemptedAt ? '已尝试 · 只对账' : a.supersededAt ? '显式接续 · 原引用保留' : '尚未尝试'}</dd></div>)}
      {patrol.report ? <><dt>实际回报 Run</dt><dd>{patrol.report.reportingRunId}</dd><dt>业务回填</dt><dd>{patrol.report.applied ? '已应用；人的接受仍独立' : '仅留历史；未覆盖当前工作'}</dd></> : null}</dl></details> : null}
  </div>
}
