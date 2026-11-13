import { mintObjectId } from '@agentmux/core/object-id'
import { safeClientIncidentCode, type AgentMuxClientIncidentReport } from '@agentmux/core/client-incident'
import { clientIncidentDispatcher } from './client-incident-recorder'
import type { SpatialSaveObservation } from './desktop-spatial-state'

/**
 * One bounded, durable record per unsaved workface period: when it is first reported stalled and when it
 * is confirmed again. Facts only (stage, code, held Core revision, unsaved age, conflict count); no names,
 * paths or graph content. Best effort: an unavailable archive never affects saving or the workface.
 */
export function workfaceSaveRecorder(hostId = 'local', send = (report: AgentMuxClientIncidentReport) => clientIncidentDispatcher().send(report)) {
  let attemptId: string | null = null, stalledOccurrence: string | null = null
  const record = (kind: 'workface-save-failed' | 'workface-save-recovered', stage: 'save-stalled' | 'save-confirmed',
    observation: SpatialSaveObservation, revision: number | null, now: number, relatedOccurrenceId: string | null) => {
    const occurrenceId = mintObjectId(), since = observation.pendingSince
    const metadata = { ...(revision === null ? {} : { spatialRevision: revision }),
      ...(since === null ? {} : { unsavedForMs: Math.max(0, now - since) }), spatialConflicts: observation.conflicts }
    try {
      send({ occurrenceId, attemptId: attemptId ??= mintObjectId(), relatedOccurrenceId, hostId, regionId: null, kind, stage,
        code: kind === 'workface-save-failed' ? safeClientIncidentCode(observation.lastFailureCode) ?? 'SPATIAL_SAVE_STALLED' : null,
        agentSessionId: null, runId: null, observedAt: now, elapsedMs: metadata.unsavedForMs ?? null, metadata,
        stages: [{ stage, elapsedMs: metadata.unsavedForMs ?? 0, metadata }], references: [] })
    } catch { /* Diagnostic admission is never a precondition for saving. */ }
    return occurrenceId
  }
  return {
    stalled(observation: SpatialSaveObservation, revision: number | null, now = Date.now()) {
      if (stalledOccurrence) return
      stalledOccurrence = record('workface-save-failed', 'save-stalled', observation, revision, now, null)
    },
    recovered(observation: SpatialSaveObservation, revision: number | null, now = Date.now()) {
      if (!stalledOccurrence) return
      record('workface-save-recovered', 'save-confirmed', observation, revision, now, stalledOccurrence)
      stalledOccurrence = null; attemptId = null
    }
  }
}
