import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readdir, readFile, lstat, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxHostedRpcPort, AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'

// One exact source/compiled owner per run; the mutation harness copies the real built package.
const entry = process.env.AGENTMUX_TEST_HOME_CORE_ENTRY
const runtime: typeof import('../src/index.js') = entry ? await import(pathToFileURL(entry).href) : await import('../src/index.js')
const internal = (name: string) => entry ? new URL('./' + name + '.js', pathToFileURL(entry)).href : new URL('../src/' + name + '.js', import.meta.url).href
const { AgentMuxClient, AgentMuxMemoryAgentSessionStore, AgentMuxFileAgentSessionStore, AgentMuxCreationAuthority,
  AgentMuxHostedRuntimeService, connectHostedAgentMux, AgentMuxControlServer, connectAgentMuxRpc, AgentMuxError } = runtime
const { parseHostEnvironment } = await import(internal('host-environment')) as typeof import('../src/host-environment.js')
const { AgentMuxRpcService } = await import(internal('public-rpc-service')) as typeof import('../src/public-rpc-service.js')
const { parseHostSettingsParams, parseHostSettingsResult } = await import(internal('public-rpc-host-settings')) as typeof import('../src/public-rpc-host-settings.js')
const { parseSettingsCommand } = await import(internal('settings-cli')) as typeof import('../src/settings-cli.js')
const { agentMuxCommandHelp } = await import(internal('agentmux-cli-help')) as typeof import('../src/agentmux-cli-help.js')
const { decodeHostedValue } = await import(internal('hosted-value')) as typeof import('../src/hosted-value.js')
const { locateAgentWorkspaceDirectory } = await import(internal('agent-workspace-directory')) as typeof import('../src/agent-workspace-directory.js')

const user = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'original-user' } }
const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Host home fixture cleanup failed')
})
const owner: AgentMuxRuntimeOwnerIdentity = { protocolVersion: 2, runtimeId: 'original-host-core', ownerInstanceId: 'original-core-instance',
  processId: process.pid, ctxmux: null, availability: 'connected' }
