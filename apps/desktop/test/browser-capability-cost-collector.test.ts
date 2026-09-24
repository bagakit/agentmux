import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, requestAgentMuxControl, subscribeAgentMuxControl } from '../../../packages/core/src/control-host'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '../../../packages/core/src/control'
import { assertNativeBrowserMeasurements, collectBrowserCapabilityMeasurements, summarizeBrowserOutcomeCollection } from '../scripts/lib/browser-capability-cost-collector.mjs'

// Source contract models and one actual public socket consumer; no Native extraction, GUI or user Run is claimed.
function facts() {
  const operation = { id: 'original-producer', browserId: 'original-browser', phase: 'completed', startedAt: 1,
    operator: { id: 'human', name: 'Human' }, summary: 'Observe original fields', url: 'https://example.test/',
    steps: [{ method: 'extractStructured', sequence: 1, status: 'completed' }] }
  const source = { operationId: operation.id, browserId: operation.browserId }
  const recordedResult = { artifact: { ...source, id: 'artifact', byteLength: 5 }, source, byteLength: 5,
    document: { schema: 'browser-structured-output.v1', source, work: { reads: 2, readBytes: 3, visitedElements: 7,
      elementWalkSteps: 8, selectorChecks: 8, textNodes: 1, textWalkSteps: 2 } },
    chunks: [{ offset: 0, returnedBytes: 2, nextOffset: 2, readCost: { metadataBytes: 17, payloadBytes: 5 } },
      { offset: 2, returnedBytes: 3, nextOffset: null, readCost: { metadataBytes: 17, payloadBytes: 5 } }] }
  const sibling = { ...operation, id: 'sibling-operation', browserId: 'sibling-browser' }
  return { operation, recordedResult, sibling }
}
function packet() {
  const { operation, recordedResult, sibling } = facts()
  const sample = (actual: typeof operation, cursor: number, events: any[]) => ({ operationId: actual.id, browserId: actual.browserId,
    afterSequence: cursor, opened: { at: 10, runOperation: actual, gap: null }, events, ends: [{ at: 113, reason: 'closed' }], disposedAt: 112 })
  const related = [{ sequence: 8, event: { operationId: operation.id, type: 'phase-changed', phase: 'completed' } }]
  const replay = [{ sequence: 3, event: { operationId: sibling.id, type: 'phase-changed', phase: 'completed' } }]
  return { schema: 'agentmux.browser-capability-native-measurements.v1', passed: true, boundary: 'native-producer-and-public-journal',
    candidateCommit: 'a'.repeat(40), sourceIdentity: { 'apps/desktop/scripts/lib/browser-capability-cost-collector.mjs': 'b'.repeat(64) },
    producer: { operation, recordedResult, totals: summarizeBrowserOutcomeCollection(recordedResult, operation) },
    journal: { preparation: sample(sibling, 0, replay), related: sample(operation, 0, related), unrelated: sample(sibling, 3, []),
      window: { startedAt: 9, bothOpenedAt: 11, endedAt: 111, fixedQuietWindowMs: 100 } } }
}

