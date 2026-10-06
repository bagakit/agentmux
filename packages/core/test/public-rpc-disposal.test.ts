import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxClient } from '../src/client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import type { AgentMuxRunAttachment } from '../src/types.js'
const { connectAgentMuxRpc } = await import(process.env.AGENTMUX_TEST_RPC_ENTRY ?? '../dist/public-rpc-client.js') as typeof import('../src/public-rpc-client.js')
const { connectHostedAgentMux } = await import(process.env.AGENTMUX_TEST_CLIENT_ENTRY ?? '../dist/hosted-client.js') as typeof import('../src/hosted-client.js')
const { AgentMuxHostedRuntimeService } = await import(process.env.AGENTMUX_TEST_SERVICE_ENTRY ?? '../dist/hosted-runtime-service.js') as typeof import('../src/hosted-runtime-service.js')
const { AgentMuxControlServer } = await import('../dist/public-rpc-server.js') as typeof import('../src/public-rpc-server.js')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function unixHost() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-dispose-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const attachment: AgentMuxRunAttachment = { run: { nativeService: null,
    runId: 'original-run', kind: 'terminal', providerId: null, executorId: null, agentSessionId: null,
    workspacePath: directory, pid: 421, state: 'running', cols: 80, rows: 24,
    observedAt: reshapeFixtureEpoch(0, 0, 1), latestOutputBytes: 0, acceptedInputBytes: 0 }, replay: [], gap: null,
    terminal: { type: 'not-requested' }, resizeRevision: 0 }
  const retained = new Map<string, typeof attachment.run>()
  const core = {
    connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}),
    onEvent: vi.fn(() => () => {}), catalog: () => [], agentSessions: () => [], readAgentSessions: async () => [],
    metadata: { pendingIds: () => [] },
    runtimeIdentity: () => ({ hostId: 'local', instanceId: 'original-daemon', buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123, ownership: 'owned' as const }),
    agentMessageQueuePath: () => join(directory, 'messages.ndjson'),
    runtimeProjection: vi.fn(async () => ({ hostId: 'local', subjects: [] })),
    listRuns: vi.fn(async () => [...retained.values()]),
    createTerminal: vi.fn(async (_input: { createOperationId?: string }) => attachment.run),
    refreshRunAttachment: vi.fn(async () => attachment), readRunReplay: vi.fn(async () => attachment),
    releaseRunAttachment: vi.fn(async () => {}), stopTerminal: vi.fn(async () => {})
  }
  const service = new AgentMuxHostedRuntimeService(core as unknown as AgentMuxClient, join(directory, 'sessions.json'), () => hostedTestOwner(core as unknown as AgentMuxClient))
  const consumerIds = new Set<string>(), settledSubscriptions = new Map<string, number>(), closedSubscriptions = new Map<string, number>()
  const remember = (params: unknown) => {
    const consumerId = (params as { consumerId?: string }).consumerId
    if (consumerId) consumerIds.add(consumerId)
  }
  const hosted = {
    assertFence: service.assertFence.bind(service),
    call: async (...args: Parameters<typeof service.call>) => { remember(args[1]); return await service.call(...args) },
    subscribe: async (...args: Parameters<typeof service.subscribe>) => {
      remember(args[1])
      try {
        const watch = await service.subscribe(...args)
        return { ...watch, dispose: async () => {
          await watch.dispose()
          closedSubscriptions.set(args[0], (closedSubscriptions.get(args[0]) ?? 0) + 1)
        } }
      } finally { settledSubscriptions.set(args[0], (settledSubscriptions.get(args[0]) ?? 0) + 1) }
    }
  }
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'rpc.sock'), hostedRuntime: () => hosted })
  await server.start()
  cleanup.push(async () => { await server.stop(); await service.dispose() })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => rpc.dispose())
  return { core, service, rpc, attachment, retained, consumerIds, settledSubscriptions, closedSubscriptions }
}

