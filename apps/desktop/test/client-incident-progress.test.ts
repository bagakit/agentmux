import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { durableWriteFile } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import type { AgentMuxClientIncidentPage, AgentMuxClientIncidentRecord, AgentMuxClientIncidentReport } from '@agentmux/core/client-incident'
import type { ReadingDiagnosticRecord } from '@agentmux/core/reading-diagnostic'
import { createReadingDiagnosticRecorder } from '@agentmux/core/reading-diagnostic-recorder'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec'
import { createClientIncidentDispatcher, type ClientIncidentTransport } from '../src/renderer/src/lib/client-incident-dispatcher'
import { readingClientIncident } from '../src/renderer/src/lib/reading-client-incident'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { ClientIncidentIpcOwner } from '../src/main/client-incident-ipc'

const directories: string[] = []
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const time = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
function pending<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(accept => { resolve = accept }), resolve: (value: T) => resolve(value) } }
function reading(serial: number, trigger: ReadingDiagnosticRecord['trigger'] = 'progress', consumerId = 'original-consumer'): AgentMuxClientIncidentReport {
  const logId = mintObjectId()
  return readingClientIncident({ version: 'reading-diagnostic.v1', logId, previousLogId: null,
    scope: { owner: 'renderer', ownerInstanceId: 'original-realm', producerBuildId: null, consumerKind: 'conversation-pane',
      consumerId, hostId: 'local', agentSessionId: 'original-session', runId: 'original-run', sourceHostId: null },
    trigger, startedAt: 1, endedAt: null,
    events: [{ sequence: serial + 1, wallMs: 1, monoMs: 1, phase: 'read-started' }],
    coverage: { firstSequence: serial + 1, lastSequence: serial + 1, overwritten: 0, rejected: 0, publicationFailures: 0 } }, 0)
}
function transport() {
  const sent: AgentMuxClientIncidentReport[] = []
  const bridge: ClientIncidentTransport = { open: vi.fn(async () => ({ token: 'original-token' })),
    report: vi.fn(async (_token, report) => { sent.push(report); return { accepted: true } }) }
  return { bridge, sent, sender: createClientIncidentDispatcher(() => bridge) }
}

it('publishes the first progress now and the first pending checkpoint with latest tail in one finite window', async () => {
  time()
  const { sender, sent } = transport(), reports = Array.from({ length: 24 }, (_, index) => reading(index))
  sender.send(reports[0]!); await vi.advanceTimersByTimeAsync(0)
  expect(sent).toEqual([reports[0]])
  for (const report of reports.slice(1)) { sender.send(report); await vi.advanceTimersByTimeAsync(0) }
  expect(sender.inspect()).toMatchObject({ pending: 2, inFlight: false, coalesced: 21 })
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(999)
  expect(sent).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(sent).toEqual([reports[0], reports[1], reports[23]])
  expect(sender.inspect()).toMatchObject({ pending: 0, pendingBytes: 0, inFlight: false })
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(5000)
  expect(sent).toHaveLength(3)
})

it('shares one wake across actual consumers and lets failure, held, recovery and release interrupt it', async () => {
  time()
  const { sender, sent } = transport(), first = reading(0), tail = reading(1), other = reading(2, 'progress', 'another-consumer')
  sender.send(first); await vi.advanceTimersByTimeAsync(0)
  sender.send(tail); sender.send(other)
  expect(vi.getTimerCount()).toBe(1)
  const urgent = ['failure', 'held', 'recovered', 'release'].map((trigger, index) => reading(index + 3, trigger as ReadingDiagnosticRecord['trigger']))
  for (const report of urgent) { sender.send(report); await vi.advanceTimersByTimeAsync(0) }
  expect(sent).toEqual([first, ...urgent])
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent).toEqual([first, ...urgent, tail, other])
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the real report slot occupied and excludes new arrivals from the frozen progress batch', async () => {
  time()
  const gate = pending<unknown>(), sent: AgentMuxClientIncidentReport[] = []
  const first = reading(0), next = reading(1), later = reading(2)
  const bridge = { open: async () => ({ token: 'original-token' }), report: vi.fn(async (_token: string, report: AgentMuxClientIncidentReport) => {
    sent.push(report); return sent.length === 1 ? gate.promise : { accepted: true }
  }) }
  const sender = createClientIncidentDispatcher(() => bridge)
  sender.send(first); await vi.advanceTimersByTimeAsync(0)
  sender.send(next)
  await vi.advanceTimersByTimeAsync(500)
  expect(sent).toEqual([first]); expect(sender.inspect().inFlight).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  gate.resolve({ accepted: true }); await vi.advanceTimersByTimeAsync(0)
  expect(sender.inspect()).toMatchObject({ pending: 1, inFlight: false })
  const batchGate = pending<unknown>()
  bridge.report.mockImplementationOnce(async (_token, report) => { sent.push(report); return batchGate.promise })
  await vi.advanceTimersByTimeAsync(500)
  expect(sent).toEqual([first, next])
  sender.send(later)
  batchGate.resolve({ accepted: true }); await vi.advanceTimersByTimeAsync(0)
  expect(sent).toEqual([first, next])
  expect(sender.inspect()).toMatchObject({ pending: 1, inFlight: false })
  await vi.advanceTimersByTimeAsync(999)
  expect(sent).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(sent).toEqual([first, next, later])
  expect(vi.getTimerCount()).toBe(0)
})

