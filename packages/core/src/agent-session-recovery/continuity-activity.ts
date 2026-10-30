import { agentNativeTurnEnd } from '../agent-session-identity.js'
import type { AgentMuxStoredAgentSession } from '../types.js'

/** Reads original activity facts; observing a retained end cannot renew its age. */
export function agentContinuityLastActivityAt(session: AgentMuxStoredAgentSession): number | undefined {
  const status = session.semanticStatus
  if (status?.state === 'done' && status.source === 'native-transcript' && !status.idleEvidenceConsumed) {
    const nativeObservedAt = agentNativeTurnEnd(session, status.nativeTurnId)?.nativeObservedAt
    if (nativeObservedAt !== undefined) return nativeObservedAt
  }
  const activity = session.recoveryActivity
  return activity?.run.runId === session.run.runId && activity.state !== 'unknown' &&
    session.nativeHandle?.kind === 'provider' && activity.nativeSessionId === session.nativeHandle.sessionId
    ? activity.observedAt : undefined
}
