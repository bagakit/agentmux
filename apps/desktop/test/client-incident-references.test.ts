import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const { fixturePath } = await import('../scripts/lib/fixture-values.mjs')
  return { app: { getPath: () => fixturePath('temporary'), getAppPath: () => process.cwd() } }
})
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
import { PerformanceToolkitOwner } from '../src/main/toolkit-owner.js'
import { PerformanceFailureStore } from '../src/main/toolkit-performance-failure-store.js'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { PerformanceSceneOwner } from '../src/main/performance-scene.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { DeliveryAttemptStore } from '../../../packages/core/src/delivery-attempt-store.js'
import { mintObjectId } from '../../../packages/core/src/object-id.js'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec.js'
import type { AgentMuxClientIncidentReference, AgentMuxClientIncidentReport } from '../../../packages/core/src/client-incident.js'
import type { AgentMuxDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const report = (references: AgentMuxClientIncidentReference[]): AgentMuxClientIncidentReport => ({
  occurrenceId: 'original-occurrence', attemptId: 'original-attempt', relatedOccurrenceId: null,
  hostId: 'local', regionId: null, kind: 'terminal-attach-failed', stage: 'attach-failed', code: 'EIO',
  agentSessionId: 'original-session', runId: 'original-run', observedAt: 1, elapsedMs: 0,
  metadata: {}, stages: [], references,
})
async function archive(root: string, references: AgentMuxClientIncidentReference[]) {
  const owner = new ClientIncidentArchive(join(root, 'incidents')); await owner.flush()
  const receipt = owner.enqueue(report(references), { kind: 'main', appInstanceId: owner.appInstanceId,
    producerInstanceId: 'original-main', windowId: null, documentGeneration: null, buildId: null })
  expect(receipt.accepted).toBe(true); expect(receipt.logId).toBeDefined(); await owner.flush()
  return { owner, target: { domain: 'client.incident' as const, hostId: 'local', logId: receipt.logId! } }
}
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amx-incident-refs-')); cleanup.push(() => rm(root, { recursive: true, force: true })); return root
}
function resizeEnvelope(result: AgentMuxDiagnosticEvidenceResult) {
  result.budget.usedReads = result.reads.length
  for (let i = 0; i < 4; i++) result.budget.usedBytes = Buffer.byteLength(JSON.stringify(result))
}