const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
function core() {
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [] })
  cleanups.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(Error('General Session observation must not prepare home reads'))
  const native = vi.spyOn(client, 'connectRuntime').mockRejectedValue(Error('Native must not prepare home reads'))
  const sessions = vi.spyOn(client, 'readAgentSessions').mockRejectedValue(Error('Session discovery must not prepare home reads'))
  return { client, connect, native, sessions }
}
function blockedEventLease(): AgentMuxHostedRpcPort['subscribe'] {
  // This unrelated general observation never becomes ready. Home uses only owner control.
  return async (_method, _params, handlers) => {
    const end = () => handlers.onEnd?.(new AgentMuxError('Unrelated fixture event lease was released.', 'CONTROL_CANCELLED'))
    handlers.signal?.addEventListener('abort', end, { once: true })
    return { dispose: async () => { handlers.signal?.removeEventListener('abort', end); end() } }
  }
}
async function socketRoot() {
  const path = await mkdtemp(join(tmpdir(), 'ahome-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}
async function fileCore(semantic = true) {
  const directory = await socketRoot(), stateDirectory = join(directory, 'explicit-state')
  const store = new AgentMuxFileAgentSessionStore(join(stateDirectory, 'sessions.json'))
  const authority = semantic ? new AgentMuxCreationAuthority({ stateDirectory, runtimeId: owner.runtimeId }) : undefined
  const client = new AgentMuxClient({ store, providers: [], ...(authority ? { creationAuthority: authority } : {}) })
  cleanups.push(() => client.dispose())
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(Error('General Session observation must not prepare locator reads'))
  const native = vi.spyOn(client, 'connectRuntime').mockRejectedValue(Error('Native must not prepare locator reads'))
  const sessions = vi.spyOn(client, 'readAgentSessions').mockRejectedValue(Error('Session discovery must not prepare locator reads'))
  const identity = authority ? vi.spyOn(authority, 'identity') : undefined
  return { directory, stateDirectory, store, authority, client, connect, native, sessions, identity }
}
async function snapshot(root: string): Promise<unknown> {
  const names = await readdir(root, { recursive: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[]
    throw error
  })
  return await Promise.all(names.sort().map(async name => {
    const path = join(root, name), stat = await lstat(path)
    if (stat.isDirectory()) return [name, 'directory']
    if (stat.isSymbolicLink()) return [name, 'symlink', await readlink(path)]
    return [name, 'file', (await readFile(path)).toString('base64')]
  }))
}
const workspace = (stateDirectory: string, agentSessionId: string) => join(stateDirectory, 'agent-workspaces',
  createHash('sha256').update(agentSessionId, 'utf8').digest('hex'))
const locator = (stateDirectory: string, agentSessionId: string, homeDirectory = '/tmp/selected-locator-home') => ({
  homeDirectory, agentWorkspace: { runtimeId: owner.runtimeId, agentSessionId, workspacePath: workspace(stateDirectory, agentSessionId) }
})

it('reads the Core process OS home without Native, Session, catalog or filesystem preparation', async () => {
  const f = core(), catalog = vi.spyOn(f.client, 'catalog').mockImplementation(() => { throw Error('No catalog prerequisite') })
  vi.stubEnv('HOME', '/tmp/original-core-user home ')
  expect(await f.client.hostEnvironment()).toEqual({ homeDirectory: '/tmp/original-core-user home ' })
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled(); expect(catalog).not.toHaveBeenCalled()
  vi.stubEnv('HOME', 'relative-unknown-home')
  await expect(f.client.hostEnvironment()).rejects.toMatchObject({ code: 'HOST_ENVIRONMENT_UNAVAILABLE' })
})

it('projects a stable exact-SID Agent workspace from the file Store without any state, signing, Session or Native effects', async () => {
  const f = await fileCore(), agentSessionId = 'Session-Case-Exact'
  vi.stubEnv('HOME', '/tmp/selected-locator-home')
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(f.directory, 'unrelated-environment-state'))
  const before = await snapshot(f.directory)
  const expected = locator(f.stateDirectory, agentSessionId)
  expect(await f.client.hostEnvironment({ agentSessionId })).toEqual(expected)
  expect(await f.client.hostEnvironment({ agentSessionId })).toEqual(expected)
  expect(expected.agentWorkspace.workspacePath).toBe(workspace(f.stateDirectory, agentSessionId))
  expect(expected.agentWorkspace.workspacePath).not.toContain(agentSessionId)
  const location = locateAgentWorkspaceDirectory({ storePath: f.store.path, runtimeId: owner.runtimeId, agentSessionId })
  expect(location.agentWorkspace).toEqual(expected.agentWorkspace)
  expect(location.markerPath).toBe(join(f.stateDirectory, 'agent-workspace-identities',
    createHash('sha256').update(agentSessionId, 'utf8').digest('hex') + '.json'))
  expect(location.markerPath).not.toBe(expected.agentWorkspace.workspacePath)
  const otherCase = await f.client.hostEnvironment({ agentSessionId: agentSessionId.toLowerCase() })
  expect(otherCase.agentWorkspace.workspacePath).not.toBe(expected.agentWorkspace.workspacePath)
  expect(otherCase.agentWorkspace.workspacePath).toBe(workspace(f.stateDirectory, agentSessionId.toLowerCase()))
  expect(await snapshot(f.directory)).toEqual(before)
  expect(f.identity).not.toHaveBeenCalled(); expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
})

it('fails only selected reads when the exact file namespace or semantic Runtime is unavailable', async () => {
  vi.stubEnv('HOME', '/tmp/still-healthy-home')
  const memoryAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(await socketRoot(), 'authority'), runtimeId: owner.runtimeId })
  const memory = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore(), providers: [], creationAuthority: memoryAuthority })
  const file = await fileCore(false); cleanups.push(() => memory.dispose())
  for (const client of [memory, file.client]) {
    await expect(client.hostEnvironment({ agentSessionId: 'selected-SID' })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    await expect(client.hostEnvironment()).resolves.toEqual({ homeDirectory: '/tmp/still-healthy-home' })
  }
  expect(file.identity).toBeUndefined(); expect(file.connect).not.toHaveBeenCalled(); expect(file.native).not.toHaveBeenCalled(); expect(file.sessions).not.toHaveBeenCalled()
})

