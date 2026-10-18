// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxClientIncidentReport } from '@agentmux/core/client-incident'
import type { ReadingDiagnosticRecord } from '@agentmux/core/reading-diagnostic'
import { CLIENT_INCIDENT_DISPATCH_LIMITS, createClientIncidentDispatcher,
  type ClientIncidentTransport } from '../src/renderer/src/lib/client-incident-dispatcher'
import { clientIncidentDispatcher } from '../src/renderer/src/lib/client-incident-recorder'

const done = { accepted: true }
const freshId = (serial: number) => 'R'.repeat(10) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(serial / 32)]! + '123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[serial % 32]!
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept }); return { promise, resolve } }
function terminal(serial = 0): AgentMuxClientIncidentReport {
  return { occurrenceId: `terminal-${serial}`, attemptId: 'original-attempt', relatedOccurrenceId: null,
    hostId: 'local', regionId: null, kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'EIO',
    agentSessionId: 'original-session', runId: 'original-run', observedAt: 10, elapsedMs: 1, metadata: {}, stages: [], references: [] }
}
function reading(serial: number, consumerId = 'original-consumer', trigger: ReadingDiagnosticRecord['trigger'] = 'progress'): AgentMuxClientIncidentReport {
  const record: ReadingDiagnosticRecord = { version: 'reading-diagnostic.v1', logId: freshId(serial), previousLogId: null,
    scope: { hostId: 'local', agentSessionId: 'original-session', runId: 'original-run', sourceHostId: null,
      owner: 'renderer', ownerInstanceId: 'original-realm', producerBuildId: null, consumerId, consumerKind: 'conversation-pane' },
    trigger, startedAt: 10, endedAt: trigger === 'release' ? 20 : null,
    events: [{ sequence: 1, wallMs: 10, monoMs: 1, phase: 'read-started', attemptId: String(serial), operation: 'changes' }],
    coverage: { firstSequence: 1, lastSequence: 1, overwritten: 0, rejected: 0, publicationFailures: 0 } }
  return { ...terminal(serial), occurrenceId: record.logId, attemptId: consumerId, relatedOccurrenceId: null,
    kind: trigger === 'failure' ? 'conversation-reading-failure' : trigger === 'held' ? 'conversation-reading-held'
      : trigger === 'recovered' ? 'conversation-reading-recovered' : 'conversation-reading-progress',
    stage: 'reading-observed', code: null, elapsedMs: 0, reading: record }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('owns one actual Realm queue regardless of document positions', async () => {
  const report = vi.fn(async () => done), open = vi.fn(async () => ({ token: 'realm-token' }))
  vi.stubGlobal('agentmux', { clientIncidents: { open, report } })
  const first = clientIncidentDispatcher()
  document.implementation.createHTMLDocument('another-position')
  const second = clientIncidentDispatcher()
  expect(first).toBe(second)
  first.send(terminal()); second.send(terminal(1))
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
  expect(open).toHaveBeenCalledTimes(1)
  expect(first.inspect()).toMatchObject({ pending: 0, pendingBytes: 0, inFlight: false })
})

it('detaches metadata before queueing and preserves actual in-flight admission until settlement', async () => {
  const release = deferred<unknown>(), observed: AgentMuxClientIncidentReport[] = []
  const report = vi.fn(async (_token: string, input: AgentMuxClientIncidentReport) => { observed.push(input); return release.promise })
  const sender = createClientIncidentDispatcher(() => ({ open: async () => ({ token: 'realm-token' }), report }))
  const input = terminal()
  sender.send(input)
  input.metadata.cursorBytes = 400
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  const next = terminal(1); next.metadata.cursorBytes = 3; sender.send(next); next.metadata.cursorBytes = 999
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(sender.inspect()).toMatchObject({ pending: 1, inFlight: true })
  expect(report).toHaveBeenCalledTimes(1)
  expect(observed[0]!.metadata.cursorBytes).toBeUndefined()
  release.resolve(done)
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2))
  expect(observed[1]!.metadata.cursorBytes).toBe(3)
})

