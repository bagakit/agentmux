// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { durableWriteFile, AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { mintObjectId } from '@agentmux/core/object-id'
import { clientIncidentPriority, safeClientIncidentCode, type AgentMuxClientIncidentReport, type AgentMuxClientIncidentPage } from '@agentmux/core/client-incident'
import type { ReadingDiagnosticRecord } from '@agentmux/core/reading-diagnostic'
import { ClientIncidentArchive, CLIENT_INCIDENT_LIMITS } from '@agentmux/host/client-incident-archive'
import { ClientIncidentIpcOwner } from '../src/main/client-incident-ipc'
import { createClientIncidentDispatcher, CLIENT_INCIDENT_DISPATCH_LIMITS } from '../src/renderer/src/lib/client-incident-dispatcher'
import { createClientIncidentRecorder } from '../src/renderer/src/lib/client-incident-recorder'
import { readingClientIncident } from '../src/renderer/src/lib/reading-client-incident'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'

const paths: string[] = []
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'amux-evidence-priority-')); paths.push(path); return path }
function reading(trigger: ReadingDiagnosticRecord['trigger'], consumerId = 'reading-consumer') {
  return readingClientIncident({ version: 'reading-diagnostic.v1', logId: mintObjectId(), previousLogId: null,
    scope: { hostId: 'local', agentSessionId: 'reading-session', runId: null, sourceHostId: null,
      owner: 'renderer', ownerInstanceId: 'original-renderer', producerBuildId: null, consumerId, consumerKind: 'conversation-pane' },
    trigger, startedAt: 1, endedAt: trigger === 'release' ? 1 : null,
    events: [{ sequence: 1, wallMs: 1, monoMs: 1, phase: trigger === 'release' ? 'consumer-ended' : 'read-failed', reason: 'source-unavailable' }],
    coverage: { firstSequence: 1, lastSequence: 1, overwritten: 0, rejected: 0, publicationFailures: 0 } }, 0)
}
function terminal(): Exclude<AgentMuxClientIncidentReport, { reading: ReadingDiagnosticRecord }> {
  return { occurrenceId: mintObjectId(), attemptId: 'original-attempt', relatedOccurrenceId: null, hostId: 'local', regionId: 'original-region',
    kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'CONTROL_CONNECTION_FAILED', agentSessionId: 'terminal-session',
    runId: 'original-run', observedAt: 1, elapsedMs: 0, metadata: {}, stages: [], references: [] }
}
const producer = { kind: 'renderer' as const, appInstanceId: 'original-app', producerInstanceId: 'original-renderer',
  windowId: 'window', documentGeneration: 'document', buildId: null }
const bounds = () => ({ signal: new AbortController().signal, maxBytes: 131072 })
const page = async (archive: ClientIncidentArchive) => (await archive.read({ domain: 'client.incident', hostId: 'local', recent: {} }, bounds())).data as AgentMuxClientIncidentPage

it('classifies release and missing index triggers conservatively with one finite policy', () => {
  for (const trigger of ['failure', 'slow-read', 'held', 'recovered', 'release'] as const) expect(clientIncidentPriority(reading(trigger))).toBe('reading')
  expect(clientIncidentPriority(reading('progress'))).toBe('progress')
  expect(clientIncidentPriority({ kind: 'conversation-reading-progress' })).toBe('reading')
  for (const kind of ['terminal-attach-failed', 'terminal-recovered', 'terminal-refresh', 'connection-failed', 'connection-recovered',
    'capability-probe-failed', 'capability-probe-recovered'] as const) expect(clientIncidentPriority({ kind })).toBe('critical')
  expect(clientIncidentPriority({ kind: 'capability-probe' })).toBe('progress')
  expect(safeClientIncidentCode('CTXMUX_DISCONNECTED')).toBe('CTXMUX_DISCONNECTED')
})

it('reserves the Realm queue under distinct reading failures and sends retained terminal evidence first', async () => {
  let open!: (value: { token: string }) => void
  const opening = new Promise<{ token: string }>(resolve => { open = resolve }), sent: AgentMuxClientIncidentReport[] = []
  const sender = createClientIncidentDispatcher(() => ({ open: () => opening, report: async (_token, report) => { sent.push(report); return { accepted: true } } }))
  for (let index = 0; index < 40; index++) sender.send(reading('failure', 'consumer-' + index))
  expect(sender.inspect()).toMatchObject({ pending: CLIENT_INCIDENT_DISPATCH_LIMITS.readingReports, dropped: 24, inFlight: true })
  const failure = terminal(), recovery = { ...terminal(), kind: 'terminal-recovered' as const, stage: 'observation-restored' as const, relatedOccurrenceId: failure.occurrenceId }
  sender.send(failure); sender.send(recovery)
  open({ token: 'original-token' })
  await vi.waitFor(() => expect(sender.inspect().inFlight).toBe(false))
  expect(sent.slice(0, 2)).toEqual([failure, recovery])
  expect(sent).toHaveLength(CLIENT_INCIDENT_DISPATCH_LIMITS.readingReports + 2)
})

