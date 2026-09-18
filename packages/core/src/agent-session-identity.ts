import { canonicalHookLifecycleEvent } from './agent-hook-event.js'
import type { AgentHookReceipt, AgentMuxAgentSession, AgentMuxRunRef, AgentMuxStoredAgentSession } from './types.js'

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

/** Native end retained independently of later diagnostic receipts or physical screen readiness. */
export function agentTurnEndEvidence(session: Pick<AgentMuxAgentSession,
  'agentSessionId' | 'providerId' | 'run' | 'hookReceipt' | 'semanticStatus' | 'terminalPromptReadiness'
>): Pick<AgentHookReceipt, 'id' | 'run' | 'observedAt'> | undefined {
  const readiness = session.terminalPromptReadiness
  if (readiness?.source !== 'native-stop' || !sameRun(readiness.run, session.run)) return undefined
  const receipt = session.hookReceipt
  const matchingReceipt = receipt?.id === readiness.id &&
    canonicalHookLifecycleEvent(receipt.eventName, receipt.lifecycleEvent) === 'turn-end' &&
    receipt.agentSessionId === session.agentSessionId && receipt.providerId === session.providerId &&
    sameRun(receipt.run, session.run) ? receipt : undefined
  const observedAt = readiness.observedAt ?? matchingReceipt?.observedAt
  if (observedAt === undefined ||
    (session.semanticStatus !== undefined && session.semanticStatus.observedAt > observedAt)) return undefined
  return { id: readiness.id, run: { ...readiness.run }, observedAt }
}

/** One manual prompt may consume a native end without asserting successful completion. */
export function agentTurnEndBoundary(session: Parameters<typeof agentTurnEndEvidence>[0]): ReturnType<typeof agentTurnEndEvidence> {
  return session.terminalPromptReadiness?.consumedBySubmissionId === undefined
    ? agentTurnEndEvidence(session) : undefined
}
