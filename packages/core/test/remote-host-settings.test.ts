import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { encodeHostedValue, decodeHostedValue } from '../src/hosted-value.js'
import { parseHostSettingsParams, parseHostSettingsResult } from '../src/public-rpc-host-settings.js'
import { parseSettingsCommand } from '../src/settings-cli.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { join } from 'node:path'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { AgentMuxHostExecutorOwner } from '../src/executor-owner.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const user = { principal: { kind: 'user' as const, id: 'real-transport-user' }, transport: 'unix' as const }
async function owners() {
  const f = await rpcOwnerFixture()
  cleanups.push(f.close)
  const source = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'source'), runtimeId: 'source-runtime' })
  const target = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'target'), runtimeId: 'target-runtime' })
  Object.assign(f.client, { creationAuthority: target })
  vi.spyOn(f.client, 'connect').mockResolvedValue()
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'remote', client: f.client }] })
  cleanups.push(() => service.dispose())
  return { ...f, source, target, service, input: { sourceRuntimeId: 'source-runtime', publicKey: (await source.identity()).publicKey, targetRuntimeId: 'target-runtime', targetKeyFingerprint: (await target.identity()).fingerprint } }
}
it('routes explicit user trust to the exact Host and reads the same durable authority without exposing private keys', async () => {
  const f = await owners()
  const before = await f.service.call('settings.hosts.trusted-sources', { hostId: 'remote' }, user)
  expect(before).toMatchObject({ routeHostId: 'remote', authority: { runtimeId: 'target-runtime' }, sources: [] })
  const configured = await f.service.call('settings.hosts.trust-source', { hostId: 'remote', input: f.input }, user)
  expect(configured.source).toMatchObject({ sourceRuntimeId: 'source-runtime', targetRuntimeId: 'target-runtime', registeredBy: user.principal })
  const after = await f.service.call('settings.hosts.trusted-sources', { hostId: 'remote' }, user)
  expect(after.sources).toEqual([configured.source])
  expect(JSON.stringify(after)).not.toMatch(/privateKey|BEGIN PRIVATE/)
  await expect(f.service.call('settings.hosts.trust-source', { hostId: 'unknown', input: f.input }, user)).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  expect(await f.target.listTrusted()).toEqual([configured.source])
})
it('refuses a route rebound after review at the target owner before any pin is persisted', async () => {
  const f = await owners()
  const replacement = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'replacement'), runtimeId: 'replacement-runtime' })
  Object.assign(f.client, { creationAuthority: replacement })
  await expect(f.service.call('settings.hosts.trust-source', { hostId: 'remote', input: f.input }, user))
    .rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
  expect(await replacement.listTrusted()).toEqual([])
  expect(await f.target.listTrusted()).toEqual([])
})
it('refuses Agent, device, missing and self-reported user principals before a trust write', async () => {
  const f = await owners(), trust = vi.spyOn(f.client, 'trustCreationSource')
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: f.client }] })
  cleanups.push(() => service.dispose())
  expect((await f.client.authorizeRetainedAgentCaller(f.credentials.capability, f.credentials.agentSessionId)).agentSessionId).toBe(f.credentials.agentSessionId)
  for (const context of [{}, { principal: { kind: 'device' as const, id: 'device' } },
    { ...user, caller: f.credentials }, { ...user, caller: { agentSessionId: 'forged', capability: 'forged' } }]) {
    await expect(service.call('settings.hosts.trust-source', { hostId: 'local', input: f.input }, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  expect(() => parseHostSettingsParams('settings.hosts.trust-source', { hostId: 'remote', input: { ...f.input, principal: user.principal } })).toThrow()
  expect(trust).not.toHaveBeenCalled()
  expect(await f.target.listTrusted()).toEqual([])
})
it('Hosted trust consumes one input and its real user context; wire principals cannot approve themselves', async () => {
  const f = await owners()
  f.inner.kernel.identity = () => ({ buildIdentity: 'trust-fixture', protocolVersion: 1, daemonInstanceId: 'trust-fixture' })
  const owner = { runtimeId: 'target-runtime', ownerInstanceId: 'epoch', protocolVersion: 1 as const, processId: process.pid,
    ctxmux: f.client.runtimeIdentity(), availability: 'connected' as const }
  const hosted = new AgentMuxHostedRuntimeService(f.client, null, () => owner)
  cleanups.push(() => hosted.dispose())
  const fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }, consumerId = 'consumer'
  const subscription = await hosted.subscribe('runtime.events', { consumerId, fence }, () => {})
  cleanups.push(() => subscription.dispose())
  const invoke = (args: unknown[], context = {}) => hosted.call('runtime.invoke', { consumerId, fence,
    invocation: encodeHostedValue({ method: 'trustCreationSource', args }) }, context)
  for (const context of [{}, { principal: { kind: 'device', id: 'device' } }, { ...user, caller: f.credentials }]) {
    await expect(invoke([f.input], context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  }
  await expect(invoke([f.input, user.principal], user)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(invoke([{ ...f.input, principal: user.principal }], user)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(hosted.call('runtime.invoke', { consumerId: 'bad:consumer', fence,
    invocation: encodeHostedValue({ method: 'trustCreationSource', args: [f.input] }) }, user))
    .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  for (const id of ['', 'bad\nprincipal', 'bad\0principal']) {
    await expect(invoke([f.input], { ...user, principal: { kind: 'user', id } }))
      .rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  }
  expect(await f.target.listTrusted()).toEqual([])
  const result = await invoke([f.input], user) as { value: unknown }
  expect(decodeHostedValue(result.value)).toMatchObject({ targetRuntimeId: 'target-runtime', registeredBy: user.principal })
})
it('actual Unix users approve through the Desktop route and Hosted target, with durable target attribution', async () => {
  const f = await owners()
  f.inner.kernel.identity = () => ({ buildIdentity: 'trust-unix', protocolVersion: 1, daemonInstanceId: 'trust-unix' })
  const owner = { runtimeId: 'target-runtime', ownerInstanceId: 'target-epoch', protocolVersion: 1 as const,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' as const }
  const hosted = new AgentMuxHostedRuntimeService(f.client, null, () => owner)
  cleanups.push(() => hosted.dispose())
  const target = new AgentMuxControlServer({ socketPath: join(f.root, 'target.sock'), coreClients: f.coreClients,
    hostedRuntime: () => hosted })
  await target.start(); cleanups.push(() => target.stop())
  const targetRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: target.path } })
  cleanups.push(() => targetRpc.dispose())
  const remote = await connectHostedAgentMux({ rpc: targetRpc })
  cleanups.push(() => remote.dispose())
  const desktop = new AgentMuxControlServer({ socketPath: join(f.root, 'desktop.sock'), coreClients: () => [
    ...f.coreClients(), { hostId: 'remote', client: remote }
  ] })
  await desktop.start(); cleanups.push(() => desktop.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } })
  cleanups.push(() => rpc.dispose())
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path }, credentials: f.credentials })
  cleanups.push(() => managed.dispose())
  const params = { hostId: 'remote', input: f.input }
  await expect(managed.call('settings.hosts.trust-source', params)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await f.target.listTrusted()).toEqual([])
  const result = await rpc.call('settings.hosts.trust-source', params)
  expect(result.source.registeredBy).toEqual({ kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` })
  expect(result.source).toMatchObject({ sourceRuntimeId: f.input.sourceRuntimeId, targetRuntimeId: owner.runtimeId })
  const read = await managed.call('settings.hosts.trusted-sources', { hostId: 'remote' })
  expect(read.sources).toEqual([result.source])
  const reloaded = new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'target'), runtimeId: owner.runtimeId })
  expect(await reloaded.listTrusted()).toEqual(read.sources)
  await expect(rpc.call('settings.hosts.trust-source', { ...params, input: { ...f.input, targetKeyFingerprint: '0'.repeat(64) } }))
    .rejects.toMatchObject({ code: 'AGENT_CREATION_TARGET_MISMATCH' })
  expect(await f.target.listTrusted()).toEqual(read.sources)
  expect(await f.source.listTrusted()).toEqual([])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.inner.kernel.attach).not.toHaveBeenCalled()
})
it('strict CLI/help and result consumers retain exact Host and source identities', async () => {
  const f = await owners(), authority = await f.target.identity(), source = await f.target.trust(f.input, user.principal)
  expect(await parseSettingsCommand(['hosts', 'trusted-sources', '--host', '--help'])).toEqual({ method: 'settings.hosts.trusted-sources', params: { hostId: '--help' } })
  expect(agentMuxCommandHelp('settings.hosts.trust-source')).toContain('--host <id> --input <file|->')
  expect(agentMuxCommandHelp('settings.hosts.trust-source')).toContain('targetKeyFingerprint')
  const input = { hostId: 'remote', input: f.input }, result = { routeHostId: 'remote', authority, source }
  expect(parseHostSettingsResult('settings.hosts.trust-source', result, input)).toEqual(result)
  for (const malformed of [{ ...result, routeHostId: 'local' }, { ...result, authority: { ...authority, fingerprint: '0'.repeat(64) } }, { ...result, source: { ...source, targetRuntimeId: 'another' } },
    { ...result, source: { ...source, sourceRuntimeId: 'forged' } }, { ...result, source: { ...source, publicKey: 'forged' } }]) {
    expect(() => parseHostSettingsResult('settings.hosts.trust-source', malformed, input)).toThrow()
  }
})
it('public Unix discovery and registration consume the executing Host owner, preserve four states and exclude credentials', async () => {
  const f = await owners(), bin = join(f.root, 'remote-bin')
  await mkdir(bin); await writeFile(join(bin, 'claude'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'claude'), 0o755)
  const owner = new AgentMuxHostExecutorOwner({ path: join(f.root, 'executors.json'), runtimeId: 'target-runtime',
    catalog: () => new AgentProviderRegistry().catalog().filter(provider => ['claude', 'codex'].includes(provider.id)), environment: () => ({ PATH: bin }) })
  Object.assign(f.client, { hostExecutorOwner: owner })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'public.sock'), coreClients: () => [{ hostId: 'remote', client: f.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const found = await rpc.call('settings.executors.discover', { hostId: 'remote' })
  expect(found).toMatchObject({ routeHostId: 'remote', runtimeId: 'target-runtime', executors: [
    expect.objectContaining({ executorId: 'codex', availability: 'missing' }), expect.objectContaining({ executorId: 'claude', availability: 'available', executable: join(bin, 'claude') })
  ] })
  const saved = await rpc.call('settings.executors.register', { hostId: 'remote', executorId: 'custom', input: { config: {
    label: 'Remote wrapper', providerId: 'claude', command: 'claude', args: ['--saved-argument'], env: { SECRET: 'remote-private' }, injectAgentMuxGuide: true
  } } })
  expect(saved).toMatchObject({ routeHostId: 'remote', runtimeId: 'target-runtime', executor: { executorId: 'custom', source: 'registered' } })
  expect(JSON.stringify(saved)).not.toMatch(/remote-private|saved-argument|"env"|"args"/)
  const unchecked = await rpc.call('settings.executors.discover', { hostId: 'remote', refresh: false })
  expect(unchecked.executors.every(executor => executor.availability === 'unknown')).toBe(true)
  expect(await parseSettingsCommand(['executors', 'discover', '--host', 'remote'])).toEqual({ method: 'settings.executors.discover', params: { hostId: 'remote', refresh: true } })
  await expect(rpc.call('settings.executors.register', { hostId: 'remote', executorId: 'custom', input: { config: {
    label: 'Overwrite', providerId: 'claude', command: fixturePath("local/copied/path"), args: [], env: {}, injectAgentMuxGuide: true
  } } })).rejects.toMatchObject({ code: 'EXECUTOR_CONFIGURATION_CONFLICT' })
})
it('two public route Hosts resolve the same registered Executor ID to their own command and runtime', async () => {
  const first = await owners(), second = await owners()
  for (const [fixture, runtimeId] of [[first, 'first-runtime'], [second, 'second-runtime']] as const) {
    const bin = join(fixture.root, 'bin')
    await mkdir(bin); await writeFile(join(bin, 'wrapper'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'wrapper'), 0o755)
    const owner = new AgentMuxHostExecutorOwner({ path: join(fixture.root, 'executors.json'), runtimeId,
      catalog: () => new AgentProviderRegistry().catalog().filter(provider => provider.id === 'claude'), environment: () => ({ PATH: bin }) })
    Object.assign(fixture.client, { hostExecutorOwner: owner })
    await fixture.client.configureHostExecutor({ executorId: 'same-id', config: { label: runtimeId, providerId: 'claude', command: join(bin, 'wrapper'), args: [], env: {}, injectAgentMuxGuide: false } })
  }
  const server = new AgentMuxControlServer({ socketPath: join(first.root, 'two-hosts.sock'), coreClients: () => [
    { hostId: 'first', client: first.client }, { hostId: 'second', client: second.client }
  ] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanups.push(() => rpc.dispose())
  const a = await rpc.call('settings.executors.discover', { hostId: 'first' }), b = await rpc.call('settings.executors.discover', { hostId: 'second' })
  expect(a).toMatchObject({ routeHostId: 'first', runtimeId: 'first-runtime', executors: expect.arrayContaining([
    expect.objectContaining({ executorId: 'same-id', command: join(first.root, 'bin/wrapper'), executable: join(first.root, 'bin/wrapper'), availability: 'available' })
  ]) })
  expect(b).toMatchObject({ routeHostId: 'second', runtimeId: 'second-runtime', executors: expect.arrayContaining([
    expect.objectContaining({ executorId: 'same-id', command: join(second.root, 'bin/wrapper'), executable: join(second.root, 'bin/wrapper'), availability: 'available' })
  ]) })
})
it('public inventory accepts the owner-valid registered set together with Provider defaults', () => {
  const executors = Array.from({ length: 260 }, (_, index) => ({ executorId: `host-${index}`, label: `Host ${index}`, providerId: 'claude', command: 'claude',
    source: index < 256 ? 'registered' : 'provider-default', configRevision: `revision-${index}`, availability: 'unknown' }))
  expect(parseHostSettingsResult('settings.executors.discover', { routeHostId: 'remote', runtimeId: 'target', executors }, { hostId: 'remote' }).executors).toHaveLength(260)
})
