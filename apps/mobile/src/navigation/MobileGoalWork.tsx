import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, ExternalLink, RefreshCw, Target } from 'lucide-react'
import type { AgentMuxRpcGoal, ContinuousProgressLoop } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { getDeviceWorkface, type GoalWorkSelection, type MobileGoalOperation } from '../recovery/device-workface'
import { admitsGoalWorkTarget, assertGoalAssociation, goalWorkTarget, inspectGoal, sendGoalOperation, type MobileGoalDetail } from './goal-work'

const statusText = { active: '持续推进中', paused: '已暂停', stopped: '已停止' }
const goalStatusText = { backlog: '待安排', todo: '待开始', in_progress: '进行中', in_review: '待验收', blocked: '需要处理', done: '已完成', cancelled: '已取消' }
const actionText = { pause: '暂停', resume: '恢复', stop: '停止续跑', check: '检查进度' }

/** This surface reads and controls the original Host Goal. It owns no clock or execution lifecycle. */
export function MobileGoalWork({ client, agentSessionId, connected, visible }: {
  client: AgentMuxHostedClient | null; agentSessionId: string | null; connected: boolean; visible: boolean
}) {
  const owner = getDeviceWorkface()
  const [selection, setSelection] = useState<GoalWorkSelection | null>(null)
  const goalId = selection?.sessionId === agentSessionId ? selection.goalId : null
  const [goals, setGoals] = useState<{ sessionId: string; runtimeId: string; deviceHostId: string | null; rows: AgentMuxRpcGoal[] }>()
  const [detail, setDetail] = useState<{ target: GoalWorkSelection; value: MobileGoalDetail }>()
  const [minutes, setMinutes] = useState('30')
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState(owner.snapshot().record.goalWork?.pending ?? [])
  const [working, setWorking] = useState<object | null>(null)
  const occurrence = useMemo(() => ({}), [client, agentSessionId, selection, connected, visible])
  const current = useRef(occurrence); current.current = occurrence
  const flight = useRef<object | null>(null)
  const busy = working === occurrence
  const isCurrent = () => current.current === occurrence && connected && visible
  const actual = detail && selection && selection.sessionId === agentSessionId && admitsGoalWorkTarget(selection, detail.target) ? detail.value : null
  const saved = pending.filter(op => selection && selection.sessionId === agentSessionId
    && (admitsGoalWorkTarget(op, selection) || admitsGoalWorkTarget(selection, op)))
  const loops = actual?.goalContinuations.filter(loop => loop.agentSessionId === agentSessionId) ?? []
  let sourceConfirmed = false, listConfirmed = false
  try {
    const runtime = connected ? client?.runtimeOwnerIdentity() : null
    const hostId = owner.snapshot().record.host?.hostId ?? null
    sourceConfirmed = Boolean(runtime?.availability === 'connected' && selection?.sessionId === agentSessionId && selection.runtimeId === runtime.runtimeId && (selection.deviceHostId === null || selection.deviceHostId === hostId))
    listConfirmed = Boolean(runtime?.availability === 'connected' && goals?.runtimeId === runtime.runtimeId && goals.deviceHostId === hostId)
  } catch { /* Keep the original read projection; its service state is unconfirmed. */ }

  useEffect(() => {
    const saved = owner.snapshot().record.goalWork?.selection
    // Observation loss cannot erase the saved original selection or redirect it to a new Host.
    setSelection(saved?.sessionId === agentSessionId ? saved : null)
  }, [agentSessionId, owner])

  const read = async () => {
    if (!client?.forwardRpc || !agentSessionId || !isCurrent()) return
    const token = occurrence
    try {
      const runtime = client.runtimeOwnerIdentity()
      if (!runtime || runtime.availability !== 'connected') throw new Error('原 Host 的运行身份尚未确认，保留已有目标与原会话。')
      const deviceHostId = owner.snapshot().record.host?.hostId ?? null
      const result = await client.forwardRpc('goal.ls', { agentSessionId })
      const ids = new Set<string>()
      if (!Array.isArray(result.goals)) throw new Error('Host 目标目录尚未确认。')
      for (const goal of result.goals) {
        assertGoalAssociation(goal, goal.id, agentSessionId)
        if (ids.has(goal.id)) throw new Error('Host 目标目录存在重复引用；原选择保留。')
        ids.add(goal.id)
      }
      if (current.current !== token) return
      if (client.runtimeOwnerIdentity()?.runtimeId !== runtime.runtimeId || (owner.snapshot().record.host?.hostId ?? null) !== deviceHostId) throw new Error('读取期间原 Host 身份已变化；原目标记录保留。')
      setGoals({ sessionId: agentSessionId, runtimeId: runtime.runtimeId, deviceHostId, rows: result.goals })
      if (selection && selection.sessionId === agentSessionId) {
        if (selection.runtimeId !== runtime.runtimeId || selection.deviceHostId !== null && selection.deviceHostId !== deviceHostId) throw new Error('已保存的目标属于原 Host；保留原内容，不能向当前 Host 重定向。')
        const value = await inspectGoal(client, selection.goalId, agentSessionId)
        if (current.current !== token) return
        if (client.runtimeOwnerIdentity()?.runtimeId !== runtime.runtimeId || (owner.snapshot().record.host?.hostId ?? null) !== deviceHostId) throw new Error('读取期间原 Host 身份已变化；原目标记录保留。')
        setDetail({ target: goalWorkTarget(client, owner, agentSessionId, selection.goalId), value })
      }
      setPending(owner.snapshot().record.goalWork?.pending ?? [])
      setNotice(owner.snapshot().issue ?? undefined)
    } catch (error) { if (current.current === token) setNotice(error instanceof Error ? error.message : String(error)) }
  }
  useEffect(() => { if (connected && visible) void read() }, [occurrence])

  const choose = async (id: string) => {
    if (!client || !agentSessionId || !connected) return
    try {
      const target = goalWorkTarget(client, owner, agentSessionId, id)
      setSelection(target)
      await owner.selectGoal(target); setNotice(undefined)
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const showList = async () => {
    setSelection(null)
    try { await owner.selectGoal(null) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const perform = async (operation: MobileGoalOperation) => {
    if (!client || !sourceConfirmed || !selection || operation.sessionId !== agentSessionId
      || !(admitsGoalWorkTarget(operation, selection) || admitsGoalWorkTarget(selection, operation)) || !isCurrent() || flight.current === occurrence) return
    const token = occurrence
    flight.current = token; setWorking(token)
    try {
      await owner.retainGoalOperation(operation)
      setPending(owner.snapshot().record.goalWork?.pending ?? [])
      const value = await sendGoalOperation(client, owner, operation, () => current.current === token && connected && visible)
      if (current.current === token) {
        setDetail({ target: goalWorkTarget(client, owner, operation.sessionId, operation.goalId), value })
        const retained = owner.snapshot().record.goalWork?.pending ?? []
        setPending(retained)
        setNotice(retained.some(op => op.operationId === operation.operationId)
          ? '原开始输入的回执未知，续跑保持暂停。可检查并明确重试原操作；不会自动再发。' : owner.snapshot().issue ?? undefined)
      }
    } catch (error) {
      if (current.current === token) {
        setPending(owner.snapshot().record.goalWork?.pending ?? [])
        setNotice(`${error instanceof Error ? error.message : String(error)} 原操作已保留；不会自动重发。`)
      }
    } finally { if (flight.current === token) flight.current = null; if (current.current === token) setWorking(null) }
  }
  const start = () => {
    if (!client || !agentSessionId || !actual?.goal || actual.goal.alignment?.confirmedAt == null || saved.length) return
    const intervalMs = Number(minutes) * 60000
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000) return
    try { void perform({ ...goalWorkTarget(client, owner, agentSessionId, actual.goal.id), kind: 'start',
      operationId: randomClientRequestId(), intervalMs, alignmentRevision: actual.goal.alignment.revision }) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const action = (loop: ContinuousProgressLoop, action: 'pause' | 'resume' | 'stop' | 'check') => {
    if (!client || !agentSessionId || !goalId || saved.length || !loop.revision) return
    try { void perform({ ...goalWorkTarget(client, owner, agentSessionId, goalId), kind: 'action', loopId: loop.loopId,
      operationId: randomClientRequestId(), action, expectedRevision: loop.revision }) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const retryStart = (loop: ContinuousProgressLoop) => {
    if (!client || !agentSessionId || !goalId || !loop.creationOperationId || loop.taskSource?.kind !== 'goal') return
    try { void perform({ ...goalWorkTarget(client, owner, agentSessionId, goalId), kind: 'start',
      operationId: loop.creationOperationId, intervalMs: loop.intervalMs, alignmentRevision: loop.taskSource.alignmentRevision }) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
  }
  const focusOriginal = async () => {
    if (!client?.forwardRpc || !agentSessionId || !goalId || !sourceConfirmed || !isCurrent()) return
    const token = occurrence
    try {
      await inspectGoal(client, goalId, agentSessionId)
      if (current.current !== token || !isCurrent()) return
      if (!selection || !admitsGoalWorkTarget(selection, goalWorkTarget(client, owner, agentSessionId, goalId))) throw new Error('原 Host 身份已经变化，不能把原目标导航发送到当前 Host。')
      await client.forwardRpc('goal.focus', { goalId, input: 'preserve' })
    } catch (error) { if (current.current === token) setNotice(error instanceof Error ? error.message : String(error)) }
  }

  return <div className="mobile-goal-work">
    <div className="mobile-section-heading"><div><h1>{goalId ? actual?.goal?.title ?? '原目标' : '目标与结果'}</h1><p>{!connected ? 'Host 连接中断 · 保留上次确认的内容' : selection && !sourceConfirmed ? '原 Host 上次内容 · 当前连接尚未确认同一身份' : '原 Host 的工作进度'}</p></div><button className="mobile-icon-button" aria-label="刷新目标状态" disabled={!connected || busy} onClick={() => { void read() }}><RefreshCw size={18} /></button></div>
    {goalId ? <>
      <button className="mobile-text-button" onClick={showList}><ArrowLeft size={15} />全部目标</button>
      {actual?.goal ? <>
        <section className="mobile-goal-section"><div className="mobile-goal-kicker"><Target size={14} /><span>{goalStatusText[actual.goal.status]} · {actual.goal.alignment?.confirmedAt != null ? `范围已确认 · v${actual.goal.alignment.revision}` : '范围待确认'}</span></div>
          <p className="mobile-goal-summary">{actual.goal.alignment?.summary || actual.goal.description}</p>
          {actual.goal.alignment?.criteria.length ? <ul className="mobile-goal-criteria">{actual.goal.alignment.criteria.map(item => <li key={item.id}>{item.text}</li>)}</ul> : null}
          <button className="mobile-text-button" disabled={!sourceConfirmed} onClick={() => { void focusOriginal() }}><ExternalLink size={14} />在 Host 查看原目标</button></section>
        <section className="mobile-goal-section"><h2>持续推进</h2><p className="mobile-goal-meta">Host 在线且原 Agent 可用时执行；关闭页面不停止工作。</p>
          {loops.map(loop => <div className="mobile-goal-loop" key={loop.loopId}><strong>{statusText[loop.status]}</strong><small>每 {loop.intervalMs / 60000} 分钟检查 · v{loop.revision ?? '未确认'}</small>
            {loop.lastDecision && <p>{loop.lastDecision}</p>}
            {loop.initialDelivery?.state !== 'confirmed' && loop.status !== 'stopped' ? <p className="mobile-goal-meta">开始回执未确认，自动推进保持暂停。</p> : null}
            <div className="mobile-goal-actions">{(['pause', 'resume', 'check', 'stop'] as const).filter(value => value === 'stop' ? loop.status !== 'stopped' : value === 'resume' ? loop.status === 'paused' && loop.initialDelivery?.state === 'confirmed' : loop.status === 'active').map(value => <button key={value} disabled={!sourceConfirmed || busy || saved.length > 0 || !loop.revision} onClick={() => action(loop, value)}>{actionText[value]}</button>)}
              {!saved.length && loop.status !== 'stopped' && loop.creationOperationId && loop.initialDelivery?.state !== 'confirmed' ? <button disabled={!sourceConfirmed || busy} onClick={() => retryStart(loop)}>检查并重试原开始</button> : null}</div></div>)}
          {!loops.some(loop => loop.status !== 'stopped') && !saved.length ? <form className="mobile-goal-start" onSubmit={event => { event.preventDefault(); start() }}><label>检查间隔<TextInput aria-label="目标检查间隔（分钟）" type="number" min="1" value={minutes} onChange={event => setMinutes(event.target.value)} /><span>分钟</span></label><button disabled={!sourceConfirmed || busy || actual.goal.alignment?.confirmedAt == null || actual.goal.status === 'done' || actual.goal.status === 'cancelled' || !Number.isSafeInteger(Number(minutes) * 60000) || Number(minutes) < 1}>开始并持续推进</button></form> : null}
        </section>
        <section className="mobile-goal-section"><h2><CheckCircle2 size={16} />成果与验收</h2>{actual.goal.grounding ? <><p className="mobile-goal-summary">{actual.goal.grounding.summary}</p><p className="mobile-goal-meta">{actual.goal.grounding.acceptedAt != null ? '已由人确认验收' : '成果已提交，等待人验收'} · 范围 v{actual.goal.grounding.alignmentRevision}{actual.goal.alignment?.revision !== actual.goal.grounding.alignmentRevision ? '（与当前范围不同）' : ''}</p>{actual.goal.grounding.checks.map(item => <div className="mobile-goal-result" key={item.criterionId}><strong>{actual.goal?.alignment?.revision !== undefined && actual.goal.alignment.revision === actual.goal.grounding?.alignmentRevision ? actual.goal?.alignment?.criteria.find(criterion => criterion.id === item.criterionId)?.text ?? item.criterionId : item.criterionId}</strong><small>{item.outcome === 'met' ? '已满足' : item.outcome === 'gap' ? '仍有缺口' : '尚未确认'}</small><p>{item.note}</p>{item.evidence.map((path, index) => <code key={index}>{path}</code>)}</div>)}</> : <p className="mobile-goal-meta">尚未提交验收成果。完成状态不会代替人的验收。</p>}
          {actual.goal.activityLog?.length ? <details><summary>最近工作记录</summary>{actual.goal.activityLog.slice(-5).map((item, index) => <p key={index}>{item}</p>)}</details> : null}</section>
      </> : <p className="mobile-spatial-notice">原目标引用保留；连接恢复后读取准确目标，不创建替代工作。</p>}
      {saved.map(operation => <aside className="mobile-goal-pending" key={operation.operationId}><strong>原{operation.kind === 'start' ? '开始' : actionText[operation.action]}操作待确认</strong><p>重试会先核对原 Host、目标和版本，再使用同一操作 ID。</p><button disabled={!sourceConfirmed || busy} onClick={() => { void perform(operation) }}>检查并重试原{operation.kind === 'start' ? '开始' : actionText[operation.action]}</button></aside>)}
    </> : <ul className="mobile-goal-list">{goals?.sessionId === agentSessionId ? goals.rows.map(goal => <li key={goal.id}><button aria-label={`查看目标 ${goal.title}`} disabled={!connected || !listConfirmed} onClick={() => choose(goal.id)}><Target size={18} /><span><strong>{goal.title}</strong><small>{goal.alignment?.summary || goal.description || goal.status}</small></span></button></li>) : null}
      {goals?.sessionId === agentSessionId && !goals.rows.length ? <li className="mobile-spatial-empty">此 Agent 尚未关联目标，可在 Host 的原 Goal 页面设定。</li> : null}</ul>}
    {!goalId && pending.filter(op => op.sessionId === agentSessionId).map(op => <aside className="mobile-goal-pending" key={op.operationId}><strong>原目标操作待确认</strong><p>原目标引用与操作 ID 已保留。读取和重试仍须核对原 Host 与 Agent。</p><button onClick={() => {
      setSelection({ runtimeId: op.runtimeId, deviceHostId: op.deviceHostId, sessionId: op.sessionId, goalId: op.goalId })
    }}>查看原待确认目标</button></aside>)}
    {notice && <p className="mobile-goal-notice" role="status">{notice}</p>}
  </div>
}
