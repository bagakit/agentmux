import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentSteerQueueEntry } from '../store'
import { steerEntryTargetsRun, steerQueueCanEverDrain } from './agent-steer-queue-drain'
import { errorIdentity } from './error-presentation'
import { agentPromptDeliveryServiceOutcome, agentSessionServiceOutcome, classifyServiceNotice, serviceNoticeToRender } from './service-window-notice'
import type { ServiceNoticeItem } from './use-service-notices'
import { agentLifecycleFailureNotice, lifecycleFailureBelongsTo, type AgentLifecycleFailure } from './agent-lifecycle-feedback'

/** Both inboxes project the same current owners; reading a notice never settles its cause. */
export function sessionServiceNotices(session: SessionSnapshot | undefined, queue: readonly AgentSteerQueueEntry[] = [], sendingId?: string,
  lifecycleError?: { message: string | null; failure: AgentLifecycleFailure | undefined }): ServiceNoticeItem[] {
  if (session?.kind !== 'agent') return []
  const notices: ServiceNoticeItem[] = []
  const identity = [session.hostId, session.id, session.control.run.runId]
  if (lifecycleError?.message && lifecycleError.failure && lifecycleFailureBelongsTo(lifecycleError.failure, { subject: session.control })) {
    notices.push({ id: 'recovery', occurrence: JSON.stringify(identity),
      notice: agentLifecycleFailureNotice(lifecycleError.failure, lifecycleError.message) })
  }
  for (const [id, outcome] of [
    ['connection', agentSessionServiceOutcome(session)],
    ['delivery', agentPromptDeliveryServiceOutcome(session)]
  ] as const) {
    const notice = serviceNoticeToRender(classifyServiceNotice(outcome))
    if (notice) notices.push({ id, occurrence: JSON.stringify(identity), notice })
  }
  const problem = queue.find(entry => entry.status === 'deferred' || entry.status === 'failed' || entry.status === 'restoring' ||
    !steerEntryTargetsRun(entry, session.control.run.runId) || !steerQueueCanEverDrain(session.processState))
  if (problem) notices.push({ id: 'queue', occurrence: JSON.stringify([...identity, problem.operationId]),
    notice: { kind: 'process-degraded', notice: {
      step: problem.status === 'restoring' && sendingId === problem.operationId
        ? 'Restoring the Agent before execution' : 'A queued message has not been sent',
      mode: errorIdentity(problem.error ?? (problem.status === 'restoring'
        ? 'Your message is kept while its Session is restored and the Run binding is saved.'
        : 'The bound Run is unavailable or changed. Its delivery result is unknown; it will not be replayed on another Run.')),
      restore: 'Your message is kept. Open the outbox to inspect, retry, copy or remove it.'
    } } })
  return notices
}
