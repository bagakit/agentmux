import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, type AgentMuxControlRequest, type RemoteCoreInstallManager, type RemoteCoreInstallReceipt, remoteCoreUpgradeTargetDigest } from '@agentmux/core'
import { ConfigOwner } from '../../../apps/desktop/src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../../../apps/desktop/src/main/config-store.js'
import { SettingsHostsInstallOwner } from '../../../apps/desktop/src/main/settings-hosts-install.js'
import { executeSettingsHostsControl } from '../../../apps/desktop/src/main/settings-hosts-control.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
import { rpcControlRequest, parseRpcControlResult } from '../src/rpc-business-codec.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
vi.mock('../../../apps/desktop/node_modules/electron/index.js', () => ({ app: { getPath: () => '/fixture' } }))
const host = { id: 'fresh', kind: 'ssh' as const, label: 'Fresh', hostname: 'fresh.invalid' }
const expected = { targetDigest: remoteCoreUpgradeTargetDigest(host), prefix: '/home/dev/core', candidateDigest: 'a'.repeat(64), nodeSha256: 'b'.repeat(64), keepRunning: 'start-script' as const }
const original: RemoteCoreInstallReceipt = { input: host, expected, operationId: 'first-install', status: 'completed', stage: 'completed', detail: 'Installed.', updatedAt: 1,
  installed: { remoteCommand: '/home/dev/core/bin/amux', remoteSocketPath: '/home/dev/core/runtime/control.sock', runtimeId: 'new-core', startScript: '/home/dev/core/start.sh', unit: null } }
let root: string, server: AgentMuxControlServer
const seen: AgentMuxControlRequest[] = [], deploy = vi.fn(), inspect = vi.fn()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'install-public-')); seen.splice(0); deploy.mockReset(); inspect.mockReset()
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  const owner = new ConfigOwner({ read: () => config, save: async value => value, publish: value => { config = value as typeof config } })
  deploy.mockResolvedValue(original); inspect.mockResolvedValue(original)
  const manager = { check: async () => ({ input: host, eligible: false, reason: 'unverified', detail: 'Target remains unverified.' }), install: deploy, inspect }
  const runtime = { checkHost: vi.fn(async () => ({ detail: 'Connected' })) }
  const installs = new SettingsHostsInstallOwner(manager as unknown as RemoteCoreInstallManager, owner, runtime)
  server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], execute: async request => {
    seen.push(request)
    return await executeSettingsHostsControl(request as Extract<AgentMuxControlRequest, { operation: `settings.hosts.${string}` }>, owner, runtime, undefined, installs)
  } })
  await server.start()
})
afterEach(async () => { await server?.stop(); await rm(root, { recursive: true, force: true }) })
it('compiled CLI discovers and calls the real saved Host install adapter, then reads without deployment replay', async () => {
  const env = objectCliEnvironment(root)
  const help = await runCompiledObjectCli(['settings', 'hosts', '--help'], env)
  expect(help.code).toBe(0); expect(help.stdout).toContain('settings hosts install-check'); expect(help.stdout).toContain('settings hosts install-inspect'); expect(seen).toEqual([])
  for (const action of ['install-check', 'install', 'install-inspect']) {
    const leaf = await runCompiledObjectCli(['settings', 'hosts', action, '--help'], env)
    expect(leaf.code).toBe(0); expect(leaf.stdout).toContain('settings hosts ' + action)
  }
  const guide = await runCompiledObjectCli(['settings', '--skill'], env)
  expect(guide.code).toBe(0); expect(guide.stdout).toContain('First install on a saved Linux SSH Host')
  expect(guide.stdout).toContain('managed Agent cannot grant it')
  expect(seen).toEqual([])
  const check = await runCompiledObjectCli(['settings', 'hosts', 'install-check', host.id], env)
  expect(check.code, check.stderr).toBe(0); expect(JSON.parse(check.stdout).result.check).toMatchObject({ input: host, eligible: false })
  const file = join(root, 'admission.json'); await writeFile(file, JSON.stringify({ operationId: original.operationId, expected }))
  const install = await runCompiledObjectCli(['settings', 'hosts', 'install', host.id, '--input', file], env)
  expect(install.code, install.stdout + install.stderr).toBe(0)
  expect(JSON.parse(install.stdout).result.receipt).toMatchObject({ ...original, connectionAdoption: { state: 'connected' } })
  const read = await runCompiledObjectCli(['settings', 'hosts', 'install-inspect', host.id, '--operation-id', original.operationId], env)
  expect(read.code, read.stdout + read.stderr).toBe(0)
  expect(JSON.parse(read.stdout).result.receipt).toMatchObject({ operationId: original.operationId, status: 'completed', installed: original.installed })
  expect(deploy).toHaveBeenCalledTimes(1); expect(inspect).toHaveBeenCalledTimes(1)
  expect(seen.map(request => request.operation)).toEqual(['settings.hosts.install-check', 'settings.hosts.install', 'settings.hosts.install-inspect'])
})
it('strict public parsing binds target, admission and original operation identity', () => {
  expect(() => rpcControlRequest('settings.hosts.install', { id: host.id, expected })).toThrow('operationId')
  expect(() => rpcControlRequest('settings.hosts.install', { id: host.id, expected: { ...expected, keepRunning: 'root' }, operationId: 'one' })).toThrow()
  const params = { id: host.id, expected, operationId: original.operationId }
  expect(parseRpcControlResult('settings.hosts.install', { receipt: original }, params)).toEqual({ receipt: original })
  for (const changed of [{ ...original, operationId: 'wrong' }, { ...original, input: { ...host, id: 'wrong' } },
    { ...original, expected: { ...expected, candidateDigest: 'c'.repeat(64) } }, { ...original, installed: undefined }, { ...original, extra: true }]) {
    expect(() => parseRpcControlResult('settings.hosts.install', { receipt: changed }, params)).toThrow()
  }
})
it('public service refuses managed Agents before the install owner is called', async () => {
  const f = await rpcOwnerFixture(), forward = vi.fn(async () => ({ receipt: original }))
  const service = new AgentMuxRpcService({ coreClients: f.coreClients, forwardControl: forward as never })
  try {
    await expect(service.call('settings.hosts.install', { id: host.id, expected, operationId: 'first' }, {
      caller: f.credentials, principal: { kind: 'device', id: 'device' }, transport: 'unix'
    })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    await expect(service.call('settings.hosts.install', { id: host.id, expected, operationId: 'first' }, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    expect(forward).not.toHaveBeenCalled()
  } finally { await service.dispose(); await f.close() }
})
