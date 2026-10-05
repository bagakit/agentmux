import { parseToolkitPerformanceFailure } from '../../../packages/core/src/toolkit-performance-failure.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => {
  const { fixturePath } = await import('../scripts/lib/fixture-values.mjs')
  return { app: { getPath: () => fixturePath('temporary'), getAppPath: () => process.cwd() } }
})
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { PerformanceToolkitOwner } from '../src/main/toolkit-owner.js'
import { PerformanceFailureStore } from '../src/main/toolkit-performance-failure-store.js'
import { ToolkitReceiptStore } from '../src/main/toolkit-receipt-store.js'
import { toolkitFailureEvidenceReader } from '../../../packages/core/src/toolkit-failure-evidence-reader.js'
import type { ToolkitPerformanceDiagnostics } from '../../../packages/core/src/toolkit-performance-failure.js'

const receiptPath = process.env.AGENTMUX_DIAGNOSTIC_TOOLKIT_RECEIPT
const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.restoreAllMocks() })

describe('independent Toolkit source through unified diagnostic query', () => {
  it('reads the real owner failure before any Run, preserves it across owner reload, and never starts collection during query', async () => {
    const root = await mkdtemp(join(sep, 'tmp', 'amx-tool-evidence-')); close.push(() => rm(root, { recursive: true, force: true }))
    const failures = new PerformanceFailureStore(join(root, 'failure.json')), receipts = new ToolkitReceiptStore(join(root, 'receipts.json'), () => ['performance'])
    const openRunPort = vi.fn(async () => { throw Object.assign(new Error('private-toolkit-primary'), { code: 'EIO', stack: 'private-toolkit-stack' }) })
    const args = { failures, receipts, openRunPort, enabled: () => true,
      launch: () => ({ runner: process.execPath, cli: join(root, 'unused-cli'), script: resolve('apps/desktop/resources/toolkit/performance.mjs'), cwd: root, env: {} }) }
    const saved = vi.spyOn(failures, 'save')
    const producer = new PerformanceToolkitOwner(args); close.push(() => producer.dispose())
    // Exercise the original producer boundary. No create/run port is returned and no Native Run starts.
    await expect(producer.subscribe('performance', () => {}, () => {}, new AbortController().signal, { captureFailure: true }))
      .rejects.toThrow('private-toolkit-primary')
    await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
    expect(() => parseToolkitPerformanceFailure(saved.mock.calls[0]![0]), JSON.stringify(saved.mock.calls[0]![0])).not.toThrow()
    expect(saved.mock.results[0]?.type, String(saved.mock.results[0]?.value?.stack ?? saved.mock.results[0]?.value)).toBe('return')
    await expect(saved.mock.results[0]!.value).resolves.toBeUndefined()
    await vi.waitFor(() => expect(producer.current.diagnostics.persistence).toBe('confirmed'))
    const executionId = producer.current.diagnostics.lastFailure!.executionId
    expect(openRunPort).toHaveBeenCalledTimes(1)
    const original = await failures.read(); expect(original?.details.stage).toBe('run-port'); expect(original?.run).toBeNull()
    const owner = new PerformanceToolkitOwner(args); close.push(() => owner.dispose())
    const execute = vi.spyOn(owner, 'execute'), subscribe = vi.spyOn(owner, 'subscribe')
    const socketPath = join(root, 'rpc.sock'), server = new AgentMuxControlServer({ socketPath, coreClients: () => [], toolkit: owner })
    await server.start(); close.push(() => server.stop())
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); close.push(() => rpc.dispose())
    const target = { domain: 'toolkit.performance-failure' as const, hostId: 'local', executionId }
    const localService = new AgentMuxRpcService({ coreClients: () => [], toolkit: owner }); close.push(() => localService.dispose())
    const local = await localService.call('system.diagnostics.inspect', { target })
    expect(local.reads[0]?.availability).toBe('found')
    expect(() => parseDiagnosticEvidenceResult(local, { target })).not.toThrow()
    const safe = await rpc.call('system.diagnostics.inspect', { target })
    expect(safe.reads[0], JSON.stringify(safe)).toMatchObject({ availability: 'found', recordRef: null, persistence: 'observed', observedAt: original?.recordedAt,
      raw: { retention: 'retained', returned: 'withheld' }, data: { kind: 'toolkit-performance-failure', coverage: 'latest-only',
        failure: { executionId, run: null, details: { stage: 'run-port', error: { code: 'EIO', message: null, stack: null } } }, original: null } })
    expect(JSON.stringify(safe)).not.toContain('private-toolkit-primary'); expect(JSON.stringify(safe)).not.toContain('private-toolkit-stack')
    const raw = await rpc.call('system.diagnostics.inspect', { target, includeRaw: true })
    expect(raw.reads[0]?.data?.original).toEqual(original); expect(raw.reads[0]?.raw.returned).toBe('included')
    expect(() => parseDiagnosticEvidenceResult(raw, { target })).toThrow()
    const other = await rpc.call('system.diagnostics.inspect', { target: { ...target, executionId: 'different-execution' } })
    expect(other.reads[0]).toMatchObject({ availability: 'not-found', recordRef: null, completeness: 'unknown', data: null })
    const cli = await runCompiledObjectCli(['--endpoint', `unix://${socketPath}`, 'system', 'diagnostics', 'inspect', '--domain', 'toolkit.performance-failure', '--host-id', 'local', '--execution-id', executionId], objectCliEnvironment(root))
    expect(cli.code, cli.stderr).toBe(0)
    expect(JSON.parse(cli.stdout)).toMatchObject({ ok: true, operation: 'system.diagnostics.inspect', result: { reads: [{ recordRef: null, data: { failure: { executionId } } }] } })
    expect(execute.mock.calls.every(([request]) => request.operation === 'toolkit.get')).toBe(true)
    expect(subscribe).not.toHaveBeenCalled(); expect(openRunPort).toHaveBeenCalledTimes(1)
    if (receiptPath) {
      await writeFile(receiptPath, JSON.stringify({ safe, raw, other, cli, ownerOperations: execute.mock.calls.map(([r]) => r.operation), nativeRuns: 0 }, null, 2))
      expect(JSON.parse(await readFile(receiptPath, 'utf8')).cli.code).toBe(0)
    }
  }, 20_000)
  it('omits oversized original material while keeping exact safe failure and original truncation', async () => {
    const diagnostics: ToolkitPerformanceDiagnostics = { captureEnabled: true, failureEvidence: 'included', droppedWrites: 3, persistence: 'confirmed',
      issue: null, cleanupIssue: null, lastFailure: { schema: 'agentmux.performance.failure.v1', executionId: 'execution', run: null, recordedAt: 100,
        details: { stage: 'toolkit-json', error: { message: 's'.repeat(4096), stack: 's'.repeat(8192), code: 'BEARER_SECRET_ABC123', messageTruncated: true, stackTruncated: false }, bytes: null, exit: null } } }
    const target = { domain: 'toolkit.performance-failure' as const, hostId: 'local', executionId: 'execution' }
    const result = await toolkitFailureEvidenceReader(async () => diagnostics, true).read(target, { maxBytes: 2048, signal: new AbortController().signal })
    expect(result).toMatchObject({ availability: 'found', recordRef: null, completeness: 'partial', raw: { retention: 'retained', returned: 'withheld', truncated: true },
      issue: { code: 'DIAGNOSTIC_EVIDENCE_QUERY_BUDGET' }, data: { omissions: ['raw-query-budget'], original: null, failure: { details: { error: { code: null } } } } })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048)
    expect(JSON.stringify(result)).not.toContain('BEARER_SECRET_ABC123')
    const mismatch = await toolkitFailureEvidenceReader(async () => diagnostics, false).read({ ...target, executionId: 'different' }, { maxBytes: 4096, signal: new AbortController().signal })
    expect(mismatch.availability).toBe('not-found'); expect(mismatch.recordRef).toBeNull()
    diagnostics.issue = { operation: 'read-failure', code: 'EIO', message: 'private-read-error', phase: null }; diagnostics.lastFailure = null; diagnostics.persistence = 'not-requested'; diagnostics.failureEvidence = 'included'
    expect((await toolkitFailureEvidenceReader(async () => diagnostics, false).read(target, { maxBytes: 4096, signal: new AbortController().signal })).availability).toBe('unavailable')
  })
})
