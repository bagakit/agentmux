import { afterEach, expect, it, vi } from 'vitest'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const user = { transport: 'unix' as const, principal: { kind: 'user' as const, id: 'transport-user' } }
async function fixture() {
  const f = await rpcOwnerFixture(); cleanups.push(f.close)
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  Object.assign(f.client, { creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: f.root, runtimeId: 'local-runtime' }) })
  const result = { routeHostId: 'remote', runtimeId: 'remote-runtime', executors: [] }
  const forward = vi.fn(async () => result)
  const service = new AgentMuxRpcService({ coreClients: f.coreClients, forwardControl: forward as never })
  cleanups.push(() => service.dispose())
  return { ...f, result, forward, service }
}

it('compiled CLI crosses the Host/Desktop Unix bridge to the target inventory and original trust owner', async () => {
  const local = await fixture(), remote = await rpcOwnerFixture(); cleanups.push(remote.close)
  vi.spyOn(remote.client, 'connect').mockResolvedValue()
  const bin = join(remote.root, 'bin'); await mkdir(bin)
  const command = join(bin, 'claude'); await writeFile(command, '#!/bin/sh\nexit 0\n'); await chmod(command, 0o755)
  Object.assign(remote.client, {
    creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: remote.root, runtimeId: 'remote-runtime' }),
    hostExecutorOwner: new AgentMuxHostExecutorOwner({ path: join(remote.root, 'executors.json'), runtimeId: 'remote-runtime',
      catalog: () => new AgentProviderRegistry().catalog().filter(p => p.id === 'claude'), environment: () => ({ PATH: bin }) })
  })
  remote.inner.kernel.identity = () => ({ buildIdentity: 'remote-trust', protocolVersion: 1, daemonInstanceId: 'remote-trust' })
  const hosted = new AgentMuxHostedRuntimeService(remote.client, null, () => ({ runtimeId: 'remote-runtime',
    ownerInstanceId: 'remote-epoch', protocolVersion: 1, processId: process.pid,
    ctxmux: remote.client.runtimeIdentity(), availability: 'connected' }))
  cleanups.push(() => hosted.dispose())
  const targetServer = new AgentMuxControlServer({ socketPath: join(remote.root, 'target.sock'), coreClients: remote.coreClients,
    hostedRuntime: () => hosted })
  await targetServer.start(); cleanups.push(() => targetServer.stop())
  const targetRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: targetServer.path } })
  cleanups.push(() => targetRpc.dispose())
  const remoteClient = await connectHostedAgentMux({ rpc: targetRpc })
  cleanups.push(() => remoteClient.dispose())
  const gui = new AgentMuxControlServer({ socketPath: join(local.root, 'gui.sock'), coreClients: () => [
    { hostId: 'local', client: local.client }, { hostId: 'remote', client: remoteClient }
  ] })
  await gui.start(); cleanups.push(() => gui.stop())
  // Same public connection and credential-preserving forwarding as startAgentMuxHost.
  const forward = vi.fn(async (method, params, context) => {
    const desktop = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: gui.path },
      ...(context.caller ? { credentials: context.caller } : {}) })
    try { return await desktop.call(method, params, context.signal ? { signal: context.signal } : {}) }
    finally { await desktop.dispose() }
  })
  const host = new AgentMuxControlServer({ socketPath: join(local.root, 'host.sock'), coreClients: local.coreClients, forwardControl: forward })
  await host.start(); cleanups.push(() => host.stop())
  const cli = (args: string[], stdin = '', managed = false) => runCompiledObjectCli(['--endpoint', `unix:${host.path}`, ...args],
    objectCliEnvironment(local.root, managed ? { AGENTMUX_AGENT_SESSION_ID: local.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: local.credentials.capability } : {}), stdin)
  const found = await cli(['settings', 'executors', 'discover', '--host', 'remote'], '', true)
  expect(found.code, found.stderr).toBe(0)
  expect(JSON.parse(found.stdout).result).toMatchObject({ routeHostId: 'remote', runtimeId: 'remote-runtime', executors: [
    { executorId: 'claude', availability: 'available', executable: command }
  ] })
  expect(forward.mock.calls[0]![2].caller).toEqual(local.credentials)
  const config = { label: 'Remote wrapper', providerId: 'claude', command, args: [], env: {}, injectAgentMuxGuide: false }
  const saved = await cli(['settings', 'executors', 'register', 'wrapper', '--host', 'remote', '--input', '-'], JSON.stringify({ config }), true)
  expect(saved.code, saved.stderr).toBe(0)
  expect(JSON.parse(saved.stdout).result).toMatchObject({ routeHostId: 'remote', executor: { executorId: 'wrapper', command } })
  const source = await local.client.agentCreationAuthority(), target = await remote.client.agentCreationAuthority()
  const input = { sourceRuntimeId: source.runtimeId, publicKey: source.publicKey,
    targetRuntimeId: target.runtimeId, targetKeyFingerprint: target.fingerprint }
  const count = forward.mock.calls.length
  const rejected = await cli(['settings', 'hosts', 'trust-source', '--host', 'remote', '--input', '-'], JSON.stringify(input), true)
  expect(rejected.code).toBe(1); expect(JSON.parse(rejected.stderr).error.code).toBe('CONTROL_PERMISSION_DENIED')
  expect(forward).toHaveBeenCalledTimes(count)
  const trust = await cli(['settings', 'hosts', 'trust-source', '--host', 'remote', '--input', '-'], JSON.stringify(input))
  expect(trust.code, trust.stderr).toBe(0)
  expect(JSON.parse(trust.stdout).result.source.registeredBy).toEqual({ kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` })
  const read = await cli(['settings', 'hosts', 'trusted-sources', '--host', 'remote'], '', true)
  expect(read.code, read.stderr).toBe(0)
  expect(JSON.parse(read.stdout).result).toMatchObject({ routeHostId: 'remote', authority: { runtimeId: 'remote-runtime' },
    sources: [{ sourceRuntimeId: source.runtimeId, publicKey: source.publicKey, targetRuntimeId: target.runtimeId }] })
  expect(await local.client.listTrustedCreationSources()).toEqual([])
  expect(local.inner.kernel.stop).not.toHaveBeenCalled(); expect(remote.inner.kernel.stop).not.toHaveBeenCalled()
})

it('delegates only absent routes, validates returned ownership, and preserves the original failure without a retry', async () => {
  const f = await fixture(), controller = new AbortController(), context = { ...user, signal: controller.signal, caller: f.credentials }
  expect(await f.service.call('settings.executors.discover', { hostId: 'remote' }, context)).toEqual(f.result)
  expect(f.forward).toHaveBeenCalledExactlyOnceWith('settings.executors.discover', { hostId: 'remote' }, context)
  f.forward.mockResolvedValueOnce({ ...f.result, routeHostId: 'another' })
  await expect(f.service.call('settings.executors.discover', { hostId: 'remote' }, user)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  const failure = new AgentMuxError('Original target is unavailable; keep its known choices.', 'RUNTIME_UNAVAILABLE')
  f.forward.mockRejectedValueOnce(failure)
  await expect(f.service.call('settings.executors.discover', { hostId: 'remote' }, user)).rejects.toBe(failure)
  expect(f.forward).toHaveBeenCalledTimes(3)
  controller.abort()
  await expect(f.service.call('settings.executors.discover', { hostId: 'remote' }, context)).rejects.toBeDefined()
  expect(f.forward).toHaveBeenCalledTimes(3)
  f.forward.mockClear()
  await f.service.call('settings.hosts.trusted-sources', { hostId: 'local' }, user)
  expect(f.forward).not.toHaveBeenCalled()
  vi.spyOn(f.client, 'connect').mockRejectedValueOnce(failure)
  await expect(f.service.call('settings.hosts.trusted-sources', { hostId: 'local' }, user)).rejects.toBe(failure)
  expect(f.forward).not.toHaveBeenCalled()
  const duplicate = new AgentMuxRpcService({ coreClients: () => [...f.coreClients(), ...f.coreClients()], forwardControl: f.forward as never })
  await expect(duplicate.call('settings.hosts.trusted-sources', { hostId: 'local' }, user)).rejects.toMatchObject({ code: 'AMBIGUOUS_AGENT_SESSION' })
  expect(f.forward).not.toHaveBeenCalled(); await duplicate.dispose()
})

it('refuses invalid authors and non-user source trust before the bridge can acquire a new Unix user principal', async () => {
  const f = await fixture(), input = { hostId: 'remote', input: { sourceRuntimeId: 'source', publicKey: 'invalid-key',
    targetRuntimeId: 'target', targetKeyFingerprint: 'a'.repeat(64) } }
  for (const context of [{}, { principal: { kind: 'device' as const, id: 'phone' } }, { ...user, caller: f.credentials }]) {
    await expect(f.service.call('settings.hosts.trust-source', input, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  await expect(f.service.call('settings.executors.discover', { hostId: 'remote' }, { caller: { ...f.credentials, capability: 'forged' } }))
    .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(f.forward).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
