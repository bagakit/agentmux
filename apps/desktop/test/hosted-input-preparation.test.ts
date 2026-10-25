import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import type { AppConfig, SessionControl } from '../src/shared/contracts.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import type { AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract.js'
import { connectDesktopAgentMuxHost } from '../src/main/desktop-host.js'

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
  const calls: string[] = []
  let discoveryError: Error | undefined
  let discoveryBarrier: ReturnType<typeof deferred> | undefined
  const port: AgentMuxHostedRpcPort = { subscribe: rpc.subscribe.bind(rpc), call: async (method, params, options) => {
    calls.push(method === 'runtime.invoke' ? (params as { invocation: { method: string } }).invocation.method : method)
    if (method === 'runtime.owner.identity' && discoveryBarrier) await discoveryBarrier.promise
    if (method === 'runtime.owner.identity' && discoveryError) throw discoveryError
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
  return { ...f, core: f.client, server, owner, client, controller, terminal, agent, calls, config, prepares: () => prepares,
    discoveryFails: (error?: Error) => { discoveryError = error },
    holdDiscovery: () => (discoveryBarrier = deferred()),
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
  const outcomes = Promise.allSettled([f.controller.write(f.terminal, 'a', 'user'), f.controller.write(f.terminal, 'b', 'user')])
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
  const result = Promise.allSettled([f.controller.write(f.terminal, 'a', 'user'), f.controller.write(f.terminal, 'b', 'user')])
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

it('admits each Main Hosted Agent input with one owner read and one original invocation', async () => {
  const f = await fixture()
  await f.client.connect(); f.client.disconnect(); f.calls.length = 0
  await f.controller.write(f.agent, 'a', 'user')
  await f.controller.paste(f.agent, 'b', 'b')
  await f.controller.write(f.agent, '\u001b[<64;1;1M', 'user')
  const writes = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>).mock.calls
  expect(writes.map(([, input]) => input.data)).toEqual(['a', '\u001b[200~b\u001b[201~', '\u001b[<64;1;1M'])
  expect(writes.map(([, input]) => input.expectedByte)).toEqual([0, 1, 14])
  expect(new Set(writes.map(([, input]) => input.operationId)).size).toBe(3)
  expect(f.calls, 'Main Hosted Agent input must not add an explicit Native preparation round trip').toEqual([
    'runtime.owner.identity', 'writeAgent', 'runtime.owner.identity', 'pasteAgent', 'runtime.owner.identity', 'writeAgent'
  ])
})

it('discovers a replaced original Host and cold Native on the first Agent input without an observation stream', async () => {
  const f = await fixture()
  await f.client.connect(); f.client.disconnect()
  await f.controller.write(f.agent, 'first', 'user')
  f.cold(); f.owner.ownerInstanceId = 'replacement-host'
  f.inner.kernel.identity = () => ({ daemonInstanceId: 'replacement-native', protocolVersion: 1, buildIdentity: 'fixture' })
  await f.controller.paste(f.agent, 'next', 'next')
  expect(f.inner.kernel.connect).toHaveBeenCalledOnce()
  expect(f.client.runtimeOwnerIdentity()).toMatchObject({ ownerInstanceId: 'replacement-host', ctxmux: null })
  // Main has no fresh Native observation here. Host execution still owns its
  // real current identity and must accept the input, not require a second probe.
  const writes = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>).mock.calls
  expect(writes).toHaveLength(2)
  expect(writes[1]?.[1]).toMatchObject({ data: '\u001b[200~next\u001b[201~', expectedByte: 5, ownerInstanceId: 'replacement-native' })
  await expect(f.controller.write({ ...f.agent, run: { runId: 'foreign' } }, 'wrong', 'user')).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  f.owner.runtimeId = 'foreign-runtime'
  await expect(f.controller.write(f.agent, 'wrong owner', 'user')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(writes).toHaveLength(2); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not reuse a failed Agent owner read and preserves a fresh explicit input', async () => {
  const f = await fixture()
  await f.client.connect(); f.client.disconnect()
  f.discoveryFails(new Error('Original Host observation unavailable'))
  await expect(f.controller.write(f.agent, 'not admitted', 'user')).rejects.toThrow('Original Host observation unavailable')
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(f.controller.endpointWarningSnapshot()).toContainEqual(expect.objectContaining({ hostId: 'local', step: 'Confirming input Host',
    availability: 'unverified', message: 'Original Host observation unavailable', recovery: expect.stringContaining('original Session') }))
  f.discoveryFails(); await f.controller.write(f.agent, 'fresh', 'user')
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect(f.controller.endpointWarningSnapshot()).toEqual([])
  await expect(f.controller.write({ ...f.agent, run: { runId: 'stale' } }, 'wrong', 'user')).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(f.controller.endpointWarningSnapshot()).toEqual([])
  const input = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>)
  const accept = input.getMockImplementation()!
  input.mockImplementationOnce(async (...args) => { await accept(...args); throw new Error('Original Agent acknowledgement lost') })
  await expect(f.controller.write(f.agent, 'accepted', 'user')).rejects.toThrow('Original Agent acknowledgement lost')
  await f.controller.write(f.agent, 'later', 'user')
  expect(input.mock.calls.map(([, op]) => [op.data, op.expectedByte])).toEqual([['fresh', 0], ['accepted', 5], ['later', 13]])
})

it('shares cold Native preparation at the Host and preserves each overlapping Agent input', async () => {
  const f = await fixture(), barrier = deferred()
  await f.client.connect(); f.client.disconnect(); f.cold(); f.calls.length = 0
  const original = f.inner.kernel.connect as () => Promise<void>
  f.inner.kernel.connect = vi.fn(async () => { await barrier.promise; await original() })
  const writes = Promise.all([f.controller.write(f.agent, 'a', 'user'), f.controller.paste(f.agent, 'b', 'b')])
  await vi.waitFor(() => expect(f.inner.kernel.connect).toHaveBeenCalledOnce())
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  barrier.resolve(); await writes
  const inputs = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>).mock.calls
  expect(inputs.map(([, op]) => [op.data, op.expectedByte])).toEqual([['a', 0], ['\u001b[200~b\u001b[201~', 1]])
  expect(f.calls.filter(value => value === 'connectRuntime')).toEqual([])
})

