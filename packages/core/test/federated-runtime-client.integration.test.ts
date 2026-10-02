import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it } from 'vitest'
import { headlessFixture, testRuntimeService, until } from './helpers/headless-runtime-fixture.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentMuxRpcClient, AgentMuxRpcSubscriptionOptions } from '../src/public-rpc-client.js'
import type { AgentMuxClientEvent } from '../src/types.js'
import { hostedTransfer, AgentMuxHostedTransferReader, AGENTMUX_HOSTED_TRANSFER_MAX_BYTES } from '../src/hosted-value.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'

const scopes: Array<Awaited<ReturnType<typeof headlessFixture>>> = []
afterEach(async () => { for (const scope of scopes.splice(0)) await scope.cleanup() })
describe('Federated Runtime client with real owner and official ctxmux', () => {
  it('streams a large raw Attachment, shares independent reader leases and preserves owner/Run across restart', async () => {
    const scope = await headlessFixture(); scopes.push(scope)
    const first = await scope.client(), second = await scope.client()
    const code = "process.stdin.setRawMode(true);process.stdout.write(Buffer.alloc(400*1024,65));process.stdout.write(Buffer.from([0x80,0xff,0xc3,0x28]));process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"
    const run = await first.createTerminal({ createOperationId: 'large-terminal', workspacePath: scope.root, command: process.execPath, args: ['-e', code], cols: 80, rows: 24 })
    await until(() => first.listRuns(), runs => (runs.find(item => item.runId === run.runId)?.latestOutputBytes ?? 0) >= 400 * 1024 + 4, 'large original output')
    const replay = await first.readRunReplay({ runId: run.runId }, 0, 'raw')
    const original = Buffer.concat(replay.replay.map(chunk => Buffer.from(chunk.dataBytes)))
    expect(original.byteLength).toBe(400 * 1024 + 4)
    expect(original.subarray(-4)).toEqual(Buffer.from([0x80, 0xff, 0xc3, 0x28]))
    const firstAttachment = await first.attachTerminal(run.runId, 0, 'terminal')
    const secondAttachment = await second.attachTerminal(run.runId, 0, 'terminal')
    expect(secondAttachment.terminal).toEqual(firstAttachment.terminal)
    expect(secondAttachment.run.pid).toBe(firstAttachment.run.pid)
    const observed: AgentMuxClientEvent[] = []; second.onEvent(event => observed.push(event))
    await first.releaseRunAttachment({ runId: run.runId })
    const input = async (operationId: string, text: string) => {
      const current = (await second.listRuns()).find(item => item.runId === run.runId)!
      if (current.acceptedInputBytes === null) throw new Error('The original Native input cursor must be observed before a write')
      await second.writeTerminal({ runId: run.runId }, { ownerInstanceId: second.runtimeIdentity().instanceId,
        operationId, expectedByte: current.acceptedInputBytes, data: text })
    }
    await input('after-reader-close', 'reader-still-live')
    const surviving = until(() => observed.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), text => text.includes('reader-still-live'), 'second reader survives cancellation')
    const readerOutcome = await surviving.then(value => ({ value }), error => ({ error }))
    expect(readerOutcome, 'second reader survives cancellation').toMatchObject({ value: expect.stringContaining('reader-still-live') })
    const originalIdentity = scope.owner
    await first.dispose(); await second.dispose()
    const restarted = await scope.restart()
    expect(restarted.owner.runtimeId).toBe(originalIdentity.runtimeId)
    expect(restarted.owner.ownerInstanceId).not.toBe(originalIdentity.ownerInstanceId)
    const recovered = await scope.client()
    const same = (await recovered.listRuns()).find(item => item.runId === run.runId)!
    expect(same.state).toBe('running'); expect(same.pid).toBe(run.pid)
    const raw = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    const staleEpoch = await raw.call('runtime.invoke', { consumerId: 'stale-epoch-consumer', fence: { runtimeId: originalIdentity.runtimeId, ownerInstanceId: originalIdentity.ownerInstanceId },
      invocation: { method: 'resizeTerminal', args: [{ runId: run.runId }, 90, 30] } }).then(value => ({ value }), error => ({ error }))
    expect(staleEpoch, 'stale owner epoch must be rejected').toMatchObject({ error: { code: 'RUNTIME_OWNER_CHANGED' } })
    const native = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath },
      runtimeFence: { runtimeId: originalIdentity.runtimeId, ownerInstanceId: originalIdentity.ownerInstanceId } })
    await expect(native.call('agent.ls', {})).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    await native.dispose()
    await expect(connectHostedAgentMux({ rpc: raw, expectedRuntimeId: 'wrong-semantic-owner' })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    await raw.dispose()
    await recovered.stopTerminal({ runId: run.runId })
  }, 120_000)

  it('reports and rereads only the failed reader while keeping its endpoint and another Run live', async () => {
    const scope = await headlessFixture(); scopes.push(scope)
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    const client = await scope.client(rpc), observed: AgentMuxClientEvent[] = []
    client.onEvent(event => observed.push(event))
    const code = "process.stdin.setRawMode(true);process.stdout.write('original-live');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"
    const first = await client.createTerminal({ createOperationId: 'reader-failure-first', workspacePath: scope.root, command: process.execPath, args: ['-e', code] })
    const other = await client.createTerminal({ createOperationId: 'reader-failure-other', workspacePath: scope.root, command: process.execPath, args: ['-e', code] })
    await until(() => client.listRuns(), values => values.filter(value => [first.runId, other.runId].includes(value.runId) && value.latestOutputBytes > 0).length === 2, 'both original Runs')
    const originalSubscribe = rpc.subscribe.bind(rpc)
    const readers: AgentMuxRpcSubscriptionOptions<'runtime.attachment-watch'>[] = []
    rpc.subscribe = (async (method, params, handlers) => {
      if (method === 'runtime.attachment-watch' && (params as { target?: { runId?: string } }).target?.runId === first.runId) readers.push(handlers as AgentMuxRpcSubscriptionOptions<'runtime.attachment-watch'>)
      return await originalSubscribe(method, params, handlers)
    }) as AgentMuxRpcClient['subscribe']
    const initial = await client.attachTerminal(first.runId, 0, 'terminal')
    await client.attachTerminal(other.runId, 0, 'terminal')
    expect(readers).toHaveLength(1)
    // Fault injection at the real subscription callback boundary; every owner,
    // Attachment, subsequent reread and byte delivery still uses the Unix transport.
    readers[0]!.onEnd?.(new Error('Only this reader ended before its owner observation.'))
    expect(client.runtimeOwnerIdentity()?.availability, 'reader failure keeps the semantic endpoint connected').toBe('connected')
    expect(observed.filter(event => event.type === 'connection-state')).toEqual([])
    const notices = observed.filter(event => event.type === 'agent-error')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ code: 'RUNTIME_ATTACHMENT_UNAVAILABLE', evidence: { run: { runId: first.runId } } })
    expect(notices[0]!.message).toContain(`byte ${initial.run.latestOutputBytes}`)
    const restored = until(() => observed.filter(event => event.type === 'terminal-snapshot'), values => values.length === 1, 'independent original reader reread')
    expect(await restored.then(value => ({ value }), error => ({ error })), 'failed reader receives its independent original Run snapshot').toMatchObject({ value: [{ run: { runId: first.runId, pid: first.pid } }] })
    const input = async (runId: string, operationId: string, text: string) => {
      const current = (await client.listRuns()).find(value => value.runId === runId)!
      if (current.acceptedInputBytes === null) throw new Error('The original Native input cursor must be observed before a write')
      await client.writeTerminal({ runId }, { ownerInstanceId: client.runtimeIdentity().instanceId, operationId,
        expectedByte: current.acceptedInputBytes, data: text })
    }
    await input(other.runId, 'other-reader-input', 'other-reader-alive')
    await input(first.runId, 'restored-reader-input', 'restored-reader-alive')
    await until(() => observed.filter(event => event.type === 'terminal-output').map(event => event.data).join(''), value => value.includes('other-reader-alive') && value.includes('restored-reader-alive'), 'independent readers still deliver bytes')
    expect(readers).toHaveLength(2)
    // A pending live range can overlap the initial replay cut. Both public text
    // and raw bytes must describe only the unread suffix, including OSC queries.
    const overlapCursor = (await client.listRuns()).find(run => run.runId === first.runId)!.latestOutputBytes
    const prefix = Buffer.from('\x1b]10;?\x07'), suffix = Buffer.from('\x1b]11;?\x07')
    const overlapping: AgentMuxClientEvent = { type: 'terminal-output', run: { runId: first.runId },
      data: Buffer.concat([prefix, suffix]).toString('utf8'), dataBytes: Buffer.concat([prefix, suffix]),
      evidence: { source: 'terminal-output', observedAt: Date.now(), run: { runId: first.runId },
        outputByteRange: { startByte: overlapCursor - prefix.length, endByte: overlapCursor + suffix.length } } }
    for (const data of hostedTransfer({ kind: 'event', event: overlapping }, 'overlapping-live-range')) readers[1]!.onEvent({ type: 'snapshot', data })
    expect(observed.filter(event => event.type === 'terminal-output').slice(-1), 'overlapping replay keeps text and bytes on the same unread range').toEqual([
      { ...overlapping, data: suffix.toString('utf8'), dataBytes: new Uint8Array(suffix),
        evidence: { ...overlapping.evidence, outputByteRange: { startByte: overlapCursor, endByte: overlapCursor + suffix.length } } }
    ])
    readers[1]!.onEvent({ type: 'error', error: { code: 'CONTROL_PROTOCOL_ERROR', message: 'Only this reader received an invalid transfer.' } })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(readers, 'a reader failure cannot produce an endless automatic replay loop').toHaveLength(2)
    expect(observed.filter(event => event.type === 'agent-error')).toHaveLength(2)
    await client.refreshRunAttachment({ runId: first.runId }, initial.run.latestOutputBytes, 'terminal', 'manual-reader-refresh')
    expect(readers).toHaveLength(3)
    const count = observed.filter(event => event.type === 'agent-error').length
    await client.releaseRunAttachment({ runId: first.runId }); await client.releaseRunAttachment({ runId: other.runId })
    expect(observed.filter(event => event.type === 'agent-error')).toHaveLength(count)
    expect((await client.listRuns()).map(value => ({ runId: value.runId, pid: value.pid, state: value.state })).sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      { runId: first.runId, pid: first.pid, state: 'running' }, { runId: other.runId, pid: other.pid, state: 'running' }
    ].sort((a, b) => a.runId.localeCompare(b.runId)))
    await client.stopTerminal({ runId: first.runId }); await client.stopTerminal({ runId: other.runId })
  }, 120_000)

  it('retains original Native input failure facts and never replays an unconfirmed remainder', async () => {
    const scope = await headlessFixture(); scopes.push(scope)
    const client = await scope.client()
    const run = await client.createTerminal({ createOperationId: 'input-failure-run', workspacePath: scope.root, command: process.execPath,
      args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('ready');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"] })
    await until(() => client.listRuns(), values => values[0]?.latestOutputBytes === 5, 'native input Run readiness')
    const write = (operationId: string) => client.writeTerminal({ runId: run.runId }, { ownerInstanceId: client.runtimeIdentity().instanceId,
      operationId, expectedByte: 0, data: 'partial-input' }).then(value => ({ value }), error => ({ error }))
    await scope.failInput({ disposition: 'not_applied', confirmedInputBytes: 0 })
    expect(await write('not-applied-input'), 'remote error retains Native confirmed input prefix').toMatchObject({ error: {
      code: 'CTXMUX_io', detail: 'not_applied', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
    } })
    await scope.failInput({ disposition: 'unknown', confirmedInputBytes: 2 })
    expect(await write('partial-input'), 'remote error retains Native confirmed input prefix').toMatchObject({ error: {
      code: 'CTXMUX_io', detail: 'unknown', controlFailure: { disposition: 'unknown', confirmedInputBytes: 2 }
    } })
    await until(() => client.listRuns(), values => values[0]?.latestOutputBytes === 7, 'physically acknowledged native prefix')
    expect(await scope.inputFailureCalls()).toEqual(['not-applied-input', 'partial-input'])
    expect((await client.listRuns()).map(value => ({ runId: value.runId, pid: value.pid, state: value.state, acceptedInputBytes: value.acceptedInputBytes }))).toEqual([
      { runId: run.runId, pid: run.pid, state: 'running', acceptedInputBytes: 2 }
    ])
    const replay = await client.readRunReplay({ runId: run.runId }, 5, 'raw')
    expect(Buffer.concat(replay.replay.map(value => Buffer.from(value.dataBytes)))).toEqual(Buffer.from('pa'))
    await client.stopTerminal({ runId: run.runId })
  }, 120_000)
})

