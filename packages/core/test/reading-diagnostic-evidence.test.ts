import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { DiagnosticEvidenceQuery } from '@agentmux/diagnostic-evidence'
import { AgentMuxRpcService, type AgentMuxRpcServiceOptions } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseDiagnosticEvidenceParams, parseDiagnosticEvidenceResult } from '../src/diagnostic-evidence-codec.js'
import { DeliveryAttemptStore } from '../src/delivery-attempt-store.js'
import type { AgentMuxDiagnosticEvidenceResult } from '../src/diagnostic-evidence.js'
import { parseReadingDiagnosticSourceRead, type ReadingDiagnosticFindResult } from '../src/reading-diagnostic-query.js'
import { CoreReadingDiagnosticSource } from '../src/reading-diagnostic-source.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const releases: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of releases.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const reference = { hostId: 'local', agentSessionId: 'reading-evidence-agent' }
const recent = { domain: 'reading.lifecycle' as const, hostId: 'local', recent: { agentSessionId: reference.agentSessionId } }
async function fixture() {
  const original = await nativeHistoryFixture('claude', jsonl([{ uuid: 'original-reply', type: 'assistant', sessionId: 'native-main',
    message: { role: 'assistant', content: [{ type: 'text', text: 'private conversation content' }] } }]), { agentSessionId: reference.agentSessionId })
  releases.push(original.close)
  await original.client.readAgentConversation({ ...reference, limit: 1 })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: original.client }] })
  releases.push(() => service.dispose())
  const index = await service.call('system.diagnostics.inspect', { target: recent })
  const page = index.reads[0]!.data as ReadingDiagnosticFindResult
  const target = { domain: 'reading.lifecycle' as const, hostId: 'local', logId: page.records[0]!.reference.logId,
    authority: { kind: page.authority!.kind, id: page.authority!.id } }
  return { ...original, service, index, target, exact: await service.call('system.diagnostics.inspect', { target }) }
}
function reseal(result: AgentMuxDiagnosticEvidenceResult) {
  // The wire budget includes its own serialized digit width.
  for (let attempt = 0; attempt < 8; attempt++) result.budget.usedBytes = Buffer.byteLength(JSON.stringify(result))
  return result
}
const wireCopy = (result: AgentMuxDiagnosticEvidenceResult): AgentMuxDiagnosticEvidenceResult => JSON.parse(JSON.stringify(result))

it('reads recent and exact original metadata through the actual RPC codec and compiled CLI without opening another conversation', async () => {
  const f = await fixture(), socketPath = join(f.root, 'reading-public.sock')
  const server = new AgentMuxControlServer({ socketPath, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); releases.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); releases.push(() => rpc.dispose())
  const discovery = await rpc.call('system.diagnostics.inspect', {})
  expect(discovery.capabilities).toContainEqual({ domain: 'reading.lifecycle', target: 'reading-lifecycle', raw: false, read: 'supported' })
  const index = await rpc.call('system.diagnostics.inspect', { target: recent })
  const exact = await rpc.call('system.diagnostics.inspect', { target: f.target, includeRaw: true })
  expect(index.reads[0]?.availability).toBe('found')
  expect(exact.reads[0]).toMatchObject({ availability: 'found', persistence: 'observed', readAuthority: { lifetime: 'instance' },
    raw: { retention: 'not-retained', returned: 'withheld' } })
  const cli = await runCompiledObjectCli(['--endpoint', `unix://${socketPath}`, 'system', 'diagnostics', 'inspect',
    '--domain', 'reading.lifecycle', '--host-id', 'local', '--logid', f.target.logId, '--authority', f.target.authority.id], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.reads[0].data.logId).toBe(f.target.logId)
  expect(cli.stdout).not.toContain('private conversation content')
  const discoveryCli = await runCompiledObjectCli(['--endpoint', `unix://${socketPath}`, 'system', 'diagnostics', 'inspect',
    '--domain', 'reading.lifecycle', '--host-id', 'local', '--recent', '--session-id', reference.agentSessionId], objectCliEnvironment(f.root))
  expect(discoveryCli.code, discoveryCli.stderr).toBe(0)
  expect(JSON.parse(discoveryCli.stdout).result.reads[0].data.records.length).toBeGreaterThan(0)
  const unchanged = await f.service.call('system.diagnostics.inspect', { target: recent })
  expect((unchanged.reads[0]!.data as ReadingDiagnosticFindResult).records.map(item => item.reference.logId))
    .toEqual((f.index.reads[0]!.data as ReadingDiagnosticFindResult).records.map(item => item.reference.logId))
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
})