it('shares count and UTF-8 budgets across reading and Terminal while retaining the first pending start', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const opening = deferred<unknown>(), sent: AgentMuxClientIncidentReport[] = []
  const transport = { open: vi.fn(() => opening.promise), report: vi.fn(async (_token: string, input: AgentMuxClientIncidentReport) => { sent.push(input); return done }) }
  const sender = createClientIncidentDispatcher(() => transport)
  for (let index = 0; index < 30; index++) sender.send(reading(index))
  expect(sender.inspect()).toMatchObject({ pending: 2, inFlight: true, coalesced: 28 })
  sender.send(terminal())
  sender.send(reading(30, 'original-consumer', 'failure'))
  sender.send(reading(31, 'original-consumer', 'held'))
  sender.send(reading(32, 'original-consumer', 'recovered'))
  expect(sender.inspect().pending).toBe(6)
  opening.resolve({ token: 'realm-token' })
  await vi.advanceTimersByTimeAsync(2000)
  expect(sent).toHaveLength(6)
  expect(sent.filter(item => item.kind === 'conversation-reading-progress').map(item => item.occurrenceId)).toEqual([freshId(0), freshId(29)])
  expect(sent.map(item => item.kind)).toEqual(['terminal-attach-failed', 'conversation-reading-failure',
    'conversation-reading-held', 'conversation-reading-recovered', 'conversation-reading-progress', 'conversation-reading-progress'])
  expect(sender.dropped()).toBe(28)
  expect(sender.inspect().pendingBytes).toBe(0)
})

it('reserves shared capacity for critical incidents when distinct healthy consumers fill their finite tier', async () => {
  const opening = deferred<unknown>(), transport = { open: () => opening.promise, report: vi.fn(async () => done) }
  const sender = createClientIncidentDispatcher(() => transport)
  for (let index = 0; index < 40; index++) sender.send(reading(index, `consumer-${index}`))
  expect(sender.inspect()).toMatchObject({ pending: CLIENT_INCIDENT_DISPATCH_LIMITS.readingReports, dropped: 24 })
  sender.send(terminal())
  expect(sender.inspect().pending).toBe(17)
  for (let index = 0; index < 40; index++) sender.send(terminal(index + 1))
  expect(sender.inspect().pending).toBe(CLIENT_INCIDENT_DISPATCH_LIMITS.reports)
  expect(sender.inspect().pendingBytes).toBeLessThanOrEqual(CLIENT_INCIDENT_DISPATCH_LIMITS.bytes)
  opening.resolve(null)
  await vi.waitFor(() => expect(sender.inspect()).toMatchObject({ pending: 0, pendingBytes: 0, inFlight: false }))
})

it('accounts actual encoded report bytes rather than character length', async () => {
  const opening = deferred<unknown>(), transport = { open: () => opening.promise, report: async () => done }
  const sender = createClientIncidentDispatcher(() => transport)
  const report = reading(0)
  report.reading!.events = Array.from({ length: 40 }, (_, index) => ({ sequence: index + 1, wallMs: 10, monoMs: 1,
    phase: 'read-page', attemptId: '界'.repeat(160) }))
  report.reading!.coverage = { ...report.reading!.coverage, lastSequence: 40 }
  const actual = new TextEncoder().encode(JSON.stringify(report)).byteLength
  expect(actual).toBeGreaterThan(JSON.stringify(report).length)
  for (let index = 0; index < 30; index++) {
    const copy = structuredClone(report)
    copy.reading!.scope.consumerId = `wide-consumer-${index}`; copy.attemptId = copy.reading!.scope.consumerId
    copy.reading!.logId = freshId(index); copy.occurrenceId = freshId(index)
    sender.send(copy)
  }
  expect(sender.inspect().pending).toBeGreaterThan(0)
  expect(sender.inspect().pending).toBeLessThan(CLIENT_INCIDENT_DISPATCH_LIMITS.readingReports)
  expect(sender.inspect().pendingBytes).toBeLessThanOrEqual(CLIENT_INCIDENT_DISPATCH_LIMITS.readingBytes)
  expect(sender.dropped()).toBeGreaterThan(0)
  opening.resolve(null)
  await vi.waitFor(() => expect(sender.inspect().inFlight).toBe(false))
})

it('reclaims queued healthy progress to preserve a newly arriving critical observation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const opening = deferred<unknown>(), seen: AgentMuxClientIncidentReport[] = []
  const sender = createClientIncidentDispatcher(() => ({ open: () => opening.promise,
    report: async (_token, report) => { seen.push(report); return report.reading ? { accepted: true, logId: report.reading.logId } : done } }))
  for (let index = 0; index < 16; index++) sender.send(reading(index, `consumer-${index}`))
  for (let index = 0; index < 16; index++) sender.send(terminal(index))
  expect(sender.inspect()).toMatchObject({ pending: 32, inFlight: true, dropped: 0 })
  sender.send(terminal(99))
  expect(sender.inspect()).toMatchObject({ pending: 32, inFlight: true, dropped: 1 })
  opening.resolve({ token: 'realm-token' })
  await vi.advanceTimersByTimeAsync(16000)
  expect(seen).toHaveLength(32)
  expect(seen.filter(report => report.kind === 'conversation-reading-progress')).toHaveLength(15)
  expect(seen.some(report => report.occurrenceId === 'terminal-99')).toBe(true)
})

