import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { parseReadingDiagnosticSourceFind } from '../src/reading-diagnostic-query.js'
import { CoreReadingDiagnosticSource } from '../src/reading-diagnostic-source.js'
import type { ReadingDiagnosticRecord } from '../src/reading-diagnostic.js'

const releases: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of releases.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const ref = { hostId: 'local', agentSessionId: 'private-agent' }
const row = (id: string) => ({ uuid: id, type: 'assistant', sessionId: 'native-main',
  message: { role: 'assistant', content: [{ type: 'text', text: 'private original reply' }] } })
const query = { hostId: 'local', agentSessionId: ref.agentSessionId }
async function fixture() { const f = await nativeHistoryFixture('claude', jsonl([row('native-original')])); releases.push(f.close); return f }
async function originals(client: Awaited<ReturnType<typeof fixture>>['client']) {
  const found = await client.findReadingDiagnostics(query)
  const records = await Promise.all(found.records.map(summary => client.readReadingDiagnostic({ domain: 'reading.lifecycle',
    hostId: 'local', logId: summary.reference.logId })))
  return records.flatMap(result => result.data ? [result.data] : [])
}

it('records actual nonminimal reads and changes at the original Core consumer without exposing the conversation body', async () => {
  const f = await fixture()
  const page = await f.client.readAgentConversation({ ...ref, limit: 1, maxBytes: 12 * 1024 })
  await f.client.readConversationChanges({ ...ref, checkpoint: page.window.checkpoint, view: page.window.view!, limit: 1 })
  const records = await originals(f.client), phases = records.flatMap(record => record.events.map(event => event.phase))
  expect(phases).toContain('source-read-started')
  expect(phases).toContain('source-read-completed')
  expect(records.some(record => record.events.some(event => event.operation === 'changes'))).toBe(true)
  expect(records.some(record => record.events.some(event => event.windowId === page.window.id))).toBe(true)
  expect(records.every(record => record.scope.owner === 'core' && record.scope.producerBuildId === null)).toBe(true)
  expect(JSON.stringify(records)).not.toContain('private original reply')
  expect(JSON.stringify(records)).not.toContain('checkpoint')
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('retains pending watch opening before a source owner resolves and observes cancellation without releasing the business read', async () => {
  const f = await fixture()
  let finish!: () => void
  const delayed = new Promise<void>(resolve => { finish = resolve })
  const original = (f.client as unknown as { conversationReader: (...args: unknown[]) => Promise<unknown> }).conversationReader.bind(f.client)
  vi.spyOn(f.client as never, 'conversationReader' as never).mockImplementation((async (...args: unknown[]) => { await delayed; return original(...args) }) as never)
  const controller = new AbortController()
  const pending = f.client.observeConversation(ref, () => {}, { signal: controller.signal }).then(value => { value.dispose(); return null }, error => error)
  await vi.waitFor(async () => expect((await originals(f.client)).some(record => record.events.some(event => event.phase === 'source-watch-opening'))).toBe(true))
  controller.abort()
  await vi.waitFor(async () => expect((await originals(f.client)).some(record => record.events.some(event => event.phase === 'source-watch-closed' && event.reason === 'cancelled'))).toBe(true))
  finish()
  await pending
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('preserves source-watch invalidation separately and bounds repeated notification publications', async () => {
  const f = await fixture(), observations: unknown[] = []
  const watch = await f.client.observeConversation(ref, value => observations.push(value)); releases.push(async () => watch.dispose())
  for (let index = 0; index < 4; index++) {
    await appendFile(f.path, jsonl([row(`native-${index}`)]))
    await vi.waitFor(() => expect(observations.length).toBeGreaterThan(index))
  }
  const index = await f.client.findReadingDiagnostics(query), records = await originals(f.client)
  expect(records.some(record => record.events.some(event => event.phase === 'source-invalidated' && event.nativeSource?.nativeSessionId === 'native-main'))).toBe(true)
  // Opening, opened and the first invalidation publish; later notifications update the same bounded ring.
  expect(index.records).toHaveLength(3)
  watch.dispose()
  expect((await originals(f.client)).some(record => record.events.filter(event => event.phase === 'source-invalidated').length >= 4)).toBe(true)
})

it('rejects another raw source Host and another instance authority, without scanning an unrelated namespace', async () => {
  const f = await fixture(); await f.client.readAgentConversation({ ...ref, limit: 1 })
  const index = await f.client.findReadingDiagnostics(query), first = index.records[0]!
  expect((await f.client.readReadingDiagnostic({ domain: 'reading.lifecycle', hostId: 'other-host', logId: first.reference.logId })).availability).toBe('not-found')
  expect((await f.client.findReadingDiagnostics({ ...query, hostId: 'other-host' })).records).toEqual([])
  expect((await f.client.readReadingDiagnostic({ domain: 'reading.lifecycle', hostId: 'local', logId: first.reference.logId,
    authority: { kind: 'core-reading-observer', id: 'another-instance' } })).issue?.code).toBe('DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH')
  expect(new CoreReadingDiagnosticSource().find(query).records).toEqual([])
})

it('reads the original Core source through the actual Hosted invoke and public diagnostic consumer', async () => {
  const f = await fixture()
  const owner = new AgentMuxHostedRuntimeService(f.client, f.storePath, () => ({ runtimeId: 'original-runtime', ownerInstanceId: 'original-owner',
    protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null })); releases.push(() => owner.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'hosted.sock'), hostedRuntime: () => owner,
    coreClients: () => [{ hostId: 'local', client: f.client }], http: { host: '127.0.0.1', port: 0, token: 'private-reading-diagnostics' } }); await server.start(); releases.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'private-reading-diagnostics' } }); releases.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); releases.push(() => hosted.dispose())
  await hosted.readAgentConversation({ ...ref, limit: 1, maxBytes: 12 * 1024 })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: hosted }] }); releases.push(() => service.dispose())
  const result = await service.call('system.diagnostics.inspect', { target: { domain: 'reading.lifecycle', hostId: 'local', recent: { agentSessionId: ref.agentSessionId } } })
  expect(result.reads[0]?.availability).toBe('found')
  const page = result.reads[0]?.data as { records: Array<{ reference: { logId: string } }> }
  expect(page.records.length).toBeGreaterThan(0)
  const exact = await service.call('system.diagnostics.inspect', { target: { domain: 'reading.lifecycle', hostId: 'local', logId: page.records[0]!.reference.logId } })
  expect(exact.reads[0]?.availability).toBe('found')
  const record = exact.reads[0]?.data as ReadingDiagnosticRecord
  expect(record.events.some(event => event.phase === 'source-read-completed')).toBe(true)
  expect(exact.reads[0]?.persistence).toBe('observed')
  expect(exact.reads[0]?.recordRef?.authority?.lifetime).toBe('instance')
  const cli = await runCompiledObjectCli(['--endpoint', `unix://${join(f.root, 'hosted.sock')}`, 'system', 'diagnostics', 'inspect',
    '--domain', 'reading.lifecycle', '--host-id', 'local', '--recent', '--session-id', ref.agentSessionId], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  const cliResult = JSON.parse(cli.stdout)
  expect(cliResult.result.reads[0].data.records.length).toBeGreaterThan(0)
  expect(cliResult.result.reads[0].data.authority.lifetime).toBe('instance')
  expect(cli.stdout).not.toContain('private original reply')
  const remote = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'selected-route', client: hosted }] }); releases.push(() => remote.dispose())
  const remoteIndex = await remote.call('system.diagnostics.inspect', { target: { domain: 'reading.lifecycle', hostId: 'selected-route', recent: { agentSessionId: ref.agentSessionId } } })
  const remotePage = remoteIndex.reads[0]!.data as { records: Array<{ reference: { logId: string; routeHostId: string }; scope: { hostId: string } }> }
  expect(remotePage.records[0]?.reference.routeHostId).toBe('selected-route')
  expect(remotePage.records[0]?.scope.hostId).toBe('local')
  const remoteExact = await remote.call('system.diagnostics.inspect', { target: { domain: 'reading.lifecycle', hostId: 'selected-route', logId: remotePage.records[0]!.reference.logId } })
  expect(remoteExact.reads[0]?.recordRef?.routeHostId).toBe('selected-route')
  expect((remoteExact.reads[0]?.data as ReadingDiagnosticRecord).scope.hostId).toBe('local')
  expect((await remote.call('system.diagnostics.inspect', { target: { domain: 'reading.lifecycle', hostId: 'unselected-route', recent: {} } })).reads[0]?.availability).toBe('unavailable')
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('bounds current-instance records, retains explicit eviction and rejects a cursor from another namespace', () => {
  const source = new CoreReadingDiagnosticSource()
  for (let index = 0; index < 80; index++) {
    const attempt = source.begin(ref)!
    attempt.recorder.record({ phase: 'source-read-completed', windowId: `window-${index}` })
    attempt.recorder.flush('progress'); attempt.end()
  }
  const first = source.find({ ...query, limit: 1 })
  expect(first.records).toHaveLength(1)
  expect(first.coverage.retainedRecords).toBe(64)
  expect(first.coverage.evictedRecords).toBe(16)
  expect(first.nextCursor).not.toBeNull()
  const next = source.find({ ...query, limit: 1, cursor: first.nextCursor! })
  expect(next.records[0]?.reference.logId).not.toBe(first.records[0]?.reference.logId)
  expect(() => new CoreReadingDiagnosticSource().find({ ...query, cursor: first.nextCursor! })).toThrow()
  expect(() => source.find({ ...query, agentSessionId: 'other-session', cursor: first.nextCursor! })).toThrow()
})