it('releases the sole wake when the bridge disappears without replaying queued original reports', async () => {
  time()
  const { bridge, sent } = transport()
  let current: ClientIncidentTransport | undefined = bridge
  const sender = createClientIncidentDispatcher(() => current)
  sender.send(reading(0)); await vi.advanceTimersByTimeAsync(0)
  sender.send(reading(1)); expect(vi.getTimerCount()).toBe(1)
  current = undefined
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent).toHaveLength(1)
  expect(sender.inspect()).toMatchObject({ pending: 0, inFlight: false, dropped: 1, unavailable: 1 })
  expect(vi.getTimerCount()).toBe(0)
})

it('reduces settled-disk writes while retaining original evidence through authenticated IPC and public discovery', async () => {
  time()
  const directory = await mkdtemp(join(tmpdir(), 'incident-progress-')); directories.push(directory)
  let writes = 0, indexWrites = 0, candidateWrites = 0, bytes = 0
  const archive = new ClientIncidentArchive(directory, { write: async (path, content, options) => {
    writes++; bytes += Buffer.byteLength(content)
    if (path.endsWith('index.json')) indexWrites++; else if (path.endsWith('.candidate')) candidateWrites++
    return durableWriteFile(path, content, options)
  } })
  await archive.flush(); writes = indexWrites = candidateWrites = bytes = 0
  const frame = {}, contents = { mainFrame: frame, isDestroyed: () => false }
  const event = { sender: contents, senderFrame: frame }
  const ipc = new ClientIncidentIpcOwner({ archive, contents: contents as never, windowId: 1, generation: () => 1, buildId: () => null })
  const bridge = { open: async () => ipc.open(event as never), report: async (token: string, report: AgentMuxClientIncidentReport) => ipc.report(event as never, token, report) }
  const sender = createClientIncidentDispatcher(() => bridge), emitted: ReadingDiagnosticRecord[] = []
  let monotonic = 0
  const recorder = createReadingDiagnosticRecorder({ owner: 'renderer', ownerInstanceId: 'original-realm', producerBuildId: null,
    consumerKind: 'conversation-pane', consumerId: 'original-consumer', hostId: 'local', agentSessionId: 'original-session', runId: 'original-run', sourceHostId: null },
  { now: () => monotonic, wall: () => 100 + monotonic, publish: record => { emitted.push(record); sender.send(readingClientIncident(record, sender.dropped())) } })
  for (let index = 0; index < 24; index++) {
    monotonic = index
    recorder.record({ phase: 'read-started', attemptId: String(index) }); recorder.flush('progress')
    await vi.advanceTimersByTimeAsync(0); await archive.flush()
  }
  expect(emitted).toHaveLength(24)
  expect({ writes, indexWrites, candidateWrites }).toEqual({ writes: 3, indexWrites: 2, candidateWrites: 1 })
  await vi.advanceTimersByTimeAsync(1000); await archive.flush()
  expect({ writes, indexWrites, candidateWrites }).toEqual({ writes: 9, indexWrites: 6, candidateWrites: 3 })
  expect(sender.inspect()).toMatchObject({ pending: 0, coalesced: 21, inFlight: false })
  const service = new AgentMuxRpcService({ clientIncidents: archive, coreClients: () => [] })
  try {
    const query = { target: { domain: 'client.incident' as const, hostId: 'local', recent: {} } }
    const result = parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', query), query)
    const page = result.reads[0]!.data as AgentMuxClientIncidentPage
    expect(page.items.map(item => item.recordRef.logId).sort()).toEqual([emitted[0]!.logId, emitted[1]!.logId, emitted[23]!.logId].sort())
    const target = { domain: 'client.incident' as const, hostId: 'local', logId: emitted[23]!.logId }
    const exact = parseDiagnosticEvidenceResult(await service.call('system.diagnostics.inspect', { target }), { target }).reads[0]!
    expect(exact).toMatchObject({ availability: 'found', persistence: 'confirmed', data: { report: { reading: { logId: emitted[23]!.logId,
      coverage: { lastSequence: 24 }, scope: { agentSessionId: 'original-session', runId: 'original-run' } } } } })
    expect((exact.data as AgentMuxClientIncidentRecord).report.reading!.events).toHaveLength(24)
    console.info(JSON.stringify({ reports: emitted.length, writes, indexWrites, candidateWrites, bytes, retained: page.items.length }))
  } finally { await service.dispose() }
  expect(vi.getTimerCount()).toBe(0)
})
