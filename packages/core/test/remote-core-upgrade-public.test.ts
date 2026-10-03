import { fixturePath } from './helpers/fixture-values.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, RemoteCoreUpgradeManager, remoteCoreUpgradeTargetDigest, type RemoteCoreUpgradeExpected, type AgentMuxControlRequest } from '@agentmux/core'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { ConfigOwner } from '../../../apps/desktop/src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../../../apps/desktop/src/main/config-store.js'
import { SettingsHostsUpgradeOwner } from '../../../apps/desktop/src/main/settings-hosts-upgrade.js'
import { executeSettingsHostsControl } from '../../../apps/desktop/src/main/settings-hosts-control.js'
import { callRemoteCoreMaintenance } from '../src/remote-core-upgrade-wire.js'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
// This Core test consumes the real Desktop adapter. Electron is resolved by that
// package, rather than a coincidentally installed Electron in an ancestor tree.
vi.mock('../../../apps/desktop/node_modules/electron/index.js', async () => {
  const { fixturePath } = await import('./helpers/fixture-values.js')
  return { app: { getPath: () => fixturePath('temporary') } }
})
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, spawn: vi.fn(real.spawn) }
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
  const manager = new RemoteCoreUpgradeManager({ stateDirectory: join(root, 'upgrade'), artifact: async () => ({ digest, sourceCommit: 'source', protocolVersion: 22,
    nativeBuild: 'native-source', nativeDigest: 'b'.repeat(64), archivePath: join(root, 'unused'), archiveDigest: 'c'.repeat(64), files: [] }) })
  const runtime = { checkHost: vi.fn(async () => ({ detail: 'ordinary check' })) }
  const upgrades = new SettingsHostsUpgradeOwner(manager, owner, runtime)
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
  const check = { input: saved, candidate: { digest, sourceCommit: 'source', protocolVersion: 22 }, eligible: false, reason: 'unverified', detail: 'Original Runtime observation is unavailable.' }
  expect(() => parseRpcControlResult('settings.hosts.upgrade-check', { check: { ...check, input: { ...saved, id: 'other' } } }, { id: 'local' })).toThrow('another target')
  expect(() => parseRpcControlResult('settings.hosts.upgrade-check', { check: { ...check, eligible: true } }, { id: 'local' })).toThrow()
  const receipt = { input: saved, operationId: 'other-operation', expected, status: 'failed', stage: 'preparing', detail: 'Refused before mutation.', updatedAt: 1 }
  expect(() => parseRpcControlResult('settings.hosts.upgrade-inspect', { receipt }, { id: 'local', operationId: 'one' })).toThrow('another target')
})

it('reports a completed remote update with an unconfirmed connection and inspects the original operation without deploying again', async () => {
  const host = { id: 'remote', kind: 'ssh' as const, label: 'Remote', hostname: 'remote.invalid', runtimeId: 'original',
    remoteCommand: fixturePath("original/core"), remoteSocketPath: fixturePath("original/control.sock") }
  const pinned = { ...expected, targetDigest: remoteCoreUpgradeTargetDigest(host) }
  const receipt = { input: host, expected: pinned, operationId: 'original-update', status: 'completed' as const,
    stage: 'completed' as const, detail: 'Core is updated.', remoteCommand: fixturePath("candidate/core"), updatedAt: 1 }
  const deploy = vi.fn(async () => receipt), inspect = vi.fn(async () => receipt)
  const manager = { upgrade: deploy, inspect, check: vi.fn(async (input: unknown) => ({ input, candidate: { digest, sourceCommit: null, protocolVersion: 22 },
    eligible: true, reason: 'ready', expected: pinned, detail: 'Core is qualified.', latestOperation: receipt })) } as unknown as RemoteCoreUpgradeManager
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  const configOwner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value as typeof config } })
  const connection = vi.fn(async (): Promise<{ detail: string }> => { throw new Error('fresh handshake could not be confirmed') })
  const upgrades = new SettingsHostsUpgradeOwner(manager, configOwner, { checkHost: connection })
  expect(await upgrades.upgrade(host, pinned, receipt.operationId)).toMatchObject({ status: 'unknown', stage: 'verifying' })
  expect(config.hosts[0].remoteCommand).toBe(receipt.remoteCommand)
  // A new Main owner reconstructs the connection uncertainty from the retained
  // Core receipt. It does not depend on the Renderer remembering this click.
  const restarted = new SettingsHostsUpgradeOwner(manager, configOwner, { checkHost: connection })
  expect(await restarted.check(config.hosts[0])).toMatchObject({ eligible: false, reason: 'unverified', latestOperation: { operationId: receipt.operationId, status: 'unknown' } })
  connection.mockImplementation(async () => ({ detail: 'fresh connection confirmed' }))
  expect((await restarted.inspect(config.hosts[0], receipt.operationId))?.status).toBe('completed')
  expect(inspect).toHaveBeenCalledTimes(1); expect(deploy).toHaveBeenCalledTimes(1)
})

it('keeps an early SSH request-pipe failure scoped to an unknown maintenance response', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>)
  const response = callRemoteCoreMaintenance({ id: 'remote', kind: 'ssh', label: 'Remote', hostname: 'unavailable.invalid', remoteCommand: fixturePath("core"), remoteSocketPath: fixturePath("scope/control.sock") }, 'runtime.owner.identity', {})
  const rejected = expect(response).rejects.toMatchObject({ code: 'CORE_UPGRADE_RESPONSE_UNKNOWN' })
  child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
  await rejected; expect(child.kill).toHaveBeenCalledWith('SIGTERM')
})
