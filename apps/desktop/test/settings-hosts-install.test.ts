import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SettingsHostsInstallOwner } from '../src/main/settings-hosts-install.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { remoteCoreUpgradeTargetDigest, type RemoteCoreInstallManager, type RemoteCoreInstallReceipt } from '@agentmux/core'
vi.mock('electron', () => ({ app: { getPath: () => '/fixture' } }))
const host = { id: 'fresh', kind: 'ssh' as const, label: 'Fresh', hostname: 'fresh.invalid' }
const expected = { targetDigest: remoteCoreUpgradeTargetDigest(host), prefix: '/home/dev/core', candidateDigest: 'a'.repeat(64), nodeSha256: 'b'.repeat(64), keepRunning: 'start-script' as const }
const receipt: RemoteCoreInstallReceipt = { input: host, expected, operationId: 'first', status: 'completed', stage: 'completed', detail: 'Installed.', updatedAt: 1,
  installed: { remoteCommand: '/home/dev/core/bin/amux', remoteSocketPath: '/home/dev/core/runtime/control.sock', runtimeId: 'new-runtime', startScript: '/home/dev/core/start.sh', unit: null } }
function fixture(adoptionPath?: string) {
  let config = { ...structuredClone(DEFAULT_CONFIG), hosts: [host] }
  const save = vi.fn(async value => value)
  const configOwner = new ConfigOwner({ read: () => config, save, publish: value => { config = value as typeof config } })
  const manager = { check: vi.fn(async () => ({ input: host, eligible: false, reason: 'installed', detail: 'Existing.' })),
    install: vi.fn(async () => structuredClone(receipt)), inspect: vi.fn(async () => structuredClone(receipt)) }
  const checkHost = vi.fn(async () => ({ detail: 'Connected.' }))
  const owner = new SettingsHostsInstallOwner(manager as unknown as RemoteCoreInstallManager, configOwner, { checkHost }, adoptionPath)
  return { owner, manager, checkHost, save, read: () => config, configOwner }
}
describe('saved Host first Core install', () => {
  it('adopts the exact saved Host only after installation and keeps inspection read-only', async () => {
    const f = fixture()
    expect((await f.owner.install(host, expected, 'first')).connectionAdoption?.state).toBe('connected')
    expect(f.read().hosts[0]).toMatchObject({ remoteCommand: receipt.installed!.remoteCommand, remoteSocketPath: receipt.installed!.remoteSocketPath, runtimeId: receipt.installed!.runtimeId })
    // Installation metadata is not copied wholesale into the Host.
    expect(f.read().hosts[0]).not.toHaveProperty('startScript')
    expect(f.checkHost).toHaveBeenCalledWith(expect.objectContaining({ id: host.id, runtimeId: 'new-runtime' }))
    f.save.mockClear(); f.checkHost.mockClear()
    expect((await f.owner.inspect(f.read().hosts[0], 'first'))?.status).toBe('completed')
    expect((await f.owner.inspect(host, 'first'))?.connectionAdoption?.state).toBe('connected')
    expect(f.save).not.toHaveBeenCalled(); expect(f.checkHost).not.toHaveBeenCalled()
  })
  it('preserves newer route edits and reports completed deployment separately', async () => {
    const f = fixture()
    f.manager.install.mockImplementation(async () => {
      await f.configOwner.update(current => ({ ...current, hosts: [{ ...host, hostname: 'newer.invalid' }] }))
      return receipt
    })
    const result = await f.owner.install(host, expected, 'first')
    expect(result.status).toBe('completed'); expect(result.connectionAdoption).toMatchObject({ state: 'unconfirmed', code: 'CONFIG_CONFLICT' })
    expect(f.read().hosts[0].hostname).toBe('newer.invalid')
    expect(f.checkHost).not.toHaveBeenCalled()
  })
  it('does not erase installed identity when connection observation fails', async () => {
    const f = fixture(); f.checkHost.mockRejectedValueOnce(new Error('Observation gap'))
    const result = await f.owner.install(host, expected, 'first')
    expect(result.status).toBe('completed'); expect(result.connectionAdoption?.state).toBe('unconfirmed')
    expect(f.read().hosts[0]).toMatchObject({ runtimeId: 'new-runtime', remoteCommand: receipt.installed!.remoteCommand })
  })
  it('refuses unsaved targets and never adopts unknown installation', async () => {
    const f = fixture()
    await expect(f.owner.install({ ...host, hostname: 'other.invalid' }, expected, 'first')).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
    expect(f.manager.install).not.toHaveBeenCalled()
    f.manager.install.mockResolvedValueOnce({ ...receipt, status: 'unknown', stage: 'starting', installed: undefined })
    expect((await f.owner.install(host, expected, 'first')).status).toBe('unknown')
    expect(f.save).not.toHaveBeenCalled(); expect(f.checkHost).not.toHaveBeenCalled()
  })
})

it('keeps the original confirmed connection adoption across Main restart without reconnecting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'install-adoptions-')), file = join(root, 'adoptions.json')
  try {
    const f = fixture(file), applied = await f.owner.install(host, expected, 'first')
    const before = await readFile(file, 'utf8')
    const restarted = new SettingsHostsInstallOwner(f.manager as unknown as RemoteCoreInstallManager, f.configOwner, { checkHost: f.checkHost }, file)
    f.checkHost.mockClear(); f.save.mockClear()
    expect((await restarted.inspect(f.read().hosts[0], 'first'))?.connectionAdoption).toEqual(applied.connectionAdoption)
    expect((await restarted.inspect(host, 'first'))?.connectionAdoption).toEqual(applied.connectionAdoption)
    expect(f.checkHost).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe(before)
    await writeFile(file, '{broken')
    const another = new SettingsHostsInstallOwner(f.manager as unknown as RemoteCoreInstallManager, f.configOwner, { checkHost: f.checkHost }, file)
    expect((await another.inspect(f.read().hosts[0], 'first'))?.connectionAdoption?.state).toBe('pending-confirmation')
    expect(await readFile(file, 'utf8')).toBe('{broken')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not replace the Runtime identity of an already bound saved Host', async () => {
  const f = fixture(), bound = { ...host, runtimeId: 'original-runtime' }
  await f.configOwner.update(current => ({ ...current, hosts: [bound] }))
  f.save.mockClear()
  await expect(f.owner.install(bound, { ...expected, targetDigest: remoteCoreUpgradeTargetDigest(bound) }, 'bound-install')).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
  expect(f.manager.install).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled()
  expect(f.read().hosts[0]).toEqual(bound)
})
