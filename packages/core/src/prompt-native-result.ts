import { dequal } from 'dequal'
import { agentNativeTurnEnd, sameNativeHandle } from './agent-session-identity.js'
import { nativeInputCorrelationKey, nativeInputSourceId } from './native-input-correlation.js'
import type { AgentMuxStoredAgentSession, AgentPromptNativeResult, AgentPromptSubmissionRecord, AgentSessionHistoryItem, AgentSessionHistorySource } from './types.js'

export function finalPromptNativeResult(result: AgentPromptNativeResult | undefined): boolean {
  return result?.state === 'completed' || result?.state === 'failed' || result?.state === 'interrupted'
}

/** Called only for a bounded, complete original native cut. A partial page cannot establish adoption uniqueness. */
export function queuedPromptNativeResult(record: AgentPromptSubmissionRecord, source: AgentSessionHistorySource,
  items: readonly AgentSessionHistoryItem[]): AgentPromptNativeResult | undefined {
  const claim = record.admission, key = claim?.inputKey
  if (claim?.transport !== 'native' || claim.native.outcome !== 'admitted' || !claim.acknowledged || !key ||
      claim.native.plan.operation !== 'queue-idle' || !claim.native.queuedSubmissionId) return
  const plan = claim.native.plan
  if (!plan.clientCorrelation || !dequal(nativeInputCorrelationKey(plan.clientCorrelation), key) ||
      !dequal(claim.intent?.plan, plan) || plan.sourceId !== nativeInputSourceId(source) || plan.threadId !== source.nativeSessionId) return
  const candidates = items.filter(item => item.conversation?.nativeInput?.clientCorrelation === plan.clientCorrelation)
  if (candidates.length !== 1) return
  const input = candidates[0]!, native = input.conversation?.nativeInput
  if (input.kind !== 'user-message' || !native?.turnId || native.turnId !== input.turnId ||
      !dequal(native.source, source) || !dequal(input.conversation?.adoptedInput?.key, key) ||
      input.contentParts.length !== 1 || input.contentParts[0]?.kind !== 'text' || input.contentParts[0].text !== claim.intent?.prompt) return
  const ends = items.filter(item => item.turnId === native.turnId && item.turnOutcome !== undefined)
  if (ends.length !== 1) return
  const end = ends[0]!, outcome = end.turnOutcome!
  return { state: outcome.status, run: { ...record.run }, promptSubmissionId: claim.submissionId!, sourceId: plan.sourceId,
    nativeSessionId: source.nativeSessionId, nativeTurnId: native.turnId, recordId: end.id, observedAt: Date.now(),
    ...(end.completedAt === undefined && end.startedAt === undefined ? {} : { nativeObservedAt: end.completedAt ?? end.startedAt! }),
    correlation: { kind: 'native-adoption', clientCorrelation: plan.clientCorrelation,
      queuedSubmissionId: claim.native.queuedSubmissionId, nativeRecordId: input.id } }
}

/** Original native ACK only. Latest activity, Hook admission and semanticIdle are not input consumption. */
export function promptNativeResult(record: AgentPromptSubmissionRecord, session: AgentMuxStoredAgentSession): AgentPromptNativeResult {
  const claim = record.admission, key = claim?.inputKey
  if (!claim?.intent || !key) return { state: 'unknown', reason: 'not-recorded' }
  if (claim.transport !== 'native') return { state: 'unsupported', reason: 'uncorrelated-carrier' }
  const plan = claim.native.plan, source = session.nativeHandle
  if (claim.native.outcome !== 'admitted' || !claim.acknowledged || !claim.native.turnId || !plan.clientCorrelation ||
      !dequal(nativeInputCorrelationKey(plan.clientCorrelation), key) || !dequal(claim.intent.plan, plan) ||
      !record.nativeSource || !sameNativeHandle(record.nativeSource.nativeHandle, source) || record.nativeSource.actorId !== plan.actorId ||
      session.nativeActor && session.nativeActor.actorId !== plan.actorId ||
      record.run.runId !== session.run.runId || source?.kind !== 'provider' || plan.threadId !== source.sessionId ||
      plan.sourceId !== nativeInputSourceId({ providerId: session.providerId, nativeSessionId: source.sessionId }))
    return { state: 'unknown', reason: 'native-input-unconfirmed' }
  const end = agentNativeTurnEnd(session, claim.native.turnId)
  if (!end?.endReason || !['completed', 'failed', 'interrupted'].includes(end.endReason))
    return { state: 'unknown', reason: 'native-outcome-unconfirmed' }
  return { state: end.endReason as 'completed' | 'failed' | 'interrupted', run: { ...record.run }, promptSubmissionId: claim.submissionId!,
    sourceId: plan.sourceId, nativeSessionId: source.sessionId, nativeTurnId: claim.native.turnId,
    recordId: end.recordId, observedAt: end.observedAt,
    ...(end.nativeObservedAt === undefined ? {} : { nativeObservedAt: end.nativeObservedAt }),
    ...(end.sequence === undefined ? {} : { sequence: end.sequence }),
    correlation: { kind: 'native-ack', clientCorrelation: plan.clientCorrelation } }
}
