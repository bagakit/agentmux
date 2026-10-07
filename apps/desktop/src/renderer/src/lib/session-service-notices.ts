import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentSteerQueueEntry } from '../store'
import { steerEntryTargetsRun, steerQueueCanEverDrain } from './agent-steer-queue-drain'
import { errorIdentity } from '@agentmux/client-ui/error-presentation'
import { agentPromptDeliveryServiceOutcome, agentSessionServiceOutcome, nativeSessionServiceOutcome, nativeSessionServiceCause, hookIngressServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from './service-window-notice'
import type { ServiceNoticeItem } from './use-service-notices'
import { observeAgentSession, activityObservationPresentation } from './agent-observation'

/** Both inboxes project the same current owners; reading a notice never settles its cause. */
export function sessionServiceNotices(session: SessionSnapshot | undefined, queue: readonly AgentSteerQueueEntry[] = [], sendingId?: string,
  nativeService = session?.nativeService,
  observationAvailable = true): ServiceNoticeItem[] {
  const notices: ServiceNoticeItem[] = []
  if (session) {
    const notice = serviceNoticeToRender(classifyServiceNotice(nativeSessionServiceOutcome(session, nativeService, observationAvailable), observationAvailable))
    if (notice) notices.push({ id: 'native-service',
      occurrence: JSON.stringify([session.hostId, session.id, session.control.run.runId]),
      cause: nativeSessionServiceCause(session, nativeService), notice })
  }
  if (session?.kind !== 'agent') return notices
  const hookNotice = serviceNoticeToRender(classifyServiceNotice(hookIngressServiceOutcome(session), observationAvailable))
  if (hookNotice && session.hookIngressObservation) notices.push({ id: 'hook-ingress',
    occurrence: JSON.stringify([session.hostId, session.id, session.control.run.runId]),
    cause: JSON.stringify([session.hookIngressObservation.phase, session.hookIngressObservation.code, session.hookIngressObservation.message]),
    observedAt: session.hookIngressObservation.observedAt, notice: hookNotice })
  if (session.creation?.initialPrompt === 'unconfirmed' || session.creation?.initialPrompt === 'unknown') notices.push({
    id: 'initial-prompt', occurrence: session.creation.createOperationId, notice: { kind: 'indeterminate', notice: {
      step: 'The original first prompt is unconfirmed', mode: 'The existing Agent Session remains available. Its first prompt will not be sent again automatically.',
      restore: `Inspect request ${session.creation.createOperationId} and the existing Session before choosing a new message.`
    } }
  })
  const identity = [session.hostId, session.id, session.control.run.runId]
  const activityObservation = observeAgentSession(session, Date.now())
  const activityAvailable = observationAvailable && session.status.state !== 'disconnected'
  const activity = activityObservationPresentation(activityObservation, activityAvailable)
  if (activity) notices.push({ id: 'activity-observation', occurrence: JSON.stringify(identity),
    cause: JSON.stringify([activityObservation.reason, activityObservation.lastKnownActivity, activityObservation.process,
      activityObservation.readiness, activityAvailable]), notice: { kind: 'indeterminate', notice: {
      step: activity.label, mode: activity.detail,
      restore: 'Open the original Agent to inspect its current work. A new native activity observation updates this state; no message is replayed.'
    } } })
  const nativeSource = session.nativeSourceObservation
  if (nativeSource && nativeSource.run.runId === session.control.run.runId) notices.push({ id: 'native-source',
    occurrence: JSON.stringify(identity), cause: JSON.stringify([nativeSource.state, nativeSource.reason]), observedAt: nativeSource.observedAt,
    notice: { kind: 'indeterminate', notice: {
      step: nativeSource.state === 'changed' ? 'Native conversation source changed'
        : nativeSource.state === 'ambiguous' ? 'Native conversation source is ambiguous' : 'Native conversation source is unconfirmed',
      mode: `${nativeSource.reason}. This source observation is separate from current activity. The original Session and available input are kept.`,
      restore: 'Inspect the original Agent and refresh its native history to retry source confirmation.'
    } } })
  const receipt = session.completedInteractionResponse
  if (receipt) notices.push({ id: 'interaction-receipt',
    occurrence: JSON.stringify([...identity, receipt.requestId, receipt.operationId]),
    cause: JSON.stringify([receipt.acknowledged, session.interactionResponseUnavailableReason]),
    notice: { kind: 'indeterminate', notice: {
      step: 'Typed answer receipt unsettled',
      mode: session.interactionResponseUnavailableReason ?? (receipt.acknowledged
        ? 'The original native request ended. Its acknowledged answer is waiting for settlement.'
        : 'The original native request ended. Its earlier typed answer receipt is unconfirmed.'),
      restore: 'Inspect the original Session and response before retrying. No answer is replayed automatically.'
    } }
  })
  if (session.timelineObservation) notices.push({ id: 'timeline-observation',
    occurrence: JSON.stringify([session.hostId, session.id, session.timelineObservation.run.runId]),
    cause: JSON.stringify([session.timelineObservation.code, session.timelineObservation.message]),
    notice: { kind: 'indeterminate', notice: {
      step: `Reading work history · ${session.timelineObservation.code}`,
      mode: `${session.timelineObservation.message} The original Session, last readable history and available input controls are kept.`,
      restore: 'Retry work history in this Session’s notice to read the original Session again. No message is replayed.'
    } }
  })
  // A connection gap can replace the display status, but cannot settle a retained native failure.
  // A subsequent current work/completion observation clears the notice with its absent failure.
  const failureStatus = session.status.failure ? session.status
    : session.status.state === 'disconnected' ? session.semanticStatus : undefined
  const failure = failureStatus?.failure
  if (failure) notices.push({ id: 'provider-request', occurrence: JSON.stringify([...identity, failure.nativeTurnId]),
    cause: JSON.stringify([failure.code, failure.message, failure.nativeCode, failure.httpStatusCode, failure.recovery]),
    observedAt: failureStatus!.observedAt,
    notice: { kind: !observationAvailable || session.processState === 'interrupted' ? 'indeterminate' : 'process-degraded', notice: {
      step: `Agent request failed · ${failure.code}`,
      mode: `${failure.message} ${session.processState === 'running'
        ? observationAvailable ? 'The Run is still alive; its original Session and input controls are kept.'
          : 'The Run was last observed running; current availability is unconfirmed. Its original Session and input controls are kept.'
        : session.processState === 'exited' ? 'The Run exited; the original Session and output are kept.'
          : 'The Run is interrupted and its availability is unknown; the original Session and output are kept.'}`,
      restore: failure.recovery
    } }
  })
  const connectionTime = session.terminalCapability?.reason === 'handshake-timeout' ? session.terminalCapability.observedAt
    : session.terminalOutputChannel?.reason === 'reattach-failed' ? session.terminalOutputChannel.observedAt
    : session.status.state === 'disconnected' ? session.status.observedAt : undefined
  for (const [id, outcome, observedAt] of [
    ['connection', agentSessionServiceOutcome(session), connectionTime],
    ['delivery', agentPromptDeliveryServiceOutcome(session), session.terminalPromptDelivery?.observedAt]
  ] as const) {
    const notice = serviceNoticeToRender(classifyServiceNotice(outcome, observationAvailable))
    if (notice) notices.push({ id, occurrence: JSON.stringify(identity), notice,
      ...(observedAt === undefined ? {} : { observedAt }) })
  }
  const problem = queue.find(entry => !entry.archived && (entry.status === 'deferred' || entry.status === 'failed' || entry.status === 'restoring' ||
    !steerEntryTargetsRun(entry, session.control.run.runId) || !steerQueueCanEverDrain(session.processState)))
  if (problem) notices.push({ id: 'queue', occurrence: JSON.stringify([...identity, problem.operationId]),
    notice: { kind: observationAvailable ? 'process-degraded' : 'indeterminate', notice: {
      step: problem.status === 'restoring' && sendingId === problem.operationId
        ? 'Restoring the Agent before execution'
        : problem.errorCode === 'AGENT_PROMPT_CONDITION_CHANGED' ? 'The original send condition changed'
        : problem.errorCode === 'AGENT_PROMPT_PREPARATION_FAILED' ? 'Preparing this send did not complete'
        : problem.promptCondition !== null ? 'The original message delivery is still unconfirmed'
        : problem.awaitingExplicitSend ? 'The restored message waits for explicit Send'
        : 'A queued message has not been sent',
      mode: errorIdentity(problem.error ?? (problem.status === 'restoring'
        ? 'Your message is kept while its Session is restored and the Run binding is saved.'
        : 'The bound Run is unavailable or changed. Its delivery result is unknown; it will not be replayed on another Run.')),
      restore: problem.errorCode === 'AGENT_PROMPT_CONDITION_CHANGED'
        ? 'This attempt wrote no input. Inspect the conversation, then move the original text to the draft to compose a new message; its previous delivery remains unconfirmed.'
        : problem.promptCondition !== null
        ? 'Your original message and operation are kept. Inspect the original conversation and outbox before choosing Send; it will not be replayed automatically.'
        : 'Your message is kept. Open the outbox to inspect, send, copy or edit it.'
    } } })
  return notices
}