it('keeps release timely and the original first and latest repeated reading failures', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const sent: AgentMuxClientIncidentReport[] = []
  const sender = createClientIncidentDispatcher(() => ({ open: async () => ({ token: 'original-token' }), report: async (_token, report) => { sent.push(report); return { accepted: true } } }))
  sender.send(reading('progress')); await vi.advanceTimersByTimeAsync(0)
  sender.send(reading('progress')); sender.send(reading('release'))
  await vi.advanceTimersByTimeAsync(0)
  expect(sent.map(report => report.reading?.trigger)).toEqual(['progress', 'release'])
  let open!: (value: null) => void
  const opening = new Promise<null>(resolve => { open = resolve })
  const blocked = createClientIncidentDispatcher(() => ({ open: () => opening, report: async () => ({ accepted: true }) }))
  for (let index = 0; index < 50; index++) blocked.send(reading('failure'))
  expect(blocked.inspect()).toMatchObject({ pending: 2, coalesced: 48, inFlight: true })
  open(null); await vi.advanceTimersByTimeAsync(1000)
  expect(blocked.inspect().inFlight).toBe(false)
})

it('publishes finite loss reasons through authenticated IPC and original public RPC and CLI readers', async () => {
  const path = await directory()
  let release!: () => void, entered!: () => void, active = 0, peak = 0
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const archive = new ClientIncidentArchive(join(path, 'archive'), { write: async (file, content, options) => {
    if (file.endsWith('.candidate')) { active++; peak = Math.max(peak, active); entered(); await gate; active-- }
    return durableWriteFile(file, content, options)
  } })
  await archive.flush()
  const frame = {}, contents = { mainFrame: frame, isDestroyed: () => false } as unknown as WebContents
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const ipc = new ClientIncidentIpcOwner({ archive, contents, windowId: 7, generation: () => 1, buildId: () => 'main', rendererBuildId: () => 'renderer' })
  const receipts: boolean[] = []
  const transport = { open: async () => ipc.open(event), report: async (token: string, report: AgentMuxClientIncidentReport) => {
    const receipt = ipc.report(event, token, report); receipts.push(receipt.accepted); return receipt
  } }
  const sender = createClientIncidentDispatcher(() => transport)
  const first = reading('failure', 'first-consumer')
  sender.send(first); await started
  try {
    for (let index = 0; index < 12; index++) { sender.send(reading('failure', 'other-' + index)); await vi.waitFor(() => expect(sender.inspect().inFlight).toBe(false)) }
    expect((await page(archive)).coverage.pendingWrites).toBe(CLIENT_INCIDENT_LIMITS.readingProducerQueue)
    expect(receipts.filter(Boolean)).toHaveLength(CLIENT_INCIDENT_LIMITS.readingProducerQueue)
    const recorder = createClientIncidentRecorder({ hostId: 'local', agentSessionId: 'terminal-session', runId: 'original-run', regionId: () => 'original-region',
      read: () => ({}), send: sender.send, reporter: sender.inspect })
    const failure = recorder.capture('terminal-attach-failed', 'attach-failed', { code: 'CTXMUX_DISCONNECTED' })!
    const recovery = recorder.capture('terminal-recovered', 'observation-restored', undefined, failure)!
    await vi.waitFor(() => expect(sender.inspect().inFlight).toBe(false))
    expect((await page(archive)).coverage.pendingWrites).toBe(CLIENT_INCIDENT_LIMITS.readingProducerQueue + 2)
    expect(active).toBe(1); expect(peak).toBe(1)
    release(); await archive.flush()
    const server = new AgentMuxControlServer({ socketPath: join(path, 'public.sock'), clientIncidents: () => archive, coreClients: () => [] })
    await server.start()
    const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    try {
      const query = { target: { domain: 'client.incident' as const, hostId: 'local', recent: { agentSessionId: 'terminal-session' } } }
      const recent = await client.call('system.diagnostics.inspect', query)
      const records = recent.reads[0]!.data as AgentMuxClientIncidentPage
      expect(records.items.map(row => row.occurrenceId).sort()).toEqual([failure, recovery].sort())
      expect(records.items.find(row => row.occurrenceId === failure)?.code).toBe('CTXMUX_DISCONNECTED')
      for (const item of records.items) {
        const target = { domain: 'client.incident' as const, hostId: 'local', logId: item.recordRef.logId,
          authority: { kind: item.recordRef.authority!.kind, id: item.recordRef.authority!.id } }
        const exact = await client.call('system.diagnostics.inspect', { target })
        expect(exact.reads[0]).toMatchObject({ availability: 'found', persistence: 'confirmed', data: { producer: { windowId: '7', buildId: 'renderer' },
          report: { metadata: { reporterRejected: 9, reporterUnavailable: 0, reporterCoalesced: 0, reporterDropped: 9 } } } })
      }
      vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
      const env = objectCliEnvironment(path)
      const cliRecent = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'system', 'diagnostics', 'inspect', '--recent', '--domain', 'client.incident', '--host-id', 'local', '--session-id', 'terminal-session'], env)
      expect(cliRecent.code, cliRecent.stderr).toBe(0)
      expect(JSON.parse(cliRecent.stdout).result.reads[0].data.items.map((row: { occurrenceId: string }) => row.occurrenceId).sort()).toEqual([failure, recovery].sort())
      const item = records.items[0]!
      const cliExact = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'system', 'diagnostics', 'inspect', '--domain', 'client.incident', '--host-id', 'local', '--logid', item.recordRef.logId, '--authority', item.recordRef.authority!.id], env)
      expect(cliExact.code, cliExact.stderr).toBe(0)
      expect(JSON.parse(cliExact.stdout).result.reads[0].data.report.metadata.reporterRejected).toBe(9)
    } finally { client.dispose(); await server.stop() }
  } finally { release(); await archive.flush() }
})

