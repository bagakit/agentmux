import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectSshAgentMux } from '../src/runtime-client.js'
import { observeHostNetwork, parseHostNetworkObservation } from '../src/host-network-observation.js'
import { parseSshNetworkConfiguration } from '../src/ssh-network-configuration.js'
import { parseSettingsCommand } from '../src/settings-cli.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { sshRouteFixture } from './helpers/ssh-route-fixture.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { AgentMuxRpcCorePort } from '../src/public-rpc-service.js'

const user = { principal: { kind: 'user' as const, id: 'original-user' }, transport: 'unix' as const }
const closes: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() {
  const f = await rpcOwnerFixture(); closes.push(f.close)
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'original-network-runtime', ownerInstanceId: 'original-network-owner',
    protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }
  const hosted = new AgentMuxHostedRuntimeService(f.client, null, () => owner); closes.push(() => hosted.dispose())
  let configuration = { id: 'selected', kind: 'local', label: 'Selected environment' }
  const unrelated = { runtimeIdentity: vi.fn(), connect: vi.fn(), runtimeOwnerIdentity: vi.fn() } as unknown as AgentMuxRpcCorePort
  const options = { hostConfiguration: (id: string) => id === 'selected' ? configuration : null,
    coreClients: () => [{ hostId: 'selected', client: f.client }, { hostId: 'unrelated', client: unrelated }], hostedRuntime: () => hosted }
  const service = new AgentMuxRpcService(options)
  closes.push(() => service.dispose())
  return { ...f, owner, hosted, service, options, unrelated, get configuration() { return configuration },
    replaceConfiguration() { configuration = { ...configuration, label: 'Changed while reading' } } }
}
it('network: public original-owner read and built CLI preserve separate namespace provenance without Native preparation', async () => {
  const f = await fixture(), connect = vi.spyOn(f.client, 'connect'), native = vi.spyOn(f.client, 'connectRuntime'), sessions = vi.spyOn(f.client, 'readAgentSessions')
  const read = await f.service.call('settings.hosts.network', { hostId: 'selected', expected: f.configuration }, user)
  expect(read.routeHostId).toBe('selected'); expect(read.configuration).toEqual(f.configuration); expect(read.ssh).toBeNull()
  expect(read.target.state).toBe('available')
  if (read.target.state !== 'available' || read.observer.state !== 'available') throw new Error('Actual OS interfaces must be readable')
  expect(read.target.value.sample.owner).toEqual(f.owner)
  expect(read.target.value.requestDurationMs).toBeGreaterThanOrEqual(0)
  expect(read.observer.value.processId).toBe(process.pid)
  expect(read.target.value.sample.interfaces.some(item => item.internal)).toBe(true)
  expect(JSON.stringify(read)).not.toContain('mac')
  expect(connect).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(sessions).not.toHaveBeenCalled()
  expect(f.unrelated.runtimeOwnerIdentity).not.toHaveBeenCalled()
  const path = join(f.root, 'network.sock')
  const server = new AgentMuxControlServer({ ...f.options, socketPath: path }); await server.start(); closes.push(() => server.stop())
  const cli = await runCompiledObjectCli(['settings', 'hosts', 'network', '--host', 'selected'], objectCliEnvironment(f.root, { AGENTMUX_RPC_ENDPOINT: `unix:${path}` }))
  expect(cli).toMatchObject({ code: 0 })
  const body = JSON.parse(cli.stdout)
  expect(body.result).toMatchObject({ routeHostId: 'selected', target: { state: 'available', value: { sample: { owner: f.owner } } } })
  expect(await parseSettingsCommand(['hosts', 'network', '--host', 'selected'])).toEqual({ method: 'settings.hosts.network', params: { hostId: 'selected' } })
})
it('network: one source failure and an owner generation mismatch never erase independent readable facts', async () => {
  const f = await fixture()
  const read = await observeHostNetwork('selected', f.configuration, () => f.owner, async () => { throw new Error('Original network reply unavailable') })
  expect(read.target).toMatchObject({ state: 'unavailable', message: 'Original network reply unavailable' })
  expect(read.observer.state).toBe('available')
  const changed = await observeHostNetwork('selected', f.configuration, () => f.owner, async fence => ({
    owner: { ...f.owner, ownerInstanceId: fence.ownerInstanceId + '-replacement' }, observedAt: Date.now(), interfaces: []
  }))
  expect(changed.target.state).toBe('unavailable')
  expect(changed.observer.state).toBe('available')
  const connect = vi.spyOn(f.client, 'connect')
  await expect(f.service.call('settings.hosts.network', { hostId: 'absent' }, user)).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  expect(connect).not.toHaveBeenCalled()
})
it('network: cancels only the requested read and refuses a same-ID configuration change before publishing', async () => {
  const f = await fixture(), controller = new AbortController()
  let entered = false
  const pending = observeHostNetwork('selected', f.configuration, () => f.owner, async () => { entered = true; return await new Promise(() => {}) }, controller.signal)
  await vi.waitFor(() => expect(entered).toBe(true)); controller.abort()
  await expect(pending).rejects.toBeDefined()
  const original = f.hosted.call.bind(f.hosted)
  vi.spyOn(f.hosted, 'call').mockImplementation(async (method, params, context) => {
    const result = await original(method, params, context)
    if (method === 'runtime.network.inspect') f.replaceConfiguration()
    return result
  })
  await expect(f.service.call('settings.hosts.network', { hostId: 'selected', expected: f.configuration }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.inner.kernel.attach).not.toHaveBeenCalled()
})
it('network: result parsing refuses mixed targets, negative timing and extra private proxy fields', async () => {
  const f = await fixture(), result = await f.service.call('settings.hosts.network', { hostId: 'selected' }, user)
  expect(() => parseHostNetworkObservation({ ...result, routeHostId: 'another' }, 'selected')).toThrow()
  if (result.target.state !== 'available') throw new Error('Actual original target is required')
  expect(() => parseHostNetworkObservation({ ...result, target: { ...result.target, value: { ...result.target.value, requestDurationMs: -1 } } }, 'selected')).toThrow()
  expect(() => parseHostNetworkObservation({ ...result, proxyCommand: 'private-command' }, 'selected')).toThrow()
})
it('network: OpenSSH machine configuration keeps jump order and policy without revealing an opaque proxy command', () => {
  const base = 'hostname compute.internal\nuser worker\nport 2200\nserveraliveinterval 17\nserveralivecountmax 4\ntcpkeepalive yes\n'
  expect(parseSshNetworkConfiguration(base + 'proxyjump entry@bastion:2222,ssh://relay@[2001:db8::7]:2223\n')).toMatchObject({
    hostname: 'compute.internal', serverAliveInterval: 17, serverAliveCountMax: 4, proxy: 'jump',
    jumps: [{ host: 'bastion', user: 'entry', port: 2222 }, { host: '2001:db8::7', user: 'relay', port: 2223 }]
  })
  const opaque = parseSshNetworkConfiguration(base + 'proxycommand private-command --secret-value\n')
  expect(opaque.proxy).toBe('command'); expect(opaque.jumps).toEqual([])
  expect(JSON.stringify(opaque)).not.toContain('private-command')
  expect(() => parseSshNetworkConfiguration(base + 'port 22\n')).toThrow()
  expect(() => parseSshNetworkConfiguration(base.replace('serveraliveinterval 17\n', ''))).toThrow()
})
it.skipIf(process.env.AGENTMUX_REAL_SSH_ROUTE_E2E !== '1')('network: real SSH keeps its existing channel and input while a new configuration evaluation reveals a different configured jump', async () => {
  const scope = await headlessFixture(); closes.push(scope.cleanup)
  const ssh = await sshRouteFixture(); closes.push(ssh.cleanup)
  const route = await ssh.route(); vi.stubEnv('PATH', ssh.root + ':' + process.env.PATH)
  const target = { ...route, hostId: 'network-route', remoteSocketPath: scope.socketPath }
  const client = await connectSshAgentMux({ expectedRuntimeId: scope.owner.runtimeId, target }); closes.push(() => client.dispose())
  const native = client.runtimeIdentity()
  const run = await client.createTerminal({ createOperationId: 'network-original-terminal', workspacePath: scope.root, command: process.execPath,
    args: ['-e', "process.stdin.setRawMode(true);process.stdout.write('ready');process.stdin.on('data',b=>process.stdout.write(b));setInterval(()=>{},1000)"] })
  await until(() => client.listRuns(), values => values.some(value => value.runId === run.runId && value.latestOutputBytes === 5), 'original network observation terminal')
  await appendFile(join(ssh.root, 'client_config'), '\nHost 127.0.0.1\n ServerAliveInterval 17\n ServerAliveCountMax 4\n ProxyJump configured-transit.invalid\n')
  const configuration = { ...route, id: target.hostId, kind: 'ssh', label: 'Private SSH network', remoteSocketPath: scope.socketPath, runtimeId: scope.owner.runtimeId }
  // The fixture's stop function is not part of a persisted Host configuration.
  const { stop: _stop, ...saved } = configuration
  const options = { coreClients: () => [{ hostId: target.hostId, client }], hostConfiguration: () => saved }
  const service = new AgentMuxRpcService(options); closes.push(() => service.dispose())
  const channelsBefore = await ssh.channelPids()
  const result = await service.call('settings.hosts.network', { hostId: target.hostId, expected: saved }, user)
  expect(result.target).toMatchObject({ state: 'available', value: { sample: { owner: { runtimeId: scope.owner.runtimeId, ownerInstanceId: scope.owner.ownerInstanceId } } } })
  expect(result.ssh).toMatchObject({ state: 'available', value: { serverAliveInterval: 17, serverAliveCountMax: 4, proxy: 'jump', jumps: [{ host: 'configured-transit.invalid' }] } })
  // Only the explicit -G evaluation spawns another ssh process; the RPC uses the original channel.
  expect((await ssh.channelPids()).length).toBe(channelsBefore.length + 1)
  await client.writeTerminal(run, { operationId: 'network-after-read', ownerInstanceId: native.instanceId, expectedByte: 0, data: 'N' })
  await until(() => client.listRuns(), values => values.some(value => value.runId === run.runId && value.pid === run.pid && value.acceptedInputBytes === 1), 'healthy original input after network read')
  const rpcPath = join(scope.root, 'network-aggregate.sock'), server = new AgentMuxControlServer({ ...options, socketPath: rpcPath })
  await server.start(); closes.push(() => server.stop())
  const cli = await runCompiledObjectCli(['settings', 'hosts', 'network', '--host', target.hostId], objectCliEnvironment(scope.root, { AGENTMUX_RPC_ENDPOINT: `unix:${rpcPath}`, PATH: process.env.PATH! }))
  expect(cli.code).toBe(0)
  expect(JSON.parse(cli.stdout).result.target.state).toBe('available')
  await client.stopTerminal(run)
}, 60_000)
