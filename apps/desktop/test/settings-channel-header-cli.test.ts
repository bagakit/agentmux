// @vitest-environment happy-dom
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import { startAgentMuxHost } from '../../host/src/host.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { executeSettingsPreferencesControl, configureChannelHeader } from '../src/main/settings-preferences-control.js'
import type { AppConfig } from '../src/shared/contracts.js'

const electronHome = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  electronHome.path = mkdtempSync(join(tmpdir(), 'amx-common-app-'))
  return { app: { getPath: () => electronHome.path, getAppPath: () => process.cwd() } }
})
afterAll(async () => { if (electronHome.path) await rm(electronHome.path, { recursive: true, force: true }) })
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const fields = { keyword: 'original', label: 'Original', body: 'Original instruction' }
async function fixture() {
  const original = await rpcOwnerFixture(['original-agent'], core); cleanup.push(original.close)
  const native = original.inner.kernel; await original.client.dispose()
  const configPath = join(original.root, 'configuration.json'), store = new ConfigStore(configPath)
  let current = await store.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private' }], workspaces: [],
    composerShortcuts: [{ id: 'original-prompt', ...fields }, { id: 'untouched-prompt', keyword: 'untouched', label: 'Untouched', body: 'Keep original unrelated instruction' }] })
  const save = vi.fn((next: AppConfig) => store.save(next))
  const owner = new ConfigOwner({ read: () => current, save, publish: value => { current = value } })
  const sources: Array<{ hostId: string; client: core.AgentMuxClient }> = []
  const execute = vi.fn(async (request: core.AgentMuxControlRequest) => {
    if (!core.isSettingsPreferenceMethod(request.operation)) throw new Error('Unexpected private preference operation')
    return executeSettingsPreferencesControl(request as core.SettingsPreferenceRequest, owner)
  })
  const desktop = new core.AgentMuxControlServer({ socketPath: join(original.root, 'desktop.sock'), coreClients: () => sources, execute })
  await desktop.start(); cleanup.push(() => desktop.stop())
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof original.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = native[name]
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>>
  try {
    host = await startAgentMuxHost({ store: original.store, socketPath: join(original.root, 'control.sock'), desktopSocketPath: join(original.root, 'desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile') })
    cleanup.push(() => host.dispose()); sources.push({ hostId: 'local', client: host.client })
    await vi.waitFor(() => expect((host.client as unknown as typeof original.inner).connected).toBe(true))
  } finally { connect.mockRestore() }
  const env = objectCliEnvironment(original.root, { AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability })
  const inputPath = join(original.root, 'common-actions.json')
  const cli = async (input?: unknown, adapterId?: string) => {
    const command = ['settings', 'channels', 'header', input === undefined ? 'inspect' : 'configure', ...(adapterId ? ['--adapter', adapterId] : [])]
    if (input === undefined) return runCompiledObjectCli(command, env)
    await writeFile(inputPath, JSON.stringify(input))
    return runCompiledObjectCli([...command, '--input', inputPath], env)
  }
  return { original, owner, store, configPath, save, execute, cli, current: () => current }
}


it('compiled CLI discovers original App presentation metadata, preserves unknown adapters and distinguishes authored absence from explicit true', async () => {
  const f = await fixture(), sessions = await readFile(f.original.store.path)
  const inspect = await f.cli(); expect(inspect.code, inspect.stderr).toBe(0)
  expect(JSON.parse(inspect.stdout).result.adapters).toEqual([
    { adapterId: 'feishu', label: 'Lark', authored: null, visible: true },
    { adapterId: 'discord', label: 'Discord', authored: null, visible: true },
    { adapterId: 'telegram', label: 'Telegram', authored: null, visible: true }])
  await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, channelHeaderVisibility: { 'vendor.future': false } } }))
  const before = structuredClone(f.current())
  const save = await f.cli({ expected: null, visible: false }, 'feishu')
  expect(save.code, save.stderr).toBe(0)
  expect(JSON.parse(save.stdout).result.adapters).toEqual([{ adapterId: 'feishu', label: 'Lark', authored: false, visible: false }])
  expect(f.current().appearance.channelHeaderVisibility).toEqual({ 'vendor.future': false, feishu: false })
  const { channelHeaderVisibility: _previous, ...appearance } = f.current().appearance
  expect({ ...f.current(), appearance }).toEqual({ ...before, appearance: Object.fromEntries(Object.entries(before.appearance).filter(([key]) => key !== 'channelHeaderVisibility')) })
  expect((await f.cli({ expected: false, visible: true }, 'feishu')).code).toBe(0)
  expect(JSON.parse((await f.cli(undefined, 'feishu')).stdout).result.adapters[0].authored).toBe(true)
  expect((await f.cli({ expected: true, visible: null }, 'feishu')).code).toBe(0)
  expect(JSON.parse((await f.cli(undefined, 'feishu')).stdout).result.adapters[0]).toMatchObject({ authored: null, visible: true })
  const all = JSON.parse((await f.cli()).stdout).result.adapters
  expect(all.find((row: any) => row.adapterId === 'vendor.future')).toEqual({ adapterId: 'vendor.future', label: null, authored: false, visible: false })
  expect((await f.cli({ expected: null, visible: false }, 'constructor')).code).toBe(0)
  expect(JSON.parse((await f.cli(undefined, 'constructor')).stdout).result.adapters[0]).toMatchObject({ authored: false, visible: false })
  expect(await readFile(f.original.store.path)).toEqual(sessions)
})