it('keeps a later failed Host observation visible when an earlier input acknowledgement arrives', async () => {
  const f = await fixture(), barrier = deferred()
  await f.client.connect(); f.client.disconnect()
  const input = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>)
  const original = input.getMockImplementation()!
  input.mockImplementationOnce(async (...args) => { const receipt = await original(...args); await barrier.promise; return receipt })
  const first = f.controller.write(f.agent, 'accepted', 'user')
  await vi.waitFor(() => expect(input).toHaveBeenCalledOnce())
  f.discoveryFails(new Error('Later Host observation unavailable'))
  await expect(f.controller.write(f.agent, 'not admitted', 'user')).rejects.toThrow('Later Host observation unavailable')
  barrier.resolve(); await first
  expect(f.controller.endpointWarningSnapshot(), 'An earlier ACK must not clear a newer unconfirmed Host observation').toContainEqual(
    expect.objectContaining({ step: 'Confirming input Host', message: 'Later Host observation unavailable' }))
  f.discoveryFails(); await f.controller.write(f.agent, 'fresh', 'user')
  expect(f.controller.endpointWarningSnapshot()).toEqual([])
  expect(input.mock.calls.map(([, op]) => [op.data, op.expectedByte])).toEqual([['accepted', 0], ['fresh', 8]])
})

