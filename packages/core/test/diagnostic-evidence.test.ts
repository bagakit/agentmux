import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { DiagnosticEvidenceQuery, unavailableDiagnosticEvidence, type DiagnosticEvidenceRead } from '@agentmux/diagnostic-evidence'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { DeliveryAttemptStore } from '../src/delivery-attempt-store.js'
import { projectDeliveryEvidence } from '../src/delivery-evidence-reader.js'
import { newDeliveryLogId, type DeliveryAttempt } from '../src/delivery-attempt.js'
import { parseDiagnosticEvidenceResult } from '../src/diagnostic-evidence-codec.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const consumerReceiptPath = process.env.AGENTMUX_DIAGNOSTIC_EVIDENCE_RECEIPT
const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks() })
async function directory() { const root = await mkdtemp(join(sep, 'tmp', 'amx-evidence-')); close.push(() => rm(root, { recursive: true, force: true })); return root }
const original = (): DeliveryAttempt => ({ logId: newDeliveryLogId(), source: 'client', agentSessionId: 'recipient', operationId: 'operation',
  hostId: 'local', expectedRunId: 'run-recipient', afterSubmissionId: null, conditionAvailable: true, promptDigest: 'private-digest',
  execution: 'default', startedAt: 1, failedAt: 2, stage: 'receipt', error: { name: 'Error', code: 'EIO', message: 'private-error-text', stack: 'private-stack' } })
async function journal(root: string) {
  const store = new DeliveryAttemptStore(root, { clientJournal: true })
  await vi.waitFor(async () => expect((await store.readJournalAuthority()).status).toBe('verified'))
  return store
}

