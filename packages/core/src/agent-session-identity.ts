import { canonicalHookLifecycleEvent } from './agent-hook-event.js'
import type { AgentHookReceipt, AgentMuxAgentSession, AgentMuxRunRef, AgentMuxStoredAgentSession, AgentNativeSessionHandle } from './types.js'

export function sameRun(left: AgentMuxRunRef, right: AgentMuxRunRef): boolean {
  return left.runId === right.runId
}

/** The full locator includes its Provider source, not only the displayed native Session ID. */
export function sameNativeHandle(a: AgentNativeSessionHandle | undefined, b: AgentNativeSessionHandle | undefined): boolean {
  return a === b || a?.kind === 'provider' && b?.kind === 'provider' && a.providerId === b.providerId &&
    a.sessionId === b.sessionId && a.transcriptPath === b.transcriptPath ||
    a?.kind === 'acp' && b?.kind === 'acp' && a.adapterId === b.adapterId && a.sessionId === b.sessionId
}

export function nativeTurnEndScopeMatches(session: Pick<AgentMuxStoredAgentSession, 'providerId' | 'run' | 'nativeHandle' | 'nativeTurnEnds'>): boolean {
  const ends = session.nativeTurnEnds
  return ends !== undefined && sameRun(ends.run, session.run) && ends.providerId === session.providerId &&
    sameNativeHandle(ends.nativeHandle, session.nativeHandle)
}

/** Only a retained exact end can deny this turn; an absent observation never denies a healthy callback. */
export function agentNativeTurnEnd(session: Parameters<typeof nativeTurnEndScopeMatches>[0], nativeTurnId: string | undefined) {
  return nativeTurnId !== undefined && nativeTurnEndScopeMatches(session) && Object.hasOwn(session.nativeTurnEnds!.turns, nativeTurnId)
    ? session.nativeTurnEnds!.turns[nativeTurnId] : undefined
}

export function cloneSession(session: AgentMuxStoredAgentSession): AgentMuxAgentSession {
  const { nativeActor: _nativeActor, continuityExecutors: _executors, nativeTurnEnds: _nativeTurnEnds, interactionOperations: _interactionOperations, hookBindingId: _bindingId, hookToken: _token, activityCommit: _activityCommit, futurePromptIntents: _retainedBodies, ...publicSession } = session
  return structuredClone(publicSession)
}

/** Identity of a completed turn, scoped to its exact Run. */
export function agentTurnCompletionIdentity(session: Pick<AgentMuxAgentSession, 'run' | 'semanticStatus' | 'currentActivity'>): string | undefined {
  if (session.currentActivity && (session.currentActivity.state !== 'idle' ||
      session.currentActivity.nativeTurnId !== session.semanticStatus?.nativeTurnId)) return undefined
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
