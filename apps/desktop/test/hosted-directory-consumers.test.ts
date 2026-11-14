import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../../../packages/core/src/errors.js'
import { observeRead } from '../../../packages/core/src/observation-read.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { AgentMuxHostedRuntimeService } from '../../../packages/core/src/hosted-runtime-service.js'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client.js'
import { connectHostedAgentMux } from '../../../packages/core/src/hosted-client.js'
import type { AgentMuxHostedClient, AgentMuxHostedRpcPort } from '../../../packages/core/src/hosted-client-contract.js'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { waitForDesktopHostConnection } from '../src/main/desktop-host.js'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getAppMetrics: () => [] }, nativeImage: {} }))
const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function config(hosts: HostConfig[]): AppConfig {
  return { version: 9, hosts, executors: {}, workspaces: [], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
}
async function fixture(runtimeId = 'original-runtime', ids = ['original']) {
  const f = await rpcOwnerFixture(ids)
  cleanups.push(f.close)
  f.inner.kernel.list = async () => [f.run('run-original')]
  const owner = { runtimeId, ownerInstanceId: 'original-owner', protocolVersion: 2 as const,
    processId: process.pid, availability: 'connected' as const, ctxmux: f.client.runtimeIdentity() }
  const service = new AgentMuxHostedRuntimeService(f.client, join(f.root, 'sessions.json'), () => owner)
  cleanups.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'directory.sock'), hostedRuntime: () => service,
    coreClients: f.coreClients })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanups.push(() => rpc.dispose())
  let directoryError: Error | undefined, identityError: Error | undefined
  const hold = deferred(), calls: string[] = []
  let directoryHeld = true
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => {
      calls.push('invocation' in params ? params.invocation.method : method)
      if (method === 'runtime.owner.identity' && identityError) throw identityError
      return await rpc.call(method, params, options)
    },
    subscribe: async (method, params, handlers) => {
      if (directoryError) throw directoryError
      if (directoryHeld) await observeRead(hold.promise, handlers.signal)
      return await rpc.subscribe(method, params, handlers)
    }
  }
  const clients: AgentMuxHostedClient[] = []
  const createClient = async () => {
    const client = await connectHostedAgentMux({ rpc: port, connectOnDemand: true, expectedRuntimeId: owner.runtimeId })
    clients.push(client); return client
  }
  cleanups.push(async () => { hold.resolve(); for (const client of clients) await client.dispose() })
  const client = await createClient()
  cleanups.push(() => {
    expect(f.rawInput).not.toHaveBeenCalled()
    expect(f.inner.kernel.input).not.toHaveBeenCalled()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })
  const controller = async (host: HostConfig = { id: 'local', kind: 'local', label: 'Local' }) => {
    let first = true
    const instance = new RuntimeController(f.store, async () => {
      if (first) { first = false; return client }
      return await createClient()
    })
    cleanups.push(() => instance.dispose())
    const current = config([host])
    instance.commit(await instance.prepare(current))
    return { controller: instance, config: current }
  }
  return { ...f, core: f.client, client, owner, calls, controller,
    release: () => { directoryHeld = false; hold.resolve() },
    failDirectory: (error?: Error) => { directoryError = error },
    failIdentity: (error?: Error) => { identityError = error } }
}

