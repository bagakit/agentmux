import type { AgentTimelineSnapshot } from '@agentmux/core'

/** Core records prompt:<operationId> only after the input side effect succeeds. A lost IPC reply
 * or renderer restart must not turn that durable delivery back into a retryable local draft. */
export function reconcileDeliveredSteers<State extends {
  agentSteerQueues: Record<string, Array<{ operationId: string }>>
  timelines: Record<string, AgentTimelineSnapshot>
}>(state: State, sessionId: string): State {
  const queue = state.agentSteerQueues[sessionId]
  const timeline = state.timelines[sessionId]
  if (!queue?.length || timeline?.agentSessionId !== sessionId) return state
  const delivered = new Set(timeline.items
    .filter((item) => item.agentSessionId === sessionId && item.kind === 'user_message' && item.status === 'complete')
    .map((item) => item.id))
  const pending = queue.filter((entry) => !delivered.has(`prompt:${entry.operationId}`))
  if (pending.length === queue.length) return state
  const agentSteerQueues = { ...state.agentSteerQueues }
  if (pending.length) agentSteerQueues[sessionId] = pending
  else delete agentSteerQueues[sessionId]
  return { ...state, agentSteerQueues }
}
