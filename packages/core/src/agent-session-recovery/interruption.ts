import type { AgentProvider } from '../agent-provider.js'
import type { AgentMuxContinuityInterruption, AgentMuxContinuityPolicy } from './continuity-contract.js'
import type { AgentMuxStoredAgentSession } from '../types.js'

/** Inspect the original native target before starting its next writer. Never observes terminal prose. */
export async function inspectAgentSessionInterruption(
  session: AgentMuxStoredAgentSession,
  provider: AgentProvider,
  policy: AgentMuxContinuityPolicy,
  args: readonly string[],
  now = Date.now()
): Promise<AgentMuxContinuityInterruption> {
  const handle = session.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== provider.id) throw new TypeError('Interruption requires the original Provider native target.')
  const supported = provider.catalog.capabilities.nativeInterruption === true
  const result: AgentMuxContinuityInterruption = {
    support: supported ? 'provider' : 'unsupported', state: 'unknown', source: supported ? 'native-protocol' : 'none',
    previousRun: { ...session.run }, nativeTarget: structuredClone(handle), observedAt: now,
    reason: supported ? 'native-interruption-unconfirmed' : 'provider-interruption-unsupported'
  }
  if (!supported) {
    if (!policy.activeInterruptionFallback) return result
    const status = session.semanticStatus
    if (!status || status.state !== 'working' || !['native-hook', 'native-transcript', 'acp'].includes(status.source) ||
      !Number.isSafeInteger(status.observedAt) || status.observedAt < 0 || status.observedAt > now || now - status.observedAt > policy.confirmedIdleWindowMs) {
      return { ...result, source: 'active-fallback', reason: 'previous-main-activity-unconfirmed' }
    }
    return { ...result, state: 'interrupted', source: 'active-fallback', nativeObservedAt: status.observedAt, reason: 'explicit-active-fallback' }
  }
  if (session.nativeSourceObservation?.run.runId === session.run.runId) {
    return { ...result, reason: 'original-native-source-unconfirmed' }
  }
  // A contributed observer returning nothing or failing is unknown, never unsupported.
  if (provider.readPromptExecutionEvidence) {
    try {
      const evidence = await provider.readPromptExecutionEvidence({ args, workspacePath: session.workspacePath, nativeHandle: handle })
      if (!evidence) return result
      const state = evidence.state === 'ended' && evidence.endReason === 'interrupted' ? 'interrupted'
        : evidence.state === 'idle' || evidence.state === 'ended' && ['completed', 'failed'].includes(evidence.endReason ?? '') ? 'not-interrupted' : 'unknown'
      return { ...result, state, evidenceId: evidence.id, nativeSourceId: evidence.sourceId, ...(evidence.nativeTurnId ? { nativeTurnId: evidence.nativeTurnId } : {}),
        ...(evidence.observedAt === undefined ? {} : { nativeObservedAt: evidence.observedAt }),
        reason: state === 'interrupted' ? 'native-turn-interrupted' : state === 'not-interrupted' ? 'native-turn-not-interrupted' : 'native-turn-end-unconfirmed' }
    } catch {
      return { ...result, reason: 'native-interruption-observation-failed' }
    }
  }
  const activity = session.recoveryActivity
  if (!activity || activity.run.runId !== session.run.runId || activity.nativeSessionId !== handle.sessionId ||
    activity.promptSubmissionId !== session.promptCompletionAdmission?.submissionId ||
    session.nativeSourceObservation?.state === 'changed' ||
    activity.state !== 'idle' || !activity.interruption) return result
  return { ...result, state: activity.interruption, ...(activity.nativeTurnId ? { nativeTurnId: activity.nativeTurnId } : {}),
    nativeObservedAt: activity.observedAt, evidenceId: activity.hookReceiptId,
    reason: activity.interruption === 'interrupted' ? 'native-turn-interrupted' : 'native-turn-not-interrupted' }
}
