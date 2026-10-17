import { parseReadingDiagnosticRecord, type ReadingDiagnosticRecord } from '@agentmux/core/reading-diagnostic'
import { clientReadingIncidentKind, type AgentMuxClientReadingIncidentReport } from '@agentmux/core/client-incident'

/** Adapt the original reading record to the common client incident owner. */
export function readingClientIncident(input: ReadingDiagnosticRecord, reporterDropped: number): AgentMuxClientReadingIncidentReport {
  const reading = parseReadingDiagnosticRecord(input)
  if (reading.scope.owner !== 'renderer' || !Number.isSafeInteger(reporterDropped) || reporterDropped < 0) {
    throw new Error('Invalid client reading publication')
  }
  const first = reading.events[0], last = reading.events.at(-1)
  return {
    occurrenceId: reading.logId, attemptId: reading.scope.consumerId, relatedOccurrenceId: reading.previousLogId,
    hostId: reading.scope.hostId, regionId: null, kind: clientReadingIncidentKind(reading.trigger), stage: 'reading-observed', code: null,
    agentSessionId: reading.scope.agentSessionId, runId: reading.scope.runId,
    observedAt: last?.wallMs ?? reading.startedAt, elapsedMs: first && last ? last.monoMs - first.monoMs : null,
    metadata: { reporterDropped }, stages: [], references: [], reading,
  }
}