it('does not coerce unknown receipts, leak rejections or replay an unknown report', async () => {
  const unhandled: unknown[] = [], listener = (value: unknown) => unhandled.push(value)
  process.on('unhandledRejection', listener)
  let getterCalls = 0
  const receipts = [null, { accepted: 'yes' }, { accepted: false, logId: freshId(0) }, { accepted: true, logId: 'not-a-log-id' },
    Object.defineProperty({}, 'accepted', { enumerable: true, get() { getterCalls++; return true } })]
  try {
    for (const receipt of receipts) {
      const transport = { open: vi.fn(async () => ({ token: 'realm-token' })), report: vi.fn(async (_token: string, _input: AgentMuxClientIncidentReport) => receipt) }
      const sender = createClientIncidentDispatcher(() => transport)
      sender.send(terminal())
      await vi.waitFor(() => expect(sender.inspect().inFlight).toBe(false))
      expect(sender.inspect()).toMatchObject({ dropped: 1, unavailable: 1 })
      sender.send(terminal(1))
      await vi.waitFor(() => expect(transport.report).toHaveBeenCalledTimes(2))
      expect(transport.report.mock.calls.map(([, input]) => input.occurrenceId)).toEqual(['terminal-0', 'terminal-1'])
      expect(transport.open).toHaveBeenCalledTimes(2)
    }
    expect(getterCalls).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unhandled).toEqual([])
  } finally { process.off('unhandledRejection', listener) }
})

it('rejects extra metadata and serializers without calling them or opening transport', () => {
  const open = vi.fn(async () => ({ token: 'realm-token' })), report = vi.fn(async () => done)
  const sender = createClientIncidentDispatcher(() => ({ open, report }))
  let serializers = 0
  const invalid = { ...terminal(), privateBody: 'withheld', toJSON() { serializers++; return terminal() } }
  const extraField = { ...terminal(), privateBody: 'withheld' }
  const extraMetadata = { ...terminal(), metadata: { ...terminal().metadata, cwd: 'withheld-location' } }
  expect(() => { sender.send(invalid); sender.send(extraField); sender.send(extraMetadata) }).not.toThrow()
  expect(sender.inspect()).toMatchObject({ pending: 0, dropped: 3, rejected: 3 })
  expect(serializers).toBe(0); expect(open).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled()
})

it('counts a throwing or unavailable bridge without affecting the caller', () => {
  const sender = createClientIncidentDispatcher(() => { throw Error('diagnostic transport unavailable') })
  expect(() => sender.send(terminal())).not.toThrow()
  expect(sender.inspect()).toMatchObject({ pending: 0, dropped: 1, unavailable: 1, inFlight: false })
})

it('parses metadata in a Browser without a Node Buffer global', async () => {
  const report = vi.fn(async () => done)
  const transport: ClientIncidentTransport = { open: async () => ({ token: 'realm-token' }), report }
  const sender = createClientIncidentDispatcher(() => transport)
  const originalBuffer = globalThis.Buffer
  try { vi.stubGlobal('Buffer', undefined); sender.send(terminal()) }
  finally { vi.stubGlobal('Buffer', originalBuffer) }
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1))
  expect(sender.inspect()).toMatchObject({ rejected: 0, dropped: 0 })
})

it('treats an accepted reading receipt with another original logId as unknown rather than saved', async () => {
  const transport = { open: async () => ({ token: 'realm-token' }), report: vi.fn(async () => ({ accepted: true, logId: freshId(1) })) }
  const sender = createClientIncidentDispatcher(() => transport)
  sender.send(reading(0))
  await vi.waitFor(() => expect(sender.inspect().inFlight).toBe(false))
  expect(transport.report).toHaveBeenCalledTimes(1)
  expect(sender.inspect()).toMatchObject({ dropped: 1, unavailable: 1 })
})

it('accepts a frozen report while discarding custom array serializers before queueing', async () => {
  let serializers = 0
  const reports: AgentMuxClientIncidentReport[] = []
  const transport = { open: async () => ({ token: 'realm-token' }), report: async (_token: string, value: AgentMuxClientIncidentReport) => { reports.push(value); return done } }
  const sender = createClientIncidentDispatcher(() => transport)
  const input = terminal()
  input.stages = Object.assign([], { toJSON() { serializers++; return ['private-array-text'] } })
  sender.send(Object.freeze(input))
  sender.send(Object.freeze(reading(0)))
  await vi.waitFor(() => expect(reports).toHaveLength(2))
  expect(serializers).toBe(0)
  expect(reports[0]!.stages).toEqual([])
  expect(JSON.stringify(reports)).not.toContain('private-array-text')
  expect(sender.inspect()).toMatchObject({ rejected: 0, dropped: 0 })
})
