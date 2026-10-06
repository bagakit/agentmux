import type { AgentInputSubmissionReceipt, AgentPromptCondition, AgentTimelineSnapshot } from '@agentmux/core'
import type { AgentSessionControl, SessionSnapshot } from '../../../shared/contracts'

/** Archive is presentation, not an input outcome. Unknown original operations remain
 * pending; confirmed history or an original intent proven not dispatched does not. */
export function pendingSteerInput(entry: {
  archived?: true
  inputReceipt?: Pick<AgentInputSubmissionReceipt, 'status' | 'control'>
  inputIntakeStarted?: true
  promptCondition?: AgentPromptCondition | null
}): boolean {
  if (!entry.archived) return true
  if (entry.inputReceipt) return entry.inputReceipt.status !== 'admitted' && entry.inputReceipt.status !== 'not-applied' &&
    entry.inputReceipt.control.state !== 'stopped-before-dispatch'
  if (entry.inputIntakeStarted) return true
  return entry.promptCondition !== null
}

export function confirmedSteerDelivery(timeline: AgentTimelineSnapshot | undefined, control: AgentSessionControl | undefined, operationId: string): boolean {
  const agentSessionId = control?.agentSessionId
  return agentSessionId !== undefined && timeline?.agentSessionId === agentSessionId && timeline.items.some(item =>
    item.agentSessionId === agentSessionId && item.kind === 'user_message' && item.status === 'complete' &&
    item.id === `prompt:${operationId}`)
}

/** Core records prompt:<operationId> only after the input side effect succeeds. A lost IPC reply
 * or renderer restart must not turn that durable delivery back into a retryable local draft. */
export function reconcileDeliveredSteers<State extends {
  agentSteerQueues: Record<string, Array<{ operationId: string; archived?: true; goalDispatch?: { goalId: string; operationId: string }; goalPmo?: { creationOperationId?: string } }>>
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
  const pending = queue.filter((entry) => entry.archived || entry.goalDispatch !== undefined || entry.goalPmo?.creationOperationId !== undefined || !delivered.has(`prompt:${entry.operationId}`))
  if (pending.length === queue.length) return state
  const agentSteerQueues = { ...state.agentSteerQueues }
  if (pending.length) agentSteerQueues[sessionId] = pending
  else delete agentSteerQueues[sessionId]
  return { ...state, agentSteerQueues }
}
