import { safeClientIncidentCode, type AgentMuxClientIncidentKind, type AgentMuxClientReadingIncidentKind, type AgentMuxClientIncidentMetadata,
  type AgentMuxClientIncidentReport, type AgentMuxClientIncidentStage } from '@agentmux/core/client-incident'
import { createClientIncidentDispatcher, type ClientIncidentDispatcher } from './client-incident-dispatcher'
export { createClientIncidentDispatcher } from './client-incident-dispatcher'

// One transport owner per JS Realm; detached documents share this original owner.
const dispatcher = createClientIncidentDispatcher(() => typeof window === 'undefined' ? undefined : window.agentmux?.clientIncidents)
export function clientIncidentDispatcher(): ClientIncidentDispatcher { return dispatcher }

/** Stage facts only: this owner never reads text, scans pixels, samples profiles or changes Run control. */
export function createClientIncidentRecorder(input: {
  hostId: string; agentSessionId: string | null; runId: string | null; regionId(): string | null
  read(includeGeometry: boolean): AgentMuxClientIncidentMetadata
  send(report: AgentMuxClientIncidentReport): void
  dropped?(): number
  now?(): number
  monotonic?(): number
  id?(): string
}) {
  const now = input.now ?? Date.now, mono = input.monotonic ?? (() => performance.now())
  const id = input.id ?? (() => crypto.randomUUID())
  const started = mono()
  let attemptId = id(), overwritten = 0, readFailures = 0, sendFailures = 0, lastFailure: string | null = null
  const stages: AgentMuxClientIncidentReport['stages'] = []
  const elapsed = () => Math.max(0, mono() - started)
  const snapshot = (geometry: boolean): AgentMuxClientIncidentMetadata => {
    try { return input.read(geometry) }
    catch { readFailures++; return {} }
  }
  const mark = (stage: AgentMuxClientIncidentStage) => {
    stages.push({ stage, elapsedMs: elapsed(), metadata: snapshot(false) })
    if (stages.length > 16) { stages.shift(); overwritten++ }
  }
  return {
    begin(stage: AgentMuxClientIncidentStage) { attemptId = id(); mark(stage) },
    mark,
    capture(kind: Exclude<AgentMuxClientIncidentKind, AgentMuxClientReadingIncidentKind>, stage: AgentMuxClientIncidentStage, error?: unknown,
      relatedOccurrenceId: string | null = lastFailure): string {
      const occurrenceId = id()
      mark(stage)
      const report: AgentMuxClientIncidentReport = {
        occurrenceId, attemptId, relatedOccurrenceId, kind, stage,
        code: safeClientIncidentCode((error as { code?: unknown } | null)?.code),
        hostId: input.hostId, agentSessionId: input.agentSessionId, runId: input.runId, regionId: input.regionId(),
        observedAt: now(), elapsedMs: elapsed(),
        metadata: { ...snapshot(true), historyOverwritten: overwritten, recorderReadFailures: readFailures, reporterDropped: (input.dropped?.() ?? 0) + sendFailures },
        stages: stages.map(item => ({ ...item, metadata: { ...item.metadata } })), references: []
      }
      if (kind === 'terminal-attach-failed' || kind === 'terminal-replay-failed' || kind === 'terminal-reveal-deadline' ||
        kind === 'terminal-context-lost' || kind === 'terminal-output-gap') lastFailure = occurrenceId
      // Freeze synchronously before the caller starts a refresh; the sender owns its bounded async queue.
      try { input.send(report) } catch { sendFailures++ }
      return occurrenceId
    }
  }
}