it('wakes the original launch waiter on directory ready after a failed opening', async () => {
  const f = await fixture(), abort = new AbortController()
  cleanups.push(() => abort.abort())
  f.failDirectory(new AgentMuxError('Original directory unavailable', 'DIRECTORY_UNAVAILABLE'))
  let outcome: string | undefined
  const waiting = waitForDesktopHostConnection(f.client, abort.signal)
    .then(() => { outcome = 'confirmed' }, () => { outcome = 'rejected' })
  await vi.waitFor(() => expect(f.client.sessionObservation().state).toBe('unavailable'))
  expect(outcome).toBeUndefined()
  f.failDirectory(); f.release()
  await f.client.connect()
  await vi.waitFor(() => expect(outcome, 'directory ready must wake the original launch waiter').toBe('confirmed'))
  await waiting
  expect(f.client.sessionObservation()).toMatchObject({ state: 'ready', hasSnapshot: true })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps a directory failure in its own service window while exact projection retains the original Session', async () => {
  const f = await fixture()
  await f.client.readRuntimeOwnerIdentity()
  f.failDirectory(new AgentMuxError('Original directory unavailable', 'DIRECTORY_UNAVAILABLE'))
  await expect(f.client.connect()).rejects.toMatchObject({ code: 'DIRECTORY_UNAVAILABLE' })
  const opening = vi.spyOn(f.client, 'connect')
  const { controller, config: current } = await f.controller()
  await vi.waitFor(() => expect(opening).toHaveBeenCalled())
  await expect(opening.mock.results[0]!.value).rejects.toMatchObject({ code: 'DIRECTORY_UNAVAILABLE' })
  await vi.waitFor(() => expect(f.client.sessionObservation().state).toBe('unavailable'))
  await vi.waitFor(() => expect(controller.endpointWarningSnapshot()).toContainEqual(expect.objectContaining({
    step: 'Reading Session directory', code: 'DIRECTORY_UNAVAILABLE', scope: 'observation', availability: 'connected' })))
  expect(controller.endpointWarningSnapshot().some(warning => warning.step === 'Core control connection')).toBe(false)
  const snapshot = await controller.snapshot(current)
  expect(snapshot.sessions).toContainEqual(expect.objectContaining({ control: expect.objectContaining({ agentSessionId: 'original' }) }))
  expect(f.client.agentSessions().map(session => session.agentSessionId)).toEqual(['original'])
  expect(f.client.sessionObservation()).toMatchObject({ state: 'unavailable', hasSnapshot: true })
  expect(controller.endpointWarningSnapshot()).toContainEqual(expect.objectContaining({ step: 'Reading Session directory' }))
  f.failDirectory(); f.release(); await f.client.connect()
  await vi.waitFor(() => expect(controller.endpointWarningSnapshot().some(warning => warning.step === 'Reading Session directory')).toBe(false))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['confirmed', 'unverified'] as const)('uses accurate caller ownership while its directory hint is unconfirmed and control is %s', async state => {
  const f = await fixture('original-runtime', ['original', 'unrelated'])
  await f.client.readRuntimeOwnerIdentity()
  const inventory = vi.spyOn(f.core, 'readAgentSessions').mockRejectedValue(new AgentMuxError('Unrelated inventory must not be read', 'UNRELATED_INVENTORY_UNAVAILABLE'))
  const metadata = vi.spyOn(f.core, 'readAgentSession')
  const { controller } = await f.controller({ id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.invalid', runtimeId: f.owner.runtimeId })
  if (state === 'unverified') {
    f.failIdentity(new AgentMuxError('Identity refresh is unconfirmed', 'CONTROL_UNAVAILABLE'))
    await expect(f.client.connectRuntime()).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(f.client.runtimeOwnerIdentity()).toMatchObject({ availability: 'unverified' })
  }
  expect(() => f.client.agentSessions()).toThrowError(expect.objectContaining({ code: 'HOSTED_SESSION_OBSERVATION_UNCONFIRMED' }))
  const outcome = await controller.authorizeAgentCaller({ agentSessionId: 'original', capability: f.capability })
    .then(() => ({ confirmed: true }), error => ({ confirmed: false, error }))
  expect(outcome, 'an unknown directory hint must not gate accurate caller ownership').toEqual({ confirmed: true })
  expect(f.calls.filter(method => method === 'readAgentSession')).toEqual(['readAgentSession'])
  expect(f.calls).not.toContain('readAgentSessions')
  expect(metadata).toHaveBeenCalledExactlyOnceWith('original')
  expect(inventory).not.toHaveBeenCalled()
  expect(f.calls.filter(method => method === 'authorizeAgentCaller')).toHaveLength(1)
  expect(f.client.sessionObservation().hasSnapshot).toBe(false)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('refuses duplicate exact caller owners without sending the capability to either Host', async () => {
  const first = await fixture(), second = await fixture('peer-runtime')
  await Promise.all([first.client.readRuntimeOwnerIdentity(), second.client.readRuntimeOwnerIdentity()])
  const authorize = [vi.spyOn(first.core, 'authorizeAgentCaller'), vi.spyOn(second.core, 'authorizeAgentCaller')]
  const inventory = [vi.spyOn(first.core, 'readAgentSessions'), vi.spyOn(second.core, 'readAgentSessions')]
  const controller = new RuntimeController(first.store, async host => host.id === 'local' ? first.client : second.client)
  cleanups.push(() => controller.dispose())
  controller.commit(await controller.prepare(config([{ id: 'local', kind: 'local', label: 'Local' },
    { id: 'remote', kind: 'ssh', label: 'Peer', hostname: 'private.invalid', runtimeId: second.owner.runtimeId }])))
  await expect(controller.authorizeAgentCaller({ agentSessionId: 'original', capability: first.capability })).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
  for (const call of [...authorize, ...inventory]) expect(call).not.toHaveBeenCalled()
  for (const f of [first, second]) expect(f.calls.filter(method => method === 'readAgentSession')).toEqual(['readAgentSession'])
})

it('reads only one cached caller hint after the complete directory is ready', async () => {
  const f = await fixture('original-runtime', ['original', 'unrelated'])
  f.release(); await f.client.connect()
  const { controller } = await f.controller()
  const directory = vi.spyOn(f.client, 'agentSessions'), hint = vi.spyOn(f.client, 'agentSession')
  const inventory = vi.spyOn(f.core, 'readAgentSessions').mockRejectedValue(Error('Unrelated inventory must not be read'))
  const metadata = vi.spyOn(f.core, 'readAgentSession')
  await controller.authorizeAgentCaller({ agentSessionId: 'original', capability: f.capability })
  expect(directory, 'a cached caller hint must not clone unrelated Session bodies').not.toHaveBeenCalled()
  expect(hint).toHaveBeenCalledExactlyOnceWith('original')
  expect(metadata).toHaveBeenCalledExactlyOnceWith('original')
  expect(inventory).not.toHaveBeenCalled()
})

it('does not adopt an unconfirmed SSH Host to authorize a caller', async () => {
  const f = await fixture()
  f.failIdentity(new AgentMuxError('First Host identity is unconfirmed', 'CONTROL_UNAVAILABLE'))
  const { controller } = await f.controller({ id: 'remote', kind: 'ssh', label: 'Draft', hostname: 'private.invalid' })
  await expect(controller.authorizeAgentCaller({ agentSessionId: 'original', capability: f.capability })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  expect(f.calls).not.toContain('authorizeAgentCaller')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('does not send a capability when the exact caller owner is foreign', async () => {
  const f = await fixture()
  await f.client.readRuntimeOwnerIdentity()
  const { controller } = await f.controller({ id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'private.invalid', runtimeId: f.owner.runtimeId })
  f.owner.ownerInstanceId = 'foreign-owner'
  await expect(controller.authorizeAgentCaller({ agentSessionId: 'original', capability: f.capability })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(f.calls).not.toContain('authorizeAgentCaller')
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('corrects an unadopted SSH connection draft without requiring an unknown directory', async () => {
  const f = await fixture(), before = await readFile(f.store.path, 'utf8')
  f.failIdentity(new AgentMuxError('Original connection has never been adopted', 'CONTROL_UNAVAILABLE'))
  const { controller, config: current } = await f.controller({ id: 'remote', kind: 'ssh', label: 'Draft', hostname: 'old.invalid' })
  await vi.waitFor(() => expect(f.client.sessionObservation().state).toBe('unavailable'))
  expect(f.client.runtimeOwnerIdentity()).toBeNull()
  const next = config([{ ...current.hosts[0]!, hostname: 'corrected.invalid' } as HostConfig])
  const outcome = await controller.prepare(next).then(prepared => ({ prepared }), error => ({ error }))
  expect(outcome, 'an unadopted local draft must not require an unknown directory').toHaveProperty('prepared')
  if (!('prepared' in outcome)) throw outcome.error
  expect(outcome.prepared.hosts.map(host => host.id)).toEqual(['remote'])
  await controller.discard(outcome.prepared)
  expect(await readFile(f.store.path, 'utf8')).toBe(before)
  expect(f.calls).not.toContain('listRuns'); expect(f.calls).not.toContain('readAgentSessions')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('retains adopted SSH work and refuses a route change until original quiescence is confirmed', async () => {
  const f = await fixture()
  f.release(); await f.client.connect()
  const { controller, config: current } = await f.controller({ id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'old.invalid', runtimeId: f.owner.runtimeId })
  const next = config([{ ...current.hosts[0]!, hostname: 'different.invalid' } as HostConfig])
  await expect(controller.prepare(next)).rejects.toThrow('Stop sessions on remote')
  expect((await f.client.readAgentSession('original'))?.run.runId).toBe('run-original')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