it('delegates the same SDK method with only the original owner fence while Native and general observation are unavailable', async () => {
  const f = core(), hosted = new AgentMuxHostedRuntimeService(f.client, null, () => owner)
  cleanups.push(() => hosted.dispose())
  vi.stubEnv('HOME', '/tmp/original-hosted-home')
  const calls: Array<{ method: string; params: any }> = []
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params) => { calls.push({ method, params }); return await hosted.call(method, params, user) as never },
    subscribe: blockedEventLease()
  }
  const client = await connectHostedAgentMux({ rpc: port, waitForReady: false }); cleanups.push(() => client.dispose())
  await expect(client.hostEnvironment()).resolves.toEqual({ homeDirectory: '/tmp/original-hosted-home' })
  const invocation = calls.filter(call => call.method === 'runtime.invoke')
  expect(invocation).toHaveLength(1)
  expect(invocation[0]!.params.fence).toEqual(fence)
  expect(decodeHostedValue(invocation[0]!.params.invocation)).toEqual({ method: 'hostEnvironment', args: [] })
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
  vi.spyOn(f.client, 'hostEnvironment').mockResolvedValueOnce({ homeDirectory: 'relative-unconfirmed-reply' })
  await expect(client.hostEnvironment()).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  await expect(hosted.call('runtime.invoke', { consumerId: 'original-home-reader', fence: { ...fence, runtimeId: 'wrong-host' },
    invocation: { method: 'hostEnvironment', args: [] } }, user)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  await expect(hosted.call('runtime.invoke', { consumerId: 'original-home-reader', fence: { ...fence, ownerInstanceId: 'wrong-instance' },
    invocation: { method: 'hostEnvironment', args: [] } }, user)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  await expect(hosted.call('runtime.invoke', { consumerId: 'original-home-reader', fence,
    invocation: { method: 'hostEnvironment', args: ['/guessed'] } }, user)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it('delegates selected reads with one strict selector and validates locator SID, owner Runtime and absolute path without retrying home', async () => {
  const f = core(), hosted = new AgentMuxHostedRuntimeService(f.client, null, () => owner)
  cleanups.push(() => hosted.dispose())
  const agentSessionId = 'selected-hosted-SID', stateDirectory = '/remote/execution-state'
  const valid = locator(stateDirectory, agentSessionId, '/tmp/selected-hosted-home')
  const read = vi.spyOn(f.client, 'hostEnvironment').mockResolvedValue(valid)
  const calls: Array<{ method: string; params: any }> = []
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params) => { calls.push({ method, params }); return await hosted.call(method, params, user) as never },
    subscribe: blockedEventLease()
  }
  const client = await connectHostedAgentMux({ rpc: port, waitForReady: false }); cleanups.push(() => client.dispose())
  await expect(client.hostEnvironment({ agentSessionId })).resolves.toEqual(valid)
  let invocations = calls.filter(call => call.method === 'runtime.invoke')
  expect(invocations).toHaveLength(1)
  expect(decodeHostedValue(invocations[0]!.params.invocation)).toEqual({ method: 'hostEnvironment', args: [{ agentSessionId }] })
  const malformed = [
    { homeDirectory: valid.homeDirectory },
    { ...valid, agentWorkspace: { ...valid.agentWorkspace, agentSessionId: 'another-SID' } },
    { ...valid, agentWorkspace: { ...valid.agentWorkspace, runtimeId: 'another-Runtime' } },
    { ...valid, agentWorkspace: { ...valid.agentWorkspace, workspacePath: 'relative/workspace' } },
    { ...valid, agentWorkspace: { ...valid.agentWorkspace, guessed: true } },
    { ...valid, guessed: true }
  ]
  for (const value of malformed) {
    const before = calls.filter(call => call.method === 'runtime.invoke').length
    read.mockResolvedValueOnce(value as never)
    await expect(client.hostEnvironment({ agentSessionId })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    invocations = calls.filter(call => call.method === 'runtime.invoke')
    expect(invocations).toHaveLength(before + 1)
    expect(decodeHostedValue(invocations.at(-1)!.params.invocation)).toEqual({ method: 'hostEnvironment', args: [{ agentSessionId }] })
  }
  const failure = new AgentMuxError('The old target requires an upgrade for selected reads.', 'REMOTE_CORE_UPGRADE_REQUIRED')
  read.mockRejectedValueOnce(failure)
  await expect(client.hostEnvironment({ agentSessionId })).rejects.toBe(failure)
  const businessReads = read.mock.calls.length
  const invoke = client.hostEnvironment as (...args: unknown[]) => Promise<unknown>
  for (const args of [[{ agentSessionId, extra: true }], [agentSessionId], [null], [{ agentSessionId }, { agentSessionId }]]) {
    await expect(invoke(...args)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  await expect(hosted.call('runtime.invoke', { consumerId: 'strict-selector', fence,
    invocation: { method: 'hostEnvironment', args: [{ agentSessionId, preparationSessionId: 'wire-forgery' }] } } as never, user))
    .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(read).toHaveBeenCalledTimes(businessReads)
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
})

it('routes actual Unix RPC and compiled CLI to the selected Hosted Core home, preserving unrelated Hosts and healthy work', async () => {
  const directory = await socketRoot(), target = core(), local = core()
  const targetRead = vi.spyOn(target.client, 'hostEnvironment')
  const unrelated = vi.spyOn(local.client, 'hostEnvironment').mockResolvedValue({ homeDirectory: '/tmp/unrelated-local-home' })
  vi.stubEnv('HOME', '/tmp/selected-remote-home ')
  const hosted = new AgentMuxHostedRuntimeService(target.client, null, () => owner); cleanups.push(() => hosted.dispose())
  const targetServer = new AgentMuxControlServer({ socketPath: join(directory, 'target.sock'), hostedRuntime: () => hosted,
    coreClients: () => [{ hostId: 'local', client: target.client }] })
  await targetServer.start(); cleanups.push(() => targetServer.stop())
  const targetRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: targetServer.path } }); cleanups.push(() => targetRpc.dispose())
  const remote = await connectHostedAgentMux({ rpc: { call: targetRpc.call.bind(targetRpc), subscribe: blockedEventLease() }, waitForReady: false })
  cleanups.push(() => remote.dispose())
  const configuration = { id: 'selected', kind: 'ssh', label: 'Original remote', hostname: 'no-network.fixture', runtimeId: owner.runtimeId }
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'desktop.sock'),
    coreClients: () => [{ hostId: 'local', client: local.client }, { hostId: 'selected', client: remote }],
    hostConfiguration: id => id === 'selected' ? configuration : null })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  expect(await rpc.call('settings.hosts.home', { hostId: 'selected', expected: configuration })).toEqual({ routeHostId: 'selected', homeDirectory: '/tmp/selected-remote-home ' })
  const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'settings', 'hosts', 'home', '--host', 'selected'],
    objectCliEnvironment(directory, { HOME: '/tmp/cli-user-must-not-be-used' }))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result).toEqual({ routeHostId: 'selected', homeDirectory: '/tmp/selected-remote-home ' })
  expect(targetRead).toHaveBeenCalledTimes(2); expect(unrelated).not.toHaveBeenCalled()
  expect(target.connect).not.toHaveBeenCalled(); expect(target.native).not.toHaveBeenCalled(); expect(target.sessions).not.toHaveBeenCalled()
})

