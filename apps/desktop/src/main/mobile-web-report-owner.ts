import { deriveObjectId } from '@agentmux/core/object-id'
import type { AgentMuxClientIncidentReport, AgentMuxClientIncidentProducer } from '@agentmux/core/client-incident'
import type { MobileWebReportPort } from '@agentmux/core/mobile-web'
import type { ClientIncidentArchive } from './client-incident-archive.js'

/** The existing Main archive receives bounded observations from the original authenticated phone. */
export function mobileWebReportOwner(archive: ClientIncidentArchive): MobileWebReportPort {
  return { report(input, devicePrincipalId) {
    const producerInstanceId = deriveObjectId('mobile-web-producer', JSON.stringify([archive.appInstanceId, devicePrincipalId, input.documentId]))
    const producer: AgentMuxClientIncidentProducer = { kind: 'mobile-web', appInstanceId: archive.appInstanceId,
      producerInstanceId, devicePrincipalId, documentId: input.documentId, buildId: input.buildId, namespaceDigest: input.namespaceDigest,
      windowId: null, documentGeneration: null }
    const observation = input.observation
    const report: AgentMuxClientIncidentReport = { kind: 'mobile-web-observation', mobile: observation,
      occurrenceId: input.occurrenceId, attemptId: input.documentId, relatedOccurrenceId: null,
      hostId: archive.hostId, regionId: null, stage: 'mobile-observed', code: observation.code,
      agentSessionId: null, runId: null, observedAt: input.observedAt, elapsedMs: null,
      metadata: { reporterDropped: input.reporter.droppedCount, reporterQueuedCount: input.reporter.queuedCount, reporterQueuedBytes: input.reporter.queuedBytes,
        ...(observation.kind === 'connection-state' ? { connectionState: observation.state,
          ...(observation.boundary ? { connectionBoundary: observation.boundary } : {}) } : {}) },
      stages: [], references: [] }
    const receipt = archive.enqueue(report, producer)
    return { hostId: archive.hostId, producer: { devicePrincipalId, documentId: input.documentId },
      accepted: receipt.accepted, logId: receipt.logId ?? null,
      recordRef: receipt.logId ? archive.reference(receipt.logId) : null, persistence: 'unconfirmed' }
  } }
}