describe('consumer reply cancellation through the real public transport', () => {
  it('cancels a transport opening before acquisition and releases its exact late reader', async () => {
    const opening = deferred<Response>(), cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => await opening.promise)
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: 'http://127.0.0.1:1/', token: 'private-disposal-fixture' } })
    cleanup.push(() => rpc.dispose())
    let settled = false
    const reply = rpc.call('runtime.owner.identity', {}).catch(error => error).finally(() => { settled = true })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    await rpc.dispose()
    await vi.waitFor(() => expect(settled, 'cancellation settles before the transport acquires its late handle').toBe(true))
    expect(await reply).toMatchObject({ code: 'CONTROL_CANCELLED' })
    opening.resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } }))
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('ends the GUI reply wait while the original admitted business operation completes once', async () => {
    const f = await unixHost(), admitted = deferred<void>(), receipt = deferred<void>()
    f.core.createTerminal.mockImplementationOnce(async input => {
      admitted.resolve(); await receipt.promise
      f.retained.set(input.createOperationId!, f.attachment.run)
      return f.attachment.run
    })
    const first = await connectHostedAgentMux({ rpc: f.rpc, consumerId: 'consumer-original' })
    const events = vi.fn(); first.onEvent(events)
    let settled = false
    const reply = first.createTerminal({ createOperationId: 'original-create', workspacePath: f.attachment.run.workspacePath }).catch(error => error).finally(() => { settled = true })
    await admitted.promise
    await first.dispose()
    await vi.waitFor(() => expect(settled, 'consumer exit ends its reply wait before the owner returns a business receipt').toBe(true))
    expect(await reply).toMatchObject({ code: 'CONTROL_CANCELLED', controlFailure: { disposition: 'unknown', confirmedInputBytes: null } })
    expect(f.consumerIds.size).toBe(1)
    const firstConsumerId = [...f.consumerIds][0]!
    const callsAfterExit = events.mock.calls.length
    expect(f.core.createTerminal).toHaveBeenCalledExactlyOnceWith({ createOperationId: 'original-create', workspacePath: f.attachment.run.workspacePath })
    expect(f.retained.size).toBe(0)
    const second = await connectHostedAgentMux({ rpc: f.rpc, consumerId: 'consumer-reconnected' })
    try {
      receipt.resolve()
      await vi.waitFor(() => expect(f.retained.get('original-create')?.runId).toBe('original-run'))
      expect(await second.listRuns()).toEqual([f.attachment.run])
      expect(events).toHaveBeenCalledTimes(callsAfterExit)
      expect(f.core.createTerminal).toHaveBeenCalledOnce()
      expect(f.core.stopTerminal).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(f.closedSubscriptions.get('runtime.events')).toBe(1))
      expect(await f.service.releaseConsumer(firstConsumerId)).toBe(false)
    } finally { receipt.resolve(); await second.dispose() }
  })

  it('prunes a cancelled attachment opening before its late Native acquisition and retains exact cleanup', async () => {
    const f = await unixHost(), admitted = deferred<void>(), opening = deferred<AgentMuxRunAttachment>()
    f.core.refreshRunAttachment.mockImplementationOnce(async () => { admitted.resolve(); return await opening.promise })
    const first = await connectHostedAgentMux({ rpc: f.rpc, consumerId: 'consumer-opening', waitForReady: false })
    const events = vi.fn(); first.onEvent(events)
    const reply = first.attachTerminal('original-run').catch(error => error)
    await admitted.promise
    await first.dispose()
    expect(await reply).toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(f.consumerIds.size).toBe(1)
    const firstConsumerId = [...f.consumerIds][0]!
    await vi.waitFor(() => expect(f.settledSubscriptions.get('runtime.attachment-watch')).toBe(1))
    expect(await f.service.releaseConsumer(firstConsumerId)).toBe(false)
    expect(f.core.releaseRunAttachment).not.toHaveBeenCalled()
    const callsAfterExit = events.mock.calls.length
    opening.resolve(f.attachment)
    await vi.waitFor(() => expect(f.core.releaseRunAttachment).toHaveBeenCalledExactlyOnceWith({ runId: 'original-run' }))
    const second = await connectHostedAgentMux({ rpc: f.rpc, consumerId: 'consumer-next', waitForReady: false })
    try {
      expect((await second.attachTerminal('original-run')).run.runId).toBe('original-run')
      expect(f.core.refreshRunAttachment).toHaveBeenCalledTimes(2)
      expect(events).toHaveBeenCalledTimes(callsAfterExit)
      expect(f.core.stopTerminal).not.toHaveBeenCalled()
    } finally { await second.dispose() }
    await vi.waitFor(() => expect(f.core.releaseRunAttachment).toHaveBeenCalledTimes(2))
    expect(f.consumerIds.size).toBe(2)
    await vi.waitFor(() => expect(f.closedSubscriptions.get('runtime.attachment-watch')).toBe(1))
    expect(await f.service.releaseConsumer([...f.consumerIds][1]!)).toBe(false)
  })
})
