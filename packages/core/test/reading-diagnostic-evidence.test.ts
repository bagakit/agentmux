import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DiagnosticEvidenceQuery } from '@agentmux/diagnostic-evidence'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseDiagnosticEvidenceResult } from '../src/diagnostic-evidence-codec.js'
import type { AgentMuxDiagnosticEvidenceResult } from '../src/diagnostic-evidence.js'
import { parseReadingDiagnosticSourceRead, type ReadingDiagnosticFindResult } from '../src/reading-diagnostic-query.js'
import { CoreReadingDiagnosticSource } from '../src/reading-diagnostic-source.js'
import { jsonl, nativeHistoryFixture } from './fixtures/native-history-session.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const releases: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of releases.splice(0).reverse()) await close() })
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