it('disposal during original owner discovery cannot admit Agent input later', async () => {
  const f = await fixture()
  await f.client.connect(); f.client.disconnect(); f.calls.length = 0
  const barrier = f.holdDiscovery(), result = f.controller.write(f.agent, 'original', 'user').catch(error => error)
  await vi.waitFor(() => expect(f.calls).toEqual(['runtime.owner.identity']))
  await f.client.dispose(); barrier.resolve()
  expect(await result).toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('disposal after Agent admission retains an unknown outcome and never replays the input', async () => {
  const f = await fixture(), barrier = deferred()
  await f.client.connect(); f.client.disconnect(); f.cold()
  const original = f.inner.kernel.connect as () => Promise<void>
  f.inner.kernel.connect = vi.fn(async () => { await barrier.promise; await original() })
  const result = f.controller.write(f.agent, 'original', 'user').catch(error => error)
  await vi.waitFor(() => expect(f.inner.kernel.connect).toHaveBeenCalledOnce())
  await f.client.dispose(); barrier.resolve()
  expect(await result).toMatchObject({ code: 'CONTROL_CANCELLED', controlFailure: { disposition: 'unknown' } })
  // Reader disposal is not an undo of an admitted business invocation. The
  // shared server channel may still finish that original authorized request.
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  await expect(f.controller.write(f.agent, 'later', 'user')).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  expect(f.inner.kernel.input).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('retains original Main preparation for a directly injected Core client', async () => {
  const f = await fixture(), prepare = vi.spyOn(f.core, 'connectRuntime')
  const controller = new RuntimeController(f.store, async () => f.core)
  controller.commit(await controller.prepare(f.config)); cleanups.push(() => controller.dispose())
  prepare.mockClear()
  await controller.write(f.agent, 'direct', 'user')
  expect(prepare).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
})

it('uses the same first-input admission through the actual Desktop SSH connector and stdio channel', async () => {
  const f = await fixture(), log = join(f.root, 'ssh-process')
  // A private stdio carrier replaces only the system SSH executable. Actual
  // Desktop connector, SSH transport framing, Hosted SDK and Unix Host execute;
  // this does not qualify network authentication or a real remote machine.
  await writeFile(join(f.root, 'ssh'), `#!${process.execPath}\n` +
    `const net=require('node:net'),fs=require('node:fs');fs.writeFileSync(${JSON.stringify(log)},String(process.pid));` +
    `const socket=net.createConnection(${JSON.stringify(f.server.path)},()=>process.stdin.pipe(socket).pipe(process.stdout));` +
    `socket.on('error',()=>process.exit(1));socket.on('close',()=>process.exit(0));\n`, { mode: 0o700 })
  vi.stubEnv('PATH', f.root + ':' + process.env.PATH)
  const config: AppConfig = { ...f.config, hosts: [{ id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.invalid',
    runtimeId: f.owner.runtimeId, remoteSocketPath: f.server.path }] }
  const client = await connectDesktopAgentMuxHost(config.hosts[0]!, f.store)
  const controller = new RuntimeController(f.store, async () => client)
  controller.commit(await controller.prepare(config)); cleanups.push(() => controller.dispose())
  await client.connect(); client.disconnect(); f.cold()
  const agent = { ...f.agent, hostId: 'remote' }
  await controller.write(agent, 'remote-first', 'user')
  f.owner.ownerInstanceId = 'replacement-remote-host'
  await controller.paste(agent, 'remote-next', 'remote-next')
  const writes = vi.mocked(f.inner.kernel.input as (...args: any[]) => Promise<unknown>).mock.calls
  expect(writes.map(([, op]) => [op.data, op.expectedByte])).toEqual([
    ['remote-first', 0], ['\u001b[200~remote-next\u001b[201~', 12]
  ])
  expect('runtimeOwnerIdentity' in client && client.runtimeOwnerIdentity()).toMatchObject({ runtimeId: f.owner.runtimeId, ownerInstanceId: 'replacement-remote-host' })
  const pid = Number(await readFile(log, 'utf8'))
  await controller.dispose()
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