it('routes exact selected locators through real Unix RPC and both compiled CLI option forms without touching a sibling Host', async () => {
  const directory = await socketRoot(), target = await fileCore(), local = core()
  const targetRead = vi.spyOn(target.client, 'hostEnvironment')
  const unrelated = vi.spyOn(local.client, 'hostEnvironment').mockResolvedValue({ homeDirectory: '/tmp/unrelated-local-home' })
  vi.stubEnv('HOME', '/tmp/selected-locator-home')
  const hosted = new AgentMuxHostedRuntimeService(target.client, null, () => owner); cleanups.push(() => hosted.dispose())
  const targetServer = new AgentMuxControlServer({ socketPath: join(directory, 'target.sock'), hostedRuntime: () => hosted,
    coreClients: () => [{ hostId: 'local', client: target.client }] })
  await targetServer.start(); cleanups.push(() => targetServer.stop())
  const targetRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: targetServer.path } }); cleanups.push(() => targetRpc.dispose())
  const remote = await connectHostedAgentMux({ rpc: { call: targetRpc.call.bind(targetRpc), subscribe: blockedEventLease() }, waitForReady: false })
  cleanups.push(() => remote.dispose())
  const configuration = { id: 'selected', kind: 'ssh', label: 'Original remote', hostname: 'no-network.fixture', runtimeId: owner.runtimeId }
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'desktop.sock'),
    coreClients: () => [{ hostId: 'local', client: local.client }, { hostId: 'selected', client: remote }],
    hostConfiguration: id => id === 'selected' ? configuration : null })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const agentSessionId = 'selected-public-SID', expected = { routeHostId: 'selected', ...locator(target.stateDirectory, agentSessionId) }
  expect(await rpc.call('settings.hosts.home', { hostId: 'selected', expected: configuration, agentSessionId })).toEqual(expected)
  for (const args of [
    ['settings', 'hosts', 'home', '--host', 'selected', '--session', agentSessionId],
    ['settings', 'hosts', 'home', '--host=selected', '--session=' + agentSessionId]
  ]) {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args],
      objectCliEnvironment(directory, { HOME: '/tmp/cli-user-must-not-be-used' }))
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).result).toEqual(expected)
  }
  expect(targetRead).toHaveBeenCalledTimes(3)
  for (const call of targetRead.mock.calls) expect(call).toEqual([{ agentSessionId }])
  expect(unrelated).not.toHaveBeenCalled()
  expect(target.connect).not.toHaveBeenCalled(); expect(target.native).not.toHaveBeenCalled(); expect(target.sessions).not.toHaveBeenCalled(); expect(target.identity).not.toHaveBeenCalled()
})

