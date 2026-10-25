import { afterEach, expect, it, vi } from 'vitest'
import { createInputPerformanceRecorder, type InputPerformanceSnapshot } from '../src/performance-diagnostics.js'
import { parseClientPerformanceDiagnostics, parseMetricsObservation } from '../src/metrics.js'
import { parseToolkitSnapshot } from '../src/toolkit.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import { deepMetricsSnapshot, hostResourceFixture } from './helpers/toolkit-metrics.js'
import { correlationParent } from './helpers/input-correlation.js'
import { AgentMuxControlServer } from '../src/control-host.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentProvider } from '../src/agent-provider.js'
import { join } from 'node:path'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('retains bounded service costs without ranking queue victims or duplicating original parent matches', async () => {
  let ms = 0
  const recorder = createInputPerformanceRecorder(() => ms, () => 1000)
  const slow = recorder.begin({ sessionId: 'original', runId: 'run', kind: 'semantic', bytes: null, work: 'launch-prompt', parent: correlationParent() })
  slow.dequeue(); await slow.measure('provider-prepare', async () => { ms += 100 }); slow.settle(true)
  expect(recorder.snapshot().slowest[0]?.parentMatch).toBe('unique')
  for (let i = 0; i < 40; i++) {
    const victim = recorder.begin({ sessionId: 'original', runId: 'run', kind: 'mouse', bytes: 12, blockedBy: slow.reference() })
    ms += 1000; victim.dequeue(); ms += 1; victim.settle(true)
  }
  const unknown = recorder.begin({ sessionId: null, runId: 'unmeasured', kind: 'terminal', bytes: 1 })
  ms += 2000; unknown.settle(false)
  const result = recorder.snapshot()
  expect(result.recent).toHaveLength(32); expect(result.slowest).toHaveLength(8)
  expect(result.slowest[0]).toMatchObject({ id: 1, work: 'launch-prompt', serviceMs: 100, parentMatch: 'unknown-omitted' })
  expect(result.recent.some(entry => entry.id === 1)).toBe(false)
  expect(result.recent.at(-1)?.serviceMs).toBeNull()
  expect(result.slowest.some(entry => entry.runId === 'unmeasured')).toBe(false)
  result.slowest[0]!.phases['provider-prepare'] = 0
  result.recent[0]!.blockedBy!.id = -1
  expect(recorder.snapshot().slowest[0]!.phases['provider-prepare']).toBe(100)
  expect(recorder.snapshot().recent[0]!.blockedBy!.id).toBe(1)
})

it('keeps nested phase costs inclusive and distinct original entries with the same parent ambiguous', async () => {
  let ms = 0
  const recorder = createInputPerformanceRecorder(() => ms)
  const first = recorder.begin({ sessionId: 'original', runId: 'run', kind: 'semantic', bytes: null, parent: correlationParent() })
  first.dequeue()
  await first.measure('operation', async () => {
    ms += 3
    await first.measure('provider-verify', async () => { ms += 7 })
    expect(first.reference().stage).toBe('operation')
  })
  first.settle(true)
  const second = recorder.begin({ sessionId: 'original', runId: 'run', kind: 'user', bytes: 1, parent: correlationParent() })
  second.dequeue()
  await expect(second.measure('native-input', async () => { ms += 2; throw Error('private failure') })).rejects.toThrow()
  second.settle(false)
  const facts = recorder.snapshot()
  expect(facts.slowest[0]).toMatchObject({ serviceMs: 10, phases: { operation: 10, 'provider-verify': 7 }, parentMatch: 'ambiguous' })
  expect(facts.recent[1]).toMatchObject({ result: 'failed', stage: 'native-input', serviceMs: 2, parentMatch: 'ambiguous' })
})