describe('actual cost fact consumer', () => {
  it('observes the full real time window even when a timer fires early in an explicit Source clock model', async () => {
    const { operation, recordedResult, sibling } = facts()
    let now = 10
    const waits: number[] = []
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      waits.push(delay); now += waits.length === 1 ? delay - 1 : delay
      queueMicrotask(callback)
      return 0 as any
    }) as any)
    const ctx = { receipt: { sourceCommit: 'a'.repeat(40), identityBefore: { collector: 'b'.repeat(64) }, browserOutcome: { recordedResult } },
      requestControl: async (request: any) => ({ ok: true, operation: request.operation, result: request.operation === 'browser.operation' ? { runOperation: operation } : { operations: [sibling] } }),
      subscribeControl: async (request: any, handlers: any) => {
        const actual = request.operationId === operation.id ? operation : sibling, sequence = actual === operation ? 8 : 3
        if (request.afterSequence < sequence) handlers.onEvent({ sequence, event: { operationId: actual.id, type: 'phase-changed', phase: 'completed' } })
        return { runOperation: actual, gap: null, dispose: () => handlers.onEnd('closed') }
      }, waitFor: async (_label: string, read: () => unknown) => { expect(read()).toBe(true) } }
    try {
      const result = await collectBrowserCapabilityMeasurements(ctx, { relatedOperationId: operation.id, siblingBrowserId: sibling.browserId })
      expect(waits).toEqual([100, 1])
      expect(result.journal.window.endedAt - result.journal.window.bothOpenedAt).toBe(100)
    } finally { timer.mockRestore(); clock.mockRestore() }
  })
  it('keeps extraction calls, DOM reads, returned slices, persisted payload and physical reads distinct', () => {
    const { operation, recordedResult } = facts()
    expect(summarizeBrowserOutcomeCollection(recordedResult, operation)).toEqual({ extractCalls: 1, extractStepSequences: [1],
      visitedElements: 7, attributeReads: 2, attributeReadBytes: 3, persistedPayloadBytes: 5, returnedBytes: 5,
      physicalMetadataBytes: 34, physicalPayloadBytes: 10 })
    expect(() => assertNativeBrowserMeasurements(packet())).not.toThrow()
  })
  it('rejects lost physical read facts instead of inferring them from return bytes', () => {
    const x = facts(); delete (x.recordedResult.chunks[0] as any).readCost
    expect(() => summarizeBrowserOutcomeCollection(x.recordedResult, x.operation)).toThrow()
    const y = facts(); y.recordedResult.chunks[0]!.readCost.payloadBytes = 1
    expect(() => summarizeBrowserOutcomeCollection(y.recordedResult, y.operation)).toThrow('Physical reads')
  })
  it('rejects another producer, empty actual extraction calls and partial payload reads', () => {
    const x = facts(); x.recordedResult.artifact.operationId = 'another'
    expect(() => summarizeBrowserOutcomeCollection(x.recordedResult, x.operation)).toThrow('another producer')
    const y = facts(); y.operation.steps[0]!.method = 'getSnapshot'
    expect(() => summarizeBrowserOutcomeCollection(y.recordedResult, y.operation)).toThrow('actual extraction calls')
    const z = facts(); z.recordedResult.chunks = []
    expect(() => summarizeBrowserOutcomeCollection(z.recordedResult, z.operation)).toThrow('raw artifact read chunks')
  })
  it('rejects manual collection aggregates that disagree with raw chunks and actual work', () => {
    const x = packet(); x.producer.totals.physicalPayloadBytes = 5
    expect(() => assertNativeBrowserMeasurements(x)).toThrow('derive from raw original facts')
  })
  it('rejects an unopened, gapped or errored stream and missing actual close observation', () => {
    for (const change of [(r: any) => { r.opened = null }, (r: any) => { r.opened.gap = { droppedThrough: 2 } },
      (r: any) => { r.ends = [{ reason: 'error', error: 'connection lost' }] }, (r: any) => { r.ends = [] }]) {
      const x = packet(); change(x.journal.unrelated); expect(() => assertNativeBrowserMeasurements(x)).toThrow()
    }
  })
  it('rejects an invented cursor, empty related callbacks and unrelated delivery amplification', () => {
    const x = packet(); x.journal.unrelated.afterSequence = 99
    expect(() => assertNativeBrowserMeasurements(x)).toThrow('actual prior final sequence')
    const y = packet(); y.journal.related.events = []
    expect(() => assertNativeBrowserMeasurements(y)).toThrow('related public callback')
    const z = packet(); z.journal.unrelated.events.push({ sequence: 4, event: { operationId: 'sibling-operation', type: 'phase-changed', phase: 'completed' } })
    expect(() => assertNativeBrowserMeasurements(z)).toThrow('Unrelated actual callbacks')
  })
  it('requires the entire prior sibling replay from cursor zero to the completed operation', () => {
    const incomplete = packet(); incomplete.journal.preparation.events[0]!.event.phase = 'running'
    expect(() => assertNativeBrowserMeasurements(incomplete)).toThrow('prior replay must finish')
    const prior = packet(); prior.journal.preparation.afterSequence = 2
    expect(() => assertNativeBrowserMeasurements(prior)).toThrow('prior replay from its actual beginning')
  })
  it('rejects same-operation unrelated samples, foreign callbacks and incomplete observation windows', () => {
    const x = packet(); x.journal.preparation = structuredClone(x.journal.related); x.journal.unrelated = structuredClone(x.journal.related)
    x.journal.unrelated.afterSequence = 8; x.journal.unrelated.events = []
    expect(() => assertNativeBrowserMeasurements(x)).toThrow('another real operation')
    const y = packet(); y.journal.related.events[0]!.event.operationId = 'foreign'
    expect(() => assertNativeBrowserMeasurements(y)).toThrow('another operation')
    const z = packet(); z.journal.window.endedAt = 60
    expect(() => assertNativeBrowserMeasurements(z)).toThrow('complete actual fixed observation window')
  })
  it('collects actual callbacks through the real public Core stream and never executes browser.run', async () => {
    const { operation, recordedResult, sibling } = facts(), root = await mkdtemp(join(tmpdir(), 'amx-cost-source-')), socket = join(root, 'control.sock')
    const requests: string[] = [], subscriptions: Array<{ operationId: string; afterSequence: number }> = [], disposals: string[] = []
    const server = new AgentMuxControlServer({
      async execute(request: any) {
        requests.push(request.operation)
        if (request.operation === 'browser.operation') return { operation: request.operation, runOperation: operation }
        if (request.operation === 'browser.history') return { operation: request.operation, operations: [sibling] }
        throw new Error('Unexpected mutation request')
      },
      async subscribeBrowserOperation(request: any, callback: any) {
        subscriptions.push({ operationId: request.operationId, afterSequence: request.afterSequence })
        const actual = request.operationId === operation.id ? operation : sibling, sequence = actual === operation ? 8 : 3
        if (request.afterSequence < sequence) callback({ sequence, event: { operationId: actual.id, type: 'phase-changed', phase: 'completed' } })
        return { runOperation: actual, gap: null, dispose: () => disposals.push(actual.id) }
      }
    } as any, socket)
    try {
      await server.start()
      const ctx = { receipt: { sourceCommit: 'a'.repeat(40), identityBefore: { collector: 'b'.repeat(64) }, browserOutcome: { recordedResult } },
        requestControl: (fields: any) => requestAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), ...fields }, socket),
        subscribeControl: (fields: any, handlers: any) => subscribeAgentMuxControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: randomUUID(), ...fields }, handlers, socket),
        waitFor: async (_label: string, read: any) => { for (let i = 0; i < 100; i++) { const value = read(); if (value) return value; await new Promise(done => setTimeout(done, 2)) } throw new Error('Source observation budget exceeded') } }
      const result = await collectBrowserCapabilityMeasurements(ctx, { relatedOperationId: operation.id, siblingBrowserId: sibling.browserId })
      expect(result.journal.related.events).toEqual([{ sequence: 8, event: { operationId: operation.id, type: 'phase-changed', phase: 'completed' } }])
      expect(result.journal.unrelated.events).toEqual([])
      expect(requests).toEqual(['browser.operation', 'browser.history'])
      expect(subscriptions).toEqual([{ operationId: sibling.id, afterSequence: 0 }, { operationId: sibling.id, afterSequence: 3 }, { operationId: operation.id, afterSequence: 0 }])
      expect(result.producer.totals.physicalMetadataBytes).toBe(34)
      expect(disposals.sort()).toEqual([sibling.id, sibling.id, operation.id].sort())
    } finally { await server.stop(); await rm(root, { recursive: true, force: true }) }
  })
})
