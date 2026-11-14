import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import type { AgentMuxRpcCoreClient, AgentMuxRpcCorePort, AgentMuxRpcCallContext } from '../../../packages/core/src/public-rpc-service.js'
import { callOriginalDesktopHost, connectDesktopAgentMuxHost } from '../../desktop/src/main/desktop-host.js'
import { desktopRpcMethods } from '../../desktop/src/main/desktop-rpc-exposure.js'
import { startAgentMuxHost } from '../src/host.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private Provider source cleanup failed.')
})

async function fixture() {
  const original = await rpcOwnerFixture(['original-agent'], core, undefined, undefined, async (store, root) => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockResolvedValueOnce(undefined)
    try {
      const owner = await core.startHeadlessAgentMux({ store, socketPath: join(root, 'initialize.sock') })
      await owner.stop()
    } finally { connect.mockRestore() }
  }); cleanup.push(original.close)
  const native = original.inner.kernel
  await original.client.dispose()
  // Only Native's process/byte port is controlled. Real Host composition, Store,
  // public services, sockets, registry and compiled CLI remain in the call chain.
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  const sources: AgentMuxRpcCoreClient[] = []
  const path = join(original.root, 'control.sock')
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: path,
      desktopSocketPath: join(original.root, 'desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'),
      connections: { directory: join(original.root, 'connections'), adapters: [], clients: () => sources as Array<{ hostId: string; client: core.AgentMuxClient }> } })
    cleanup.push(() => host.dispose())
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path }, credentials: original.credentials })
  cleanup.push(() => rpc.dispose())
  const env = objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}`,
    AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability })
  const cli = (args: string[], person = false) => runCompiledObjectCli(['agent', 'provider', 'ls', ...args], person
    ? objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}` }) : env)
  const probes = [vi.spyOn(host.client, 'probeAgent'), vi.spyOn(host.client, 'probeExecutorAvailability'),
    vi.spyOn(host.client, 'inspectManagedHooks'), vi.spyOn(host.client, 'connect'), vi.spyOn(host.client, 'connectRuntime')]
  for (const probe of probes) probe.mockImplementation(() => { throw new Error('A declaration read must not invoke Native or probe ports.') })
  return { original, host, rpc, env, sources, cli, probes }
}

it('compiled CLI reads complete original declarations across the actual Host without Native/probe work', async () => {
  const f = await fixture(), before = await readFile(f.original.store.path)
  const result = await f.cli(['--host', 'local'])
  expect(result.code, result.stderr).toBe(0)
  const observed = JSON.parse(result.stdout).result
  expect(observed).toMatchObject({ routeHostId: 'local', runtimeId: expect.any(String), observedAt: expect.any(Number) })
  expect(observed.catalog).toEqual(f.host.client.catalog())
  expect(observed.catalog.map((entry: core.AgentCatalogEntry) => entry.id).sort())
    .toEqual([...core.BUILT_IN_AGENT_PROVIDER_IDS].sort())
  expect(new Set(observed.catalog.map((entry: core.AgentCatalogEntry) => JSON.stringify(entry.promptDelivery))).size).toBeGreaterThan(1)
  const posture = observed.catalog.find((entry: core.AgentCatalogEntry) => entry.postureControl)
  expect(posture.postureControl.modes.length).toBeGreaterThan(1)
  expect(posture.postureControl).toEqual(f.host.client.catalog().find(entry => entry.id === posture.id)!.postureControl)
  const selected = await f.cli(['--host', 'local', '--provider', posture.id])
  expect(selected.code, selected.stderr).toBe(0)
  expect(JSON.parse(selected.stdout).result.catalog).toEqual([posture])
  const person = await f.cli(['--host', 'local', '--provider', posture.id], true)
  expect(person.code, person.stderr).toBe(0)
  const help = await runCompiledObjectCli(['agent', 'provider', 'ls', '--help'], f.env)
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('--host ID'); expect(help.stdout).toContain('runtimeId may be null')
  expect(await readFile(f.original.store.path)).toEqual(before)
  for (const probe of f.probes) expect(probe).not.toHaveBeenCalled()
})