it('per-adapter CAS preserves concurrent adapters and rejects stale, malformed or wrong-target results without a retry', async () => {
  const f = await fixture()
  expect((await f.cli({ expected: null, visible: false }, 'alpha')).code).toBe(0)
  expect((await f.cli({ expected: null, visible: false }, 'beta')).code).toBe(0)
  const before = await readFile(f.configPath)
  const stale = await f.cli({ expected: null, visible: true }, 'alpha')
  expect(stale.code).not.toBe(0); expect(JSON.parse(stale.stderr).error.code).toBe('CONFIG_CONFLICT')
  for (const [input, id] of [[{ expected: false, visible: true, traffic: false }, 'alpha'], [{ expected: false, visible: 'false' }, 'alpha'], [{ expected: null, visible: false }, '../other']]) expect((await f.cli(input, id as string)).code).not.toBe(0)
  expect(await readFile(f.configPath)).toEqual(before)
  const saves = f.save.mock.calls.length
  f.save.mockRejectedValueOnce(new Error('Original owner unavailable'))
  expect((await f.cli({ expected: false, visible: true }, 'alpha')).code).not.toBe(0)
  expect((await f.cli(undefined, 'alpha')).code).toBe(0); expect(f.save).toHaveBeenCalledTimes(saves + 1)
  expect(await readFile(f.configPath)).toEqual(before)
  f.execute.mockImplementationOnce(async request => ({ operation: request.operation, revision: 'original-observation', adapters: [{ adapterId: 'another-adapter', label: null, authored: false, visible: false }] }) as any)
  const wrong = await f.cli(undefined, 'alpha'); expect(wrong.code).not.toBe(0); expect(JSON.parse(wrong.stderr).error.code).toBe('CONTROL_PROTOCOL_ERROR')
  expect(await readFile(f.configPath)).toEqual(before)
})

it('GUI display save uses the same exact authored expectation and a delayed reply cannot overwrite newer configuration', async () => {
  const f = await fixture()
  const { api } = await import('../src/renderer/src/lib/api.js')
  const { useAppStore } = await import('../src/renderer/src/store.js')
  const { saveChannelHeader } = await import('../src/renderer/src/lib/channel-header-config.js')
  const previous = useAppStore.getState().config; cleanup.push(() => { useAppStore.setState({ config: previous }) })
  useAppStore.setState({ config: f.current() })
  let release!: () => void, saved!: AppConfig
  const delay = new Promise<void>(resolve => { release = resolve })
  const call = vi.spyOn(api.config, 'configureChannelHeader').mockImplementation(async input => { saved = await configureChannelHeader(f.owner, input); await delay; return saved })
  const pending = saveChannelHeader({ adapterId: 'alpha', expected: null, visible: false })
  await vi.waitFor(() => expect(saved).toBeTruthy())
  const later = await configureChannelHeader(f.owner, { adapterId: 'beta', expected: null, visible: false })
  useAppStore.setState({ config: later }); release(); await pending
  expect(call).toHaveBeenCalledWith({ adapterId: 'alpha', expected: null, visible: false })
  expect(useAppStore.getState().config).toBe(later)
  expect(f.current().appearance.channelHeaderVisibility).toEqual({ alpha: false, beta: false })
})
