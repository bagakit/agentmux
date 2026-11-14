import { MobileNotice } from '../notices/MobileNotice'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { TextInput } from '@agentmux/client-ui/input'
import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcResult } from '@agentmux/core'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import { beginGoalOperation, finishGoalOperation } from './goal-operation-recovery'
import { mobileGoalReferenceLabel } from './presentation'
import { demandAgentReferenceKey, mergeDemandAgentReferences, type DemandAgentReference } from '@agentmux/demand/relations'

export function MobileGoalActions({ client, goal, visible, updated, deleted }: {
  client: AgentMuxHostedClient | null; goal: AgentMuxRpcGoal; visible: boolean
  updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void; deleted(id: string): void
}) {
  const [expanded, expand] = useState(false), [sessions, setSessions] = useState<AgentMuxRpcResult<'app.snapshot'>['sessions']>([])
  const [assigneeIds, setAssigneeIds] = useState((goal.assigneeSessionIds ?? []).filter(value => typeof value === 'string').join(', ')), [sessionId, setSessionId] = useState('')
  const [sourceAssignees, setSourceAssignees] = useState(() => (goal.assigneeSessionIds ?? []).filter(value => typeof value !== 'string'))
  const initialAssignees = useRef({ text: assigneeIds, references: goal.assigneeSessionIds ?? [] })
  const [supervisorId, setSupervisorId] = useState<DemandAgentReference>(goal.supervisorSessionId ?? '')
  const [discoveryIssue, setDiscoveryIssue] = useState(''), [revision, refresh] = useState(0)
  const [messages, setMessages] = useState<Array<{ operationId: string; text: string; action: string; request: Record<string, unknown> }>>([])
  const [pending, setPending] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const inFlight = useRef(false)
  const sourceAssigneeKey = JSON.stringify(sourceAssignees.map(demandAgentReferenceKey))
  const original = useRef({ assigneeIds, sourceAssigneeKey, supervisorId, sessionId })
  const local = useRef({ assigneeIds, sourceAssigneeKey, supervisorId, sessionId })
  local.current = { assigneeIds, sourceAssigneeKey, supervisorId, sessionId }
  useMobileWebUpdateSafetyOwner(() => {
    if (local.current.assigneeIds !== original.current.assigneeIds || local.current.sourceAssigneeKey !== original.current.sourceAssigneeKey || local.current.supervisorId !== original.current.supervisorId || local.current.sessionId !== original.current.sessionId) return '目标操作有未保存的输入；请先保存、清空或撤销修改，再更新网页。'
    return null
  })
  useEffect(() => {
    if (!expanded || !visible || !client?.forwardRpc) return
    let live = true
    void client.forwardRpc('app.snapshot', { include: ['sessions'] }).then(result => {
      if (live) { setSessions(result.sessions); setDiscoveryIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setDiscoveryIssue(`读取会话目录失败：${error instanceof Error ? error.message : String(error)}。可以刷新重试。`) })
    return () => { live = false }
  }, [client, expanded, visible, revision])
  const execute = async (action: 'assign' | 'start' | 'handoff' | 'delete') => {
    if (inFlight.current) return
    const operationId = randomClientRequestId()
    const common = { goalId: goal.id, operationId }
    let request: Record<string, unknown> = common
    let operation: ReturnType<typeof beginGoalOperation> | undefined
    const report = (text: string) => setMessages(values => [...values, { operationId, text, action, request }])
    if (!client?.forwardRpc) { report('操作未发送：Mac 上的目标服务暂不可用。'); return }
    inFlight.current = true; setPending(true)
    let presentReceipt: () => void = () => {}
    try {
      const rawAssignees = assigneeIds === initialAssignees.current.text ? initialAssignees.current.references.filter(value => typeof value === 'string') : assigneeIds.split(',').map(value => value.trim()).filter(Boolean)
      const selection = mergeDemandAgentReferences(sourceAssignees, rawAssignees), selectedKeys = new Set(selection.map(demandAgentReferenceKey))
      const assigneeSessionIds = mergeDemandAgentReferences(initialAssignees.current.references.filter(reference => selectedKeys.has(demandAgentReferenceKey(reference))), selection)
      if (action === 'delete') {
        const params = { ...common, confirmation: 'delete' as const }; request = params
        operation = beginGoalOperation(client, 'goal.delete', params)
        const result = await client.forwardRpc('goal.delete', params, undefined, operation.fence)
        presentReceipt = () => deleted(result.goal.id)
      } else if (action === 'assign') {
        const params = { ...common, assigneeSessionIds, supervisorSessionId: typeof supervisorId === 'string' ? supervisorId.trim() || null : supervisorId, expectedUpdatedAt: goal.updatedAt, start: false }; request = params
        operation = beginGoalOperation(client, 'goal.assign', params)
        original.current = { ...original.current, assigneeIds, sourceAssigneeKey, supervisorId }
        const result = await client.forwardRpc('goal.assign', params, undefined, operation.fence)
        presentReceipt = () => { updated(result.goal, ['assigneeSessionIds', 'supervisorSessionId', 'sessionIds', 'activityLog']); report('负责人分配已保存，未开始执行。') }
      } else if (action === 'handoff') {
        const params = { ...common, assigneeSessionIds, supervisorSessionId: typeof supervisorId === 'string' ? supervisorId.trim() || null : supervisorId, expectedUpdatedAt: goal.updatedAt, ...(sessionId ? { sessionId } : {}) }; request = params
        operation = beginGoalOperation(client, 'goal.handoff', params)
        original.current = { assigneeIds, sourceAssigneeKey, supervisorId, sessionId }
        const result = await client.forwardRpc('goal.handoff', params, undefined, operation.fence)
        presentReceipt = () => { updated(result.goal, ['assigneeSessionIds', 'supervisorSessionId', 'sessionIds', 'activityLog']); report('交接关系已保存，未自动发送新任务。') }
      } else {
        const params = { ...common, ...(sessionId ? { sessionId } : {}) }; request = params
        operation = beginGoalOperation(client, 'goal.start', params)
        original.current = { ...original.current, sessionId }
        const result = await client.forwardRpc('goal.start', params, undefined, operation.fence)
        presentReceipt = () => { updated(result.goal, ['status', 'sessionIds', 'activityLog']); report(result.receipt.sessionId ? '开始请求已处理；请在关联会话查看实际执行。' : '开始请求已返回，执行会话尚未确认。') }
      }
    } catch (error) {
      if (operation) void finishGoalOperation(operation, false)
      report(`Mac 还没确认${action === 'delete' ? '删除' : action === 'start' ? '开始执行' : action === 'handoff' ? '交接' : '分配'}：${error instanceof Error ? error.message : String(error)}。请读取当前目标核对。`)
      return
    }
    finally { inFlight.current = false; setPending(false) }
    if (operation) void finishGoalOperation(operation, true)
    try { presentReceipt() } catch (error) { report(`Mac 已确认操作，但页面没能更新：${error instanceof Error ? error.message : String(error)}。请重新读取目标。`) }
  }
  return <details onToggle={event => expand(event.currentTarget.open)}><summary>分配、执行与删除</summary>
    {discoveryIssue && <MobileNotice identity={[discoveryIssue]} role="status">{discoveryIssue}</MobileNotice>}
    <label>负责人会话<TextInput aria-label="负责人会话 ID" list={`goal-assignees-${goal.id}`} value={assigneeIds} onChange={event => { local.current.assigneeIds = event.target.value; setAssigneeIds(event.target.value) }} placeholder="会话 ID，多个用逗号分隔，留空表示未分配" /></label>
    {sourceAssignees.map(reference => <div key={demandAgentReferenceKey(reference)}><p>{mobileGoalReferenceLabel(reference)} <button onClick={() => setSourceAssignees(values => values.filter(value => demandAgentReferenceKey(value) !== demandAgentReferenceKey(reference)))}>移除此负责人关系</button></p><details><summary>完整来源身份</summary><pre>{JSON.stringify(reference, null, 2)}</pre></details></div>)}
    <datalist id={`goal-assignees-${goal.id}`}>{sessions.map(item => <option key={item.session.agentSessionId} value={item.session.agentSessionId}>{item.session.agentSessionId} · {item.session.providerId}</option>)}</datalist>
    {typeof supervisorId === 'string' ? <label>Supervisor 会话<TextInput aria-label="Supervisor 会话 ID" value={supervisorId} onChange={event => { local.current.supervisorId = event.target.value; setSupervisorId(event.target.value) }} placeholder="一个会话 ID，留空表示不指定" /></label>
      : <div><p>Supervisor · {mobileGoalReferenceLabel(supervisorId)} <button onClick={() => setSupervisorId('')}>更换 Supervisor</button></p><details><summary>完整来源身份</summary><pre>{JSON.stringify(supervisorId, null, 2)}</pre></details></div>}
    <button onClick={() => refresh(value => value + 1)}>刷新会话目录</button>
    <button disabled={pending} onClick={() => { void execute('assign') }}>保存负责人分配</button>
    <label>执行或交接的会话<TextInput aria-label="执行或交接的会话 ID" value={sessionId} onChange={event => { local.current.sessionId = event.target.value; setSessionId(event.target.value) }} placeholder="会话 ID（可选）" /></label>
    <p>填写会话时明确指向它；不填写时，开始执行需有唯一准确负责人。交接只保存明确负责人和历史关系，不启动或重绑循环。</p>
    <button disabled={pending} onClick={() => { void execute('start') }}>开始执行此目标</button>
    <button disabled={pending} onClick={() => { void execute('handoff') }}>保存交接关系</button>
    <details><summary>删除目标</summary><p>删除这个目标；关联的 Agent 会话会保留。</p>
      {!confirmDelete ? <button onClick={() => setConfirmDelete(true)}>删除目标…</button> : <><p>确认删除「{goal.title}」？</p><button disabled={pending} onClick={() => { void execute('delete') }}>确认删除此目标</button><button onClick={() => setConfirmDelete(false)}>取消删除</button></>}
    </details>
    {messages.map(value => <div key={value.operationId}><MobileNotice kind="feedback" identity={[value.operationId,value.text]} role="status">{value.text}</MobileNotice><details><summary>操作身份</summary><dl><dt>操作</dt><dd>{value.action}</dd><dt>操作 ID</dt><dd>{value.operationId}</dd><dt>请求</dt><dd><pre>{JSON.stringify(value.request, null, 2)}</pre></dd></dl></details></div>)}
  </details>
}
