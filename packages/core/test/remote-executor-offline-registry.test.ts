import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError } from '../src/errors.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { encodeHostedValue } from '../src/hosted-value.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const observationFailure = new AgentMuxError('Native Session observation is unavailable; the registry and original Runs remain intact.', 'RUNTIME_UNAVAILABLE')

async function fixture() {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  const bin = join(f.root, 'target-bin'); await mkdir(bin)
  const command = join(bin, 'claude'); await writeFile(command, '#!/bin/sh\nexit 0\n'); await chmod(command, 0o755)
  Object.assign(f.client, { hostExecutorOwner: new AgentMuxHostExecutorOwner({ path: join(f.root, 'executors.json'),
    runtimeId: 'original-runtime', catalog: () => new AgentProviderRegistry().catalog().filter(p => ['claude', 'codex'].includes(p.id)),
    environment: () => ({ PATH: bin }) }) })
  f.inner.kernel.identity = () => ({ buildIdentity: 'offline-registry', protocolVersion: 1, daemonInstanceId: 'original-daemon' })
  const connect = vi.spyOn(f.client, 'connect').mockRejectedValue(observationFailure)
  return { ...f, bin, command, connect }
}

it('actual Unix RPC and compiled settings CLI can discover and register while Session connect fails', async () => {
  const f = await fixture()
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'public.sock'), coreClients: () => [{ hostId: 'remote', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const found = await rpc.call('settings.executors.discover', { hostId: 'remote' })
  expect(found).toMatchObject({ routeHostId: 'remote', runtimeId: 'original-runtime', executors: expect.arrayContaining([
    expect.objectContaining({ executorId: 'claude', availability: 'available', executable: f.command }),
    expect.objectContaining({ executorId: 'codex', availability: 'missing' })
  ]) })
  const config = { label: 'Target wrapper', providerId: 'claude', command: f.command, args: ['--private-argument'], env: { SECRET: 'target-secret' }, injectAgentMuxGuide: false }
  const saved = await rpc.call('settings.executors.register', { hostId: 'remote', executorId: 'wrapper', input: { config } })
  expect(saved).toMatchObject({ routeHostId: 'remote', executor: { executorId: 'wrapper', availability: 'unknown' } })
  expect(JSON.stringify(saved)).not.toMatch(/target-secret|private-argument|"env"|"args"/)
  const cli = (args: string[], stdin = '') => runCompiledObjectCli(['--endpoint', `unix:${server.path}`, ...args], objectCliEnvironment(f.root), stdin)
  const read = await cli(['settings', 'executors', 'discover', '--host', 'remote'])
  expect(read.code, read.stderr).toBe(0)
  expect(JSON.parse(read.stdout).result.executors).toEqual(expect.arrayContaining([
    expect.objectContaining({ executorId: 'wrapper', availability: 'available', executable: f.command })
  ]))
  const registered = await cli(['settings', 'executors', 'register', 'unresolved', '--host', 'remote', '--input', '-'],
    JSON.stringify({ config: { ...config, command: 'claude', env: { PATH: '.' } } }))
  expect(registered.code, registered.stderr).toBe(0)
  const checked = await rpc.call('settings.executors.discover', { hostId: 'remote' })
  expect(checked.executors.find(e => e.executorId === 'unresolved')).toMatchObject({ availability: 'check-failed', cause: expect.any(Object) })
  const unchecked = await rpc.call('settings.executors.discover', { hostId: 'remote', refresh: false })
  expect(unchecked.executors.every(e => e.availability === 'unknown')).toBe(true)
  expect(f.connect).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the real Hosted SDK and public target route retain control identity/auth when Session observation cannot open', async () => {
  const f = await fixture(), owner = hostedTestOwner(f.client)
  const hostedService = new AgentMuxHostedRuntimeService(f.client, null, () => owner); cleanups.push(() => hostedService.dispose())
  // The durable registry is independent of opening a Session observation. No synthetic healthy snapshot is supplied.
  vi.spyOn(f.client, 'agentSessions').mockImplementation(() => { throw observationFailure })
  const target = new AgentMuxControlServer({ socketPath: join(f.root, 'target.sock'), coreClients: f.coreClients, hostedRuntime: () => hostedService })
  await target.start(); cleanups.push(() => target.stop())
  const transport = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: target.path } }); cleanups.push(() => transport.dispose())
  const hosted = await connectHostedAgentMux({ rpc: transport, waitForReady: false, forwardRpc: async (method, params, context = {}) => {
    const forwarded = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: target.path },
      ...(context.caller ? { credentials: context.caller } : {}) })
    try { return await forwarded.call(method, params, context) }
    finally { await forwarded.dispose() }
  } }); cleanups.push(() => hosted.dispose())
  await expect(hosted.connect()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  const desktop = new AgentMuxControlServer({ socketPath: join(f.root, 'desktop.sock'), coreClients: () => [{ hostId: 'remote', client: hosted }] })
  await desktop.start(); cleanups.push(() => desktop.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } }); cleanups.push(() => rpc.dispose())
  expect(await rpc.call('settings.executors.discover', { hostId: 'remote' })).toMatchObject({ routeHostId: 'remote', runtimeId: owner.runtimeId })
  const saved = await rpc.call('settings.executors.register', { hostId: 'remote', executorId: 'hosted-wrapper', input: { config: {
    label: 'Hosted target', providerId: 'claude', command: f.command, args: [], env: {}, injectAgentMuxGuide: false
  } } })
  expect(saved.executor).toMatchObject({ executorId: 'hosted-wrapper', command: f.command })
  await expect(hosted.statusAgent('caller')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  const list = vi.spyOn(f.client, 'listHostExecutors'), configure = vi.spyOn(f.client, 'configureHostExecutor')
  await expect(transport.call('runtime.invoke', { consumerId: 'consumer-invalid', fence: { runtimeId: owner.runtimeId, ownerInstanceId: 'old-owner' },
    invocation: encodeHostedValue({ method: 'listHostExecutors', args: [] }) })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  const forged = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path }, credentials: { ...f.credentials, capability: 'forged' } })
  cleanups.push(() => forged.dispose())
  await expect(forged.call('settings.executors.discover', { hostId: 'remote' })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  await expect(forged.call('settings.executors.register', { hostId: 'remote', executorId: 'forged', input: { config: {
    label: 'Forbidden', providerId: 'claude', command: f.command, args: [], env: {}, injectAgentMuxGuide: false
  } } })).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(list).not.toHaveBeenCalled(); expect(configure).not.toHaveBeenCalled()
  expect(await f.client.readAgentSessions()).toHaveLength(2)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
