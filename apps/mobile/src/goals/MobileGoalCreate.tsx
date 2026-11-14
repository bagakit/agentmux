import { MobileNotice } from '../notices/MobileNotice'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { mintObjectId } from '@agentmux/core/object-id'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcResult } from '@agentmux/core'
import { assertGoalIntentScope, goalIntentScope, useGoalIntents } from './goal-intents'
import { MobileRecoveryPanel } from '../recovery/MobileRecoveryPanel'
import type { GoalCreationInput, GoalIntent, GoalIntentScope } from '../recovery/device-workface'

type Creation = { recordId: string | null; input: GoalCreationInput; target: GoalIntentScope; present: () => boolean; phase: 'saving' | 'unknown' | 'not-saved' | 'pmo' | 'ready'; issue: string }
export type GoalDiscussionReceipt = AgentMuxRpcResult<'goal.discuss'>['receipt']

/** One explicit click, one caller-held identity, and the original Goal owner. */
export function MobileGoalCreate({ client, visible, presented = true, expanded, created, openDiscussion, beginPresentation }: {
  client: AgentMuxHostedClient | null; visible: boolean; presented?: boolean; expanded: boolean; created(goal: AgentMuxRpcGoal, present: () => boolean): void
  openDiscussion(receipt: GoalDiscussionReceipt): void
  beginPresentation(): () => boolean
}) {
  const { owner, issue: deviceIssue, intents } = useGoalIntents(client)
  const [projects, setProjects] = useState<AgentMuxRpcResult<'app.snapshot'>['projects']>([])
  const [projectId, setProjectId] = useState(''), [directoryIssue, setDirectoryIssue] = useState('')
  const [revision, reread] = useState(0), [request, setRequest] = useState<Creation | null>(null)
  const [busy, setBusy] = useState(false), flight = useRef(false)
  const projectInput = useRef<HTMLSelectElement>(null)
  useEffect(() => { if (visible && expanded) projectInput.current?.focus() }, [visible, expanded])
  const retained = intents.find(intent => intent.kind === 'create')
  const retainedRunning = retained ? owner.goalIntentRunning(retained.operationId) : false
  useEffect(() => {
    if (flight.current || !retained || retained.kind !== 'create') return
    setRequest(previous => previous?.input.operationId === retained.operationId ? previous.phase === 'saving' && !retainedRunning ? { ...previous, phase: 'unknown' } : previous : {
      recordId: owner.recordIdentity(), input: retained.input, target: retained, present: () => false,
      phase: retained.phase === 'saved' ? 'pmo' : 'unknown',
      issue: retained.phase === 'saved' ? '目标已保存，请打开它的讨论。' : '还不确定目标是否已创建，请读取同一目标核对。'
    })
  }, [retained?.operationId, retained?.phase, retainedRunning])
  const intent = (value: Creation): GoalIntent => ({ ...value.target, kind: 'create', goalId: value.input.goalId, operationId: value.input.operationId, phase: 'sending', input: value.input })
  useEffect(() => {
    if (!visible || !client?.forwardRpc) return
    let live = true
    void client.forwardRpc('app.snapshot', { include: ['projects'] }).then(result => {
      if (live) { setProjects(result.projects); setDirectoryIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setDirectoryIssue(`项目目录读取失败：${error instanceof Error ? error.message : String(error)}。可以刷新重试。`) })
    return () => { live = false }
  }, [client, visible, revision])
  async function discussion(value: Creation, goal: AgentMuxRpcGoal) {
    const original = owner.snapshot().record.goalIntents?.find(item => item.operationId === value.input.operationId)
    setRequest({ ...value, phase: 'pmo', issue: '目标已保存，正在打开主 Mote 讨论…' })
    const input = { goalId: value.input.goalId, mode: 'grill' as const, operationId: randomClientRequestId() }
    try {
      assertGoalIntentScope(client, owner, intent(value))
      const result = await client!.forwardRpc!('goal.discuss', input)
      if (result.receipt.route !== 'discussion' || result.goal.id !== goal.id || result.receipt.goalId !== goal.id || result.receipt.operationId !== input.operationId || result.receipt.mode !== 'grill') throw new Error('返回的讨论与这次请求不一致')
      setRequest({ ...value, phase: 'ready', issue: result.receipt.agentSessionId ? '目标已保存，已打开主 Mote 讨论。' : '目标已保存，还没有 Agent 接上；请在 Mac 上为主 Mote 选择 Agent 并启动。' })
      await owner.settleGoalIntent(intent(value), 'confirmed', value.recordId, original)
      if (value.present()) openDiscussion(result.receipt)
    } catch (error) {
      setRequest({ ...value, phase: 'pmo', issue: `目标已保存，讨论还没确认：${error instanceof Error ? error.message : String(error)}。可以再次打开这个目标的讨论。` })
    }
  }
  async function save(value: Creation) {
    const original = owner.snapshot().record.goalIntents?.find(item => item.operationId === value.input.operationId)
    try {
      const result = await client!.forwardRpc!('goal.create', value.input)
      if (result.goal.id !== value.input.goalId || result.receipt.goalId !== value.input.goalId) throw new Error('返回的目标与这次创建不一致')
      owner.releaseGoalIntent(intent(value), value.recordId); await owner.settleGoalIntent(intent(value), 'saved', value.recordId, original)
      created(result.goal, value.present); await discussion(value, result.goal)
    } catch (error) {
      owner.releaseGoalIntent(intent(value), value.recordId)
      try { await owner.settleGoalIntent(intent(value), 'unknown', value.recordId, original) } catch { /* Original durable intent remains the recovery guard. */ }
      setRequest({ ...value, phase: 'unknown', issue: `Mac 还没确认创建：${error instanceof Error ? error.message : String(error)}。请读取同一目标核对。` })
    }
  }
  async function invoke(action: 'new' | 'read' | 'save-same' | 'open') {
    if (flight.current) return
    if (!client?.forwardRpc) { setDirectoryIssue('请求未发送：Mac 上的目标服务暂不可用。'); return }
    flight.current = true; setBusy(true)
    try {
      if (action === 'new') {
        if (request && request.phase !== 'ready') return
        const value: Creation = { recordId: owner.recordIdentity(), input: { goalId: mintObjectId(), title: 'Untitled goal', description: '', status: 'backlog', ...(projectId ? { projectId } : {}), risk: 'low', confirmation: 'user', operationId: randomClientRequestId() }, target: goalIntentScope(client, owner), present: beginPresentation(), phase: 'saving', issue: '正在保存新目标…' }
        setRequest(value); await owner.retainGoalIntent(intent(value), value.recordId); await save(value)
      } else if (request && action === 'save-same' && request.phase === 'not-saved') {
        const value = { ...request, phase: 'saving' as const, issue: '正在保存同一个目标…' }
        assertGoalIntentScope(client, owner, intent(value))
        await owner.settleGoalIntent(intent(value), 'confirmed', value.recordId); await owner.retainGoalIntent(intent(value), value.recordId)
        const next = { ...value, present: beginPresentation() }; setRequest(next); await save(next)
      } else if (request) {
        const presentation = beginPresentation()
        try {
          assertGoalIntentScope(client, owner, intent(request))
          if (owner.goalIntentRunning(request.input.operationId)) throw new Error('创建还在等待 Mac 确认')
          const original = owner.snapshot().record.goalIntents?.find(item => item.operationId === request.input.operationId)
          const result = await client.forwardRpc('goal.inspect', { goalId: request.input.goalId })
          if (result.goal === null) { setRequest({ ...request, phase: 'not-saved', issue: 'Mac 上还没有这个目标，可以保存同一目标。' }); return }
          if (result.goal.id !== request.input.goalId) throw new Error('读到的不是这次创建的目标')
          await owner.settleGoalIntent(intent(request), 'saved', request.recordId, original)
          const value = { ...request, present: presentation }
          created(result.goal, value.present); await discussion(value, result.goal)
        } catch (error) { setRequest({ ...request, issue: `读取同一目标没有完成：${error instanceof Error ? error.message : String(error)}。可以再试一次。` }) }
      }
    } catch (error) { setDirectoryIssue(`请求未发送：${error instanceof Error ? error.message : String(error)}。请先恢复这台手机的存储，再核对目标。`) }
    finally { flight.current = false; setBusy(false) }
  }
  return <section className="mobile-goal-create" aria-label="新建目标">
    <div className="mobile-goal-create__form" hidden={!presented || !expanded}>

      <label>新目标的项目<select ref={projectInput} aria-label="新目标项目" value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)}><option value="">未分配项目</option>{projectId && !projects.some(project => project.projectId === projectId) && <option value={projectId}>项目未确认</option>}{projects.map(project => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select></label><Button type="button" onClick={() => reread(value => value + 1)}>刷新项目目录</Button>
      <Button variant="primary" type="button" disabled={busy || !!retained || !!request && request.phase !== 'ready'} onClick={() => void invoke('new')}>{busy ? '处理中…' : '创建目标'}</Button>
    </div>
    {directoryIssue && <MobileNotice kind="feedback" identity={[directoryIssue,deviceIssue]} role="status">{directoryIssue}</MobileNotice>}{deviceIssue && <MobileNotice identity={[directoryIssue,deviceIssue]} role="status">{deviceIssue}</MobileNotice>}
    {owner.snapshot().issue && <details><summary>保全设备意图</summary><MobileRecoveryPanel onRestored={() => reread(value => value + 1)} /><Button type="button" onClick={async () => { try { await owner.replaceUnreadableWithCurrent(); setDirectoryIssue('已保存当前工作面。') } catch { setDirectoryIssue('这台手机的存储仍不可写；可以继续操作并导出备份。') } }}>存储恢复后保存当前工作面</Button></details>}
    {request && request.phase !== 'ready' && <><MobileNotice dismissible={!busy && request.phase !== "saving"} kind={busy || request.phase === "saving" ? "feedback" : "warning"} identity={[request?.input.operationId,request?.phase,request?.issue]} role="status">{request.issue}</MobileNotice>
      {request.phase === 'unknown' && <Button type="button" disabled={busy} onClick={() => void invoke('read')}>读取同一目标核对</Button>}
      {request.phase === 'not-saved' && <Button type="button" disabled={busy} onClick={() => void invoke('save-same')}>明确保存同一目标</Button>}
      {request.phase === 'pmo' && !busy && <Button type="button" onClick={() => void invoke('open')}>打开这个目标的讨论</Button>}
      <details><summary>创建请求详情</summary><code>{request.input.goalId}</code><pre>{JSON.stringify(request.input, null, 2)}</pre></details>
    </>}
  </section>
}
