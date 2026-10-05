import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionControl, SessionSnapshot } from '../../../shared/contracts'

export function confirmedSteerDelivery(timeline: AgentTimelineSnapshot | undefined, control: AgentSessionControl | undefined, operationId: string): boolean {
  const agentSessionId = control?.agentSessionId
  return agentSessionId !== undefined && timeline?.agentSessionId === agentSessionId && timeline.items.some(item =>
    item.agentSessionId === agentSessionId && item.kind === 'user_message' && item.status === 'complete' &&
    item.id === `prompt:${operationId}`)
}

/** Core records prompt:<operationId> only after the input side effect succeeds. A lost IPC reply
 * or renderer restart must not turn that durable delivery back into a retryable local draft. */
export function reconcileDeliveredSteers<State extends {
  agentSteerQueues: Record<string, Array<{ operationId: string; archived?: true; goalPmo?: { creationOperationId?: string } }>>
  timelines: Record<string, AgentTimelineSnapshot>
  sessions: SessionSnapshot[]
}>(state: State, sessionId: string): State {
  const queue = state.agentSteerQueues[sessionId]
  const timeline = state.timelines[sessionId]
  const source = state.sessions.find(session => session.kind === 'agent' && session.id === sessionId)
  const agentSessionId = source?.kind === 'agent' ? source.control.agentSessionId : undefined
  if (!queue?.length || agentSessionId === undefined || timeline?.agentSessionId !== agentSessionId) return state
  const delivered = new Set(timeline.items
    .filter((item) => item.agentSessionId === agentSessionId && item.kind === 'user_message' && item.status === 'complete')
    .map((item) => item.id))
  // Original input confirmation does not confirm the first Goal source write. Keep its
  // exact existing queue reference until the caller reconciles that owner without input.
  const pending = queue.filter((entry) => entry.archived || entry.goalPmo?.creationOperationId !== undefined || !delivered.has(`prompt:${entry.operationId}`))
  if (pending.length === queue.length) return state
  const agentSteerQueues = { ...state.agentSteerQueues }
  if (pending.length) agentSteerQueues[sessionId] = pending
  else delete agentSteerQueues[sessionId]
  return { ...state, agentSteerQueues }
}