it('compiled CLI follows the actual Host → Desktop → original Host bridge for a borrowed client', async () => {
  const f = await fixture()
  const desktopCore = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Local' }, f.original.store)
  cleanup.push(() => desktopCore.dispose())
  await desktopCore.readAgentSessions()
  // Finish the connector's independent initial process observation before measuring
  // the pure read. Its Native port is a failing sentinel, never a real process.
  await vi.waitFor(() => expect(f.probes.at(-1)).toHaveBeenCalled())
  for (const probe of f.probes) probe.mockClear()
  vi.spyOn(desktopCore, 'runtimeOwnerIdentity').mockReturnValue(null)
  vi.spyOn(desktopCore, 'readAgentSessions').mockImplementation(() => { throw new Error('Pure declarations cannot require a whole-Host observation.') })
  const cached = vi.spyOn(desktopCore, 'catalog').mockImplementation(() => { throw new Error('The borrowed bootstrap is not a fresh Provider source.') })
  const call = vi.fn(async (hostId: string, method: core.AgentMuxRpcMethod, params: never, context: AgentMuxRpcCallContext) => {
    expect(hostId).toBe('desktop-route'); expect(context.caller).toBeUndefined()
    return await callOriginalDesktopHost(desktopCore, method, params, context)
  })
  const sources = vi.fn((hostId?: string) => [{ hostId: 'local', client: desktopCore }, { hostId: 'desktop-route', client: desktopCore }]
    .filter(source => hostId === undefined || source.hostId === hostId))
  const desktop = new core.AgentMuxControlServer({ socketPath: join(f.original.root, 'desktop.sock'), exposedMethods: desktopRpcMethods(),
    forwardingPeer: { authoritySocketPath: join(f.original.root, 'control.sock') },
    coreClients: sources,
    callOriginalCore: call as never })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const result = await f.cli(['--host', 'desktop-route'], true)
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({ routeHostId: 'desktop-route', runtimeId: expect.any(String), catalog: f.host.client.catalog() })
  expect(call).toHaveBeenCalledTimes(1); expect(cached).not.toHaveBeenCalled()
  expect(sources.mock.calls.map(([hostId]) => hostId)).toEqual(['desktop-route', 'desktop-route'])
  for (const probe of f.probes) expect(probe).not.toHaveBeenCalled()
})

it('exact target reads preserve different same-ID Host declarations, unknown Runtime, empty and unavailable', async () => {
  const f = await fixture()
  const target = new core.AgentMuxClient({ store: f.original.store }); cleanup.push(() => target.dispose())
  const declarations = target.catalog().slice(0, 2).map(entry => ({ ...entry, label: 'Target ' + entry.label }))
  const catalog = vi.spyOn(target, 'catalog').mockReturnValue(declarations)
  const path = join(f.original.root, 'target.sock')
  const server = new core.AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'local', client: target }] })
  await server.start(); cleanup.push(() => server.stop())
  const transport = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); cleanup.push(() => transport.dispose())
  const outbound = vi.fn(async (method: core.AgentMuxRpcMethod, params: never, context: AgentMuxRpcCallContext) => {
    expect(context.caller).toBeUndefined(); expect(method).toBe('agent.provider.ls')
    return await transport.call(method, params)
  })
  f.sources.push({ hostId: 'target-route', client: { forwardRpc: outbound } as unknown as AgentMuxRpcCorePort })
  const result = await f.cli(['--host', 'target-route'])
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toMatchObject({ routeHostId: 'target-route', runtimeId: null, catalog: declarations })
  expect(outbound).toHaveBeenCalledTimes(1)
  expect(catalog).toHaveBeenCalledTimes(1)
  // Optional identity observation cannot turn a readable declaration into a blocker.
  Object.assign(target, { runtimeOwnerIdentity: () => { throw new Error('Semantic identity observation unavailable') } })
  const unknownIdentity = await f.cli(['--host', 'target-route'])
  expect(unknownIdentity.code, unknownIdentity.stderr).toBe(0)
  expect(JSON.parse(unknownIdentity.stdout).result).toMatchObject({ runtimeId: null, catalog: declarations })
  catalog.mockReturnValue([])
  const empty = await f.cli(['--host', 'target-route'])
  expect(empty.code, empty.stderr).toBe(0); expect(JSON.parse(empty.stdout).result.catalog).toEqual([])
  catalog.mockImplementation(() => { throw new core.AgentMuxError('Original source unavailable', 'PROVIDER_SOURCE_UNAVAILABLE') })
  const unavailable = await f.cli(['--host', 'target-route'])
  expect(unavailable.code).not.toBe(0); expect(JSON.parse(unavailable.stderr).error.code).toBe('PROVIDER_SOURCE_UNAVAILABLE')
  const local = await f.cli(['--host', 'local'])
  expect(local.code, local.stderr).toBe(0); expect(JSON.parse(local.stdout).result.catalog).toEqual(f.host.client.catalog())
  for (const probe of f.probes) expect(probe).not.toHaveBeenCalled()
})

