import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { fixturePath } from './helpers/fixture-values.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, RemoteCoreUpgradeManager, remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeExpected, type AgentMuxControlRequest } from '@agentmux/core'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { ConfigOwner } from '../../../apps/desktop/src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../../../apps/desktop/src/main/config-store.js'
import { SettingsHostsUpgradeOwner } from '../../../apps/desktop/src/main/settings-hosts-upgrade.js'
import { executeSettingsHostsControl } from '../../../apps/desktop/src/main/settings-hosts-control.js'
// This Core test consumes the real Desktop adapter. Electron is resolved by that
// package, rather than a coincidentally installed Electron in an ancestor tree.
vi.mock('../../../apps/desktop/node_modules/electron/index.js', async () => {
  const { fixturePath } = await import('./helpers/fixture-values.js')
  return { app: { getPath: () => fixturePath('temporary') } }
})
let root: string, server: AgentMuxControlServer
const seen: AgentMuxControlRequest[] = []
const digest = 'a'.repeat(64)
const saved = { id: 'local' as const, kind: 'local' as const, label: 'Exact saved Host' }
const expected: RemoteCoreUpgradeExpected = { targetDigest: remoteCoreUpgradeTargetDigest(saved), runtimeId: 'original', ownerInstanceId: 'original-owner',
  processId: 111, startTicks: '123', candidateDigest: digest, nativeInstanceId: 'native', nativeProcessId: 222, nativeStartTicks: '321' }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'core-upgrade-public-')); seen.splice(0)
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [saved] }
  const owner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value } })
  const manager = new RemoteCoreUpgradeManager({ stateDirectory: join(root, 'upgrade'), artifact: async () => ({ digest, sourceCommit: 'source', version: '0.1.0', ownerProtocolVersion: 2, requiredNativeProtocolVersion: 22,
    nativeBuild: 'native-source', nativeDigest: 'b'.repeat(64), archivePath: join(root, 'unused'), archiveDigest: 'c'.repeat(64), files: [] }) })
  const runtime = { checkHost: vi.fn(async () => ({ detail: 'ordinary check' })) }
  const upgrades = new SettingsHostsUpgradeOwner(manager, owner, runtime, join(root, 'adoptions.json'))
  server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => {
    seen.push(request)
    if (!request.operation.startsWith('settings.hosts.')) throw new Error('Unexpected control operation')
    return await executeSettingsHostsControl(request as Extract<AgentMuxControlRequest, { operation: `settings.hosts.${string}` }>, owner, runtime, upgrades)
  } })
  await server.start()
})
afterEach(async () => { await server?.stop(); if (root) await rm(root, { recursive: true }) })

it('built public CLI discovers and actually consumes the same saved-Host maintenance owner without a Renderer', async () => {
  const env = objectCliEnvironment(root)
  const help = await runCompiledObjectCli(['settings', 'hosts', '--help'], env)
  expect(help.code).toBe(0); expect(help.stdout).toContain('settings hosts upgrade-check'); expect(help.stdout).toContain('settings hosts upgrade-inspect')
  expect(seen).toEqual([])
  const check = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-check', 'local'], env)
  expect(check.code).toBe(0)
  expect(JSON.parse(check.stdout).result.check).toMatchObject({ input: saved, eligible: false, reason: 'unverified', candidate: { digest } })
  const input = join(root, 'admission.json'); await writeFile(input, JSON.stringify({ operationId: 'public-original', expected }))
  const upgrade = await runCompiledObjectCli(['settings', 'hosts', 'upgrade', 'local', '--input', input], env)
  expect(upgrade.code).toBe(0)
  expect(JSON.parse(upgrade.stdout).result.receipt).toMatchObject({ operationId: 'public-original', status: 'failed', input: saved })
  const original = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-inspect', 'local', '--operation-id', 'public-original'], env)
  expect(original.code).toBe(0); expect(JSON.parse(original.stdout).result.receipt.status).toBe('failed')
  const ledger = JSON.parse(await readFile(join(root, 'upgrade', 'operations', 'public-original.json'), 'utf8'))
  expect(ledger.receipt.input).toEqual(saved)
  expect(seen.map(request => request.operation)).toEqual(['settings.hosts.upgrade-check', 'settings.hosts.upgrade', 'settings.hosts.upgrade-inspect'])
})

