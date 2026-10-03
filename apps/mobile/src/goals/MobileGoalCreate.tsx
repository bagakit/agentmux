import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcResult } from '@agentmux/core'
import { assertGoalIntentScope, goalIntentScope, useGoalIntents } from './goal-intents'
import { MobileRecoveryPanel } from '../recovery/MobileRecoveryPanel'
import type { GoalCreationInput, GoalIntent, GoalIntentScope } from '../recovery/device-workface'

type Creation = { input: GoalCreationInput; target: GoalIntentScope; present: () => boolean; phase: 'saving' | 'unknown' | 'not-saved' | 'pmo' | 'ready'; issue: string }
export type GoalDiscussionReceipt = AgentMuxRpcResult<'goal.discuss'>['receipt']

/** One explicit click, one caller-held identity, and the original Goal owner. */
export function MobileGoalCreate({ client, visible, created, openDiscussion, beginPresentation }: {
  client: AgentMuxHostedClient | null; visible: boolean; created(goal: AgentMuxRpcGoal, present: () => boolean): void
  openDiscussion(receipt: GoalDiscussionReceipt): void
  beginPresentation(): () => boolean
}) {
  const { owner, issue: deviceIssue, intents } = useGoalIntents(client)
  const [projects, setProjects] = useState<AgentMuxRpcResult<'app.snapshot'>['projects']>([])
  const [projectId, setProjectId] = useState(''), [directoryIssue, setDirectoryIssue] = useState('')
  const [revision, reread] = useState(0), [request, setRequest] = useState<Creation | null>(null)
  const [busy, setBusy] = useState(false), flight = useRef(false)
  const retained = intents.find(intent => intent.kind === 'create')
  const retainedRunning = retained ? owner.goalIntentRunning(retained.operationId) : false
  useEffect(() => {
    if (flight.current || !retained || retained.kind !== 'create') return
    setRequest(previous => previous?.input.operationId === retained.operationId ? previous.phase === 'saving' && !retainedRunning ? { ...previous, phase: 'unknown' } : previous : {
      input: retained.input, target: retained, present: () => false,
      phase: retained.phase === 'saved' ? 'pmo' : 'unknown',
      issue: retained.phase === 'saved' ? '原目标已确认保存；请明确打开这同一个目标的原讨论。' : '重启或重入后的原创建回执未知；准确 Goal ID 和请求保留，先读取同一目标，不会重复创建。'
    })
  }, [retained?.operationId, retained?.phase, retainedRunning])
  const intent = (value: Creation): GoalIntent => ({ ...value.target, kind: 'create', goalId: value.input.goalId, operationId: value.input.operationId, phase: 'sending', input: value.input })
  useEffect(() => {
    if (!visible || !client?.forwardRpc) return
    let live = true
    void client.forwardRpc('app.snapshot', { include: ['projects'] }).then(result => {
      if (live) { setProjects(result.projects); setDirectoryIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setDirectoryIssue(`项目目录读取失败：${error instanceof Error ? error.message : String(error)}。原选择保留，可刷新核对。`) })
    return () => { live = false }
  }, [client, visible, revision])
  async function discussion(value: Creation, goal: AgentMuxRpcGoal) {
    setRequest({ ...value, phase: 'pmo', issue: '原目标已确认保存，正在打开它的主 Mote 讨论。' })
    const input = { goalId: value.input.goalId, mode: 'open' as const, operationId: crypto.randomUUID() }
    try {
      assertGoalIntentScope(client, owner, intent(value))
      const result = await client!.forwardRpc!('goal.discuss', input)
      if (result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.operationId !== input.operationId || result.receipt.mode !== 'open') throw new Error('原讨论回执身份未匹配。')
      setRequest({ ...value, phase: 'ready', issue: result.receipt.agentSessionId ? '原目标已保存，并打开了它的原主 Mote 讨论。' : '原目标已保存，专属 Tab 已保留。Agent 尚未接上；请在 Mac 的原主 Mote 工作面选择 Agent 并启动。' })
      owner.settleGoalIntent(intent(value), 'confirmed')
      if (value.present()) openDiscussion(result.receipt)
    } catch (error) {
      setRequest({ ...value, phase: 'pmo', issue: `原目标已保存，讨论回执未确认：${error instanceof Error ? error.message : String(error)}。原目标和可能已建立的专属 Tab 保留；明确打开仍沿同一目标，不重新创建或发送 Prompt。` })
    }
  }
  async function save(value: Creation) {
    try {
      const result = await client!.forwardRpc!('goal.create', value.input)
      if (result.goal.id !== value.input.goalId || result.receipt.goalId !== value.input.goalId) throw new Error('原创建回执身份未匹配。')
      owner.releaseGoalIntent(intent(value)); owner.settleGoalIntent(intent(value), 'saved')
      created(result.goal, value.present); await discussion(value, result.goal)
    } catch (error) {
      owner.releaseGoalIntent(intent(value))
      try { owner.settleGoalIntent(intent(value), 'unknown') } catch { /* Original durable intent remains the recovery guard. */ }
      setRequest({ ...value, phase: 'unknown', issue: `创建回执未确认：${error instanceof Error ? error.message : String(error)}。准确 Goal ID 和请求保留；先读取这同一个目标，不会重复创建。` })
    }
  }
  async function invoke(action: 'new' | 'read' | 'save-same' | 'open') {
    if (flight.current) return
    if (!client?.forwardRpc) { setDirectoryIssue('请求未发送：原目标公共端口暂不可用；原目标与创建记录保留。'); return }
    flight.current = true; setBusy(true)
    try {
      if (action === 'new') {
        if (request && request.phase !== 'ready') return
        const value: Creation = { input: { goalId: `demand_${crypto.randomUUID()}`, title: 'Untitled goal', description: '', status: 'backlog', ...(projectId ? { projectId } : {}), risk: 'low', confirmation: 'user', operationId: crypto.randomUUID() }, target: goalIntentScope(client, owner), present: beginPresentation(), phase: 'saving', issue: '正在保存待定义目标；创建不会开始执行。' }
        setRequest(value); owner.retainGoalIntent(intent(value)); await save(value)
      } else if (request && action === 'save-same' && request.phase === 'not-saved') {
        const value = { ...request, phase: 'saving' as const, issue: '正在明确保存原 ID 的同一个目标。' }
        assertGoalIntentScope(client, owner, intent(value))
        owner.settleGoalIntent(intent(value), 'confirmed'); owner.retainGoalIntent(intent(value))
        const next = { ...value, present: beginPresentation() }; setRequest(next); await save(next)
      } else if (request) {
        const presentation = beginPresentation()
        try {
          assertGoalIntentScope(client, owner, intent(request))
          if (owner.goalIntentRunning(request.input.operationId)) throw new Error('原创建仍在等待回执，读取不能代签在途保存。')
          const result = await client.forwardRpc('goal.inspect', { goalId: request.input.goalId })
          if (result.goal === null) { setRequest({ ...request, phase: 'not-saved', issue: '原 owner 完整读取确认这个准确 ID 尚未保存。可明确保存同一 ID；不会另建实例。' }); return }
          if (result.goal.id !== request.input.goalId) throw new Error('其他目标不能代签原创建结果。')
          owner.settleGoalIntent(intent(request), 'saved')
          const value = { ...request, present: presentation }
          created(result.goal, value.present); await discussion(value, result.goal)
        } catch (error) { setRequest({ ...request, issue: `读取同一目标未确认：${error instanceof Error ? error.message : String(error)}。准确 ID 和请求保留，不会再次创建。` }) }
      }
    } catch (error) { setDirectoryIssue(`本次请求未发送：${error instanceof Error ? error.message : String(error)}。原设备意图保留，请恢复设备存储并核对原目标。`) }
    finally { flight.current = false; setBusy(false) }
  }
  return <section className="mobile-goal-create" aria-label="新建目标">
    {visible && <>
      <button type="button" disabled={busy || !!retained || !!request && request.phase !== 'ready'} onClick={() => void invoke('new')}>{busy ? '原目标操作中…' : '新建目标'}</button>
      <details><summary>新目标的项目上下文</summary><label>项目<select aria-label="新目标项目" value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}><option value="">未分配项目</option>{projectId && !projects.some(project => project.projectId === projectId) && <option value={projectId}>原项目暂未确认</option>}{projects.map(project => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select></label><button type="button" onClick={() => reread(value => value + 1)}>刷新项目目录</button></details>
    </>}
    {directoryIssue && <p role="status">{directoryIssue}</p>}{deviceIssue && <p role="status">{deviceIssue}</p>}
    {owner.snapshot().issue && <details><summary>保全设备意图</summary><MobileRecoveryPanel onRestored={() => reread(value => value + 1)} /><button type="button" onClick={() => { try { owner.replaceUnreadableWithCurrent(); setDirectoryIssue('当前工作面已保存，原 Goal 意图继续沿同一身份核对。') } catch { setDirectoryIssue('设备存储仍不可写；原字节和当前内存意图保留，可继续原 Goal 操作并导出备份。') } }}>存储恢复后保存当前工作面</button></details>}
    {request && request.phase !== 'ready' && <><p role="status">{request.issue}</p>
      {request.phase === 'unknown' && <button type="button" disabled={busy} onClick={() => void invoke('read')}>读取同一目标核对</button>}
      {request.phase === 'not-saved' && <button type="button" disabled={busy} onClick={() => void invoke('save-same')}>明确保存同一目标</button>}
      {request.phase === 'pmo' && !busy && <button type="button" onClick={() => void invoke('open')}>打开这个目标的原讨论</button>}
      <details><summary>原创建身份与请求</summary><code>{request.input.goalId}</code><pre>{JSON.stringify(request.input, null, 2)}</pre></details>
    </>}
  </section>
}
