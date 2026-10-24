import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unavailableDiagnosticEvidence } from '@agentmux/diagnostic-evidence'
import { mintObjectId } from '../src/object-id.js'
import type { AgentMuxRpcService as Service } from '../src/public-rpc-service.js'
import type { AgentMuxControlServer as Server } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { parseDiagnosticEvidenceParams, parseDiagnosticEvidenceResult } from '../src/diagnostic-evidence-codec.js'
import type { AgentMuxClientIncidentPort, AgentMuxClientIncidentRecord, AgentMuxClientIncidentReport } from '../src/client-incident.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

// The same consumers can run against an isolated compiled production candidate.
const ownerRoot = process.env.AGENTMUX_TEST_INCIDENT_CORE_ENTRY
const ownerModule = (file: string) => import(ownerRoot ? new URL(file, ownerRoot).href : new URL(`../src/${file}`, import.meta.url).href)
const { AgentMuxRpcService }: { AgentMuxRpcService: typeof Service } = await ownerModule('public-rpc-service.js')
const { AgentMuxControlServer }: { AgentMuxControlServer: typeof Server } = await ownerModule('public-rpc-server.js')
const { parseClientIncidentReport, parseClientIncidentRecord, safeClientIncidentCode }: typeof import('../src/client-incident.js') = await ownerModule('client-incident.js')

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const authority = { kind: 'client-incident-archive', id: 'original-archive', lifetime: 'durable' as const }
function report(kind: AgentMuxClientIncidentReport['kind'] = 'terminal-attach-failed'): AgentMuxClientIncidentReport {
  return { occurrenceId: 'original-occurrence', attemptId: 'original-attempt', relatedOccurrenceId: null,
    hostId: 'execution-host', regionId: 'original-region', kind, stage: 'attach-failed', code: 'EIO',
    agentSessionId: 'original-session', runId: 'original-run', observedAt: 1, elapsedMs: 2,
    metadata: { cursorBytes: 16, latestOutputBytes: 32, liveReady: false, renderCallbacks: 0 },
    stages: [{ stage: 'attach-requested', elapsedMs: 0, metadata: { visible: true } }], references: [] }
}
function record(kind?: AgentMuxClientIncidentReport['kind']): AgentMuxClientIncidentRecord {
  return { kind: 'client-incident', logId: mintObjectId(), authority, receivedAt: 3,
    producer: { kind: 'renderer', appInstanceId: 'original-app', producerInstanceId: 'original-producer',
      windowId: 'original-window', documentGeneration: 'original-document', buildId: 'original-build' }, report: report(kind) }
}
function port(records: AgentMuxClientIncidentRecord[]) {
  const read = vi.fn<AgentMuxClientIncidentPort['read']>(async target => {
    const base = { ...unavailableDiagnosticEvidence(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'),
      readAuthority: authority, authorityStatus: 'verified' as const, availability: 'found' as const,
      persistence: 'confirmed' as const, completeness: 'complete' as const,
      raw: { retention: 'retained' as const, returned: 'withheld' as const, truncated: false }, issue: null }
    const ref = (r: AgentMuxClientIncidentRecord) => ({ domain: 'client.incident', logId: r.logId, authority, routeHostId: 'local' })
    if ('recent' in target) {
      const recent = target.recent
      const found = records.filter(r => (!recent.agentSessionId || r.report.agentSessionId === recent.agentSessionId) &&
        (!recent.runId || r.report.runId === recent.runId) && (!recent.kind || r.report.kind === recent.kind) &&
        (recent.since === undefined || r.receivedAt >= recent.since) && (recent.until === undefined || r.receivedAt <= recent.until)).slice(0, recent.limit ?? 32)
      return { ...base, recordRef: null, scope: 'interval-observation', observedAt: null,
        data: { kind: 'client-incident-page', items: found.map(r => ({ recordRef: ref(r), kind: r.report.kind, stage: r.report.stage,
          code: r.report.code, agentSessionId: r.report.agentSessionId, runId: r.report.runId, attemptId: r.report.attemptId,
          occurrenceId: r.report.occurrenceId, receivedAt: r.receivedAt, persistence: 'confirmed' })), nextCursor: null,
        coverage: { startup: 'ready', retainedCount: records.length, retainedBytes: 512, pendingWrites: 0, dropped: 0,
          invalid: 0, duplicates: 0, evicted: 0, corrupt: 0, writeFailures: 0, indexFailures: 0, cleanupFailures: 0 } } }
    }
    const r = records.find(r => r.logId === target.logId)
    if (!r) return { ...unavailableDiagnosticEvidence(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'), availability: 'not-found', issue: null }
    return { ...base, recordRef: ref(r), scope: 'record', observedAt: r.receivedAt, data: r }
  })
  return { hostId: 'local', read } satisfies AgentMuxClientIncidentPort
}

describe('client incident public contract', () => {
  it('admits finite facts and rejects text, paths, forged provenance and arbitrary machine-looking codes', () => {
    expect(parseClientIncidentReport(report())).toEqual(report())
    expect(safeClientIncidentCode('EIO')).toBe('EIO')
    expect(safeClientIncidentCode('TOKEN_SECRET_UNKNOWN')).toBeNull()
    const invalid = [
      { ...report(), message: 'private-error' }, { ...report(), producer: record().producer },
      { ...report(), metadata: { text: 'private-terminal' } }, { ...report(), metadata: { cursorBytes: -1 } },
      { ...report(), code: 'TOKEN_SECRET_UNKNOWN' }, { ...report(), stage: 'private-stage' },
      { ...report(), attemptId: 'private/directory' }, { ...report(), hostId: 'private\\directory' },
      { ...report(), stages: Array.from({ length: 17 }, () => report().stages[0]) },
      { ...report(), references: [{ domain: 'performance.scene', hostId: 'local', captureId: 'capture', text: 'private' }] },
    ]
    for (const value of invalid) expect(() => parseClientIncidentReport(value)).toThrow()
    expect(() => parseClientIncidentRecord({ ...record(), producer: { ...record().producer, cwd: 'private-directory' } })).toThrow()
    const recent = { domain: 'client.incident', hostId: 'local', recent: {} }
    expect(parseDiagnosticEvidenceParams({ target: recent })).toEqual({ target: recent })
    const scoped = { ...recent, authority: { kind: authority.kind, id: authority.id } }
    expect(parseDiagnosticEvidenceParams({ target: scoped })).toEqual({ target: scoped })
    for (const target of [
      { ...recent, logId: mintObjectId() }, { ...recent, authority: { kind: 'client-incident-archive', id: null } },
      { ...recent, recent: { limit: 33 } }, { ...recent, recent: { since: 4, until: 3 } },
      { ...recent, recent: { cursor: 'private/path' } }, { ...recent, recent: { prompt: 'private' } },
    ]) expect(() => parseDiagnosticEvidenceParams({ target })).toThrow()
  })

  it('discovers both selectors through the default Host and consumes recent-to-original over Unix RPC and the compiled CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'amx-incident-rpc-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
    const original = record(), recovered = record('connection-recovered'), archive = port([original, recovered])
    const desktopPath = join(root, 'desktop.sock'), hostPath = join(root, 'host.sock')
    const desktop = new AgentMuxControlServer({ socketPath: desktopPath, coreClients: () => [], clientIncidents: () => archive })
    await desktop.start(); cleanup.push(() => desktop.stop())
    const owner = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopPath } }); cleanup.push(() => owner.dispose())
    const forwarded: string[] = []
    const host = new AgentMuxControlServer({ socketPath: hostPath, coreClients: () => [], forwardControl: async (method, params, context) => {
      forwarded.push(method); return owner.call(method, params, { ...(context.signal ? { signal: context.signal } : {}) })
    } })
    await host.start(); cleanup.push(() => host.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: hostPath } }); cleanup.push(() => rpc.dispose())
    const discovery = await rpc.call('system.diagnostics.inspect', {})
    expect(discovery.capabilities.filter(c => c.domain === 'client.incident')).toEqual([
      { domain: 'client.incident', target: 'log-id', raw: false, read: 'supported' },
      { domain: 'client.incident', target: 'recent', raw: false, read: 'supported' },
    ])
    expect(archive.read).not.toHaveBeenCalled()
    const params = { target: { domain: 'client.incident' as const, hostId: 'local', recent: {} } }
    const page = await rpc.call('system.diagnostics.inspect', params)
    expect(page.reads[0]).toMatchObject({ recordRef: null, data: { kind: 'client-incident-page', items: [
      { recordRef: { logId: original.logId } }, { kind: 'connection-recovered' },
    ] } })
    expect(() => parseDiagnosticEvidenceResult(page, params)).not.toThrow()
    const mixedArchive = structuredClone(page)
    if (mixedArchive.reads[0]?.data?.kind === 'client-incident-page') mixedArchive.reads[0].data.items[0]!.recordRef.authority!.id = 'another-archive'
    for (let i = 0; i < 4; i++) mixedArchive.budget.usedBytes = Buffer.byteLength(JSON.stringify(mixedArchive))
    expect(() => parseDiagnosticEvidenceResult(mixedArchive, params)).toThrow()
    const duplicate = structuredClone(page)
    if (duplicate.reads[0]?.data?.kind === 'client-incident-page') duplicate.reads[0].data.items.push(duplicate.reads[0].data.items[0]!)
    for (let i = 0; i < 4; i++) duplicate.budget.usedBytes = Buffer.byteLength(JSON.stringify(duplicate))
    expect(() => parseDiagnosticEvidenceResult(duplicate, params)).toThrow()
    const emptyParams = { target: { ...params.target, authority: { kind: authority.kind, id: authority.id }, recent: { kind: 'mobile-web-observation' as const } } }
    const empty = await rpc.call('system.diagnostics.inspect', emptyParams)
    expect(empty.reads[0]!.data).toMatchObject({ kind: 'client-incident-page', items: [] })
    expect(() => parseDiagnosticEvidenceResult(empty, emptyParams)).not.toThrow()
    const wrongEmptyAuthority = structuredClone(empty)
    wrongEmptyAuthority.reads[0]!.readAuthority = { ...authority, id: 'another-empty-archive' }
    for (let i = 0; i < 4; i++) wrongEmptyAuthority.budget.usedBytes = Buffer.byteLength(JSON.stringify(wrongEmptyAuthority))
    expect(() => parseDiagnosticEvidenceResult(wrongEmptyAuthority, emptyParams)).toThrow()
    const target = { domain: 'client.incident' as const, hostId: 'local', logId: original.logId, authority: { kind: authority.kind, id: authority.id } }
    const exact = await rpc.call('system.diagnostics.inspect', { target, includeRaw: true })
    expect(exact.reads[0]).toMatchObject({ recordRef: { logId: original.logId, routeHostId: 'local' }, raw: { returned: 'withheld' }, data: original })
    const bad = structuredClone(exact); if (bad.reads[0]?.data?.kind === 'client-incident') bad.reads[0].data.logId = mintObjectId()
    for (let i = 0; i < 4; i++) bad.budget.usedBytes = Buffer.byteLength(JSON.stringify(bad))
    expect(() => parseDiagnosticEvidenceResult(bad, { target, includeRaw: true })).toThrow()
    const env = objectCliEnvironment(root), prefix = ['--endpoint', `unix://${hostPath}`, 'system', 'diagnostics', 'inspect']
    const cli = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local', '--recent', '--limit', '1', '--kind', 'connection-recovered'], env)
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, result: { reads: [{ data: { kind: 'client-incident-page', items: [{ kind: 'connection-recovered' }] } }] } })
    const scopedCli = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local', '--recent', '--authority', authority.id, '--limit', '1'], env)
    expect(scopedCli.code, scopedCli.stderr).toBe(0)
    expect(JSON.parse(scopedCli.stdout).result.reads[0].readAuthority).toEqual(authority)
    const read = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local', '--logid', original.logId, '--authority', authority.id], env)
    expect(read.code, read.stderr).toBe(0); expect(JSON.parse(read.stdout).result.reads[0].data).toEqual(original)
    const calls = archive.read.mock.calls.length
    const mixed = await runCompiledObjectCli([...prefix, '--domain', 'client.incident', '--host-id', 'local', '--recent', '--logid', original.logId], env)
    expect(mixed.code).not.toBe(0); expect(archive.read).toHaveBeenCalledTimes(calls)
    expect(forwarded.every(method => method === 'system.diagnostics.inspect')).toBe(true)
  }, 30_000)

  it('refuses another archive Host without reading or controlling a healthy Agent', async () => {
    const h = await rpcOwnerFixture(); cleanup.push(h.close)
    const archive = port([record()]), service = new AgentMuxRpcService({ coreClients: h.coreClients, clientIncidents: () => archive })
    cleanup.push(() => service.dispose())
    const result = await service.call('system.diagnostics.inspect', { target: { domain: 'client.incident', hostId: 'other', recent: {} } }, { caller: h.credentials })
    expect(result.reads[0]).toMatchObject({ availability: 'forbidden', data: null })
    expect(archive.read).not.toHaveBeenCalled()
    expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
})
