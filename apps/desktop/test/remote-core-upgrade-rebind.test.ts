import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore, type RemoteCoreUpgradeManager } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { saveRuntimeConfig } from '../src/main/runtime-config-transaction.js'
import { SettingsHostsUpgradeOwner } from '../src/main/settings-hosts-upgrade.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import type { DesktopRuntimeClient } from '../src/main/desktop-host.js'
import type { AppConfig, HostConfig } from '../src/shared/contracts.js'

vi.mock('electron', () => ({ app: { getPath: () => _hygiene_fixturePath("tmp") }, nativeImage: {} }))
const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close() })
const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'private.invalid',
  user: 'owner', port: 2222, identityFile: _hygiene_fixturePath("private/key"), remoteSocketPath: _hygiene_fixturePath("private/control.sock"),
  runtimeId: 'original-runtime', remoteCommand: _hygiene_fixturePath("original/core") }
const next = { ...host, remoteCommand: _hygiene_fixturePath("candidate/core") }
const native = { hostId: 'local', instanceId: 'original-native', processId: 553, buildIdentity: 'fixture', protocolVersion: 22 }
const control = { kind: 'agent' as const, hostId: host.id, agentSessionId: 'original-session', run: { runId: 'original-run' } }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function fixture() {
  const clients: ReturnType<typeof makeClient>[] = []
  let prepareProbe: ((client: ReturnType<typeof makeClient>) => void) | undefined
  function makeClient(config: HostConfig) {
    const identity = { runtimeId: host.runtimeId, ownerInstanceId: 'current-core', protocolVersion: 1,
    processId: 777, ctxmux: native, availability: 'connected' as 'connected' | 'unverified' }
    return { config, identity, connect: vi.fn(async () => {}), connectRuntime: vi.fn(async () => {}),
      runtimeOwnerIdentity: () => identity, runtimeIdentity: () => native, onEvent: vi.fn(() => () => {}),
      dispose: vi.fn(async () => {}), setRemoteCommand: vi.fn(),
      listRuns: vi.fn(async () => [{ runId: control.run.runId, state: 'running' }]),
      stopAgent: vi.fn(), stopTerminal: vi.fn(), writeAgent: vi.fn(async () => {}),
      observeSessionHistory: vi.fn(async () => ({ source: { providerId: 'claude', nativeSessionId: 'native-history' }, dispose: vi.fn() })) }
  }
  const connector = vi.fn(async (config: HostConfig) => {
    const client = makeClient(config); clients.push(client)
    if (clients.length > 1) prepareProbe?.(client)
    return client as unknown as DesktopRuntimeClient
  })
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connector)
  let config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  runtime.commit(await runtime.prepare(config))
  closes.push(() => runtime.dispose())
  const original = clients[0]!
  const history = await runtime.observeSessionHistory(control, vi.fn(), config, new AbortController().signal)
  const save = vi.fn(async (value: AppConfig) => value)
  const owner = new ConfigOwner({ read: () => config, save: async value => await saveRuntimeConfig({ runtime, configWriter: { save }, next: value }),
    publish: value => { config = value } })
  const receipt = { input: host, expected: { runtimeId: host.runtimeId }, operationId: 'original-upgrade',
    status: 'completed', stage: 'completed', remoteCommand: next.remoteCommand, updatedAt: 1, detail: 'Authoritative maintenance completed.' }
  const manager = { inspect: vi.fn(async () => receipt), upgrade: vi.fn() } as unknown as RemoteCoreUpgradeManager
  const upgrades = new SettingsHostsUpgradeOwner(manager, owner, runtime)
  return { runtime, owner, original, clients, save, connector, history, manager, upgrades, config: () => config,
    probe: (prepare: NonNullable<typeof prepareProbe>) => { prepareProbe = prepare } }
}

it('reconciles the completed upgrade through the actual configuration transaction without replacing its live consumer', async () => {
  const f = await fixture()
  expect(await f.upgrades.inspect(host, 'original-upgrade')).toMatchObject({ status: 'completed', operationId: 'original-upgrade' })
  expect(f.config().hosts[0]).toEqual(next)
  expect(f.runtime.rpcClients()[0]!.client).toBe(f.original)
  expect(f.original.setRemoteCommand).toHaveBeenCalledExactlyOnceWith(next.remoteCommand)
  expect(f.original.dispose).not.toHaveBeenCalled(); expect(f.original.listRuns).not.toHaveBeenCalled()
  const handle = await f.original.observeSessionHistory.mock.results[0]!.value
  expect(handle.dispose).not.toHaveBeenCalled()
  expect(f.clients.slice(1).map(client => client.dispose.mock.calls.length)).toEqual([1, 1])
  expect(f.clients[1]!.connectRuntime).toHaveBeenCalledOnce()
  expect(f.clients[1]!.connect).not.toHaveBeenCalled()
  expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.original.setRemoteCommand.mock.invocationCallOrder[0]!)
  await f.runtime.write(control, 'original Run still accepts input', 'user')
  expect(f.original.writeAgent).toHaveBeenCalledOnce()
  expect(f.original.stopAgent).not.toHaveBeenCalled(); expect(f.original.stopTerminal).not.toHaveBeenCalled()
  expect(f.manager.upgrade).not.toHaveBeenCalled()
})

it('keeps original input available while the independent candidate confirmation waits', async () => {
  const f = await fixture(), release = deferred()
  const enteredProbe = vi.fn()
  f.probe(client => { client.connectRuntime.mockImplementationOnce(async () => { enteredProbe(); await release.promise }) })
  const pending = f.owner.update(current => ({ ...current, hosts: [next] }))
  void pending.catch(() => {})
  try {
    await vi.waitFor(() => expect(enteredProbe).toHaveBeenCalledOnce())
    await expect(f.runtime.write(control, 'input during probe', 'user')).resolves.toBeUndefined()
    expect(f.original.writeAgent).toHaveBeenCalledOnce(); expect(f.original.setRemoteCommand).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled(); expect(f.config().hosts[0]).toEqual(host)
  } finally { release.resolve(); await pending }
})