it('retains the original running semantic owner after a mouse flood through Core, Hosted, Unix metrics and Toolkit', async () => {
  const h = await rpcOwnerFixture(['recipient', 'other'])
  const entered = deferred(), release = deferred()
  let ms = 0
  const inner = h.client as unknown as { inputPerformance: ReturnType<typeof createInputPerformanceRecorder>; providers: { get(id: string): AgentProvider } }
  inner.inputPerformance = createInputPerformanceRecorder(() => ms, () => 1000)
  h.inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 123 }))
  const send = vi.fn(async () => ({ outcome: 'admitted' as const, turnId: 'turn' }))
  inner.providers.get('codex').prepareNativeInput = async () => {
    entered.resolve(); await release.promise
    return { plan: { kind: 'native-rpc', protocolId: 'fixture-native', sourceId: JSON.stringify(['codex', 'thread']),
      actorId: 'actor', threadId: 'thread', operation: 'start-or-steer' }, assertCurrent: async () => {}, send, dispose: () => {} }
  }
  const hosted = await hostedTestClient(h.client)
  let owner: AgentMuxControlServer | undefined, publicClient: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  const writes: Promise<unknown>[] = []
  try {
    await hosted.sdk.submitAgentPrompt({ agentSessionId: 'recipient', operationId: 'original-prompt', expectedRun: { runId: 'run-recipient' },
      admissionIntent: { kind: 'native-conversation', source: { providerId: 'codex', nativeSessionId: 'thread' } }, execution: 'immediate', prompt: 'Private input', authorHuman: true })
    await entered.promise
    const first = (await hosted.sdk.clientPerformanceDiagnostics()).input.active.find(entry => entry.work === 'prompt-submit')!
    expect(first).toMatchObject({ kind: 'semantic', stage: 'provider-prepare', runId: 'run-recipient' })
    for (let i = 0; i < 70; i++) writes.push(hosted.sdk.writeAgent({ agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' },
      data: '\x1b[<35;10;20M', source: 'user' }))
    await vi.waitFor(async () => expect((await hosted.sdk.clientPerformanceDiagnostics()).input.pending).toBe(71))
    await hosted.sdk.writeAgent({ agentSessionId: 'other', expectedRun: { runId: 'run-other' }, data: 'x', source: 'user' })
    expect((await hosted.sdk.clientPerformanceDiagnostics()).input.recent.at(-1)?.blockedBy).toBeNull()
    ms = 10000; release.resolve(); await Promise.all(writes)
    await vi.waitFor(async () => expect((await hosted.sdk.clientPerformanceDiagnostics()).input.pending).toBe(0))
    const facts = parseClientPerformanceDiagnostics(await hosted.sdk.clientPerformanceDiagnostics())
    const evidence: InputPerformanceSnapshot = facts.input
    expect(evidence.recent.some(entry => entry.id === first.id)).toBe(false)
    expect(evidence.slowest[0]).toMatchObject({ id: first.id, work: 'prompt-submit', serviceMs: 10000, phases: { 'provider-prepare': 10000 } })
    for (const phase of ['submission-store', 'session-state', 'input-authority', 'input-claim', 'provider-verify', 'provider-send', 'provider-cleanup', 'input-receipt'] as const) {
      expect(evidence.slowest[0]!.phases[phase], phase + ' must be measured at its real consumer').not.toBeNull()
    }
    expect(evidence.recent.every(entry => entry.blockedBy?.id === first.id && entry.blockedBy.stage === 'provider-prepare'),
      'Queued mouse reports must retain the actual running owner, not another queued victim').toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(h.inner.kernel.input).toHaveBeenCalledTimes(71)
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    const toolkit = deepMetricsSnapshot(), observation = toolkit.observation!
    observation.diagnostics = { state: 'available', observedAt: 1000, lastSuccessAt: 1000, reason: null,
      data: { host: hostResourceFixture(), main: facts, hosts: [], omittedHosts: 0, storage: null,
        storageUnavailable: 'Not observed', eventLoop: { resolutionMs: 20, generation: 1, count: 0, meanMs: null, maxMs: null } } }
    expect(parseMetricsObservation(observation).diagnostics.data!.main.input.slowest).toEqual(evidence.slowest)
    expect(parseToolkitSnapshot(toolkit)).toEqual(toolkit)
    const path = join(h.root, 'metrics.sock')
    owner = new AgentMuxControlServer({ execute: vi.fn(), coreClients: () => [], toolkit: {
      async execute() { return { operation: 'toolkit.get', snapshot: toolkit } }, async subscribe() { throw Error('unused') }
    }, metrics: { async subscribe(push) { queueMicrotask(() => push(observation)); return { dispose: () => {} } } } }, path)
    await owner.start(); publicClient = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
    const publicFacts = await publicClient.call('system.metrics.get', {})
    expect(publicFacts.observation.diagnostics.data!.main.input).toEqual(evidence)
    expect((await publicClient.call('toolkit.inspect', { toolId: 'performance' })).snapshot).toEqual(toolkit)
    const invalid = structuredClone(facts); invalid.input.slowest.push(...invalid.input.slowest)
    expect(() => parseClientPerformanceDiagnostics(invalid)).toThrow()
    const missing = structuredClone(facts); delete (missing.input as Partial<InputPerformanceSnapshot>).slowest
    expect(() => parseClientPerformanceDiagnostics(missing)).toThrow()
    expect(JSON.stringify(evidence)).not.toContain('Private input')
    // An unknown raw receipt settles this observer; it never authorizes replay.
    ;(h.inner.kernel.input as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Original ACK unknown'))
    const beforeFailure = (h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length
    const raw = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, data: 'distinct input', source: 'user' as const }
    await expect(hosted.sdk.writeAgent(raw)).rejects.toThrow('Original ACK unknown')
    await hosted.sdk.writeAgent({ ...raw, data: 'later distinct input' })
    expect((h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length - beforeFailure).toBe(2)
    const afterFailure = (await hosted.sdk.clientPerformanceDiagnostics()).input
    expect(afterFailure.recent.slice(-2).map(entry => entry.result)).toEqual(['failed', 'completed'])
    expect(afterFailure.recent.at(-1)?.blockedBy).toBeNull()
  } finally {
    release.resolve(); await Promise.allSettled(writes); await publicClient?.dispose(); await owner?.stop(); await hosted.dispose(); await h.close()
  }
})