describe('portable evidence mechanism', () => {
  const target = { domain: 'ordinary-observation', key: 'root' }
  const found = (value = 'original'): DiagnosticEvidenceRead<typeof target, string> => ({
    ...unavailableDiagnosticEvidence(target, 'DIAGNOSTIC_EVIDENCE_SOURCE_UNAVAILABLE'), availability: 'found', data: value,
    completeness: 'complete', scope: 'point-observation', issue: null,
  })
  it('keeps the original while a related reader fails and relationship projection throws', async () => {
    const query = new DiagnosticEvidenceQuery(), read = vi.fn(async (t: typeof target) => {
      if (t.key !== 'root') throw Error('private secondary error')
      return found()
    })
    const result = await query.inspect(target, { read }, { related: () => [{ ...target, key: 'child' }], relations: () => { throw Error('private projection') } })
    expect(result.reads).toHaveLength(2); expect(result.reads[0]?.data).toBe('original')
    expect(result.reads[1]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_READ_FAILED')
    expect(result.issues[0]?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_PROJECTION_FAILED'); expect(result.completeness).toBe('partial')
    expect(JSON.stringify(result)).not.toContain('private secondary')
    expect(result.budget.usedBytes).toBe(Buffer.byteLength(JSON.stringify(result)))
  })
  it('holds actual pending I/O slots after deadline; cancellation never replays a read', async () => {
    let release!: (r: DiagnosticEvidenceRead<typeof target, string>) => void
    const read = vi.fn(() => new Promise<DiagnosticEvidenceRead<typeof target, string>>(resolve => { release = resolve }))
    const query = new DiagnosticEvidenceQuery(1)
    expect((await query.inspect(target, { read }, { budget: { deadlineMs: 10 } })).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_QUERY_DEADLINE')
    expect((await query.inspect(target, { read })).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_SOURCE_BUSY'); expect(read).toHaveBeenCalledTimes(1)
    release(found()); await vi.waitFor(async () => {
      const r = await query.inspect(target, { read: async () => found() }); expect(r.reads[0]?.availability).toBe('found')
    })
    const controller = new AbortController(); controller.abort()
    expect((await query.inspect(target, { read }, { signal: controller.signal })).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('bounds full envelopes, depth and count, including oversized owner material', async () => {
    const query = new DiagnosticEvidenceQuery()
    const result = await query.inspect(target, { read: async () => found('x'.repeat(8192)) }, { budget: { maxBytes: 4096 } })
    expect(result.reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_QUERY_BUDGET'); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
    const read = vi.fn(async () => found())
    expect((await query.inspect(target, { read }, { budget: { maxDepth: 0 }, related: () => [{ ...target, key: 'child' }] })).completeness).toBe('partial')
    expect(read).toHaveBeenCalledTimes(1)
    await expect(query.inspect(target, { read }, { budget: { maxReads: 0 } })).rejects.toThrow(RangeError)
  })
  it('does not invoke an owner cancelled before the deferred reader starts', async () => {
    const controller = new AbortController(), read = vi.fn(async () => found())
    const pending = new DiagnosticEvidenceQuery().inspect(target, { read }, { signal: controller.signal })
    controller.abort()
    expect((await pending).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_QUERY_CANCELLED')
    expect(read).not.toHaveBeenCalled()
  })
})

describe('original domain owners → typed public RPC → compiled CLI', () => {
  it('keeps arbitrary primary text out of the ordinary domain projection', () => {
    const data = projectDeliveryEvidence(original(), false)
    expect(JSON.stringify(data)).not.toContain('private-error-text')
    expect(data.original).toBeNull()
    const record = original(); record.error.code = 'BEARER_SECRET_ABC123'; record.error.cause = { name: 'Error', message: 'private-inner', code: 'BEARER_SECRET_CAUSE', truncated: true }
    record.stage = 'core-submit'
    const safe = projectDeliveryEvidence(record, false)
    expect(safe.error).toMatchObject({ code: null, causeCodes: [] }); expect(safe.stage).toBe('core-submit')
  })
  it('retains the original disk-read slots even after finite caller observations return', async () => {
    const store = new DeliveryAttemptStore(await directory())
    const source = store as unknown as { readDisk(logId: string): Promise<import('../src/delivery-attempt.js').DeliveryAttemptLookup> }
    const disk = vi.spyOn(source, 'readDisk').mockImplementation(() => new Promise(() => {}))
    const values = await Promise.all(Array.from({ length: 9 }, () => store.read(newDeliveryLogId())))
    expect(values.every(value => value.availability === 'unavailable')).toBe(true)
    expect(disk).toHaveBeenCalledTimes(8)
    await store.read(newDeliveryLogId()); expect(disk).toHaveBeenCalledTimes(8)
  })
  it('reads an actual Core submission failure and trusted Client report, with conservative association and explicit original material', async () => {
    const root = await directory(), h = await rpcOwnerFixture(); close.push(h.close)
    const failure = Object.assign(new Error('private-error-text'), { code: 'EIO', stack: 'private-stack',
      controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
    vi.spyOn(h.client.providers.get('codex'), 'planPromptInput').mockImplementation(() => { throw failure })
    const error = await h.client.submitAgentPrompt({ agentSessionId: 'recipient', operationId: 'operation', expectedRun: { runId: 'run-recipient' },
      afterSubmissionId: null, authorHuman: true, prompt: 'private-prompt' }).catch(error => error)
    expect(error.logId).toMatch(/^[1-9A-HJ-NP-Za-km-z]{12}$/u)
    const store = await journal(join(root, 'reports')), socketPath = join(root, 'owner.sock')
    const coreAuthority = { authority: { kind: 'core-runtime', id: 'original-runtime', lifetime: 'instance' as const }, status: 'verified' as const, causeCode: null }
    const server = new AgentMuxControlServer({ socketPath, coreClients: h.coreClients, diagnosticCoreAuthority: () => coreAuthority,
      deliveryAttempts: { hostId: 'local', store } })
    await server.start(); close.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); close.push(() => rpc.dispose())
    const report = { ...original(), coreLogId: error.logId }
    const saved = await rpc.call('message.delivery.report', { hostId: 'local', record: report })
    expect(saved.persistence).toBe('confirmed')
    const target = { domain: 'delivery.client' as const, hostId: 'local', logId: report.logId }
    const evidence = await rpc.call('system.diagnostics.inspect', { target })
    expect(evidence.reads).toHaveLength(2); expect(evidence.relations[0]?.verification).toBe('target-matched')
    const single = await rpc.call('system.diagnostics.inspect', { target, includeRelated: false })
    expect(single.reads).toHaveLength(1); expect(single.relations[0]?.verification).toBe('declared')
    expect(evidence.reads[1]?.data).toMatchObject({ kind: 'delivery', source: 'core', error: { code: 'EIO', controlFailure: failure.controlFailure },
      missingEvidence: [{ source: 'native-recorder-first-failure', availability: 'not-exposed' }] })
    for (const secret of ['private-error-text', 'private-stack', 'private-prompt', 'private-digest']) expect(JSON.stringify(evidence)).not.toContain(secret)
    const raw = await rpc.call('system.diagnostics.inspect', { target, includeRaw: true })
    expect(raw.reads[0]?.data?.original).toEqual(saved.record); const rawCore = raw.reads[1]?.data; expect(rawCore?.kind === 'delivery' ? rawCore.original?.error.message : null).toBe(failure.message)
    expect(() => parseDiagnosticEvidenceResult(raw, { target })).toThrow()
    const cli = await runCompiledObjectCli(['--endpoint', `unix://${socketPath}`, 'system', 'diagnostics', 'inspect', '--domain', 'delivery.client', '--host-id', 'local', '--logid', report.logId], objectCliEnvironment(root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'system.diagnostics.inspect', result: { relations: [{ verification: 'target-matched' }] } })
    const help = await runCompiledObjectCli(['system', 'diagnostics', 'inspect', '--help'], objectCliEnvironment(root))
    expect(help.code).toBe(0); expect(help.stdout).toContain('--list'); expect(help.stdout).toContain('--include-raw')
    const skill = await runCompiledObjectCli(['system', '--skill'], objectCliEnvironment(root))
    expect(skill.code).toBe(0); expect(skill.stdout).toContain('system diagnostics inspect')
    const discovery = await rpc.call('system.diagnostics.inspect', {})
    expect(discovery.reads).toEqual([]); expect(discovery.capabilities.length).toBeGreaterThan(1)
    expect(h.inner.kernel.attach).not.toHaveBeenCalled(); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    const conflict = { ...report, logId: newDeliveryLogId(), operationId: 'different-operation' }; await rpc.call('message.delivery.report', { hostId: 'local', record: conflict })
    expect((await rpc.call('system.diagnostics.inspect', { target: { ...target, logId: conflict.logId } })).relations[0]?.verification).toBe('conflict')
    const native = await rpc.call('system.diagnostics.inspect', { target: { domain: 'native-recorder-failure', hostId: 'local', agentSessionId: 'recipient', runId: 'run-recipient' } })
    expect(native.reads[0]).toMatchObject({ availability: 'not-exposed', recordRef: null, data: null })
    if (consumerReceiptPath) {
      await writeFile(consumerReceiptPath, JSON.stringify({ evidence, raw, discovery, native, cli }, null, 2))
      expect(JSON.parse(await readFile(consumerReceiptPath, 'utf8')).cli.code).toBe(0)
    }
  }, 20_000)
  it('keeps readable history when namespace metadata is corrupt; explicit authority is never relaxed', async () => {
    const root = await directory(), store = await journal(root), record = original()
    const identity = (await store.readJournalAuthority()).authority!; await store.record(record)
    await writeFile(join(root, 'journal-identity.json'), '{corrupt namespace')
    const service = new AgentMuxRpcService({ coreClients: () => [], deliveryAttempts: { hostId: 'local', store } }); close.push(() => service.dispose())
    const target = { domain: 'delivery.client' as const, hostId: 'local', logId: record.logId }
    expect((await service.call('system.diagnostics.inspect', { target })).reads[0]).toMatchObject({ availability: 'found', recordRef: { authority: null }, authorityStatus: 'unavailable', data: { error: { code: 'EIO' } } })
    expect((await service.call('system.diagnostics.inspect', { target: { ...target, authority: { kind: identity.kind, id: identity.id } } })).reads[0]).toMatchObject({ availability: 'unavailable', data: null, issue: { code: 'DIAGNOSTIC_EVIDENCE_AUTHORITY_UNAVAILABLE' } })
    expect((await store.read(record.logId)).record).toEqual(record)
    // A new reader sees the same original bytes, independent of in-memory receipt confirmation.
    expect((await new DeliveryAttemptStore(root).read(record.logId)).persistence).toBe('observed')
    expect(JSON.parse(await readFile(join(root, record.logId + '.json'), 'utf8'))).toEqual(record)
    const identityRead = vi.spyOn(store, 'readJournalAuthority').mockRejectedValue(Object.assign(Error('metadata only'), { code: 'EACCES' }))
    expect((await service.call('system.diagnostics.inspect', { target })).reads[0]).toMatchObject({ availability: 'found', issue: { causeCode: 'EACCES' } })
    identityRead.mockRejectedValue({ code: 'BEARER_SECRET_ABC123' })
    expect(JSON.stringify(await service.call('system.diagnostics.inspect', { target }))).not.toContain('BEARER_SECRET_ABC123')
    identityRead.mockResolvedValue({ authority: identity, status: 'unconfirmed', causeCode: null })
    expect((await service.call('system.diagnostics.inspect', { target: { ...target, authority: { kind: identity.kind, id: identity.id } } })).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_AUTHORITY_UNVERIFIABLE')
    identityRead.mockResolvedValue({ authority: identity, status: 'verified', causeCode: null })
    expect((await service.call('system.diagnostics.inspect', { target: { ...target, authority: { kind: identity.kind, id: 'another-journal' } } })).reads[0]?.issue?.code).toBe('DIAGNOSTIC_EVIDENCE_AUTHORITY_MISMATCH')
  })
  it('preserves inner-cause truncation and the original finite queue failure stage', async () => {
    const root = await directory(), store = await journal(root), record = original()
    record.error.cause = { name: 'Error', message: 'inner', truncated: true }; record.stage = 'queue-preparation'
    await store.record(record)
    const service = new AgentMuxRpcService({ coreClients: () => [], deliveryAttempts: { hostId: 'local', store } }); close.push(() => service.dispose())
    expect((await service.call('system.diagnostics.inspect', { target: { domain: 'delivery.client', hostId: 'local', logId: record.logId } })).reads[0]).toMatchObject({
      completeness: 'partial', raw: { truncated: true }, data: { stage: 'queue-preparation', original: null },
    })
  })
  it('keeps safe Delivery facts when the explicitly requested original exceeds this query budget', async () => {
    const store = await journal(await directory()), record = original(); record.error.message = 's'.repeat(8192)
    await store.record(record)
    const service = new AgentMuxRpcService({ coreClients: () => [], deliveryAttempts: { hostId: 'local', store } }); close.push(() => service.dispose())
    const params = { target: { domain: 'delivery.client' as const, hostId: 'local', logId: record.logId }, includeRaw: true, budget: { maxBytes: 4096 } }
    const result = await service.call('system.diagnostics.inspect', params)
    expect(result.reads[0]).toMatchObject({ availability: 'found', data: { error: { code: 'EIO' }, original: null }, raw: { returned: 'withheld', retention: 'retained' }, issue: { code: 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET' } })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096)
    expect(() => parseDiagnosticEvidenceResult(result, params)).not.toThrow()
  })
  it('isolates unavailable Core, malformed requests and other-Host reads without removing healthy Agent capability', async () => {
    const root = await directory(), store = await journal(root), record = { ...original(), coreLogId: newDeliveryLogId() }
    await store.record(record)
    const h = await rpcOwnerFixture(); close.push(h.close)
    const service = new AgentMuxRpcService({ coreClients: h.coreClients, deliveryAttempts: { hostId: 'local', store } }); close.push(() => service.dispose())
    vi.spyOn(h.client, 'readDeliveryAttempt').mockRejectedValue(Error('private core unavailable'))
    const target = { domain: 'delivery.client' as const, hostId: 'local', logId: record.logId }
    const result = await service.call('system.diagnostics.inspect', { target })
    expect(result.reads[0]?.availability).toBe('found'); expect(result.reads[1]?.availability).toBe('unavailable')
    expect(result.relations[0]?.verification).toBe('unverifiable')
    const read = vi.spyOn(store, 'read')
    const other = await service.call('system.diagnostics.inspect', { target: { ...target, hostId: 'other' } }, { caller: h.credentials })
    expect(other.reads[0]?.availability).toBe('forbidden'); expect(read).not.toHaveBeenCalled()
    await expect(service.call('system.diagnostics.inspect', { target, budget: { maxReads: 99 } })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    expect((await service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'caller' } }, { caller: h.credentials }))).toBeDefined()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  })
})