it('refuses malformed admissions and wrong-object replies before accepting any update result', () => {
  expect(() => rpcControlRequest('settings.hosts.upgrade', { id: 'local', expected })).toThrow('operationId')
  expect(() => rpcControlRequest('settings.hosts.upgrade', { id: 'local', operationId: 'one', expected: { ...expected, processId: '111' } })).toThrow()
  expect(() => rpcControlRequest('settings.hosts.upgrade', { id: 'local', operationId: 'one', expected: { ...expected, nativeStartTicks: 'unknown' } })).toThrow()
  expect(() => rpcControlRequest('settings.hosts.upgrade-inspect', { id: 'local', operationId: 'one', expected })).toThrow()
  const check = { input: saved, current: { state: 'unavailable', observedAt: 1, code: 'UNAVAILABLE', detail: 'Original facts unknown' }, candidate: { digest, sourceCommit: 'source', version: '0.1.0', ownerProtocolVersion: 2, requiredNativeProtocolVersion: 22 }, eligible: false, reason: 'unverified', detail: 'Original Runtime observation is unavailable.' }
  expect(() => parseRpcControlResult('settings.hosts.upgrade-check', { check: { ...check, input: { ...saved, id: 'other' } } }, { id: 'local' })).toThrow('another target')
  expect(() => parseRpcControlResult('settings.hosts.upgrade-check', { check: { ...check, eligible: true } }, { id: 'local' })).toThrow()
  const receipt = { input: saved, operationId: 'other-operation', expected, status: 'failed', stage: 'preparing', detail: 'Refused before mutation.', updatedAt: reshapeFixtureEpoch(0, 0, 1) }
  expect(() => parseRpcControlResult('settings.hosts.upgrade-inspect', { receipt }, { id: 'local', operationId: 'one' })).toThrow('another target')
  const original = { ...receipt, operationId: 'one' }
  const params = { id: 'local', operationId: 'one', expected }
  expect(parseRpcControlResult('settings.hosts.upgrade', { receipt: original }, params)).toEqual({ receipt: original })
  expect(parseRpcControlResult('settings.hosts.upgrade-inspect', { receipt: null }, { id: 'local', operationId: 'absent' })).toEqual({ receipt: null })
  expect(() => parseRpcControlResult('settings.hosts.upgrade', { receipt: null }, params)).toThrow('another target')
  expect(() => parseRpcControlResult('settings.hosts.upgrade', { receipt: { ...original, input: { ...saved, id: 'other' } } }, params)).toThrow('another target')
  expect(() => parseRpcControlResult('settings.hosts.upgrade', { receipt: { ...original, expected: { ...expected, candidateDigest: 'b'.repeat(64) } } }, params)).toThrow('another target')
  expect(() => parseRpcControlResult('settings.hosts.upgrade', { receipt: { ...original, requestId: 'one' } }, params)).toThrow('invalid fields')
  expect(() => parseRpcControlResult('settings.hosts.upgrade', { receipt: { ...original, extra: true } }, params)).toThrow('invalid fields')
})

it.each(['completed', 'failed', 'unknown'] as const)('built CLI reads the original %s upgrade receipt without replaying deployment', async status => {
  const operationId = 'retained-' + status
  const receipt = { input: saved, operationId, expected, status, stage: status === 'completed' ? 'completed' : 'verifying',
    detail: 'Original maintenance facts.', remoteCommand: fixturePath("candidate/core"), updatedAt: reshapeFixtureEpoch(0, 0, 1) }
  const directory = join(root, 'upgrade', 'operations')
  await mkdir(directory, { recursive: true })
  const ledger = join(directory, operationId + '.json'), bytes = JSON.stringify({ receipt })
  await writeFile(ledger, bytes)
  const result = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-inspect', 'local', '--operation-id', operationId], objectCliEnvironment(root))
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.receipt).toEqual(receipt)
  expect(await readFile(ledger, 'utf8')).toBe(bytes)
  expect(seen.map(request => request.operation)).toEqual(['settings.hosts.upgrade-inspect'])
})