it('rejects an aggregate exact reply that fabricates durability, producer authority or observation time', async () => {
  const f = await fixture()
  expect(() => parseDiagnosticEvidenceResult(f.exact, { target: f.target })).not.toThrow()
  const corruptions = [
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.persistence = 'confirmed' },
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.recordRef!.authority!.lifetime = 'durable' },
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.readAuthority!.id = 'receiver-is-not-producer' },
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.observedAt = result.reads[0]!.readAt + 1 },
  ]
  for (const corrupt of corruptions) {
    const forged = wireCopy(f.exact); corrupt(forged)
    expect(() => parseDiagnosticEvidenceResult(reseal(forged), { target: f.target })).toThrow()
  }
})

it('keeps the selected aggregate route separate from the unchanged original Core scope', async () => {
  const f = await fixture(), route = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'remote-route', client: f.client }] })
  releases.push(() => route.dispose())
  const target = { ...f.target, hostId: 'remote-route' }
  const result = await route.call('system.diagnostics.inspect', { target })
  expect(result.reads[0]?.recordRef?.routeHostId).toBe('remote-route')
  expect(result.reads[0]?.data).toMatchObject({ scope: { hostId: 'local', owner: 'core' } })
  expect(() => parseDiagnosticEvidenceResult(result, { target })).not.toThrow()
  const wrongRoute = wireCopy(result); wrongRoute.reads[0]!.recordRef!.routeHostId = 'local'
  expect(() => parseDiagnosticEvidenceResult(reseal(wrongRoute), { target })).toThrow()
})

it('rejects an index envelope that disagrees with its original instance namespace or retained-page coverage', async () => {
  const f = await fixture()
  expect(() => parseDiagnosticEvidenceResult(f.index, { target: recent })).not.toThrow()
  const corruptions = [
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.readAuthority!.id = 'another-instance' },
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.authorityStatus = 'unavailable' },
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.raw.retention = 'retained' },
    (result: AgentMuxDiagnosticEvidenceResult) => { result.reads[0]!.completeness = 'partial' },
    (result: AgentMuxDiagnosticEvidenceResult) => {
      const read = result.reads[0]!, page = read.data as ReadingDiagnosticFindResult
      page.availability = 'unavailable'; page.authority = null; page.records = []; page.nextCursor = null
      page.coverage.complete = false; page.issue = 'source-unavailable'
      read.readAuthority = null; read.completeness = 'partial'
    },
  ]
  for (const corrupt of corruptions) {
    const forged = wireCopy(f.index); corrupt(forged)
    expect(() => parseDiagnosticEvidenceResult(reseal(forged), { target: recent })).toThrow()
  }
})

it('keeps actual recorder loss partial at both the original Hosted codec and aggregate wire boundary', async () => {
  const source = new CoreReadingDiagnosticSource(), attempt = source.begin(reference)!
  for (let index = 0; index < 80; index++) attempt.recorder.record({ phase: 'source-invalidated' })
  attempt.recorder.flush('progress'); attempt.end()
  const first = source.find({ hostId: reference.hostId }).records[0]!
  const target = { domain: 'reading.lifecycle' as const, hostId: reference.hostId, logId: first.reference.logId }
  const original = source.read(target)
  expect(original.data?.coverage.overwritten).toBeGreaterThan(0)
  expect(parseReadingDiagnosticSourceRead(original, target).completeness).toBe('partial')
  expect(() => parseReadingDiagnosticSourceRead({ ...original, completeness: 'complete' }, target)).toThrow()
  const report = reseal({ ...await new DiagnosticEvidenceQuery().inspect(target, { read: async () => source.read(target) }), capabilities: [] })
  expect(() => parseDiagnosticEvidenceResult(report, { target })).not.toThrow()
  const forged = wireCopy(report); forged.reads[0]!.completeness = 'complete'
  expect(() => parseDiagnosticEvidenceResult(reseal(forged), { target })).toThrow()
})

