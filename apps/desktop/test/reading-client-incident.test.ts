import { describe, expect, it } from 'vitest'
import type { ReadingDiagnosticRecord } from '@agentmux/core/reading-diagnostic'
import { readingClientIncident } from '../src/renderer/src/lib/reading-client-incident'
import { parseClientIncidentReport, parseClientIncidentRecord } from '@agentmux/core/client-incident'

const original = (): ReadingDiagnosticRecord => ({
  version: 'reading-diagnostic.v1', logId: '111111111111', previousLogId: '222222222222',
  scope: { hostId: 'execution-host', agentSessionId: 'original-session', runId: 'original-run', sourceHostId: null,
    owner: 'renderer', ownerInstanceId: 'original-clock', producerBuildId: null,
    consumerId: 'original-consumer', consumerKind: 'conversation-pane' },
  trigger: 'progress', startedAt: 5, endedAt: null,
  events: [{ sequence: 1, wallMs: 5, monoMs: 1, phase: 'read-started', attemptId: '1' },
    { sequence: 2, wallMs: 4, monoMs: 3, phase: 'read-ended', attemptId: '1' }],
  coverage: { firstSequence: 1, lastSequence: 2, overwritten: 0, rejected: 0, publicationFailures: 0 },
})

describe('reading adapter for the common incident owner', () => {
  it('preserves original identity, lifetime and clocks without inventing an archive acknowledgement', () => {
    const input = original(), report = readingClientIncident(input, 2)
    expect(report).toMatchObject({ occurrenceId: input.logId, relatedOccurrenceId: input.previousLogId,
      attemptId: 'original-consumer', hostId: 'execution-host', runId: 'original-run',
      observedAt: 4, elapsedMs: 2, metadata: { reporterDropped: 2 } })
    expect(report.reading).toEqual(input)
    expect(report).not.toHaveProperty('authority')
    expect(report).not.toHaveProperty('receivedAt')
    expect(report).not.toHaveProperty('persistence')
    input.scope.agentSessionId = 'later-mutation'
    expect(report.reading.scope.agentSessionId).toBe('original-session')
  })

  it('classifies only the original finite publication trigger, preserving fault and held records separately', () => {
    const input = original()
    for (const trigger of ['progress', 'release'] as const) {
      expect(readingClientIncident({ ...input, trigger }, 0).kind).toBe('conversation-reading-progress')
    }
    for (const trigger of ['failure', 'slow-read'] as const) {
      expect(readingClientIncident({ ...input, trigger }, 0).kind).toBe('conversation-reading-failure')
    }
    expect(readingClientIncident({ ...input, trigger: 'held' }, 0).kind).toBe('conversation-reading-held')
    expect(readingClientIncident({ ...input, trigger: 'recovered' }, 0).kind).toBe('conversation-reading-recovered')
  })

  it('cannot promote a Core producer through the Renderer route or accept content and invalid coverage', () => {
    const input = original()
    expect(() => readingClientIncident({ ...input, scope: { ...input.scope, owner: 'core' } }, 0)).toThrow()
    expect(() => readingClientIncident(input, -1)).toThrow()
    expect(() => readingClientIncident({ ...input, body: 'private-content' } as ReadingDiagnosticRecord, 0)).toThrow()
  })

  it('rejects disagreement between the common envelope and the original reading entity', () => {
    const report = readingClientIncident(original(), 0)
    expect(parseClientIncidentReport(report)).toEqual(report)
    for (const fields of [
      { occurrenceId: '333333333333' }, { relatedOccurrenceId: null }, { attemptId: 'other-consumer' },
      { hostId: 'other-host' }, { agentSessionId: 'other-session' }, { runId: null },
      { kind: 'conversation-reading-failure' }, { observedAt: 6 }, { elapsedMs: 3 },
      { stage: 'attach-failed' }, { code: 'EIO' },
      { reading: { ...report.reading, scope: { ...report.reading.scope, owner: 'core' } } },
    ]) expect(() => parseClientIncidentReport({ ...report, ...fields })).toThrow()
    const record = { kind: 'client-incident', logId: report.reading.logId,
      authority: { kind: 'client-incident-archive', id: 'archive', lifetime: 'durable' }, receivedAt: 9,
      producer: { kind: 'renderer', appInstanceId: 'app', producerInstanceId: 'producer', windowId: 'window', documentGeneration: 'document', buildId: null }, report }
    expect(parseClientIncidentRecord(record).report).toEqual(report)
    expect(() => parseClientIncidentRecord({ ...record, logId: '333333333333' })).toThrow()
  })

  it('detaches nested stages and references before the common owner queues caller data', () => {
    const { reading: _reading, ...base } = readingClientIncident(original(), 0)
    const input = { ...base, kind: 'terminal-attach-failed', stage: 'attach-failed',
      stages: [{ stage: 'attach-requested', elapsedMs: 1, metadata: { visible: true } }],
      references: [{ domain: 'delivery.core', hostId: 'host', logId: '111111111111', authority: { kind: 'owner', id: 'source' } }] }
    const parsed = parseClientIncidentReport(input)
    input.stages[0]!.metadata.visible = false
    input.references[0]!.authority.id = 'changed'
    expect(parsed.stages[0]!.metadata.visible).toBe(true)
    expect(parsed.references[0]).toMatchObject({ authority: { id: 'source' } })
  })
})
