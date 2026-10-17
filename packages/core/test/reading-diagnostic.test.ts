import { describe, expect, it } from 'vitest'
import { parseReadingDiagnosticEvent, parseReadingDiagnosticRecord, parseReadingDiagnosticScope,
  READING_DIAGNOSTIC_MAX_RECORD_BYTES, type ReadingDiagnosticRecord } from '../src/reading-diagnostic.js'

const original = (): ReadingDiagnosticRecord => ({
  version: 'reading-diagnostic.v1', logId: '111111111111', previousLogId: null,
  scope: { hostId: 'local', agentSessionId: 'session-original', runId: null, sourceHostId: null,
    owner: 'renderer', ownerInstanceId: 'instance-original', producerBuildId: null,
    consumerId: 'consumer-lifetime', consumerKind: 'conversation-pane' },
  trigger: 'progress', startedAt: 100, endedAt: null,
  events: [{ sequence: 1, wallMs: 100, monoMs: 1, phase: 'consumer-started' },
    { sequence: 2, wallMs: 99, monoMs: 2, phase: 'invalidation-received', sourceHostId: 'source-original',
      sourceKind: 'native', nativeSource: { providerId: 'provider-original', nativeSessionId: 'native-original' } }],
  coverage: { firstSequence: 1, lastSequence: 2, overwritten: 0, rejected: 0, publicationFailures: 0 },
})

describe('finite reading diagnostic boundary', () => {
  it('preserves origin, unknown initial bindings and wall rollback without inventing a shared clock', () => {
    const record = parseReadingDiagnosticRecord(original())
    expect(record.scope).toMatchObject({ sourceHostId: null, runId: null, ownerInstanceId: 'instance-original' })
    expect(record.events[1]).toMatchObject({ sourceHostId: 'source-original', wallMs: 99, monoMs: 2 })
    expect(record.events[1]?.phase).toBe('invalidation-received')
    expect(parseReadingDiagnosticEvent({ sequence: 3, wallMs: 101, monoMs: 3, phase: 'source-invalidated' }).phase).toBe('source-invalidated')
  })

  it('rejects body, cursors, arbitrary codes and unknown keys at their actual boundary', () => {
    const event = original().events[0]!
    for (const field of ['body', 'cursor', 'checkpoint', 'errorText', 'stack', 'cause']) {
      expect(() => parseReadingDiagnosticEvent({ ...event, [field]: 'private-material' })).toThrow()
    }
    expect(() => parseReadingDiagnosticEvent({ ...event, reason: 'PRIVATE_REASON' })).toThrow()
    expect(() => parseReadingDiagnosticRecord({ ...original(), originalText: 'private-material' })).toThrow()
    expect(() => parseReadingDiagnosticScope({ ...original().scope, unknown: true })).toThrow()
  })

  it('detaches every retained JSON field from the source objects', () => {
    const source = original(), parsed = parseReadingDiagnosticRecord(source)
    source.scope.agentSessionId = 'different-session'
    source.events[1]!.nativeSource!.nativeSessionId = 'different-native'
    source.coverage.rejected = 9
    expect(parsed.scope.agentSessionId).toBe('session-original')
    expect(parsed.events[1]?.nativeSource?.nativeSessionId).toBe('native-original')
    expect(parsed.coverage.rejected).toBe(0)
  })

  it('does not execute accessor fields or toJSON hooks', () => {
    let called = 0
    const event = Object.defineProperty({ sequence: 1, wallMs: 1, monoMs: 1 }, 'phase', {
      enumerable: true, get() { called++; return 'consumer-started' },
    })
    expect(() => parseReadingDiagnosticEvent(event)).toThrow()
    expect(() => parseReadingDiagnosticEvent({ ...original().events[0], toJSON() { called++; return {} } })).toThrow()
    expect(called).toBe(0)
  })

  it('rebuilds event arrays without invoking caller methods, iterators or entry accessors', () => {
    const source = original()
    let called = 0
    Object.defineProperty(source.events, 'map', { value() { called++; return this } })
    Object.defineProperty(source.events, Symbol.iterator, { value() { called++; throw Error('untrusted iterator') } })
    Object.defineProperty(source.events, 'toJSON', { value() { called++; throw Error('untrusted serializer') } })
    let parsed!: ReadingDiagnosticRecord
    expect(() => { parsed = parseReadingDiagnosticRecord(source) }).not.toThrow()
    expect(parsed.events).not.toBe(source.events)
    source.events[1]!.nativeSource!.nativeSessionId = 'later-mutation'
    expect(parsed.events[1]!.nativeSource!.nativeSessionId).toBe('native-original')
    expect(called).toBe(0)
    const accessor = original()
    Object.defineProperty(accessor.events, 0, { get() { called++; return source.events[0] } })
    expect(() => parseReadingDiagnosticRecord(accessor)).toThrow()
    expect(called).toBe(0)
    const sparse = original()
    delete (sparse.events as unknown[])[0]
    expect(() => parseReadingDiagnosticRecord(sparse)).toThrow()
  })

  it('checks exact sequence coverage, monotonic order, finite counts and prior-record identity', () => {
    const record = original()
    expect(() => parseReadingDiagnosticRecord({ ...record, previousLogId: record.logId })).toThrow()
    expect(() => parseReadingDiagnosticRecord({ ...record, events: [record.events[1], record.events[0]] })).toThrow()
    expect(() => parseReadingDiagnosticRecord({ ...record, events: [record.events[0], { ...record.events[1], monoMs: 0 }] })).toThrow()
    expect(() => parseReadingDiagnosticRecord({ ...record, coverage: { ...record.coverage, lastSequence: 8 } })).toThrow()
    expect(() => parseReadingDiagnosticRecord({ ...record, coverage: { ...record.coverage, rejected: -1 } })).toThrow()
    expect(() => parseReadingDiagnosticEvent({ ...record.events[0], monoMs: NaN })).toThrow()
    expect(() => parseReadingDiagnosticEvent({ ...record.events[0], itemCount: Infinity })).toThrow()
  })

  it('bounds count, field sizes and the entire encoded envelope', () => {
    const record = original()
    expect(() => parseReadingDiagnosticRecord({ ...record, events: Array.from({ length: 65 }, (_, index) => ({ ...record.events[0], sequence: index + 1 })) })).toThrow()
    expect(() => parseReadingDiagnosticScope({ ...record.scope, consumerId: 'x'.repeat(513) })).toThrow()
    const large = { ...record, events: Array.from({ length: 64 }, (_, index) => ({ ...record.events[0], sequence: index + 1,
      attemptId: 'x'.repeat(512), windowId: 'y'.repeat(512) })), coverage: { ...record.coverage, firstSequence: 1, lastSequence: 64 } }
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeGreaterThan(READING_DIAGNOSTIC_MAX_RECORD_BYTES)
    expect(() => parseReadingDiagnosticRecord(large)).toThrow()
  })

  it('does not mix source identities or invent a known source', () => {
    const event = original().events[1]!
    expect(() => parseReadingDiagnosticEvent({ ...event, sourceKind: 'captured' })).toThrow()
    expect(() => parseReadingDiagnosticEvent({ ...original().events[0], capturedEpoch: 'original-epoch' })).toThrow()
    expect(parseReadingDiagnosticEvent({ ...original().events[0], sourceKind: 'captured', capturedEpoch: 'original-epoch' })).toMatchObject({ sourceKind: 'captured', capturedEpoch: 'original-epoch' })
  })
})