it('keeps maintenance eligibility independent of ordinary handshake while reconciling the original update without replay', async () => {
  const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'remote.invalid', runtimeId: 'original',
    remoteCommand: fixturePath("original/core"), remoteSocketPath: fixturePath("original/control.sock") }
  const pinned = { ...expected, targetDigest: remoteCoreUpgradeTargetDigest(host) }
  const receipt = { input: host, expected: pinned, operationId: 'original-update', status: 'completed' as const,
    stage: 'completed' as const, detail: 'Core is updated.', remoteCommand: fixturePath("candidate/core"), updatedAt: reshapeFixtureEpoch(0, 0, 1) }
  const deploy = vi.fn(async () => receipt), inspect = vi.fn(async () => receipt)
  const manager = { upgrade: deploy, inspect, check: vi.fn(async (input: unknown) => ({ input, candidate: { digest, sourceCommit: null, version: null, ownerProtocolVersion: 2, requiredNativeProtocolVersion: 22 },
    current: { state: 'available', observedAt: 1, version: '0.1.0', sourceCommit: 'original', deploymentDigest: 'd'.repeat(64), ownerProtocolVersion: 1, runtimeId: pinned.runtimeId, ownerInstanceId: pinned.ownerInstanceId, processId: pinned.processId, native: { instanceId: pinned.nativeInstanceId, buildId: 'native', protocolVersion: 22 } }, eligible: true, reason: 'ready', expected: pinned, detail: 'Core is qualified.', latestOperation: receipt })) } as unknown as RemoteCoreUpgradeManager
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  const configOwner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value as typeof config } })
  const connection = vi.fn(async (): Promise<{ detail: string }> => { throw new Error('fresh handshake could not be confirmed') })
  const adoptions = join(root, 'restart-adoptions.json')
  const upgrades = new SettingsHostsUpgradeOwner(manager, configOwner, { checkHost: connection }, adoptions)
  expect(await upgrades.check(host)).toMatchObject({ eligible: true, reason: 'ready', latestOperation: { status: 'completed', connectionAdoption: { state: 'pending-confirmation' } } })
  expect(connection).not.toHaveBeenCalled()
  expect(await upgrades.upgrade(host, pinned, receipt.operationId)).toMatchObject({ status: 'completed', stage: 'completed', connectionAdoption: { state: 'unconfirmed' } })
  expect(config.hosts[0].remoteCommand).toBe(receipt.remoteCommand)
  // Maintenance qualifies the old owner even when the new ordinary SDK cannot
  // handshake with it. Only upgrade/inspect claims a fresh client connection.
  // A restarted Main reads the recorded adoption fact; it is not reset to pending.
  const restarted = new SettingsHostsUpgradeOwner(manager, configOwner, { checkHost: connection }, adoptions)
  expect(await restarted.check(config.hosts[0])).toMatchObject({ eligible: true, reason: 'ready', latestOperation: { operationId: receipt.operationId, status: 'completed', connectionAdoption: { state: 'unconfirmed' } } })
  expect(connection).toHaveBeenCalledTimes(1)
  const check = await manager.check(config.hosts[0])
  for (const rejected of [
    { ...check, eligible: false, expected: undefined, reason: 'runtime-update-required' },
    { ...check, eligible: false, expected: undefined, reason: 'unverified', latestOperation: { ...receipt, status: 'unknown' } }
  ]) {
    vi.mocked(manager.check).mockResolvedValueOnce(rejected as Awaited<ReturnType<RemoteCoreUpgradeManager['check']>>)
    expect(await restarted.check(config.hosts[0])).toMatchObject(rejected)
  }
  expect(connection).toHaveBeenCalledTimes(1)
  expect(await restarted.inspect(config.hosts[0], receipt.operationId)).toMatchObject({ status: 'completed', stage: 'completed', connectionAdoption: { state: 'unconfirmed' } })
  expect(receipt.status).toBe('completed')
  connection.mockImplementation(async () => ({ detail: 'fresh connection confirmed' }))
  expect((await restarted.reconnect(config.hosts[0], receipt.operationId))?.connectionAdoption?.state).toBe('connected')
  const again = new SettingsHostsUpgradeOwner(manager, configOwner, { checkHost: connection }, adoptions)
  expect(await again.inspect(config.hosts[0], receipt.operationId)).toMatchObject({ status: 'completed', connectionAdoption: { state: 'connected' } })
  expect(inspect).toHaveBeenCalledTimes(3); expect(deploy).toHaveBeenCalledTimes(1); expect(connection).toHaveBeenCalledTimes(2)
})

