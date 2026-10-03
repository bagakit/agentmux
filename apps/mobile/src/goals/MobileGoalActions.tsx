import { useEffect, useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcResult } from '@agentmux/core'

export function MobileGoalActions({ client, goal, visible, updated, deleted }: {
  client: AgentMuxHostedClient | null; goal: AgentMuxRpcGoal; visible: boolean
  updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void; deleted(id: string): void
}) {
  const [expanded, expand] = useState(false), [executors, setExecutors] = useState<AgentMuxRpcResult<'app.snapshot'>['executors']>([])
  const [executorId, setExecutorId] = useState(goal.assigneeExecutorId ?? ''), [sessionId, setSessionId] = useState('')
  const [discoveryIssue, setDiscoveryIssue] = useState(''), [revision, refresh] = useState(0)
  const [messages, setMessages] = useState<Array<{ operationId: string; text: string; action: string; request: Record<string, unknown> }>>([])
  const [pending, setPending] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const inFlight = useRef(false)
  useEffect(() => {
    if (!expanded || !visible || !client?.forwardRpc) return
    let live = true
    void client.forwardRpc('app.snapshot', { include: ['executors'] }).then(result => {
      if (live) { setExecutors(result.executors); setDiscoveryIssue(result.unavailable.map(value => `${value.message} ${value.recovery}`).join('\n')) }
    }).catch(error => { if (live) setDiscoveryIssue(`读取执行者目录失败：${error instanceof Error ? error.message : String(error)}。原选择与准确 ID 输入保留，可刷新重试。`) })
    return () => { live = false }
  }, [client, expanded, visible, revision])
  const execute = async (action: 'assign' | 'start' | 'handoff' | 'delete') => {
    if (inFlight.current) return
    const operationId = crypto.randomUUID()
    const common = { goalId: goal.id, operationId }
    let request: Record<string, unknown> = common
    const report = (text: string) => setMessages(values => [...values, { operationId, text, action, request }])
    if (!client?.forwardRpc) { report('操作未发送：目标公共端口暂不可用，原目标与输入保留。'); return }
    inFlight.current = true; setPending(true)
    try {
      if (action === 'delete') {
        const params = { ...common, confirmation: 'delete' as const }; request = params
        const result = await client.forwardRpc('goal.delete', params)
        deleted(result.goal.id)
      } else if (action === 'assign') {
        const params = { ...common, assigneeExecutorId: executorId || null, start: false }; request = params
        const result = await client.forwardRpc('goal.assign', params)
        updated(result.goal, ['assigneeExecutorId', 'activityLog']); report('执行者分配已保存，未开始执行。')
      } else if (action === 'handoff') {
        const params = { ...common, assigneeExecutorId: executorId || null, ...(sessionId ? { sessionId } : {}) }; request = params
        const result = await client.forwardRpc('goal.handoff', params)
        updated(result.goal, ['assigneeExecutorId', 'sessionIds', 'activityLog']); report('交接关系已保存，未自动发送新任务。')
      } else {
        const params = { ...common, ...(sessionId ? { sessionId } : {}) }; request = params
        const result = await client.forwardRpc('goal.start', params)
        updated(result.goal, ['status', 'sessionIds', 'activityLog'])
        report(result.receipt.sessionId ? '开始请求已处理；请在关联会话查看实际执行。' : '开始请求已返回，执行会话尚未确认。')
      }
    } catch (error) { report(`${action === 'delete' ? '删除' : action === 'start' ? '开始执行' : action === 'handoff' ? '交接' : '分配'}回执未确认：${error instanceof Error ? error.message : String(error)}。原目标、输入与操作身份保留；先读取当前目标核对，不会自动重发。`) }
    finally { inFlight.current = false; setPending(false) }
  }
  return <details onToggle={event => expand(event.currentTarget.open)}><summary>分配、执行与删除</summary>
    {discoveryIssue && <p role="status">{discoveryIssue}</p>}
    <label>执行者<input aria-label="分配 Executor ID" list={`goal-executors-${goal.id}`} value={executorId} onChange={event => setExecutorId(event.target.value)} placeholder="准确 Executor ID，清空表示未分配" /></label>
    <datalist id={`goal-executors-${goal.id}`}>{executors.map(executor => <option key={executor.executorId} value={executor.executorId}>{executor.label} · {executor.providerId} · {executor.availability}</option>)}</datalist>
    <button onClick={() => refresh(value => value + 1)}>刷新执行者目录</button>
    <button disabled={pending} onClick={() => { void execute('assign') }}>保存执行者分配</button>
    <label>执行或交接的会话<input aria-label="执行 Session ID" value={sessionId} onChange={event => setSessionId(event.target.value)} placeholder="可选准确 Session ID" /></label>
    <p>填写会话时明确指向它；不填写时，开始执行沿目标的原分配处理，可能复用关联会话或启动新 Agent。交接只更新原执行者与会话关系。</p>
    <button disabled={pending} onClick={() => { void execute('start') }}>开始执行此目标</button>
    <button disabled={pending} onClick={() => { void execute('handoff') }}>保存交接关系</button>
    <details><summary>删除目标</summary><p>删除此目标，保留原 Agent 会话。</p>
      {!confirmDelete ? <button onClick={() => setConfirmDelete(true)}>删除目标…</button> : <><p>确认删除「{goal.title}」？</p><button disabled={pending} onClick={() => { void execute('delete') }}>确认删除此目标</button><button onClick={() => setConfirmDelete(false)}>取消删除</button></>}
    </details>
    {messages.map(value => <div key={value.operationId}><p role="status">{value.text}</p><details><summary>操作身份</summary><dl><dt>操作</dt><dd>{value.action}</dd><dt>操作 ID</dt><dd>{value.operationId}</dd><dt>原请求</dt><dd><pre>{JSON.stringify(value.request, null, 2)}</pre></dd></dl></details></div>)}
  </details>
}
