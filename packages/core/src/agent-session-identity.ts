import type { AgentMuxAgentSession, AgentMuxRunRef, AgentMuxStoredAgentSession } from './types.js'

export function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.runId === right.runId
}

export function cloneSession(session: AgentMuxStoredAgentSession): AgentMuxAgentSession {
  const { hookBindingId: _bindingId, hookToken: _token, ...publicSession } = structuredClone(session)
  return publicSession
}
