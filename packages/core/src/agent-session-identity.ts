import type { AgentMuxAgentSession, AgentMuxRunRef, AgentMuxStoredAgentSession } from './types.js'

export function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.runId === right.runId
}

export function cloneSession(session: AgentMuxStoredAgentSession): AgentMuxAgentSession {
  const { hookBindingId: _bindingId, hookToken: _token, ...publicSession } = structuredClone(session)
  return publicSession
}

/** Identity of a completed turn, scoped to its exact Run. */
export function agentTurnCompletionIdentity(session: Pick<AgentMuxAgentSession, 'run' | 'semanticStatus'>): string | undefined {
  return session.semanticStatus?.state === 'done'
    ? JSON.stringify([session.run.runId, session.semanticStatus.observedAt]) : undefined
}
