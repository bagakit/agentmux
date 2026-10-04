import { TextInput } from '@agentmux/client-ui/input'
import { useRef, useState } from 'react'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { AgentMuxRpcGoal } from '@agentmux/core'

/** Exact identities go to the existing owner; the phone never infers a binding. */
export function MobileGoalLinks({ client, goal, updated }: {
  client: AgentMuxHostedClient | null; goal: AgentMuxRpcGoal; updated(goal: AgentMuxRpcGoal, fields: Array<keyof AgentMuxRpcGoal>): void
}) {
  const [sessionId, setSessionId] = useState(''), [projectId, setProjectId] = useState('')
  const [messages, setMessages] = useState<string[]>([]), [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const link = async (kind: 'session' | 'project') => {
    if (inFlight.current) return
    if (!client?.forwardRpc) { setMessages(values => [...values, '关联未发送：目标公共端口暂不可用，原关系保留。']); return }
    const operationId = crypto.randomUUID()
    inFlight.current = true; setPending(true)
    try {
      const result = kind === 'session'
        ? await client.forwardRpc('goal.link-session', { goalId: goal.id, sessionId, operationId })
        : await client.forwardRpc('goal.link-project', { goalId: goal.id, projectId, operationId })
      updated(result.goal, kind === 'session' ? ['sessionIds'] : ['projectId', 'projectName'])
      setMessages(values => [...values, `${kind === 'session' ? '会话' : '项目'}已关联到原目标。`])
    } catch (error) {
      setMessages(values => [...values, `关联回执未确认：${error instanceof Error ? error.message : String(error)}。原目标与输入保留，先读取当前目标核对，不会自动重发。操作 ${operationId}`])
    } finally { inFlight.current = false; setPending(false) }
  }
  return <details><summary>关联项目或会话</summary>
    <form onSubmit={event => { event.preventDefault(); void link('session') }}><label>准确 Session ID<TextInput aria-label="关联 Session ID" value={sessionId} onChange={event => setSessionId(event.target.value)} required /></label><button disabled={pending}>关联会话</button></form>
    <form onSubmit={event => { event.preventDefault(); void link('project') }}><label>准确 Project ID<TextInput aria-label="关联 Project ID" value={projectId} onChange={event => setProjectId(event.target.value)} required /></label><button disabled={pending}>关联项目</button></form>
    {messages.map((text, index) => <p key={index} role="status">{text}</p>)}
  </details>
}