it('actual compiled CLI keeps inspect pure and explicitly reconnects the original completed deployment without redeploying', async () => {
  await server.stop()
  const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'private.fixture', runtimeId: 'original', remoteCommand: fixturePath('original/core'), remoteSocketPath: fixturePath('original/control.sock') }
  const original = { input: host, operationId: 'retained-deployment', expected: { ...expected, targetDigest: remoteCoreUpgradeTargetDigest(host) }, status: 'completed' as const,
    stage: 'completed' as const, remoteCommand: fixturePath('candidate/core'), detail: 'Original deployment completed.', updatedAt: 1 }
  const inspect = vi.fn(async () => original), deploy = vi.fn()
  const manager = { inspect, upgrade: deploy } as unknown as RemoteCoreUpgradeManager
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  const save = vi.fn(async (value: typeof config) => value)
  const owner = new ConfigOwner({ read: () => config, save: save as never, publish: value => { config = value as typeof config } })
  const check = vi.fn(async () => ({ detail: 'Connection verified' }))
  const runtime = { checkHost: check }, upgrades = new SettingsHostsUpgradeOwner(manager, owner, runtime, join(root, 'cli-adoptions.json'))
  server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => executeSettingsHostsControl(request as never, owner, runtime, upgrades) })
  await server.start()
  const env = objectCliEnvironment(root)
  const reading = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-inspect', 'remote', '--operation-id', original.operationId], env)
  expect(reading.code, reading.stderr).toBe(0)
  expect(JSON.parse(reading.stdout).result.receipt).toMatchObject({ status: 'completed', connectionAdoption: { state: 'pending-confirmation' } })
  expect(save).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled()
  const applied = await runCompiledObjectCli(['settings', 'hosts', 'upgrade-reconnect', 'remote', '--operation-id', original.operationId], env)
  expect(applied.code, applied.stderr).toBe(0)
  expect(JSON.parse(applied.stdout).result.receipt).toMatchObject({ operationId: original.operationId, status: 'completed', connectionAdoption: { state: 'connected' } })
  expect(config.hosts[0].remoteCommand).toBe(original.remoteCommand)
  expect(save).toHaveBeenCalledOnce(); expect(check).toHaveBeenCalledOnce(); expect(inspect).toHaveBeenCalledTimes(2); expect(deploy).not.toHaveBeenCalled()
})

it('maintenance write authority is preserved before the original forward owner and cannot be forged by managed Agents', async () => {
  const f = await rpcOwnerFixture()
  const forward = vi.fn(async () => ({ receipt: null }))
  const service = new AgentMuxRpcService({ coreClients: f.coreClients, forwardControl: forward as never })
  try {
    const input = { id: 'remote', operationId: 'original-operation' }
    for (const method of ['settings.hosts.upgrade', 'settings.hosts.upgrade-reconnect'] as const) {
      const params = method === 'settings.hosts.upgrade' ? { ...input, expected } : input
      await expect(service.call(method, params, { caller: f.credentials, principal: { kind: 'user', id: 'local-user' }, transport: 'unix' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
      await expect(service.call(method, params, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    }
    expect(forward).not.toHaveBeenCalled()
    for (const kind of ['user', 'device'] as const) {
      await service.call('settings.hosts.upgrade-reconnect', input, { principal: { kind, id: 'approved-' + kind }, transport: kind === 'user' ? 'unix' : 'relay' })
    }
    expect(forward).toHaveBeenCalledTimes(2)
    await service.call('settings.hosts.upgrade-inspect', input, { caller: f.credentials, transport: 'unix' })
    expect(forward).toHaveBeenCalledTimes(3)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await service.dispose(); await f.close() }
})
