import { safeClientIncidentCode, type AgentMuxClientIncidentKind, type AgentMuxClientIncidentMetadata,
  type AgentMuxClientIncidentReport, type AgentMuxClientIncidentStage } from '@agentmux/core/client-incident'
import { api } from './api'

// One slow IPC owns its slot until it really settles. A busy archive never holds up Terminal work.
const dispatchers = new WeakMap<Document, { send(report: AgentMuxClientIncidentReport): void; dropped(): number }>()
export function clientIncidentDispatcher(document: Document) {
  let dispatcher = dispatchers.get(document)
  if (dispatcher) return dispatcher
  const queue: AgentMuxClientIncidentReport[] = []
  let sending = false, dropped = 0, token: string | null = null
  const drain = async () => {
    if (sending) return
    sending = true
    try {
      if (!token) token = (await api.clientIncidents.open())?.token ?? null
      if (!token) { dropped += queue.length; queue.length = 0; return }
      while (queue.length) {
        const report = queue.shift()!
        try {
          const receipt = await api.clientIncidents.report(token, report)
          if (!receipt.accepted) dropped++
        } catch {
          // The report may have been accepted. Do not replay it or let a failed token poison later attempts.
          dropped++; token = null
          dropped += queue.length; queue.length = 0
          break
        }
      }
    } catch { dropped += queue.length; queue.length = 0; token = null }
    finally { sending = false }
  }
  dispatcher = {
    send(report) {
      // A report contains at most a small metadata ring. Bound queued work independently of Run count.
      if (queue.length >= 32) { dropped++; return }
      queue.push(report)
      void drain()
    },
    dropped: () => dropped
  }
  dispatchers.set(document, dispatcher)
  return dispatcher
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
    capture(kind: AgentMuxClientIncidentKind, stage: AgentMuxClientIncidentStage, error?: unknown,
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
