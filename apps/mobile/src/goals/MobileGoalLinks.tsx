import { MobileNotice } from '../notices/MobileNotice'
import { randomClientRequestId } from '@agentmux/core/relay-hosted'
import { TextInput } from '@agentmux/client-ui/input'
import { useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal, AgentMuxRpcResult } from '@agentmux/core'
import { useMobileWebUpdateSafetyOwner } from '../mobile-web/update-safety'
import { beginGoalOperation, finishGoalOperation } from './goal-operation-recovery'

/** Exact identities go to the existing owner; the phone never infers a binding. */
export function MobileGoalLinks({ client, goal, updated }: {
  client: AgentMuxHostedClient | null; goal: AgentMuxRpcGoal; updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void
}) {
  const [sessionId, setSessionId] = useState(''), [projectId, setProjectId] = useState('')
  const [messages, setMessages] = useState<Array<{ text: string; original?: { goalId: string; sessionId: string; operationId: string } | { goalId: string; projectId: string; operationId: string } }>>([]), [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const original = useRef({ sessionId, projectId }), local = useRef({ sessionId, projectId })
  local.current = { sessionId, projectId }
  useMobileWebUpdateSafetyOwner(() => {
    if (local.current.sessionId !== original.current.sessionId || local.current.projectId !== original.current.projectId) return '目标关联输入仅保留在当前页面；请先保存、清空或还原输入，再更新网页。'
    return null
  })
  const link = async (kind: 'session' | 'project') => {
    if (inFlight.current) return
    if (!client?.forwardRpc) { setMessages(values => [...values, { text: '关联未发送：目标公共端口暂不可用，原关系保留。' }]); return }
    const operationId = randomClientRequestId()
    const request = kind === 'session' ? { goalId: goal.id, sessionId, operationId } : { goalId: goal.id, projectId, operationId }
    inFlight.current = true; setPending(true)
    const operation = beginGoalOperation(client, kind === 'session' ? 'goal.link-session' : 'goal.link-project', request)
    if ('sessionId' in request) original.current.sessionId = request.sessionId
    else original.current.projectId = request.projectId
    let result: AgentMuxRpcResult<'goal.link-session'> | AgentMuxRpcResult<'goal.link-project'>
    try {
      result = kind === 'session'
        ? await client.forwardRpc('goal.link-session', { goalId: goal.id, sessionId, operationId }, undefined, operation.fence)
        : await client.forwardRpc('goal.link-project', { goalId: goal.id, projectId, operationId }, undefined, operation.fence)
    } catch (error) {
      void finishGoalOperation(operation, false)
      setMessages(values => [...values, { text: `关联回执未确认：${error instanceof Error ? error.message : String(error)}。原目标与输入保留，先读取当前目标核对，不会自动重发。操作 ${operationId}`, original: request }])
      return
    } finally { inFlight.current = false; setPending(false) }
    void finishGoalOperation(operation, true)
    try {
      updated(result.goal, kind === 'session' ? ['sessionIds'] : ['projectId', 'projectName'])
      setMessages(values => [...values, { text: `${kind === 'session' ? '会话' : '项目'}已关联到原目标。` }])
    } catch (error) { setMessages(values => [...values, { text: `原关联已收到回执，但当前页面未能更新：${error instanceof Error ? error.message : String(error)}。请重新读取原目标。` }]) }
  }
  return <details><summary>关联项目或会话</summary>
    <form onSubmit={event => { event.preventDefault(); void link('session') }}><label>准确 Session ID<TextInput aria-label="关联 Session ID" value={sessionId} onChange={event => { local.current.sessionId = event.target.value; setSessionId(event.target.value) }} required /></label><button disabled={pending}>关联会话</button></form>
    <form onSubmit={event => { event.preventDefault(); void link('project') }}><label>准确 Project ID<TextInput aria-label="关联 Project ID" value={projectId} onChange={event => { local.current.projectId = event.target.value; setProjectId(event.target.value) }} required /></label><button disabled={pending}>关联项目</button></form>
    {messages.map((message, index) => <div key={index}><MobileNotice kind="feedback" identity={[message.text]} role="status">{message.text}</MobileNotice>
      {message.original && <details><summary>原关联请求</summary><pre>{JSON.stringify(message.original, null, 2)}</pre></details>}</div>)}
  </details>
}
