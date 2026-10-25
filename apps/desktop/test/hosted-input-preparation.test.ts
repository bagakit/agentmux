import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { AppConfig, SessionControl } from '../src/shared/contracts.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import type { AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract.js'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, nativeImage: {} }))
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function fixture() {
  const f = await rpcOwnerFixture(['original'])
  cleanups.push(() => f.close())
  f.inner.kernel.list = async () => [f.run('shell'), f.run('run-original')]
  const owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-host', protocolVersion: 2 as const,
    processId: process.pid, availability: 'connected' as const, ctxmux: f.client.runtimeIdentity() }
  let nativeConnected = true
  f.inner.kernel.isConnected = () => nativeConnected
  f.inner.kernel.connect = vi.fn(async () => { nativeConnected = true })
  const service = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => ({ ...owner,
    ctxmux: nativeConnected ? f.client.runtimeIdentity() : null }))
  cleanups.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'consumer.sock'),
    coreClients: f.coreClients, hostedRuntime: () => service })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(() => rpc.dispose())
  const originalCall: AgentMuxHostedRpcPort['call'] = rpc.call.bind(rpc)
  let prepares = 0, held: ReturnType<typeof deferred> | undefined
  const port: AgentMuxHostedRpcPort = { subscribe: rpc.subscribe.bind(rpc), call: async (method, params, options) => {
    if (method === 'runtime.invoke' && (params as { invocation?: { method: string } }).invocation?.method === 'connectRuntime') {
      prepares++; const barrier = held; if (barrier) await barrier.promise
    }
    return await originalCall(method, params, options)
  } }
  const client = await connectHostedAgentMux({ rpc: port })
  cleanups.push(() => client.dispose())
  const controller = new RuntimeController(f.store, async () => client)
  const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {
      selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  controller.commit(await controller.prepare(config))
  cleanups.push(() => controller.dispose())
  const terminal: SessionControl = { kind: 'terminal', hostId: 'local', runId: 'shell', run: { runId: 'shell' } }
  const agent: SessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'original', run: { runId: 'run-original' } }
  return { ...f, owner, client, controller, terminal, agent, prepares: () => prepares,
    cold: () => { nativeConnected = false },
    hold: () => (held = deferred()), release: () => { const current = held; held = undefined; current?.resolve() } }
}

it('shares overlapping Main preparation over public RPC while preserving every ordered input and fresh later preparation', async () => {
  const f = await fixture(), barrier = f.hold()
  const inputs = [f.controller.write(f.terminal, 'a', 'user'), f.controller.paste(f.terminal, 'b', 'b'),
    f.controller.write(f.agent, 'c', 'user'), f.controller.paste(f.agent, 'd', 'd')]
  await vi.waitFor(() => expect(f.prepares()).toBeGreaterThan(0))
  // A metadata read reaches the real Store while Native preparation is held.
  expect((await f.client.readAgentSession('original'))?.agentSessionId).toBe('original')
  const cohortPrepares = f.prepares()
  barrier.resolve(); await Promise.all(inputs); f.release()
  const writes = vi.mocked(f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>).mock.calls
  expect(writes).toHaveLength(4)
  expect(writes.filter(([run]) => run === 'shell').map(([, input]) => (input as { data: string }).data)).toEqual(['a', 'b'])
  expect(writes.filter(([run]) => run === 'run-original').map(([, input]) => (input as { data: string }).data)).toEqual(['c', '\u001b[200~d\u001b[201~'])
  expect(writes.filter(([run]) => run === 'shell').map(([, input]) => (input as { expectedByte: number }).expectedByte)).toEqual([0, 1])
  expect(writes.filter(([run]) => run === 'run-original').map(([, input]) => (input as { expectedByte: number }).expectedByte)).toEqual([0, 1])
  expect(cohortPrepares).toBe(1)
  await f.controller.write(f.terminal, 'e', 'user')
  expect(f.prepares()).toBe(2)
})

it('shares an original preparation failure without input replay and permits an explicit fresh attempt', async () => {
  const f = await fixture(), barrier = f.hold()
  const outcomes = Promise.allSettled([f.controller.write(f.terminal, 'a', 'user'), f.controller.write(f.agent, 'b', 'user')])
  await vi.waitFor(() => expect(f.prepares()).toBe(1))
  barrier.reject(new Error('Original preparation failed'))
  expect((await outcomes).map(result => result.status)).toEqual(['rejected', 'rejected'])
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  f.release(); await f.controller.write(f.terminal, 'fresh', 'user')
  expect(f.prepares()).toBe(2); expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('does not let old cleanup clear a newer preparation after disconnect', async () => {
  const f = await fixture(), oldBarrier = f.hold(), old = f.client.connectRuntime()
  await vi.waitFor(() => expect(f.prepares()).toBe(1))
  f.client.disconnect()
  const newBarrier = f.hold(), next = f.client.connectRuntime()
  await vi.waitFor(() => expect(f.prepares()).toBe(2))
  oldBarrier.resolve(); await old
  const joined = f.client.connectRuntime()
  // Metadata discovery gives the joiner a turn without a timing-only sleep.
  await f.client.readAgentSession('original')
  const count = f.prepares(); newBarrier.resolve(); await Promise.all([next, joined])
  expect(count).toBe(2); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('disposal cancels the shared consumer without reviving input on a late preparation', async () => {
  const f = await fixture(), barrier = f.hold()
  const result = Promise.allSettled([f.controller.write(f.terminal, 'a', 'user'), f.controller.write(f.agent, 'b', 'user')])
  await vi.waitFor(() => expect(f.prepares()).toBe(1))
  await f.client.dispose(); barrier.resolve()
  expect((await result).map(value => value.status)).toEqual(['rejected', 'rejected'])
  await expect(f.client.connectRuntime()).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps cold Native and changed Host preparation before the first exact Main input', async () => {
  const f = await fixture()
  f.cold(); f.owner.ownerInstanceId = 'replacement-host'
  f.inner.kernel.identity = () => ({ daemonInstanceId: 'replacement-native', protocolVersion: 1, buildIdentity: 'fixture' })
  await f.controller.write(f.terminal, 'original bytes', 'user')
  expect(f.inner.kernel.connect).toHaveBeenCalledOnce()
  expect(f.client.runtimeOwnerIdentity()).toMatchObject({ ownerInstanceId: 'replacement-host', ctxmux: { instanceId: 'replacement-native' } })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(vi.mocked(f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>).mock.calls[0]?.[1]).toMatchObject({ expectedByte: 0, data: 'original bytes' })
  await expect(f.controller.write({ ...f.agent, run: { runId: 'foreign-run' } }, 'wrong target', 'user')).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('does not resend accepted bytes when their original acknowledgement is lost', async () => {
  const f = await fixture()
  const input = vi.mocked(f.inner.kernel.input as (...args: unknown[]) => Promise<unknown>)
  const accept = input.getMockImplementation()!
  input.mockImplementationOnce(async (...args) => { await accept(...args); throw new Error('Original acknowledgement lost') })
  await expect(f.controller.write(f.terminal, 'first', 'user')).rejects.toThrow('Original acknowledgement lost')
  expect(input).toHaveBeenCalledOnce()
  await f.controller.write(f.terminal, 'next', 'user')
  expect(input).toHaveBeenCalledTimes(2)
  expect(input.mock.calls[1]?.[1]).toMatchObject({ expectedByte: 5, data: 'next' })
})