it('rejects unknown, ambiguous and changed Host routes without a local-home fallback or default Native connection', async () => {
  const f = core(), read = vi.spyOn(f.client, 'hostEnvironment').mockResolvedValue({ homeDirectory: '/remote/confirmed' })
  let configuration = { id: 'selected', kind: 'ssh', label: 'Original', hostname: 'original.fixture' }
  let routes = [{ hostId: 'selected', client: f.client }]
  const service = new AgentMuxRpcService({ coreClients: () => routes, hostConfiguration: () => configuration }); cleanups.push(() => service.dispose())
  await expect(service.call('settings.hosts.home', { hostId: 'unknown' }, user)).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  routes = [...routes, ...routes]
  await expect(service.call('settings.hosts.home', { hostId: 'selected' }, user)).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
  routes = [routes[0]!]
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected: { ...configuration, hostname: 'wrong.fixture' } }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  expect(read).not.toHaveBeenCalled()
  read.mockImplementationOnce(async () => { configuration = { ...configuration, hostname: 'changed.fixture' }; return { homeDirectory: '/original/result' } })
  await expect(service.call('settings.hosts.home', { hostId: 'selected' }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  const empty = new AgentMuxRpcService({}); cleanups.push(() => empty.dispose())
  await expect(empty.call('settings.hosts.home', { hostId: 'local' }, user)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled()
})

it('Home accepts a display-only rename before and during its read while other Host observations keep their original expected contract', async () => {
  const f = core(), read = vi.spyOn(f.client, 'hostEnvironment').mockResolvedValue({ homeDirectory: '/remote/original-home' })
  const expected = { id: 'selected', kind: 'ssh', label: 'Original', hostname: 'original.fixture' }
  let configuration = { hostname: expected.hostname, label: 'Renamed', kind: expected.kind, id: expected.id }
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'selected', client: f.client }], hostConfiguration: () => configuration }); cleanups.push(() => service.dispose())
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected }, user)).resolves.toEqual({ routeHostId: 'selected', homeDirectory: '/remote/original-home' })
  read.mockImplementationOnce(async () => { configuration = { ...configuration, label: 'Renamed during read' }; return { homeDirectory: '/remote/original-home' } })
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected }, user)).resolves.toEqual({ routeHostId: 'selected', homeDirectory: '/remote/original-home' })
  expect(read).toHaveBeenCalledTimes(2)
  for (const method of ['settings.hosts.inspect', 'settings.hosts.network'] as const) {
    await expect(service.call(method, { hostId: 'selected', expected }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  }
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
})

