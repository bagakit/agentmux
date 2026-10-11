import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { AgentMuxError } from '../src/errors.js'
import { parseHostRuntimeObservation, observeHostRuntime } from '../src/host-runtime-observation.js'
import { parseSettingsCommand } from '../src/settings-cli.js'
import { agentMuxCommandHelp } from '../src/agentmux-cli-help.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import type { AgentMuxRuntimeOwnerIdentity } from '../src/hosted-client-contract.js'
import type { AgentMuxRpcCorePort } from '../src/public-rpc-service.js'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const user = { principal: { kind: 'user' as const, id: 'original-user' }, transport: 'unix' as const }
const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await rpcOwnerFixture()
  cleanup.push(f.close)
  const owner: AgentMuxRuntimeOwnerIdentity = { runtimeId: 'semantic-runtime', ownerInstanceId: 'core-instance', protocolVersion: 2,
    processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }
  const resource = { observedAt: _historyFixtureEpoch(0, 1, 234), runCount: 4, runningRuns: 1, terminatedRuns: 3,
    terminatedUnattachedRuns: 2, attachments: 2, retainedOutputBytes: 600 }
  const resources = vi.fn(async () => ({ ...resource }))
  f.inner.kernel.resourceSnapshot = resources
  const readOwner = vi.fn(() => owner)
  Object.assign(f.client, { runtimeOwnerIdentity: readOwner })
  const unrelated = { runtimeIdentity: vi.fn(() => { throw new Error('Unrelated identity must not be inspected') }),
    runtimeDiagnostics: vi.fn(), runtimeResourceSnapshot: vi.fn() } as unknown as AgentMuxRpcCorePort
  let configuration = { id: 'selected', kind: 'ssh', label: 'Original connection', hostname: 'original.invalid' }
  const service = new AgentMuxRpcService({ hostConfiguration: id => id === 'selected' ? configuration : null, coreClients: () => [{ hostId: 'selected', client: f.client }, { hostId: 'unrelated', client: unrelated }] })
  cleanup.push(() => service.dispose())
  return { ...f, owner, resource, resources, readOwner, unrelated, service, get configuration() { return configuration }, replaceConfiguration() { configuration = { ...configuration, hostname: 'replacement.invalid' } } }
}
it('reads one exact route, keeps producer time, and preserves source failures independently without lifecycle work', async () => {
  const f = await fixture(), connect = vi.spyOn(f.client, 'connect'), connectRuntime = vi.spyOn(f.client, 'connectRuntime')
  const sessions = vi.spyOn(f.client, 'readAgentSessions'), identity = vi.spyOn(f.client, 'runtimeIdentity')
  const before = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(before).toMatchObject({ routeHostId: 'selected', owner: { state: 'available', value: f.owner },
    nativeIdentity: { state: 'available', value: { instanceId: 'fixture-runtime' } },
    diagnostics: { state: 'available' }, resources: { state: 'available', value: f.resource } })
  expect(before.resources.readAt).toBeGreaterThan(f.resource.observedAt)
  f.resources.mockRejectedValueOnce(new AgentMuxError('Original resource page unavailable', 'CTXMUX_DISCONNECTED'))
  const partial = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(partial.resources).toMatchObject({ state: 'unavailable', code: 'CTXMUX_DISCONNECTED', message: 'Original resource page unavailable' })
  expect(partial.diagnostics.state).toBe('available'); expect(partial.nativeIdentity.state).toBe('available')
  expect(connect).not.toHaveBeenCalled(); expect(connectRuntime).not.toHaveBeenCalled(); expect(sessions).not.toHaveBeenCalled()
  expect(f.unrelated.runtimeIdentity).not.toHaveBeenCalled(); expect(f.unrelated.runtimeResourceSnapshot).not.toHaveBeenCalled()
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  expect(identity).toHaveBeenCalledTimes(4)
  await expect(f.service.call('settings.hosts.inspect', { hostId: 'absent' }, user)).rejects.toMatchObject({ code: 'UNKNOWN_HOST' })
  await expect(f.service.call('settings.hosts.inspect', { hostId: 'selected', guessed: true } as never, user)).rejects.toBeDefined()
})
it('does not create a default Runtime when no existing public service client was supplied', async () => {
  // No borrowed owner exists in this constructor. Thin forwarders that explicitly
  // provide coreClients: () => [] still take their original forwarding path.
  const runtime = await import('../src/runtime-client.js')
  const connect = vi.spyOn(runtime, 'connectLocalAgentMux').mockRejectedValue(new Error('A passive observation must never connect'))
  const service = new AgentMuxRpcService({})
  cleanup.push(() => service.dispose())
  await expect(service.call('settings.hosts.inspect', { hostId: 'local' }, user)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  await expect(service.call('settings.hosts.inspect', { hostId: 'local' }, { caller: { agentSessionId: 'exact-retained-agent', capability: 'original-capability' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(connect).not.toHaveBeenCalled()
})
it('keeps independent readable Native facts when semantic observation is unverified and preserves missing sources', async () => {
  const f = await fixture()
  f.owner.availability = 'unverified'
  const unavailable = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(unavailable.owner).toMatchObject({ state: 'available', value: { availability: 'unverified' } })
  expect(unavailable.resources).toMatchObject({ state: 'available', value: f.resource })
  expect(unavailable.nativeIdentity.state).toBe('available')
  expect(f.resources).toHaveBeenCalledOnce()
  f.owner.availability = 'connected'; f.inner.connected = false
  const missing = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(missing.owner.state).toBe('available')
  expect(missing.diagnostics).toMatchObject({ state: 'unavailable', code: 'CTXMUX_DISCONNECTED' })
  expect(missing.resources).toMatchObject({ state: 'unavailable', code: 'CTXMUX_DISCONNECTED' })
})
it('validates each original source independently and keeps readable facts when another reply is malformed or newer than the identity cache', async () => {
  const f = await fixture()
  const original = await f.client.runtimeDiagnostics()
  const diagnostic = vi.spyOn(f.client, 'runtimeDiagnostics')
  diagnostic.mockResolvedValueOnce({ ...original, ctxmux: { ...original.ctxmux, ready: 'not-a-fact' } } as never)
  const malformed = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(malformed.diagnostics).toMatchObject({ state: 'unavailable', code: 'CONTROL_PROTOCOL_ERROR' })
  expect(malformed.resources).toMatchObject({ state: 'available', value: f.resource })
  diagnostic.mockResolvedValueOnce({ ...original, ctxmux: { ...original.ctxmux, serving: { ...original.ctxmux.serving, instanceId: 'new-serving-native' } } })
  const newer = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(newer.diagnostics).toMatchObject({ state: 'available', value: { ctxmux: { serving: { instanceId: 'new-serving-native' } } } })
  expect(newer.nativeIdentity).toMatchObject({ state: 'unavailable', code: 'NATIVE_IDENTITY_UNCONFIRMED' })
  expect(newer.resources).toMatchObject({ state: 'unavailable', code: 'NATIVE_IDENTITY_UNCONFIRMED' })
  f.owner.ctxmux = { ...f.owner.ctxmux!, instanceId: 'old-semantic-cache' }
  const staleOwner = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(staleOwner.owner).toMatchObject({ state: 'unavailable', code: 'RUNTIME_OWNER_UNCONFIRMED' })
  expect(staleOwner.nativeIdentity.state).toBe('available')
  expect(staleOwner.diagnostics.state).toBe('available')
  expect(staleOwner.resources).toMatchObject({ state: 'available', value: f.resource })
})
it('reports a missing final semantic confirmation without hiding independently readable Native facts', async () => {
  const f = await fixture()
  let reads = 0
  const missing = await observeHostRuntime('selected', f.client, () => ++reads === 1 ? f.owner : null)
  expect(reads).toBe(2)
  expect(missing.owner).toMatchObject({ state: 'unavailable', code: 'RUNTIME_OWNER_UNCONFIRMED' })
  expect(missing.nativeIdentity.state).toBe('available')
  expect(missing.diagnostics.state).toBe('available')
  expect(missing.resources).toMatchObject({ state: 'available', value: f.resource })
  reads = 0
  const recovered = await observeHostRuntime('selected', f.client, () => ++reads === 1 ? null : f.owner)
  expect(reads).toBe(2)
  expect(recovered.owner).toMatchObject({ state: 'available', value: f.owner })
  expect(recovered.resources.state).toBe('available')
})
it('never borrows the receiving service semantic identity for another raw route client', async () => {
  const local = await fixture(), selected = await rpcOwnerFixture(['separate-raw-route'])
  cleanup.push(selected.close)
  selected.inner.kernel.resourceSnapshot = vi.fn(async () => ({ ...local.resource }))
  const localOwner = new AgentMuxHostedRuntimeService(local.client, null, () => local.owner)
  cleanup.push(() => localOwner.dispose())
  const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'selected-raw', client: selected.client }], hostedRuntime: () => localOwner })
  cleanup.push(() => service.dispose())
  const observation = await service.call('settings.hosts.inspect', { hostId: 'selected-raw' }, user)
  expect(observation.owner).toMatchObject({ state: 'unavailable', code: 'RUNTIME_OWNER_UNCONFIRMED' })
  expect(observation.nativeIdentity.state).toBe('available')
  expect(observation.diagnostics.state).toBe('available')
  expect(observation.resources).toMatchObject({ state: 'available', value: local.resource })
})
it('cancels the exact reader promptly and does not publish mixed Native or semantic generations', async () => {
  const f = await fixture(), controller = new AbortController()
  let release!: (value: typeof f.resource) => void
  f.resources.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = f.service.call('settings.hosts.inspect', { hostId: 'selected' }, { ...user, signal: controller.signal })
  await vi.waitFor(() => expect(f.resources).toHaveBeenCalledOnce())
  controller.abort(new AgentMuxError('Original reader cancelled', 'CONTROL_CANCELLED'))
  await expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
  release(f.resource)
  const native = f.client.runtimeIdentity()
  let reads = 0
  vi.spyOn(f.client, 'runtimeIdentity').mockImplementation(() => ({ ...native, instanceId: ++reads === 1 ? native.instanceId : 'replacement-native' }))
  const changed = await observeHostRuntime('selected', f.client, f.readOwner)
  expect(changed.resources).toMatchObject({ state: 'unavailable', code: 'CTXMUX_DISCONNECTED' })
  expect(changed.nativeIdentity.state).toBe('unavailable')
  vi.restoreAllMocks()
  let ownerReads = 0
  const ownerChanged = await observeHostRuntime('selected', f.client, () => ({ ...f.owner, ownerInstanceId: ++ownerReads === 1 ? 'before' : 'after' }))
  expect(ownerChanged.resources).toMatchObject({ state: 'unavailable', code: 'RUNTIME_OWNER_CHANGED' })
})
it('checks the original saved configuration before and after a same-ID route changes, even before a client config event', async () => {
  const f = await fixture(), expected = structuredClone(f.configuration)
  let finish!: (value: typeof f.resource) => void
  f.resources.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const reading = f.service.call('settings.hosts.inspect', { hostId: 'selected', expected }, user)
  await vi.waitFor(() => expect(f.resources).toHaveBeenCalledOnce())
  f.replaceConfiguration(); finish(f.resource)
  await expect(reading).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  await expect(f.service.call('settings.hosts.inspect', { hostId: 'selected', expected }, user)).rejects.toMatchObject({ code: 'HOST_CONFIGURATION_CHANGED' })
  const current = await f.service.call('settings.hosts.inspect', { hostId: 'selected', expected: f.configuration }, user)
  expect(current.configuration).toEqual(f.configuration)
  expect(current.nativeIdentity).toMatchObject({ state: 'available', value: { instanceId: f.owner.ctxmux!.instanceId } })
})
it('strictly checks route, complete source shape, Native identity and resource counts', async () => {
  const f = await fixture(), observation = await f.service.call('settings.hosts.inspect', { hostId: 'selected' }, user)
  expect(parseHostRuntimeObservation(observation, 'selected')).toBe(observation)
  expect(() => parseHostRuntimeObservation(observation, 'other')).toThrow()
  for (const change of [
    (v: any) => { delete v.diagnostics },
    (v: any) => { v.owner.value.protocolVersion = 999 },
    (v: any) => { v.nativeIdentity.value.secret = 'not-part-of-contract' },
    (v: any) => { v.resources.value.retainedOutputBytes = -1 },
    (v: any) => { v.resources.value.runningRuns = 999 },
    (v: any) => { v.diagnostics.value.ctxmux.serving.instanceId = 'another' }
  ]) { const invalid = structuredClone(observation); change(invalid); expect(() => parseHostRuntimeObservation(invalid, 'selected')).toThrow() }
})
it('uses passive Hosted calls across actual Unix RPC and exposes the same public result to CLI and managed callers', async () => {
  const f = await fixture()
  // This is the target semantic service. Its Native byte source remains controlled here.
  const connect = vi.spyOn(f.client, 'connect').mockResolvedValue(), connectRuntime = vi.spyOn(f.client, 'connectRuntime').mockResolvedValue()
  f.inner.kernel.list = vi.fn(async () => [])
  const hosted = new AgentMuxHostedRuntimeService(f.client, null, () => f.owner)
  cleanup.push(() => hosted.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'target.sock'), coreClients: f.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanup.push(() => client.dispose())
  // Finish the pre-existing Hosted bootstrap/projection before measuring this read.
  await client.runtimeProjection()
  connect.mockClear(); connectRuntime.mockClear()
  const source = await rpcOwnerFixture(['independent-source']); cleanup.push(source.close)
  const desktop = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'selected', client }, ...source.coreClients()] })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const userRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path } })
  cleanup.push(() => userRpc.dispose())
  const result = await userRpc.call('settings.hosts.inspect', { hostId: 'selected' })
  expect(result.resources).toMatchObject({ state: 'available', value: f.resource })
  expect(connect).not.toHaveBeenCalled(); expect(connectRuntime).not.toHaveBeenCalled()
  const cli = await runCompiledObjectCli(['settings', 'hosts', 'inspect', '--host', 'selected'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.resources).toMatchObject({ state: 'available', value: f.resource })
  f.inner.connected = false
  const missing = await userRpc.call('settings.hosts.inspect', { hostId: 'selected' })
  expect(missing.resources).toMatchObject({ state: 'unavailable', code: 'CTXMUX_DISCONNECTED' })
  expect(connect).not.toHaveBeenCalled(); expect(connectRuntime).not.toHaveBeenCalled()
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: desktop.path }, credentials: source.credentials })
  cleanup.push(() => managed.dispose())
  const read = await managed.call('settings.hosts.inspect', { hostId: 'selected' })
  expect(read.owner.state).toBe('available')
  await expect(managed.call('settings.hosts.trust-source', { hostId: 'selected', input: { sourceRuntimeId: 'source', publicKey: 'invalid-key', targetRuntimeId: 'target', targetKeyFingerprint: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
it('registers accurate CLI discovery and an explicit route without default guessing', async () => {
  expect(await parseSettingsCommand(['hosts', 'inspect', '--host', 'exact-route'])).toEqual({ method: 'settings.hosts.inspect', params: { hostId: 'exact-route' } })
  for (const args of [['hosts', 'inspect'], ['hosts', 'inspect', 'exact-route']]) await expect(parseSettingsCommand(args)).rejects.toBeDefined()
  expect(agentMuxCommandHelp('settings.hosts.inspect')).toContain('--host <id>')
})