// Owner-side dispatch cost is measured at the service boundary, independently of socket speed.
// The fake Core supplies only observations; the real ordinary-process transport is exercised above.
describe('Runtime dispatch index and ordered initial cut', () => {
  it('ends an oversized observation for its matching Run and keeps the other Run and semantic reader', async () => {
    const { AgentMuxHostedRuntimeService } = await testRuntimeService()
    let publish!: (event: AgentMuxClientEvent) => void
    const released: string[] = [], outputs: Record<string, Array<{ type: string; error?: { code: string } }>> = { first: [], other: [], semantic: [] }
    const core = { onEvent(listener: typeof publish) { publish = listener; return () => {} }, catalog: () => [], agentSessions: () => [],
      runtimeIdentity: () => owner.ctxmux, agentMessageQueuePath: () => upstreamFixturePath("original/messages"),
      refreshRunAttachment: async (run: { runId: string }) => ({ run, replay: [], gap: null }),
      releaseRunAttachment: async ({ runId }: { runId: string }) => { released.push(runId) } }
    const owner = { runtimeId: 'semantic-owner', ownerInstanceId: 'semantic-epoch', protocolVersion: 1, processId: process.pid, availability: 'connected',
      ctxmux: { hostId: 'local', instanceId: 'ctxmux-epoch', processId: process.pid, buildIdentity: 'fixture-sdk', protocolVersion: 1 } } satisfies AgentMuxRuntimeOwnerIdentity
    const service = new AgentMuxHostedRuntimeService(core as unknown as import('../src/client.js').AgentMuxClient, null, () => owner)
    const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
    const subscriptions = []
    const semantic = await service.subscribe('runtime.events', { consumerId: 'budget-consumer', fence }, event => { outputs.semantic!.push(event) }, {})
    await semantic.start?.()
    for (const runId of ['first', 'other']) {
      const sub = await service.subscribe('runtime.attachment-watch', { consumerId: 'budget-consumer', fence, target: { kind: 'terminal-run', runId }, afterByte: 0, view: 'terminal' }, event => { outputs[runId]!.push(event) }, {})
      await sub.start?.(); subscriptions.push(sub)
    }
    const oversized = new Uint8Array(AGENTMUX_HOSTED_TRANSFER_MAX_BYTES)
    publish({ type: 'terminal-output', run: { runId: 'first' }, data: '', dataBytes: oversized,
      evidence: { source: 'terminal-output', observedAt: 1, run: { runId: 'first' }, outputByteRange: { startByte: 0, endByte: oversized.byteLength } } })
    await new Promise(resolve => setImmediate(resolve))
    expect(outputs.first!.filter(event => event.type === 'error'), 'serialization failure must terminate its exact reader visibly').toEqual([{ type: 'error', error: {
      code: 'RUNTIME_READER_BUDGET_EXCEEDED', message: 'This observation exceeds its reader budget; the original Run remains live.' } }])
    expect(released).toEqual(['first'])
    expect(outputs.other).toHaveLength(1); expect(outputs.semantic).toHaveLength(1)
    publish({ type: 'terminal-output', run: { runId: 'other' }, data: 'a', dataBytes: new Uint8Array([97]),
      evidence: { source: 'terminal-output', observedAt: 1, run: { runId: 'other' }, outputByteRange: { startByte: 0, endByte: 1 } } })
    await new Promise(resolve => setImmediate(resolve))
    expect(outputs.other).toHaveLength(2); expect(outputs.semantic).toHaveLength(1)
    for (const sub of subscriptions) await sub.dispose()
    await semantic.dispose(); await service.dispose()
  })
  it('does work only for the matching Run consumers and shares one Core event listener', async () => {
    const { AgentMuxHostedRuntimeService } = await testRuntimeService()
    let publish!: (event: AgentMuxClientEvent) => void, listeners = 0
    const released: string[] = [], output: Record<string, unknown[]> = {}
    const attachment = (runId: string) => ({ run: { runId, latestOutputBytes: 0 }, replay: [], gap: null })
    const core = { onEvent(listener: typeof publish) { listeners++; publish = listener; return () => {} },
      catalog: () => [{ id: 'fixture-provider' }], agentSessions: () => [],
      runtimeIdentity: () => owner.ctxmux, agentMessageQueuePath: () => upstreamFixturePath("original/messages"),
      refreshRunAttachment: async (run: { runId: string }) => attachment(run.runId), readRunReplay: async (run: { runId: string }) => attachment(run.runId),
      releaseRunAttachment: async (run: { runId: string }) => { released.push(run.runId) } }
    const owner = { runtimeId: 'semantic-owner', ownerInstanceId: 'semantic-epoch', protocolVersion: 1, processId: process.pid, availability: 'connected',
      ctxmux: { hostId: 'local', instanceId: 'ctxmux-epoch', processId: process.pid, buildIdentity: 'fixture-sdk', protocolVersion: 1 } } satisfies AgentMuxRuntimeOwnerIdentity
    const service = new AgentMuxHostedRuntimeService(core as unknown as import('../src/client.js').AgentMuxClient, null, () => owner)
    const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
    const subscriptions = []
    const semantic: unknown[] = [], semanticTransfer = new AgentMuxHostedTransferReader()
    const sub = await service.subscribe('runtime.events', { consumerId: 'indexed-consumer', fence }, event => {
      if (event.type === 'snapshot') { const value = semanticTransfer.accept(event.data); if (value) semantic.push(value) }
    }, {})
    await sub.start?.()
    for (let index = 0; index < 8; index++) {
      const runId = index === 0 ? 'run-a' : 'run-b', key = String(index)
      output[key] = []; const transfer = new AgentMuxHostedTransferReader()
      const sub = await service.subscribe('runtime.attachment-watch', { consumerId: 'indexed-consumer', fence, target: { kind: 'terminal-run', runId }, afterByte: 0, view: 'terminal' }, event => {
        if (event.type === 'snapshot') { const value = transfer.accept(event.data); if (value) output[key]!.push(value) }
      }, {})
      await sub.start?.(); subscriptions.push(sub)
    }
    expect(listeners).toBe(1)
    type IndexedReader = { enqueue(chunks: unknown): void }
    const index = service as unknown as { runs: Map<string, { readers: Set<IndexedReader> }>; consumers: Map<string, unknown> }
    expect([...index.runs.values()].map(run => run.readers.size)).toEqual([1, 7])
    expect(index.consumers.size).toBe(1)
    let delivered = 0
    for (const run of index.runs.values()) for (const reader of run.readers) {
      const enqueue = reader.enqueue.bind(reader)
      reader.enqueue = chunks => { delivered++; enqueue(chunks) }
    }
    const event = (runId: string): AgentMuxClientEvent => ({ type: 'terminal-output', run: { runId }, data: 'a', dataBytes: new Uint8Array([97]),
      evidence: { source: 'terminal-output', observedAt: 1, run: { runId }, outputByteRange: { startByte: 0, endByte: 1 } } })
    for (let index = 0; index < 100; index++) publish(event(`unrelated-${index}`))
    expect(delivered).toBe(0)
    publish(event('run-a')); expect(delivered).toBe(1)
    publish(event('run-b')); expect(delivered).toBe(8)
    await new Promise(resolve => setImmediate(resolve))
    expect(Object.values(output).map(values => values.length)).toEqual([2, 2, 2, 2, 2, 2, 2, 2])
    expect(semantic).toHaveLength(1)
    await subscriptions[1]!.dispose(); expect(released).toEqual([])
    for (const subscription of subscriptions) await subscription.dispose()
    expect(released.sort()).toEqual(['run-a', 'run-b'])
    await sub.dispose(); await service.dispose()
  })

  it('keeps snapshot and a mutation before stream start in one ordered cut', async () => {
    const { AgentMuxHostedRuntimeService } = await testRuntimeService()
    let publish!: (event: AgentMuxClientEvent) => void
    const session = { agentSessionId: 'session', run: { runId: 'original' }, workspacePath: upstreamFixturePath("original"), updatedAt: 1 }
    const core = { onEvent(listener: typeof publish) { publish = listener; return () => {} },
      catalog: () => [{ id: 'fixture-provider' }], agentSessions: () => [session],
      runtimeIdentity: () => owner.ctxmux, agentMessageQueuePath: () => upstreamFixturePath("original/messages") }
    const owner = { runtimeId: 'semantic-owner', ownerInstanceId: 'semantic-epoch', protocolVersion: 1, processId: process.pid, availability: 'connected',
      ctxmux: { hostId: 'local', instanceId: 'ctxmux-epoch', processId: process.pid, buildIdentity: 'fixture-sdk', protocolVersion: 1 } } satisfies AgentMuxRuntimeOwnerIdentity
    const service = new AgentMuxHostedRuntimeService(core as unknown as import('../src/client.js').AgentMuxClient, null, () => owner)
    const values: unknown[] = [], transfer = new AgentMuxHostedTransferReader()
    const sub = await service.subscribe('runtime.events', { consumerId: 'snapshot-consumer', fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } }, event => {
      if (event.type === 'snapshot') { const value = transfer.accept(event.data); if (value) values.push(value) }
    }, {})
    session.workspacePath = upstreamFixturePath("mutated"); session.updatedAt = 2
    publish({ type: 'agent-session', session: session as import('../src/types.js').AgentMuxAgentSession })
    expect(values).toEqual([])
    await sub.start?.()
    expect(values).toHaveLength(2)
    expect(values[0]).toMatchObject({ kind: 'initial', value: { sessions: [{ workspacePath: upstreamFixturePath("original"), updatedAt: 1 }] } })
    expect(values[1]).toMatchObject({ kind: 'event', event: { type: 'agent-session', session: { workspacePath: upstreamFixturePath("mutated"), updatedAt: 2 } } })
    await sub.dispose(); await service.dispose()
  })
})