it.each([
  { hostname: 'changed.fixture' }, { transport: 'tailcat' }, { tailcat: { address: 'tcChangedFixture', keyFile: '/fixture/client' } },
  { tailcat: { address: 'tcOriginalFixture', keyFile: '/fixture/changed-client' } }, { runtimeId: 'changed-runtime' }, { remoteCommand: 'another-amux' }
])('Home keeps the exact route fence before and after reads for %j', async change => {
  const f = core(), read = vi.spyOn(f.client, 'hostEnvironment').mockResolvedValue({ homeDirectory: '/remote/original-home' })
  const expected = { id: 'selected', kind: 'ssh', label: 'Original', hostname: 'original.fixture', transport: 'ssh-tailcat',
    tailcat: { address: 'tcOriginalFixture', keyFile: '/fixture/client' }, runtimeId: 'original-runtime', remoteCommand: 'amux' }
  let configuration = { ...expected, ...change }
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'selected', client: f.client }], hostConfiguration: () => configuration }); cleanups.push(() => service.dispose())
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  expect(read).not.toHaveBeenCalled()
  configuration = { ...expected }
  read.mockImplementationOnce(async () => { configuration = { ...expected, ...change }; return { homeDirectory: '/remote/stale-route' } })
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  expect(read).toHaveBeenCalledOnce(); expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled()
})

it('Home still refuses a replaced client even when its route configuration and display name are unchanged', async () => {
  const f = core(), replacement = core(), configuration = { id: 'selected', kind: 'ssh', label: 'Original', hostname: 'original.fixture' }
  let client = f.client
  const read = vi.spyOn(f.client, 'hostEnvironment').mockImplementation(async () => { client = replacement.client; return { homeDirectory: '/remote/old-client-home' } })
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'selected', client }], hostConfiguration: () => configuration }); cleanups.push(() => service.dispose())
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected: configuration }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  expect(read).toHaveBeenCalledOnce(); expect(replacement.connect).not.toHaveBeenCalled(); expect(replacement.native).not.toHaveBeenCalled()
})

