import type { AgentMuxContinuityOperation, AgentNativeSessionHandle } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

type Agent = Extract<SessionSnapshot, { kind: 'agent' }>
/** Presentation scope only: a missing original locator may be enriched; a known locator may not change. */
function displayedTargetMatches(original: AgentNativeSessionHandle | undefined, observed: AgentNativeSessionHandle | undefined): boolean {
  return original?.kind === 'provider' && observed?.kind === 'provider' && original.providerId === observed.providerId &&
    original.sessionId === observed.sessionId && (original.transcriptPath === undefined || original.transcriptPath === observed.transcriptPath)
}
/** O(1) presentation join of the current attempt and its original durable intent. No action authority. */
export function currentContinuitySupervision(session: Agent): { root: AgentMuxContinuityOperation; attempt: AgentMuxContinuityOperation; targetChanged: boolean; waitingForInitialAttempt: boolean } | null {
  const pointer = session.continuity
  if (!pointer || pointer.agentSessionId !== session.id) return null
  const rootId = pointer.intentOperationId ?? pointer.operationId
  const root = session.continuityOperations?.[rootId] ?? (pointer.operationId === rootId ? pointer : undefined)
  const supervision = root?.supervision
  if (!root || root.agentSessionId !== session.id || root.operationId !== rootId || root.intentOperationId || !supervision) return null
  const attempt = session.continuityOperations?.[supervision.activeAttemptOperationId] ??
    (pointer.operationId === supervision.activeAttemptOperationId ? pointer : undefined)
  if (!attempt || attempt.agentSessionId !== session.id || attempt.operationId !== supervision.activeAttemptOperationId ||
      (attempt.operationId !== rootId && attempt.intentOperationId !== rootId) ||
      (attempt.newRun ?? attempt.previousRun).runId !== session.control.run.runId) return null
  const targets = [root.nativeTarget, attempt.nativeTarget].filter((target): target is NonNullable<typeof target> => !!target)
  const targetChanged = targets.length === 0 || targets.some(target => !displayedTargetMatches(target, session.nativeHandle))
  const waitingForInitialAttempt = supervision.attemptCount === 0 && root.kind === 'pending' && !root.newRun &&
    attempt.operationId === root.operationId && !['manual', 'input'].includes(root.trigger)
  return { root, attempt, targetChanged, waitingForInitialAttempt }
}

export function continuitySupervisionPresentation(session: Agent) {
  const joined = currentContinuitySupervision(session)
  if (!joined) return null
  const { root, attempt, targetChanged, waitingForInitialAttempt } = joined, supervision = root.supervision!
  const context = supervision.contextEvidence
  const contextConfirmed = !targetChanged && context?.source === 'native-hook' && context.run.runId === session.control.run.runId &&
    displayedTargetMatches(context.nativeTarget, session.nativeHandle)
  const inputUnconfirmed = root.previousInput?.outcome === 'unknown' || root.launchInput && ['prepared', 'unknown', 'launch-carried'].includes(root.launchInput.state) ||
    root.recoveryDelivery && !['accepted', 'not-applied', 'superseded'].includes(root.recoveryDelivery.phase)
  if (supervision.phase === 'settled' && contextConfirmed && !inputUnconfirmed) return null
  const title = supervision.phase === 'cancelled' ? 'Automatic recovery cancelled'
    : waitingForInitialAttempt ? supervision.phase === 'paused' ? 'Initial recovery paused' : 'Waiting for initial recovery'
    : targetChanged ? 'Original recovery target is unconfirmed' : { observing: 'Checking restored context', 'retry-wait': 'Recovery retry scheduled', paused: 'Recovery paused',
    settled: 'Original input needs review', cancelled: 'Automatic recovery cancelled' }[supervision.phase]
  const process = supervision.process
  const processDetail = session.processState === 'exited'
    ? `Agent process exited${session.status.exitCode == null ? '' : ` with code ${session.status.exitCode}`}.`
    : session.processState === 'running' ? 'The current Run is alive. This does not confirm task progress.'
      : 'The current process availability is unconfirmed.'
  const failure = process?.state === 'exited' ? `Attempt Run ${process.run.runId} exited${process.exitCode == null ? '' : ` with code ${process.exitCode}`}${process.exitSignal == null ? '' : `, signal ${process.exitSignal}`}.` : undefined
  const contextDetail = contextConfirmed ? 'Original conversation context confirmed by its native receipt; task completion is separate.'
    : 'Original conversation context is not yet confirmed. Available terminal input stays usable.'
  return { root, attempt, supervision, title, processDetail, failure, contextDetail, waitingForInitialAttempt,
    canContinue: supervision.attemptCount > 0 && !targetChanged && supervision.phase === 'paused',
    canCancel: (waitingForInitialAttempt || !targetChanged) && ['observing', 'retry-wait', 'paused'].includes(supervision.phase),
    detail: `${supervision.attemptCount === 0 ? 'No recovery attempt has started.' : `Attempt ${supervision.attemptCount} of ${supervision.attemptLimit}.`} ${contextDetail}`,
    initialInput: root.launchInput?.state === 'launch-carried'
      ? 'Initial recovery input: Runtime launch carriage confirmed; Provider consumption remains unconfirmed.'
      : root.launchInput ? `Initial recovery input: ${root.launchInput.state}.`
        : root.recoveryDelivery ? `Initial recovery input: ${root.recoveryDelivery.phase}.` : 'No automatic initial recovery input was recorded.',
    originalInput: root.previousInput ? `Earlier typed input: ${root.previousInput.outcome}${root.previousInput.key ? ` · ${root.previousInput.key.kind === 'prompt' ? root.previousInput.key.submissionId : root.previousInput.key.messageId}` : ''}. No unknown input is replayed.` : 'Earlier typed input outcome is unconfirmed.',
    childInput: attempt.intentOperationId ? 'This retry restores context only. No earlier input, reminder or continuation is resent.' : undefined }
}
