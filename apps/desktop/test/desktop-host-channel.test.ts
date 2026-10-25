import { join } from 'node:path'
import { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import type { RpcForwardingAuthority } from '../../../packages/core/src/rpc-forwarding.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { connectDesktopAgentMuxHost, callOriginalDesktopHost, subscribeOriginalDesktopHost } from '../src/main/desktop-host.js'
import type { AppConfig, SessionControl } from '../src/shared/contracts.js'

const platform = vi.hoisted(() => ({ probes: 0, start: undefined as undefined | (() => Promise<unknown>) }))
vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, nativeImage: {} }))
vi.mock('@agentmux/core', async original => {
  const core = await original<typeof import('@agentmux/core')>()
  return { ...core, probeSocketLiveness: async (...args: Parameters<typeof core.probeSocketLiveness>) => {
    platform.probes++; return await core.probeSocketLiveness(...args)
  } }
})
// The platform launcher is the boundary of this private consumer. No launchctl,
// production socket or real Agent process is used by the test.
vi.mock('@agentmux/host/macos-service', () => ({ macosHostService: (value: unknown) => value,
  ensureMacosHostService: async () => await platform.start!() }))
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  platform.probes = 0; platform.start = undefined; vi.restoreAllMocks(); vi.unstubAllEnvs()
})
const deferred = () => {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function fixture() {
  const f = await rpcOwnerFixture(['original']); cleanup.push(f.close)
  f.inner.kernel.list = async () => [f.run('shell'), f.run('run-original')]
  const socketPath = join(f.root, 'control.sock')
  const owner = { runtimeId: 'original-runtime', ownerInstanceId: 'original-host', protocolVersion: 2 as const,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' as const }
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => owner); cleanup.push(() => service.dispose())
  const appearances = new Set<(value: any) => void>()
  const server = new AgentMuxControlServer({ socketPath, coreClients: f.coreClients, hostedRuntime: () => service,
    forwardingPeer: { authoritySocketPath: socketPath },
    appearance: { subscribe: async receive => {
      appearances.add(receive)
      return { initial: { sourceId: 'appearance-owner', revision: 1, values: { theme: 'dark' }, issues: [] },
        start: () => {}, dispose: () => { appearances.delete(receive) } }
    } } })
  cleanup.push(() => server.stop())
  return { ...f, owner, server, socketPath, appearances }
}
async function desktop(f: Awaited<ReturnType<typeof fixture>>) {
  const client = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, f.store)
  const controller = new RuntimeController(f.store, async () => client)
  const config = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {}, workspaces: [],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true,
      devTools: true, viewport: true, saveBookmark: true, more: true } } } as AppConfig
  controller.commit(await controller.prepare(config)); cleanup.push(() => controller.dispose())
  const terminal: SessionControl = { kind: 'terminal', hostId: 'local', runId: 'shell', run: { runId: 'shell' } }
  const agent: SessionControl = { kind: 'agent', hostId: 'local', agentSessionId: 'original', run: { runId: 'run-original' } }
  return { client, controller, terminal, agent }
}

it('prepares the real Desktop channel once for cold startup and all warm input and reader consumers', async () => {
  const f = await fixture(), launch = vi.fn(async () => { await f.server.start(); return {} })
  platform.start = launch
  const d = await desktop(f)
  await d.controller.write(d.terminal, 'a', 'user')
  await d.controller.paste(d.terminal, 'b', 'b')
  await Promise.all([d.controller.write(d.agent, 'c', 'user'), d.controller.paste(d.agent, 'd', 'd')])
  await d.controller.write(d.terminal, 'e', 'terminal-protocol')
  const endpoint = await callOriginalDesktopHost(d.client, 'system.endpoint', {}, {})
  expect(endpoint.endpoint).toEqual({ transport: 'unix', path: f.socketPath })
  let initial: unknown
  const reader = await subscribeOriginalDesktopHost(d.client, 'settings.appearance.watch', {}, {
    onInitial: value => { initial = value }, onEvent: () => {}
  })
  expect(initial).toMatchObject({ observation: { sourceId: 'appearance-owner' } }); await reader.dispose()
  const writes = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>).mock.calls
  expect(writes.filter(([id]) => id === 'shell').map(([, op]) => [op.data, op.expectedByte])).toEqual([['a', 0], ['b', 1], ['e', 2]])
  expect(writes.filter(([id]) => id === 'run-original').map(([, op]) => [op.data, op.expectedByte])).toEqual([['c', 0], ['\u001b[200~d\u001b[201~', 1]])
  expect(new Set(writes.map(([, op]) => op.operationId)).size).toBe(5)
  expect(launch).toHaveBeenCalledOnce()
  expect(platform.probes, 'Warm business and reader calls must not probe a serving Unix channel again').toBe(1)
  await expect(d.controller.write({ ...d.agent, run: { runId: 'foreign' } }, 'wrong', 'user')).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(writes).toHaveLength(5)
})