it('retains original terminal failure and recovery against reading failure retention pressure', async () => {
  const archive = new ClientIncidentArchive(await directory()); await archive.flush()
  const failure = terminal(), recovered = { ...terminal(), kind: 'terminal-recovered' as const, stage: 'observation-restored' as const, relatedOccurrenceId: failure.occurrenceId }
  const refs = [archive.enqueue(failure, producer)]; await archive.flush(); refs.push(archive.enqueue(recovered, producer)); await archive.flush()
  for (let index = 0; index < 128; index++) { archive.enqueue(reading('failure'), producer); await archive.flush() }
  expect((await page(archive)).coverage.retainedCount).toBe(CLIENT_INCIDENT_LIMITS.readingRecords + 2)
  for (const ref of refs) expect(await archive.read({ domain: 'client.incident', hostId: 'local', logId: ref.logId! }, bounds())).toMatchObject({ availability: 'found' })
  const reopened = new ClientIncidentArchive(archive.directory); await reopened.flush()
  for (const ref of refs) expect(await reopened.read({ domain: 'client.incident', hostId: 'local', logId: ref.logId! }, bounds())).toMatchObject({ availability: 'found', persistence: 'observed' })
})

it('keeps a retained release important after index reopening without reading or rewriting old records', async () => {
  const archive = new ClientIncidentArchive(await directory()); await archive.flush()
  const original = reading('release'), receipt = archive.enqueue(original, producer); await archive.flush()
  const reopened = new ClientIncidentArchive(archive.directory); await reopened.flush()
  for (let index = 0; index < 70; index++) { reopened.enqueue(reading('progress'), producer); await reopened.flush() }
  expect(await reopened.read({ domain: 'client.incident', hostId: 'local', logId: receipt.logId! }, bounds())).toMatchObject({ availability: 'found', data: { report: original } })
  expect((await page(reopened)).coverage.retainedCount).toBe(CLIENT_INCIDENT_LIMITS.readingProgressRecords + 1)
})

it('bounds encoded reading-failure bytes independently of the number of consumers', async () => {
  let open!: (value: null) => void
  const opening = new Promise<null>(resolve => { open = resolve })
  const sender = createClientIncidentDispatcher(() => ({ open: () => opening, report: async () => ({ accepted: true }) }))
  for (let index = 0; index < 30; index++) {
    const report = reading('failure', 'wide-' + index)
    report.reading.events = Array.from({ length: 40 }, (_, entry) => ({ sequence: entry + 1, wallMs: 1, monoMs: 1, phase: 'read-page', attemptId: '界'.repeat(160) }))
    report.reading.coverage.lastSequence = 40
    sender.send(report)
  }
  expect(sender.inspect().pending).toBeGreaterThan(0)
  expect(sender.inspect().pending).toBeLessThan(CLIENT_INCIDENT_DISPATCH_LIMITS.readingReports)
  expect(sender.inspect().pendingBytes).toBeLessThanOrEqual(CLIENT_INCIDENT_DISPATCH_LIMITS.readingBytes)
  open(null); await vi.waitFor(() => expect(sender.inspect().inFlight).toBe(false))
})