it('permits a display label update alongside the exact launcher change without replacing the consumer', async () => {
  const f = await fixture()
  await f.owner.update(current => ({ ...current, hosts: [{ ...next, label: 'Renamed presentation' }] }))
  expect(f.runtime.rpcClients()[0]!.client).toBe(f.original)
  expect(f.config().hosts[0]).toEqual({ ...next, label: 'Renamed presentation' })
  expect(f.original.setRemoteCommand).toHaveBeenCalledExactlyOnceWith(next.remoteCommand)
  expect(f.original.dispose).not.toHaveBeenCalled()
})

it.each(['unverified', 'different-runtime', 'failed'] as const)('keeps the original consumer and binding when candidate confirmation is %s', async failure => {
  const f = await fixture()
  f.probe(client => {
    if (failure === 'unverified') client.identity.availability = 'unverified'
    if (failure === 'different-runtime') client.identity.runtimeId = 'other-runtime'
    if (failure === 'failed') client.connectRuntime.mockRejectedValueOnce(new Error('Transport unavailable'))
  })
  expect(await f.upgrades.inspect(host, 'original-upgrade')).toMatchObject({ status: 'unknown', stage: 'verifying' })
  expect(f.save).not.toHaveBeenCalled(); expect(f.config().hosts[0]).toEqual(host)
  expect(f.original.setRemoteCommand).not.toHaveBeenCalled(); expect(f.original.dispose).not.toHaveBeenCalled()
  expect(f.clients[1]!.dispose).toHaveBeenCalledOnce()
  await f.runtime.write(control, 'healthy input after failed confirmation', 'user')
  expect(f.original.writeAgent).toHaveBeenCalledOnce()
})

it('does not update the active launcher when durable save fails and retries only original operation reconciliation', async () => {
  const f = await fixture()
  f.save.mockRejectedValueOnce(new Error('Disk unavailable'))
  expect(await f.upgrades.inspect(host, 'original-upgrade')).toMatchObject({ status: 'unknown' })
  expect(f.config().hosts[0]).toEqual(host); expect(f.original.setRemoteCommand).not.toHaveBeenCalled()
  expect(f.original.dispose).not.toHaveBeenCalled()
  expect(await f.upgrades.inspect(host, 'original-upgrade')).toMatchObject({ status: 'completed' })
  expect(f.manager.inspect).toHaveBeenCalledTimes(2); expect(f.manager.upgrade).not.toHaveBeenCalled()
})

it.each(['hostname', 'user', 'port', 'identityFile', 'remoteSocketPath', 'runtimeId', 'unbound'] as const)('preserves the live target-change guard for %s changes', async field => {
  const f = await fixture()
  const changed = { ...next }
  if (field === 'unbound') delete (changed as Partial<typeof changed>).runtimeId
  else if (field === 'port') changed.port++
  else changed[field] += '-different'
  await expect(f.owner.update(current => ({ ...current, hosts: [changed] }))).rejects.toThrow()
  expect(f.save).not.toHaveBeenCalled(); expect(f.original.setRemoteCommand).not.toHaveBeenCalled()
  expect(f.original.dispose).not.toHaveBeenCalled()
})

it('keeps an unpersisted Runtime binding under the existing live target-change guard', async () => {
  const f = await fixture(), { runtimeId: _runtimeId, ...unbound } = host
  f.runtime.commit({ hosts: [], configs: [unbound], removedHostIds: [], reservedHostIds: [],
    hostSignatures: new Map((await f.runtime.prepare(f.config())).hostSignatures) })
  await expect(f.owner.update(current => ({ ...current, hosts: [next] }))).rejects.toThrow('Stop sessions')
  expect(f.save).not.toHaveBeenCalled(); expect(f.original.setRemoteCommand).not.toHaveBeenCalled()
})

it('rejects a source change while the candidate probe waits without writing config', async () => {
  const f = await fixture(), entered = vi.fn(), release = deferred()
  f.probe(client => { client.connectRuntime.mockImplementationOnce(async () => { entered(); await release.promise }) })
  const pending = f.owner.update(current => ({ ...current, hosts: [next] }))
  const rejected = expect(pending).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
  f.runtime.commit({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map([['remote', 'other-signature']]) })
  release.resolve(); await rejected
  expect(f.save).not.toHaveBeenCalled(); expect(f.original.setRemoteCommand).not.toHaveBeenCalled()
})

it.each(['signature', 'consumer'] as const)('rejects a stale prepared launcher %s before mutation', async changed => {
  const f = await fixture()
  const originalSignatures = (await f.runtime.prepare(f.config())).hostSignatures
  const prepared = await f.runtime.prepare({ ...f.config(), hosts: [next] })
  const replacement = { ...f.original, setRemoteCommand: vi.fn(), dispose: vi.fn(async () => {}) }
  f.runtime.commit({ hosts: changed === 'consumer' ? [{ id: host.id, client: replacement as unknown as DesktopRuntimeClient,
    config: host, executionHost: { kind: 'ssh', dispose: async () => {} } as never }] : [], removedHostIds: [], reservedHostIds: [],
    hostSignatures: changed === 'signature' ? new Map([['remote', 'other-signature']]) : new Map(originalSignatures) })
  expect(() => f.runtime.commit(prepared)).toThrow()
  expect(f.original.setRemoteCommand).not.toHaveBeenCalled()
  expect(replacement.setRemoteCommand).not.toHaveBeenCalled()
})