it('shares held channel preparation, cancels one reader and prepares a new channel only after actual loss', async () => {
  const f = await fixture(); await f.server.start()
  const barrier = deferred(), prepare = vi.fn(async () => { await barrier.promise })
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath }, prepareUnixConnection: prepare })
  cleanup.push(() => rpc.dispose())
  const cancelled = new AbortController()
  const first = rpc.call('system.endpoint', {}, { signal: cancelled.signal }).catch(error => error)
  const second = rpc.call('system.endpoint', {})
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce())
  cancelled.abort(); expect(await first).toMatchObject({ code: 'CONTROL_CANCELLED', controlFailure: { disposition: 'not_applied' } })
  barrier.resolve(); expect((await second).endpoint).toEqual({ transport: 'unix', path: f.socketPath })
  await rpc.call('system.endpoint', {}); expect(prepare).toHaveBeenCalledOnce()
  const owner = (rpc as any).route.unix
  // Exact physical channel failure, not another caller's cancellation.
  owner.fail(new AgentMuxError('Private original channel closed', 'CONTROL_CONNECTION_FAILED'))
  await rpc.call('system.endpoint', {}); expect(prepare).toHaveBeenCalledTimes(2)
})

it('cannot open or dispatch after disposal during preparation, and a rejected preparation releases the channel', async () => {
  const f = await fixture(); await f.server.start()
  const connections = vi.spyOn(Socket.prototype, 'connect')
  const barrier = deferred(); let signal: AbortSignal | undefined
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath },
    prepareUnixConnection: async value => { signal = value; await barrier.promise } })
  const pending = rpc.call('system.endpoint', {}).catch(error => error)
  await vi.waitFor(() => expect(signal).toBeDefined())
  await rpc.dispose(); expect(await pending).toMatchObject({ code: 'CONTROL_CANCELLED' }); expect(signal!.aborted).toBe(true)
  barrier.resolve(); await new Promise<void>(resolve => setImmediate(resolve))
  expect((rpc as any).route.unix).toBeUndefined()
  expect(connections).not.toHaveBeenCalled()
  const prepare = vi.fn().mockRejectedValueOnce(new AgentMuxError('Original preparation failed', 'HOST_SERVICE_UNCONFIRMED')).mockResolvedValue(undefined)
  const next = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath }, prepareUnixConnection: prepare })
  cleanup.push(() => next.dispose())
  await expect(next.call('system.endpoint', {})).rejects.toMatchObject({ code: 'HOST_SERVICE_UNCONFIRMED', controlFailure: { disposition: 'not_applied' } })
  expect((await next.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: f.socketPath })
  expect(prepare).toHaveBeenCalledTimes(2)
})

it('prepares separate forwarded Unix connections while preserving their original authority and cancellation', async () => {
  const f = await fixture(), prepare = vi.fn(async () => { if (prepare.mock.calls.length === 1) await f.server.start() })
  const authority = (f.server as unknown as { forwarding: RpcForwardingAuthority }).forwarding
  const current = vi.fn(), forwarding = vi.fn((request, destination) => authority.lend({
    principal: { kind: 'device', id: 'original-device' }, assertCurrent: current
  }, request, destination))
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath }, prepareUnixConnection: prepare, forwarding })
  cleanup.push(() => rpc.dispose())
  for (let index = 0; index < 2; index++) expect((await rpc.call('system.endpoint', {})).endpoint).toEqual({ transport: 'unix', path: f.socketPath })
  expect(prepare).toHaveBeenCalledTimes(2); expect(forwarding).toHaveBeenCalledTimes(2); expect(current).toHaveBeenCalled()
  const barrier = deferred(); prepare.mockImplementationOnce(async () => { await barrier.promise })
  const abort = new AbortController(), pending = rpc.call('system.endpoint', {}, { signal: abort.signal }).catch(error => error)
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(3))
  abort.abort(); expect(await pending).toMatchObject({ code: 'CONTROL_CANCELLED', controlFailure: { disposition: 'not_applied' } })
  barrier.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); expect(forwarding).toHaveBeenCalledTimes(2)
  prepare.mockRejectedValueOnce(new AgentMuxError('Original preparation failed', 'HOST_SERVICE_UNCONFIRMED'))
  await expect(rpc.call('system.endpoint', {})).rejects.toMatchObject({ code: 'HOST_SERVICE_UNCONFIRMED', controlFailure: { disposition: 'not_applied' } })
  expect(forwarding).toHaveBeenCalledTimes(2)
  // Once forwarding starts, cancellation must not claim the original request
  // was certainly unwritten. Its original authenticated owner retains it.
  const authorityBarrier = deferred()
  forwarding.mockImplementationOnce(async (request, destination) => {
    await authorityBarrier.promise
    return authority.lend({ principal: { kind: 'device', id: 'original-device' }, assertCurrent: current }, request, destination)
  })
  const afterPreparation = new AbortController()
  const opened = rpc.call('system.endpoint', {}, { signal: afterPreparation.signal }).catch(error => error)
  await vi.waitFor(() => expect(forwarding).toHaveBeenCalledTimes(3))
  afterPreparation.abort(); expect(await opened).toMatchObject({ code: 'CONTROL_CANCELLED', controlFailure: { disposition: 'unknown' } })
  authorityBarrier.resolve()
})