it('keeps the same route and client fences around selected reads and preserves old-target, cancellation and late-result semantics', async () => {
  const f = core(), replacement = core(), agentSessionId = 'selected-fenced-SID'
  const valid = locator('/remote/execution-state', agentSessionId, '/remote/original-home')
  const expected = { id: 'selected', kind: 'ssh', label: 'Original', hostname: 'original.fixture', runtimeId: owner.runtimeId }
  let configuration = { ...expected }, client = f.client
  const read = vi.spyOn(f.client, 'hostEnvironment').mockResolvedValue(valid)
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'selected', client }], hostConfiguration: () => configuration }); cleanups.push(() => service.dispose())
  read.mockImplementationOnce(async () => { configuration = { ...configuration, hostname: 'changed.fixture' }; return valid })
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected, agentSessionId }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  expect(read).toHaveBeenLastCalledWith({ agentSessionId })
  configuration = { ...expected }
  read.mockImplementationOnce(async () => { client = replacement.client; return valid })
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected, agentSessionId }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  expect(read).toHaveBeenCalledTimes(2); expect(replacement.connect).not.toHaveBeenCalled(); expect(replacement.native).not.toHaveBeenCalled()

  client = f.client; configuration = { ...expected }
  const failure = new AgentMuxError('The original old target rejected this selector.', 'REMOTE_CORE_UPGRADE_REQUIRED')
  read.mockRejectedValueOnce(failure)
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected, agentSessionId }, user)).rejects.toBe(failure)
  expect(read).toHaveBeenCalledTimes(3); expect(read).toHaveBeenLastCalledWith({ agentSessionId })
  const controller = new AbortController()
  let release!: (value: typeof valid) => void
  read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = service.call('settings.hosts.home', { hostId: 'selected', expected, agentSessionId }, { ...user, signal: controller.signal })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4))
  const outcome = pending.catch(error => error); controller.abort(new AgentMuxError('Original selected read cancelled.', 'CONTROL_CANCELLED'))
  expect(await outcome).toMatchObject({ code: 'CONTROL_CANCELLED' }); release(valid)
  read.mockResolvedValueOnce(valid)
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected, agentSessionId }, user)).resolves.toEqual({ routeHostId: 'selected', ...valid })
  expect(read).toHaveBeenCalledTimes(5)
  read.mockResolvedValueOnce({ homeDirectory: '/remote/healthy-no-selector' })
  await expect(service.call('settings.hosts.home', { hostId: 'selected', expected }, user)).resolves.toEqual({ routeHostId: 'selected', homeDirectory: '/remote/healthy-no-selector' })
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
})

it('retains the original read failure and cancels only this reader, with no healthy Run or other Host effects', async () => {
  const f = core(), read = vi.spyOn(f.client, 'hostEnvironment').mockRejectedValueOnce(new AgentMuxError('Original Host home is unavailable.', 'HOST_ENVIRONMENT_UNAVAILABLE'))
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'selected', client: f.client }] }); cleanups.push(() => service.dispose())
  await expect(service.call('settings.hosts.home', { hostId: 'selected' }, user)).rejects.toMatchObject({ code: 'HOST_ENVIRONMENT_UNAVAILABLE' })
  const controller = new AbortController()
  let release!: (value: { homeDirectory: string }) => void
  read.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = service.call('settings.hosts.home', { hostId: 'selected' }, { ...user, signal: controller.signal })
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  const outcome = pending.catch(error => error); controller.abort(new AgentMuxError('Original read cancelled.', 'CONTROL_CANCELLED'))
  expect(await outcome).toMatchObject({ code: 'CONTROL_CANCELLED' }); release({ homeDirectory: '/late/original-result' })
  read.mockResolvedValueOnce({ homeDirectory: '/remote/recovered' })
  expect(await service.call('settings.hosts.home', { hostId: 'selected' }, user)).toEqual({ routeHostId: 'selected', homeDirectory: '/remote/recovered' })
  expect(f.connect).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.sessions).not.toHaveBeenCalled()
})

