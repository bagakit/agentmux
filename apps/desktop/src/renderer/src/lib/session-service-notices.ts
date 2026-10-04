import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentSteerQueueEntry } from '../store'
import { steerEntryTargetsRun, steerQueueCanEverDrain } from './agent-steer-queue-drain'
import { errorIdentity } from '@agentmux/client-ui/error-presentation'
import { agentPromptDeliveryServiceOutcome, agentSessionServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from './service-window-notice'
import type { ServiceNoticeItem } from './use-service-notices'
import { agentLifecycleFailureNotice, lifecycleFailureBelongsTo, type AgentLifecycleFailure } from './agent-lifecycle-feedback'

/** Both inboxes project the same current owners; reading a notice never settles its cause. */
export function sessionServiceNotices(session: SessionSnapshot | undefined, queue: readonly AgentSteerQueueEntry[] = [], sendingId?: string,
  lifecycleError?: { message: string | null; failure: AgentLifecycleFailure | undefined }): ServiceNoticeItem[] {
  if (session?.kind !== 'agent') return []
  const notices: ServiceNoticeItem[] = []
  if (session.creation?.initialPrompt === 'unconfirmed' || session.creation?.initialPrompt === 'unknown') notices.push({
    id: 'initial-prompt', occurrence: session.creation.createOperationId, notice: { kind: 'indeterminate', notice: {
      step: 'The original first prompt is unconfirmed', mode: 'The existing Agent Session remains available. Its first prompt will not be sent again automatically.',
      restore: `Inspect request ${session.creation.createOperationId} and the existing Session before choosing a new message.`
    } }
  })
  const identity = [session.hostId, session.id, session.control.run.runId]
  // A connection gap can replace the display status, but cannot settle a retained native failure.
  // A subsequent current work/completion observation clears the notice with its absent failure.
  const failureStatus = session.status.failure ? session.status
    : session.status.state === 'disconnected' ? session.semanticStatus : undefined
  const failure = failureStatus?.failure
  if (failure) notices.push({ id: 'provider-request', occurrence: JSON.stringify([...identity, failure.nativeTurnId]),
    cause: JSON.stringify([failure.code, failure.message, failure.nativeCode, failure.httpStatusCode, failure.recovery]),
    observedAt: failureStatus!.observedAt,
    notice: { kind: session.processState === 'interrupted' ? 'indeterminate' : 'process-degraded', notice: {
      step: `Agent request failed · ${failure.code}`,
      mode: `${failure.message} ${session.processState === 'running'
        ? 'The Run is still alive; its original Session and input controls are kept.'
        : session.processState === 'exited' ? 'The Run exited; the original Session and output are kept.'
          : 'The Run is interrupted and its availability is unknown; the original Session and output are kept.'}`,
      restore: failure.recovery
    } }
  })
  if (lifecycleError?.message && lifecycleError.failure && lifecycleFailureBelongsTo(lifecycleError.failure, { subject: session.control })) {
    notices.push({ id: 'recovery', occurrence: JSON.stringify(identity),
      cause: JSON.stringify([lifecycleError.failure.step, errorIdentity(lifecycleError.message)]),
      notice: agentLifecycleFailureNotice(lifecycleError.failure, lifecycleError.message) })
  }
  const connectionTime = session.terminalCapability?.reason === 'handshake-timeout' ? session.terminalCapability.observedAt
    : session.terminalOutputChannel?.reason === 'reattach-failed' ? session.terminalOutputChannel.observedAt
    : session.status.state === 'disconnected' ? session.status.observedAt : undefined
  for (const [id, outcome, observedAt] of [
    ['connection', agentSessionServiceOutcome(session), connectionTime],
    ['delivery', agentPromptDeliveryServiceOutcome(session), session.terminalPromptDelivery?.observedAt]
  ] as const) {
    const notice = serviceNoticeToRender(classifyServiceNotice(outcome))
    if (notice) notices.push({ id, occurrence: JSON.stringify(identity), notice,
      ...(observedAt === undefined ? {} : { observedAt }) })
  }
  const problem = queue.find(entry => !entry.archived && (entry.status === 'deferred' || entry.status === 'failed' || entry.status === 'restoring' ||
    !steerEntryTargetsRun(entry, session.control.run.runId) || !steerQueueCanEverDrain(session.processState)))
  if (problem) notices.push({ id: 'queue', occurrence: JSON.stringify([...identity, problem.operationId]),
    notice: { kind: 'process-degraded', notice: {
      step: problem.status === 'restoring' && sendingId === problem.operationId
        ? 'Restoring the Agent before execution'
        : problem.errorCode === 'AGENT_PROMPT_PREPARATION_FAILED' ? 'Preparing this send did not complete'
        : problem.promptCondition !== null ? 'The original message delivery is still unconfirmed'
        : problem.awaitingExplicitSend ? 'The restored message waits for explicit Send'
        : 'A queued message has not been sent',
      mode: errorIdentity(problem.error ?? (problem.status === 'restoring'
        ? 'Your message is kept while its Session is restored and the Run binding is saved.'
        : 'The bound Run is unavailable or changed. Its delivery result is unknown; it will not be replayed on another Run.')),
      restore: problem.promptCondition !== null
        ? 'Your original message and operation are kept. Inspect the original conversation and outbox before choosing Send; it will not be replayed automatically.'
        : 'Your message is kept. Open the outbox to inspect, send, copy or edit it.'
    } } })
  return notices
}