it('rejects missing, ambiguous and stale sources and invalid caller without probing another Host', async () => {
  const f = await fixture()
  expect((await f.cli([])).code).not.toBe(0)
  const unknown = await f.cli(['--host', 'not-registered'])
  expect(unknown.code).not.toBe(0)
  const read = vi.fn(() => [])
  const client = { catalog: read } as unknown as AgentMuxRpcCorePort
  f.sources.push({ hostId: 'duplicate', client }, { hostId: 'duplicate', client })
  const ambiguous = await f.cli(['--host', 'duplicate'])
  expect(ambiguous.code).not.toBe(0); expect(JSON.parse(ambiguous.stderr).error.code).toBe('AMBIGUOUS_AGENT_SESSION')
  expect(read).not.toHaveBeenCalled()
  await expect(f.rpc.call('agent.provider.ls', { hostId: 'local' }, { credentials: { ...f.original.credentials, capability: 'invalid' } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  const changing = { catalog: () => { f.sources.splice(0); return [] } } as unknown as AgentMuxRpcCorePort
  f.sources.push({ hostId: 'changing', client: changing })
  const stale = await f.cli(['--host', 'changing'])
  expect(stale.code).not.toBe(0); expect(JSON.parse(stale.stderr).error.code).toBe('HOST_CONFIGURATION_CHANGED')
  for (const probe of f.probes) expect(probe).not.toHaveBeenCalled()
})

it('public decoder rejects another source and private posture/launch contributions', () => {
  const client = new core.AgentMuxClient()
  cleanup.push(() => client.dispose())
  const entries = client.catalog(), query = { hostId: 'original' }
  const observation = { routeHostId: 'original', runtimeId: null, observedAt: Date.now(), catalog: entries }
  expect(core.parseProviderCatalogObservation(observation, query).catalog).toEqual(entries)
  expect(() => core.parseProviderCatalogObservation({ ...observation, routeHostId: 'other' }, query)).toThrow()
  const entry = entries.find(entry => entry.postureControl)!
  expect(() => core.parseProviderCatalogObservation({ ...observation, catalog: [{ ...entry,
    postureControl: { ...entry.postureControl, modes: entry.postureControl!.modes.map(mode => ({ ...mode, input: 'private-bytes' })) } }] }, query)).toThrow()
})

it('an unavailable source never creates a lazy SDK/Native connection, including managed caller admission', async () => {
  const original = await rpcOwnerFixture(['original-agent'], core); cleanup.push(original.close)
  const path = join(original.root, 'unavailable.sock')
  const native = vi.spyOn(core.AgentMuxClient.prototype, 'connectRuntime').mockImplementation(() => { throw new Error('Native startup forbidden') })
  const semantic = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementation(() => { throw new Error('Lazy SDK startup forbidden') })
  const server = new core.AgentMuxControlServer({ socketPath: path }); await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(original.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}`,
    AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability })
  const result = await runCompiledObjectCli(['agent', 'provider', 'ls', '--host', 'local'], env)
  expect(result.code).not.toBe(0); expect(JSON.parse(result.stderr).error.code).toBe('CONTROL_UNAVAILABLE')
  expect(native).not.toHaveBeenCalled(); expect(semantic).not.toHaveBeenCalled()
})