it('keeps all nine injected capabilities and both domains within the complete wire budget without starting collection', async () => {
  const pending = fixture()
  await expect(pending).resolves.toHaveProperty('target.domain', 'reading.lifecycle')
  const f = await pending
  // Seed the actual Client's owner-local recorder, without creating a conversation Reader.
  const source = (f.client as unknown as { originalReadingDiagnosticSource(): CoreReadingDiagnosticSource }).originalReadingDiagnosticSource()
  for (let index = 0; index < 32; index++) {
    const attempt = source.begin(reference)!
    attempt.recorder.record({ phase: 'source-read-completed' }); attempt.recorder.flush('progress'); attempt.end()
  }
  const targets = []
  for (const length of [64, 128, 192, 256, 384, 512]) {
    const attempt = source.begin(reference)!, id = 'm'.repeat(length)
    attempt.recorder.record({ phase: 'source-read-completed', windowId: id, attemptId: id, watchId: id })
    attempt.recorder.flush('progress'); attempt.end()
    targets.push({ domain: 'reading.lifecycle' as const, hostId: 'local', logId: source.find({ ...reference, limit: 1 }).records[0]!.reference.logId })
  }
  expect(Buffer.byteLength(JSON.stringify(source.find(reference)))).toBeGreaterThan(4096)
  expect(Buffer.byteLength(JSON.stringify(source.read(targets.at(-1)!)))).toBeGreaterThan(2048)
  const retained = source.find(reference).coverage.retainedRecords
  const unusedOwner = vi.fn(async (): Promise<never> => { throw Error('An unrelated diagnostic owner must not be read') })
  const store = new DeliveryAttemptStore(join(f.root, 'unused-diagnostic-journal')), deliveryRead = vi.spyOn(store, 'read')
  const businessRead = vi.spyOn(f.client, 'readAgentConversation'), businessWatch = vi.spyOn(f.client, 'observeConversation')
  const ports = { coreClients: () => [{ hostId: 'local', client: f.client }], deliveryAttempts: { hostId: 'local', store },
    toolkit: { execute: unusedOwner, subscribe: unusedOwner }, metrics: { inspectScene: unusedOwner, subscribe: unusedOwner },
    moteContext: { hostId: 'local', read: unusedOwner }, clientIncidents: () => ({ hostId: 'local', read: unusedOwner }),
  } satisfies AgentMuxRpcServiceOptions
  const socketPath = join(f.root, 'joint.sock'), server = new AgentMuxControlServer({ socketPath, ...ports })
  await server.start(); releases.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); releases.push(() => rpc.dispose())
  const discovering = rpc.call('system.diagnostics.inspect', {})
  await expect(discovering).resolves.toHaveProperty('capabilities.length', 9)
  const discovery = await discovering
  expect(discovery.capabilities.map(item => `${item.domain}:${item.target}`).sort()).toEqual([
    'reading.lifecycle:reading-lifecycle', 'delivery.client:log-id', 'delivery.core:log-id', 'toolkit.performance-failure:execution-id',
    'performance.scene:capture-id', 'mote.context.client:mote-context', 'client.incident:log-id', 'client.incident:recent', 'native-recorder-failure:session-run',
  ].sort())
  for (const target of [recent, f.target, { domain: 'client.incident', hostId: 'local', recent: {} }, { domain: 'client.incident', hostId: 'local', logId: f.target.logId }]) {
    expect(() => parseDiagnosticEvidenceParams({ target })).not.toThrow()
    expect(parseDiagnosticEvidenceParams({ target }).target).toEqual(target)
  }
  const cases = []
  for (const target of [recent, ...targets]) {
    const request = { target, budget: { maxBytes: 4096 } }
    const result = await rpc.call('system.diagnostics.inspect', request), bytes = Buffer.byteLength(JSON.stringify(result))
    expect(bytes).toBeLessThanOrEqual(4096); expect(result.budget.usedBytes).toBe(bytes)
    expect(() => parseDiagnosticEvidenceResult(result, request)).not.toThrow()
    cases.push({ availability: result.reads[0]!.availability, issue: result.reads[0]!.issue?.code ?? null, bytes })
  }
  expect(cases.some(item => item.availability === 'found')).toBe(true)
  expect(cases.some(item => item.issue === 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET')).toBe(true)
  expect(source.find(reference).coverage.retainedRecords).toBe(retained)
  expect(unusedOwner).not.toHaveBeenCalled(); expect(deliveryRead).not.toHaveBeenCalled()
  expect(businessRead).not.toHaveBeenCalled(); expect(businessWatch).not.toHaveBeenCalled()
  expect(f.controls.every(control => control.mock.calls.length === 0)).toBe(true)
  if (process.env.READING_BUDGET_RECEIPT) await writeFile(process.env.READING_BUDGET_RECEIPT, JSON.stringify({ capabilities: discovery.capabilities.length, cases }, null, 2))
})