it('strictly validates exact home results, params and the discoverable CLI while preserving target path spelling', async () => {
  expect(parseHostSettingsParams('settings.hosts.home', { hostId: 'selected', expected: { id: 'selected' } })).toEqual({ hostId: 'selected', expected: { id: 'selected' } })
  expect(parseHostSettingsResult('settings.hosts.home', { routeHostId: 'selected', homeDirectory: '/Volumes/Owner Home ' }, { hostId: 'selected' })).toEqual({ routeHostId: 'selected', homeDirectory: '/Volumes/Owner Home ' })
  expect(parseHostEnvironment({ homeDirectory: 'C:\\Users\\Original Home' })).toEqual({ homeDirectory: 'C:\\Users\\Original Home' })
  for (const homeDirectory of ['', 'relative', '~/guessed', '/home\0wrong', '/home\nwrong', 7, null]) {
    expect(() => parseHostSettingsResult('settings.hosts.home', { routeHostId: 'selected', homeDirectory }, { hostId: 'selected' })).toThrow()
  }
  for (const value of [{ routeHostId: 'wrong', homeDirectory: '/wrong-host' }, { routeHostId: 'selected', homeDirectory: '/home', guessed: true }]) {
    expect(() => parseHostSettingsResult('settings.hosts.home', value, { hostId: 'selected' })).toThrow()
  }
  expect(() => parseHostSettingsParams('settings.hosts.home', { hostId: 'selected', command: 'echo ~' })).toThrow()
  const agentSessionId = 'strict-selected-SID', input = { hostId: 'selected', expected: { runtimeId: owner.runtimeId }, agentSessionId }
  const selected = { routeHostId: 'selected', ...locator('/remote/execution-state', agentSessionId) }
  expect(parseHostSettingsParams('settings.hosts.home', input)).toEqual(input)
  expect(parseHostSettingsResult('settings.hosts.home', selected, input)).toEqual(selected)
  for (const method of ['settings.hosts.inspect', 'settings.hosts.network'] as const) {
    expect(() => parseHostSettingsParams(method, { hostId: 'selected', agentSessionId })).toThrow()
  }
  const protocolError = (run: () => unknown) => {
    let failure: unknown
    try { run() } catch (error) { failure = error }
    expect(failure).toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  }
  const invalidSelected = [
    { routeHostId: 'selected', homeDirectory: selected.homeDirectory },
    { ...selected, guessed: true },
    { ...selected, agentWorkspace: { ...selected.agentWorkspace, guessed: true } },
    { ...selected, agentWorkspace: { ...selected.agentWorkspace, agentSessionId: 'wrong-SID' } },
    { ...selected, agentWorkspace: { ...selected.agentWorkspace, runtimeId: 'wrong-Runtime' } },
    { ...selected, agentWorkspace: { ...selected.agentWorkspace, workspacePath: 'relative/workspace' } }
  ]
  for (const value of invalidSelected) protocolError(() => parseHostSettingsResult('settings.hosts.home', value, input))
  protocolError(() => parseHostSettingsResult('settings.hosts.home', { routeHostId: 'selected', ...selected, agentWorkspace: selected.agentWorkspace }, { hostId: 'selected' }))
  expect(await parseSettingsCommand(['hosts', 'home', '--host', 'selected'])).toEqual({ hostId: 'selected' })
  await expect(parseSettingsCommand(['hosts', 'home'])).rejects.toBeDefined()
  expect(agentMuxCommandHelp('settings.hosts.home')).toContain('settings hosts home --host <id>')
})

it('keeps the actual compiled Hosted home consumer browser-safe without importing local OS facts', async () => {
  const path = entry ? new URL('./hosted.js', pathToFileURL(entry)).pathname : new URL('../dist/hosted.js', import.meta.url).pathname
  const bundled = await build({ entryPoints: [path], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true, logLevel: 'silent' })
  const inputs = Object.values(bundled.metafile!.inputs)
  expect(inputs.length).toBeGreaterThan(2)
  expect(inputs.flatMap(input => input.imports).some(input => input.path.startsWith('node:'))).toBe(false)
  expect(bundled.outputFiles[0]!.contents.byteLength).toBeGreaterThan(100)
})
