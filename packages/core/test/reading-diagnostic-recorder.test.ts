import { describe, expect, it } from 'vitest'
import { createReadingDiagnosticRecorder } from '../src/reading-diagnostic-recorder.js'
import type { ReadingDiagnosticRecord, ReadingDiagnosticScope } from '../src/reading-diagnostic.js'
import { parseReadingDiagnosticRecord } from '../src/reading-diagnostic.js'

const scope = (): ReadingDiagnosticScope => ({ hostId: 'route-host', agentSessionId: 'session-a', runId: null, sourceHostId: null,
  owner: 'renderer', ownerInstanceId: 'renderer-one', producerBuildId: null, consumerId: 'consumer-a', consumerKind: 'conversation-pane' })
function harness(publish?: (record: ReadingDiagnosticRecord) => void) {
  const records: ReadingDiagnosticRecord[] = []
  let mono = 10, wall = 1000, serial = 0
  const recorder = createReadingDiagnosticRecorder(scope(), { now: () => mono++, wall: () => wall++,
    mintId: () => String(++serial).padStart(12, '1'), publish: record => { records.push(record); publish?.(record) } })
  return { recorder, records }
}

describe('owner reading diagnostic recorder', () => {
  it('preserves document provenance when a sink attempts to mutate the frozen nested identity', () => {
    const { recorder, records } = harness(record => {
      try { record.events[0]!.document!.windowId = 'forged-window' } catch { /* Frozen public snapshots reject sink mutation. */ }
    })
    const originalDocument = { windowId: 'original-window', documentGeneration: 'original-generation' }
    recorder.record({ phase: 'dom-committed', document: originalDocument })
    originalDocument.windowId = 'caller-mutated-window'
    expect(() => recorder.flush('progress')).not.toThrow()
    expect(() => recorder.flush('recovered')).not.toThrow()
    expect(records).toHaveLength(2)
    expect(records.every(record => record.events[0]?.document?.windowId === 'original-window')).toBe(true)
    expect(Object.isFrozen(records[0]!.events[0]!.document)).toBe(true)
  })

  it('preserves actual source observation separately from the original unknown scope', () => {
    const { recorder, records } = harness()
    recorder.record({ phase: 'watch-opened', watchId: 'watch-a' })
    recorder.record({ phase: 'invalidation-received', watchId: 'watch-a', sourceHostId: 'actual-source', sourceKind: 'native' })
    recorder.flush('progress')
    expect(records).toHaveLength(1)
    expect(records[0]!.scope.sourceHostId).toBeNull()
    expect(records[0]!.events).toEqual([
      { sequence: 1, wallMs: 1000, monoMs: 10, phase: 'watch-opened', watchId: 'watch-a' },
      { sequence: 2, wallMs: 1001, monoMs: 11, phase: 'invalidation-received', watchId: 'watch-a', sourceHostId: 'actual-source', sourceKind: 'native' },
    ])
    expect(records[0]!.coverage).toMatchObject({ firstSequence: 1, lastSequence: 2, overwritten: 0, rejected: 0 })
  })

  it('retains a recent bounded history under ordinary repeated lifecycle events', () => {
    const { recorder, records } = harness()
    for (let index = 0; index < 200; index++) recorder.record({ phase: 'read-page', attemptId: `attempt-${index}`, itemCount: 20 })
    recorder.flush('progress')
    expect(records).toHaveLength(1)
    expect(records[0]!.events).toHaveLength(64)
    expect(records[0]!.events[0]!.sequence).toBe(137)
    expect(records[0]!.events.at(-1)!.sequence).toBe(200)
    expect(records[0]!.coverage).toMatchObject({ firstSequence: 137, lastSequence: 200, overwritten: 136, rejected: 0 })
    expect(recorder.status()).toMatchObject({ recorded: 200, retained: 64, overwritten: 136, rejected: 0 })
  })

  it('bounds the actual UTF-8 envelope and accounts for byte eviction separately from rejection', () => {
    const { recorder, records } = harness()
    const nativeSessionId = '界'.repeat(160)
    for (let index = 0; index < 40; index++) recorder.record({ phase: 'source-invalidated', sourceKind: 'native', nativeSource: { providerId: 'provider', nativeSessionId },
      attemptId: 'a'.repeat(500), watchId: 'w'.repeat(500), windowId: 'v'.repeat(500) })
    recorder.record({ phase: 'read-started', attemptId: '\n'.repeat(20_000) })
    recorder.record({ phase: 'read-failed', reason: 'protocol' })
    recorder.flush('failure')
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.events.length).toBeGreaterThan(1)
    expect(record.events.length).toBeLessThan(40)
    expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThanOrEqual(32 * 1024)
    expect(record.events.at(-1)!.sequence).toBe(42)
    expect(record.coverage.overwritten).toBe(41 - record.events.length)
    expect(record.coverage.rejected).toBe(1)
    expect(recorder.status().rejected).toBe(1)
    expect(parseReadingDiagnosticRecord(record)).toEqual(record)
  })

  it('takes detached frozen facts at append and does not let later events rewrite an emitted incident', () => {
    const originalScope = scope(), nativeSource = { providerId: 'provider', nativeSessionId: 'native-a' }
    const input = { phase: 'source-invalidated' as const, sourceKind: 'native' as const, nativeSource, attemptId: 'original' }
    const records: ReadingDiagnosticRecord[] = []
    let serial = 0
    const recorder = createReadingDiagnosticRecorder(originalScope, { publish: record => records.push(record), now: () => 5, wall: () => 50,
      mintId: () => String(++serial).padStart(12, '1') })
    recorder.record(input)
    expect(() => { originalScope.consumerId = 'mutated'; nativeSource.nativeSessionId = 'mutated'; input.attemptId = 'mutated' }).not.toThrow()
    recorder.flush('failure')
    expect(records).toHaveLength(1)
    const first = records[0]!, original = JSON.stringify(first)
    expect(first.scope.consumerId).toBe('consumer-a')
    expect(first.events[0]!.nativeSource!.nativeSessionId).toBe('native-a')
    expect(first.events[0]!.attemptId).toBe('original')
    expect(() => { first.events[0]!.nativeSource!.nativeSessionId = 'output mutation' }).toThrow(TypeError)
    expect(() => { first.scope.consumerId = 'output mutation' }).toThrow(TypeError)
    expect(() => { (first.events as unknown[]).push({}) }).toThrow(TypeError)
    for (let index = 0; index < 100; index++) recorder.record({ phase: 'read-page', itemCount: index })
    recorder.flush('recovered')
    expect(records).toHaveLength(2)
    expect(JSON.stringify(first)).toBe(original)
    expect(records[1]!.previousLogId).toBe(first.logId)
  })

  it('does not serialize caller-owned extra fields or toJSON', () => {
    const { recorder, records } = harness()
    let serializerCalls = 0
    recorder.record({ phase: 'read-started', attemptId: 'attempt-a', body: 'private',
      toJSON() { serializerCalls++; throw new Error('must never execute caller serializer') } } as Parameters<typeof recorder.record>[0])
    recorder.flush('progress')
    expect(records).toHaveLength(1)
    expect(records[0]!.events).toEqual([])
    expect(recorder.status().rejected).toBe(1)
    expect(serializerCalls).toBe(0)
  })

  it('keeps the original work running through a publication failure and exposes that failure', () => {
    let originalWork = 0, publications = 0
    const { recorder, records } = harness(() => { if (++publications === 1) throw new Error('journal not available') })
    const originalRead = () => {
      recorder.record({ phase: 'read-page', itemCount: 3 })
      recorder.flush('progress')
      originalWork++
      return ['original', 'page', 'data']
    }
    let result: string[] | undefined
    expect(() => { result = originalRead() }).not.toThrow()
    expect(result).toEqual(['original', 'page', 'data'])
    expect(originalWork).toBe(1)
    expect(recorder.status()).toMatchObject({ publicationFailures: 1, lastEmittedLogId: null, recorded: 1 })
    recorder.record({ phase: 'admission-accepted', itemCount: 3 })
    recorder.flush('recovered')
    expect(records).toHaveLength(2)
    expect(records[1]!.previousLogId).toBeNull()
    expect(records[1]!.coverage.publicationFailures).toBe(1)
    expect(recorder.status()).toMatchObject({ publicationFailures: 1, lastEmittedLogId: records[1]!.logId })
  })

  it('does not recursively publish and retains only finite failure counters', () => {
    let publications = 0
    const recorder = createReadingDiagnosticRecorder(scope(), { now: () => 1, wall: () => 1,
      publish() { publications++; recorder.flush('failure') } })
    recorder.record({ phase: 'consumer-started' })
    recorder.flush('progress')
    expect(publications).toBe(1)
    expect(recorder.status()).toMatchObject({ publicationFailures: 1, retained: 1 })
  })

  it('quarantines an asynchronous sink rejection without replaying it or claiming a synchronous emission', async () => {
    const unhandled: unknown[] = [], records: ReadingDiagnosticRecord[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    try {
      let serial = 0
      const recorder = createReadingDiagnosticRecorder(scope(), { now: () => 1, wall: () => 1,
        mintId: () => String(++serial).padStart(12, '1'), publish(record) {
          records.push(record)
          if (records.length === 1) return Promise.reject(new Error('asynchronous sink violates enqueue contract'))
        } })
      recorder.record({ phase: 'read-page', itemCount: 3 })
      recorder.flush('progress')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
      expect(records).toHaveLength(1)
      expect(recorder.status()).toMatchObject({ publicationFailures: 1, lastEmittedLogId: null })
      recorder.flush('recovered')
      expect(records).toHaveLength(2)
      expect(records[1]!.previousLogId).toBeNull()
      expect(records[1]!.coverage.publicationFailures).toBe(1)
      expect(recorder.status().lastEmittedLogId).toBe(records[1]!.logId)
    } finally { process.off('unhandledRejection', onUnhandled) }
  })

  it('rejects a nonfinite flush trigger without serializing it', () => {
    const { recorder, records } = harness()
    let serialized = 0
    recorder.record({ phase: 'consumer-started' })
    recorder.flush({ toJSON() { serialized++; return 'progress' } } as unknown as ReadingDiagnosticRecord['trigger'])
    expect(records).toEqual([])
    expect(serialized).toBe(0)
    expect(recorder.status()).toMatchObject({ publicationFailures: 1, retained: 1 })
  })

  it('exposes failed metadata and clocks without throwing into the original reader', () => {
    const invalidScope = scope(); invalidScope.consumerId = 'x'.repeat(40_000)
    const invalid = createReadingDiagnosticRecorder(invalidScope, { publish() { throw new Error('must not publish') } })
    expect(() => invalid.record({ phase: 'consumer-started' })).not.toThrow()
    expect(() => invalid.flush('failure')).not.toThrow()
    expect(invalid.status()).toMatchObject({ retained: 0, rejected: 1, publicationFailures: 1 })
    const brokenClock = createReadingDiagnosticRecorder(scope(), { publish() {}, now() { throw new Error('clock unavailable') } })
    expect(() => brokenClock.record({ phase: 'read-started' })).not.toThrow()
    expect(brokenClock.status()).toMatchObject({ retained: 0, rejected: 1 })
  })

  it('reports consumer end at its original observation time and never invents it for a release flush', () => {
    const { recorder, records } = harness()
    recorder.record({ phase: 'read-started' })
    recorder.flush('release')
    recorder.record({ phase: 'consumer-ended', reason: 'disposed' })
    recorder.flush('release')
    expect(records).toHaveLength(2)
    expect(records[0]!.endedAt).toBeNull()
    expect(records[1]!).toMatchObject({ startedAt: 1000, endedAt: 1001 })
  })
})