describe('original incident references through the existing evidence readers', () => {
  it('reads exact retained Delivery, Toolkit and Scene material through the default Host and compiled CLI without recollection', async () => {
    const root = await directory(), journal = new DeliveryAttemptStore(join(root, 'delivery'), { clientJournal: true })
    await vi.waitFor(async () => expect((await journal.readJournalAuthority()).status).toBe('verified'))
    const deliveryId = mintObjectId(), delivery = { logId: deliveryId, source: 'client' as const,
      agentSessionId: 'original-session', operationId: 'original-operation', hostId: 'local', expectedRunId: 'original-run',
      afterSubmissionId: null, conditionAvailable: true, promptDigest: 'private-digest', execution: 'default' as const,
      startedAt: 1, failedAt: 2, stage: 'receipt', error: { name: 'Error', code: 'EIO', message: 'private-delivery', stack: 'private-stack' } }
    await journal.record(delivery)
    const journalAuthority = (await journal.readJournalAuthority()).authority!
    const failures = new PerformanceFailureStore(join(root, 'toolkit-failure.json'))
    const receipts = new ToolkitReceiptStore(join(root, 'toolkit-receipts.json'), () => ['performance'])
    const openRunPort = vi.fn(async () => { throw Object.assign(new Error('private-toolkit'), { code: 'EIO' }) })
    const args = { failures, receipts, openRunPort, enabled: () => true,
      launch: () => ({ runner: process.execPath, cli: join(root, 'unused'), script: resolve('apps/desktop/resources/toolkit/performance.mjs'), cwd: root, env: {} }) }
    const producer = new PerformanceToolkitOwner(args); cleanup.push(() => producer.dispose())
    await expect(producer.subscribe('performance', () => {}, () => {}, new AbortController().signal, { captureFailure: true })).rejects.toThrow('private-toolkit')
    await vi.waitFor(() => expect(producer.current.diagnostics.persistence).toBe('confirmed'))
    const executionId = producer.current.diagnostics.lastFailure!.executionId
    const toolkit = new PerformanceToolkitOwner(args); cleanup.push(() => toolkit.dispose())
    const execute = vi.spyOn(toolkit, 'execute'), subscribe = vi.spyOn(toolkit, 'subscribe')
    const scene = new PerformanceSceneOwner(join(root, 'scene.json')); cleanup.push(() => scene.dispose())
    const target = { windowId: 1, webContentsId: 2, generation: 3, pid: 4, creationTime: 5 }
    const unavailable = vi.fn(async () => { throw Object.assign(new Error('private-scene'), { code: 'EIO' }) })
    const capture = await scene.capture({ target }, { currentTarget: () => target,
      loaded: () => ({ mainPid: process.pid, package: null, renderer: null }), resources: unavailable,
      captureProfile: unavailable, captureAllocations: unavailable, captureTrace: unavailable, inspectMemory: unavailable })
    expect(capture.persistence.status).toBe('confirmed')
    const captureCalls = unavailable.mock.calls.length, inspectScene = vi.spyOn(scene, 'inspect'), captureScene = vi.spyOn(scene, 'capture')
    const references: AgentMuxClientIncidentReference[] = [
      { domain: 'delivery.client', hostId: 'local', logId: deliveryId, authority: { kind: journalAuthority.kind, id: journalAuthority.id } },
      { domain: 'toolkit.performance-failure', hostId: 'local', executionId },
      { domain: 'performance.scene', hostId: 'local', captureId: capture.scene.captureId },
      { executionId, hostId: 'local', domain: 'toolkit.performance-failure' },
      { logId: deliveryId, authority: { id: journalAuthority.id, kind: journalAuthority.kind }, hostId: 'local', domain: 'delivery.client' },
    ]
    const incident = await archive(root, references)
    const paths = [join(root, 'delivery', deliveryId + '.json'), join(root, 'toolkit-failure.json'), join(root, 'scene.json'),
      join(root, 'incidents', incident.target.logId + '.json')]
    const before = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    const desktopPath = join(root, 'desktop.sock'), hostPath = join(root, 'host.sock')
    const desktop = new AgentMuxControlServer({ socketPath: desktopPath, coreClients: () => [], clientIncidents: () => incident.owner,
      deliveryAttempts: { hostId: 'local', store: journal }, toolkit, metrics: { subscribe: async () => ({ dispose() {} }),
        inspectScene: (input, signal) => scene.inspect(input, signal) } })
    await desktop.start(); cleanup.push(() => desktop.stop())
    const owner = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktopPath } }); cleanup.push(() => owner.dispose())
    const forwarded: string[] = []
    const host = new AgentMuxControlServer({ socketPath: hostPath, coreClients: () => [], forwardControl: async (method, params, context) => {
      forwarded.push(method); return owner.call(method, params, { ...(context.signal ? { signal: context.signal } : {}) })
    } })
    await host.start(); cleanup.push(() => host.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: hostPath } }); cleanup.push(() => rpc.dispose())
    const discovery = await rpc.call('system.diagnostics.inspect', {})
    expect(discovery.capabilities).toEqual(expect.arrayContaining(references.map(reference => expect.objectContaining({ domain: reference.domain, read: 'supported' }))))
    expect(execute).not.toHaveBeenCalled(); expect(inspectScene).not.toHaveBeenCalled()
    const result = await rpc.call('system.diagnostics.inspect', { target: incident.target })
    expect(result.reads.map(read => read.target)).toEqual([incident.target, ...references.slice(0, 3)])
    expect(result.reads.map(read => read.availability)).toEqual(['found', 'found', 'found', 'found'])
    expect(result.reads[0]?.data).toMatchObject({ kind: 'client-incident', report: { references } })
    expect(result.reads[1]).toMatchObject({ recordRef: { logId: deliveryId, authority: journalAuthority }, data: { kind: 'delivery', original: null } })
    expect(result.reads[2]).toMatchObject({ recordRef: null, data: { kind: 'toolkit-performance-failure', coverage: 'latest-only', failure: { executionId }, original: null } })
    expect(result.reads[3]).toMatchObject({ recordRef: null, data: { kind: 'performance-scene', coverage: 'latest-only', captureId: capture.scene.captureId } })
    expect(result.relations).toEqual([])
    for (const secret of ['private-delivery', 'private-stack', 'private-digest', 'private-toolkit', 'private-scene']) expect(JSON.stringify(result)).not.toContain(secret)
    expect(() => parseDiagnosticEvidenceResult(result, { target: incident.target })).not.toThrow()
    const originalOnly = await rpc.call('system.diagnostics.inspect', { target: incident.target, includeRelated: false })
    expect(originalOnly.reads).toHaveLength(1)
    const cli = await runCompiledObjectCli(['--endpoint', `unix://${hostPath}`, 'system', 'diagnostics', 'inspect', '--domain', 'client.incident',
      '--host-id', 'local', '--logid', incident.target.logId], objectCliEnvironment(root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout).result.reads.map((read: { target: unknown }) => read.target)).toEqual([incident.target, ...references.slice(0, 3)])
    const noRelated = await runCompiledObjectCli(['--endpoint', `unix://${hostPath}`, 'system', 'diagnostics', 'inspect', '--domain', 'client.incident',
      '--host-id', 'local', '--logid', incident.target.logId, '--no-related'], objectCliEnvironment(root))
    expect(noRelated.code, noRelated.stderr).toBe(0); expect(JSON.parse(noRelated.stdout).result.reads).toHaveLength(1)
    expect(execute.mock.calls).toHaveLength(2); expect(execute.mock.calls.every(([request]) => request.operation === 'toolkit.get')).toBe(true)
    expect(inspectScene).toHaveBeenCalledTimes(2); expect(subscribe).not.toHaveBeenCalled(); expect(openRunPort).toHaveBeenCalledTimes(1)
    expect(captureScene).not.toHaveBeenCalled(); expect(unavailable).toHaveBeenCalledTimes(captureCalls)
    expect(await Promise.all(paths.map(path => readFile(path, 'utf8')))).toEqual(before)
    expect(forwarded.every(method => method === 'system.diagnostics.inspect')).toBe(true)
    const forged = structuredClone(result), forgedRead = forged.reads[1]!
    if (forgedRead.target.domain !== 'delivery.client' || !forgedRead.recordRef) throw new Error('Original Delivery source was not consumed')
    forgedRead.target.logId = mintObjectId(); forgedRead.recordRef.logId = forgedRead.target.logId; resizeEnvelope(forged)
    expect(() => parseDiagnosticEvidenceResult(forged, { target: incident.target })).toThrow()
    expect(() => parseDiagnosticEvidenceResult(result, { target: incident.target, includeRelated: false })).toThrow()
    expect(() => parseDiagnosticEvidenceResult(result, { target: incident.target, budget: { maxDepth: 0 } })).toThrow()
    const repeated = structuredClone(result); repeated.reads.push(structuredClone(repeated.reads[1]!)); resizeEnvelope(repeated)
    expect(() => parseDiagnosticEvidenceResult(repeated, { target: incident.target })).toThrow()
    const receipt = process.env.AGENTMUX_INCIDENT_REFERENCES_RECEIPT
    if (receipt) await writeFile(receipt, JSON.stringify({ result, cli, noRelated, ownerOperations: execute.mock.calls.map(([request]) => request.operation),
      newRunPortsDuringQuery: openRunPort.mock.calls.length - 1, newSceneCapturesDuringQuery: captureScene.mock.calls.length, originalFilesUnchanged: true }, null, 2))
  }, 30_000)

  it('preserves the primary while related sources are absent, corrupt, unavailable or not exposed', async () => {
    const root = await directory(), journal = new DeliveryAttemptStore(join(root, 'delivery'), { clientJournal: true })
    await vi.waitFor(async () => expect((await journal.readJournalAuthority()).status).toBe('verified'))
    const missing = mintObjectId(), corrupt = mintObjectId(), retained = mintObjectId()
    await journal.record({ logId: retained, source: 'client', agentSessionId: 'original-session', operationId: 'original-operation',
      hostId: 'local', expectedRunId: 'original-run', afterSubmissionId: null, conditionAvailable: true, promptDigest: 'private-digest',
      execution: 'default', startedAt: 1, failedAt: 2, stage: 'receipt', error: { name: 'Error', code: 'EIO', message: 'private-original' } })
    await writeFile(join(root, 'delivery', corrupt + '.json'), '{broken-original')
    const references: AgentMuxClientIncidentReference[] = [
      { domain: 'delivery.client', hostId: 'local', logId: missing }, { domain: 'delivery.client', hostId: 'local', logId: corrupt },
      { domain: 'delivery.client', hostId: 'local', logId: retained },
      { domain: 'toolkit.performance-failure', hostId: 'local', executionId: 'original-execution' },
      { domain: 'native-recorder-failure', hostId: 'local', agentSessionId: 'original-session', runId: 'original-run' },
    ]
    const incident = await archive(root, references)
    const service = new AgentMuxRpcService({ coreClients: () => [], clientIncidents: () => incident.owner, deliveryAttempts: { hostId: 'local', store: journal } })
    cleanup.push(() => service.dispose())
    const result = await service.call('system.diagnostics.inspect', { target: incident.target })
    expect(result.reads.map(read => read.availability)).toEqual(['found', 'not-found', 'unavailable', 'found', 'unsupported', 'not-exposed'])
    expect(result.reads[2]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE')
    expect(result.reads[0]?.data).toMatchObject({ report: { references } }); expect(result.completeness).toBe('partial')
    expect(result.reads[3]).toMatchObject({ recordRef: { logId: retained }, data: { kind: 'delivery', original: null } })
    expect(result.reads.filter(read => read.availability !== 'found').every(read => read.data === null && read.recordRef === null)).toBe(true)
    expect(result.capabilities.filter(capability => capability.domain === 'native-recorder-failure')).toEqual([
      { domain: 'native-recorder-failure', target: 'session-run', raw: false, read: 'not-exposed' },
    ])
    expect(result.capabilities.some(capability => capability.domain === 'toolkit.performance-failure')).toBe(false)
    expect(result.relations).toEqual([])
    expect(() => parseDiagnosticEvidenceResult(result, { target: incident.target })).not.toThrow()
    const absent = await service.call('system.diagnostics.inspect', { target: { ...incident.target, logId: mintObjectId() } })
    expect(absent.reads).toHaveLength(1); expect(absent.reads[0]?.availability).toBe('not-found')
    const bounded = await service.call('system.diagnostics.inspect', { target: incident.target, budget: { maxReads: 2 } })
    expect(bounded.reads).toHaveLength(2); expect(bounded.reads[0]?.availability).toBe('found'); expect(bounded.completeness).toBe('partial')
    const shallow = await service.call('system.diagnostics.inspect', { target: incident.target, budget: { maxDepth: 0 } })
    expect(shallow.reads).toHaveLength(1); expect(shallow.reads[0]?.availability).toBe('found'); expect(shallow.completeness).toBe('partial')
  })

  it('denies each foreign Host before touching its source and leaves the authenticated Agent available', async () => {
    const root = await directory(), h = await rpcOwnerFixture(); cleanup.push(h.close)
    const journal = new DeliveryAttemptStore(join(root, 'delivery'), { clientJournal: true })
    await vi.waitFor(async () => expect((await journal.readJournalAuthority()).status).toBe('verified'))
    const read = vi.spyOn(journal, 'read'), identity = vi.spyOn(journal, 'readJournalAuthority')
    const incident = await archive(root, [
      { domain: 'delivery.client', hostId: 'other', logId: mintObjectId() },
      { domain: 'toolkit.performance-failure', hostId: 'other', executionId: 'unknown-execution' },
    ])
    const service = new AgentMuxRpcService({ coreClients: h.coreClients, clientIncidents: () => incident.owner, deliveryAttempts: { hostId: 'local', store: journal } })
    cleanup.push(() => service.dispose())
    const result = await service.call('system.diagnostics.inspect', { target: incident.target }, { caller: h.credentials })
    expect(result.reads.map(value => value.availability)).toEqual(['found', 'forbidden', 'forbidden'])
    expect(result.reads.slice(1).every(value => value.recordRef === null && value.readAuthority === null && value.data === null)).toBe(true)
    expect(read).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled()
    expect(await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'caller' } }, { caller: h.credentials })).toBeDefined()
    expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
})
