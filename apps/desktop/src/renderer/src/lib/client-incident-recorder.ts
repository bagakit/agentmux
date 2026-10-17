import { parseClientIncidentMetadata, parseClientIncidentReport, safeClientIncidentCode, type AgentMuxClientIncidentKind, type AgentMuxClientReadingIncidentKind, type AgentMuxClientIncidentMetadata,
  type AgentMuxClientIncidentReport, type AgentMuxClientIncidentStage } from '@agentmux/core/client-incident'
import { createClientIncidentDispatcher, type ClientIncidentDispatcher } from './client-incident-dispatcher'
export { createClientIncidentDispatcher } from './client-incident-dispatcher'

// One transport owner per JS Realm; detached documents share this original owner.
const dispatcher = createClientIncidentDispatcher(() => typeof window === 'undefined' ? undefined : window.agentmux?.clientIncidents)
export function clientIncidentDispatcher(): ClientIncidentDispatcher { return dispatcher }
const increment = (count: number) => Math.min(Number.MAX_SAFE_INTEGER, count + 1)
const timestamp = (value: number) => {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw Error('Diagnostic clock is unavailable')
  return value
}

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
  let overwritten = 0, readFailures = 0, publicationFailures = 0, lastFailure: string | null = null
  // All producer observations, including initialization, stay inside this one boundary.
  const observe = <T>(read: () => T, unavailable: T): T => {
    try { return read() } catch { readFailures = increment(readFailures); return unavailable }
  }
  const mono = () => timestamp(input.monotonic ? input.monotonic() : performance.now())
  const id = () => input.id ? input.id() : crypto.randomUUID()
  const started = observe<number | null>(mono, null)
  let attemptId = observe<string | null>(id, null)
  const stages: AgentMuxClientIncidentReport['stages'] = []
  const elapsed = (): number | null => {
    if (started === null) return null
    const current = mono()
    if (current < started) throw Error('Diagnostic clock moved before its original observation')
    return current - started
  }
  const snapshot = (geometry: boolean) => observe(() => parseClientIncidentMetadata(input.read(geometry)), {})
  const mark = (stage: AgentMuxClientIncidentStage) => {
    const elapsedMs = elapsed()
    if (elapsedMs === null) return
    stages.push({ stage, elapsedMs, metadata: snapshot(false) })
    if (stages.length > 16) { stages.shift(); overwritten = increment(overwritten) }
  }
  return {
    begin(stage: AgentMuxClientIncidentStage): void {
      attemptId = null
      observe(() => { attemptId = id(); mark(stage) }, undefined)
    },
    mark(stage: AgentMuxClientIncidentStage): void { observe(() => mark(stage), undefined) },
    capture(kind: Exclude<AgentMuxClientIncidentKind, AgentMuxClientReadingIncidentKind>, stage: AgentMuxClientIncidentStage, error?: unknown,
      relatedOccurrenceId: string | null = lastFailure): string | null {
      // A failed publication returns no occurrence. It must not interrupt a reveal,
      // refresh or the original error handler, and is counted by a later valid report.
      try {
        const occurrenceId = id()
        if (attemptId === null) attemptId = id()
        mark(stage)
        const code = observe(() => {
          if (error === null || typeof error !== 'object' && typeof error !== 'function') return null
          const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
          if (descriptor && !Object.hasOwn(descriptor, 'value')) throw Error('Diagnostic code is not a data observation')
          return safeClientIncidentCode(descriptor?.value)
        }, null)
        const reporterDropped = input.dropped?.() ?? 0
        if (!Number.isSafeInteger(reporterDropped) || reporterDropped < 0) throw Error('Diagnostic drop coverage is unavailable')
        const report = parseClientIncidentReport({
          occurrenceId, attemptId, relatedOccurrenceId, kind, stage, code,
          hostId: input.hostId, agentSessionId: input.agentSessionId, runId: input.runId, regionId: input.regionId(),
          observedAt: timestamp(input.now ? input.now() : Date.now()), elapsedMs: elapsed(),
          metadata: { ...snapshot(true), historyOverwritten: overwritten, recorderReadFailures: readFailures,
            reporterDropped: Math.min(Number.MAX_SAFE_INTEGER, reporterDropped + publicationFailures) },
          stages, references: []
        })
        input.send(report)
        if (kind === 'terminal-attach-failed' || kind === 'terminal-replay-failed' || kind === 'terminal-reveal-deadline' ||
          kind === 'terminal-context-lost' || kind === 'terminal-output-gap') lastFailure = occurrenceId
        return occurrenceId
      } catch { publicationFailures = increment(publicationFailures); return null }
    }
  }
}