it('keeps the actual original read usable when the diagnostic retention callback fails', async () => {
  const f = await fixture()
  vi.spyOn(CoreReadingDiagnosticSource.prototype as never, 'retain' as never).mockImplementation((() => { throw Error('diagnostic retention unavailable') }) as never)
  const page = await f.client.readAgentConversation({ ...ref, limit: 1, maxBytes: 12 * 1024 })
  expect(JSON.stringify(page)).toContain('private original reply')
  expect((await f.client.findReadingDiagnostics(query)).records).toEqual([])
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('preserves a primary source failure without executing arbitrary diagnostic code accessors', async () => {
  const f = await fixture()
  let getters = 0
  const failure = Object.defineProperty(new Error('private primary source failure'), 'code', { get() { getters++; throw Error('diagnostic accessor') } })
  vi.spyOn(f.client as never, 'conversationReader' as never).mockRejectedValue(failure as never)
  await expect(f.client.readAgentConversation({ ...ref, limit: 1 })).rejects.toBe(failure)
  expect(getters).toBe(0)
  const records = await originals(f.client)
  expect(records.some(record => record.events.some(event => event.phase === 'source-read-failed' && event.reason === 'unknown'))).toBe(true)
  expect(JSON.stringify(records)).not.toContain('private primary source failure')
})

it('rejects forged raw Hosted index Host, authority lifetime and absent namespace while retaining the original valid page', async () => {
  const f = await fixture(); await f.client.readAgentConversation({ ...ref, limit: 1 })
  const found = await f.client.findReadingDiagnostics(query)
  expect(parseReadingDiagnosticSourceFind(found, query).records.length).toBeGreaterThan(0)
  const wrongHost = structuredClone(found); wrongHost.records[0]!.scope.hostId = 'foreign-raw-host'
  expect(() => parseReadingDiagnosticSourceFind(wrongHost, query)).toThrow()
  const wrongLifetime = structuredClone(found); wrongLifetime.records[0]!.reference.authority!.lifetime = 'durable'
  expect(() => parseReadingDiagnosticSourceFind(wrongLifetime, query)).toThrow()
  const absent = structuredClone(found); absent.authority = null; absent.records.forEach(record => { record.reference.authority = null })
  expect(() => parseReadingDiagnosticSourceFind(absent, query)).toThrow()
})

it('omits an unknown Core page navigation purpose instead of labelling an opaque continuation latest', async () => {
  const f = await fixture(), page = await f.client.readAgentConversation({ ...ref, limit: 1 })
  await f.client.readAgentConversation({ ...ref, view: page.window.view! })
  const records = await originals(f.client)
  const complete = records.flatMap(record => record.events.filter(event => event.phase === 'source-read-completed'))
  expect(complete.some(event => event.operation === 'latest')).toBe(true)
  expect(complete.some(event => event.operation === undefined)).toBe(true)
})

it('discovers a late observation snapshot from a long-lived watch by its actual last observation time', () => {
  const source = new CoreReadingDiagnosticSource(), wall = vi.spyOn(Date, 'now').mockReturnValue(100)
  const attempt = source.begin(ref)!
  attempt.recorder.record({ phase: 'source-watch-opening' }); attempt.recorder.flush('progress')
  wall.mockReturnValue(500)
  attempt.recorder.record({ phase: 'source-watch-unavailable', reason: 'source-unavailable' }); attempt.recorder.flush('failure')
  const recent = source.find({ ...query, since: 400 })
  expect(recent.records).toHaveLength(1)
  expect(recent.records[0]).toMatchObject({ trigger: 'failure', startedAt: 100, observedAt: 500 })
  expect(source.find({ ...query, until: 200 }).records).toHaveLength(1)
  attempt.end()
})
