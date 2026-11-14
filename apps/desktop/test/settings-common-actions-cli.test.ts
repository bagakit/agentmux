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
import { executeSettingsPreferencesControl, configureGoalsCommonActions } from '../src/main/settings-preferences-control.js'
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
  const cli = async (input?: unknown) => {
    if (input === undefined) return runCompiledObjectCli(['settings', 'goals', 'common-actions', 'inspect'], env)
    await writeFile(inputPath, JSON.stringify(input))
    return runCompiledObjectCli(['settings', 'goals', 'common-actions', 'configure', '--input', inputPath], env)
  }
  return { original, owner, store, configPath, save, execute, cli, current: () => current }
}

it('compiled CLI traverses actual Host and Desktop to one ConfigOwner transaction for ordered references and exact Prompt edits', async () => {
  const f = await fixture(), sessions = await readFile(f.original.store.path)
  const initial = await f.cli(); expect(initial.code, initial.stderr).toBe(0)
  const observed = JSON.parse(initial.stdout).result
  expect(observed.directory).toBeNull(); expect(observed.effective.items).toHaveLength(3)
  expect(observed.availableRefs.some((value: any) => value.ref.id === 'original-prompt')).toBe(true)
  expect(JSON.stringify(observed.availableRefs)).not.toContain(fields.body)
  const directory = { items: [{ kind: 'prompt', id: 'created-prompt' }, { kind: 'builtin', id: 'next' }, { kind: 'prompt', id: 'original-prompt' }], collapsed: true }
  const saved = await f.cli({ expected: null, directory, promptEdits: [
    { id: 'original-prompt', expected: fields, value: { ...fields, body: 'Changed instruction' } },
    { id: 'created-prompt', expected: null, value: { keyword: 'new-action', label: 'New action', body: 'New original instruction' } }
  ] })
  expect(saved.code, saved.stderr).toBe(0); expect(JSON.parse(saved.stdout).result.directory).toEqual(directory)
  expect(f.save).toHaveBeenCalledTimes(1)
  const disk = await f.store.get()
  expect(disk.goalsCommonActions).toEqual(directory)
  expect(disk.composerShortcuts!.find(prompt => prompt.id === 'original-prompt')!.body).toBe('Changed instruction')
  expect(disk.composerShortcuts!.find(prompt => prompt.id === 'untouched-prompt')!.body).toBe('Keep original unrelated instruction')
  expect(await readFile(f.original.store.path)).toEqual(sessions)
  const swap = await f.cli({ expected: directory, directory, promptEdits: [
    { id: 'original-prompt', expected: { ...fields, body: 'Changed instruction' }, value: { ...fields, keyword: 'new-action', body: 'Changed instruction' } },
    { id: 'created-prompt', expected: { keyword: 'new-action', label: 'New action', body: 'New original instruction' }, value: { keyword: 'original', label: 'New action', body: 'New original instruction' } }
  ] })
  expect(swap.code, swap.stderr).toBe(0)
  expect(f.current().composerShortcuts!.find(prompt => prompt.id === 'original-prompt')!.keyword).toBe('new-action')
  expect(f.current().composerShortcuts!.find(prompt => prompt.id === 'created-prompt')!.keyword).toBe('original')
  expect((await f.cli({ expected: directory, directory: { items: [], collapsed: false } })).code).toBe(0)
  expect(f.current().goalsCommonActions!.items).toEqual([])
  expect((await f.cli({ expected: { items: [], collapsed: false }, directory: null })).code).toBe(0)
  expect(f.current().goalsCommonActions).toBeUndefined()
})

it('exact directory and Prompt CAS reject only conflicting edits; preserved unresolved refs do not block unrelated common preferences', async () => {
  const f = await fixture()
  const directory = { items: [{ kind: 'prompt', id: 'original-prompt' }], collapsed: false }
  expect((await f.cli({ expected: null, directory })).code).toBe(0)
  await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, terminalFontSize: 17 } }))
  const changed = { ...directory, collapsed: true }
  expect((await f.cli({ expected: directory, directory: changed })).code).toBe(0)
  const before = await readFile(f.configPath)
  for (const input of [
    { expected: directory, directory },
    { expected: changed, directory, promptEdits: [{ id: 'original-prompt', expected: { ...fields, body: 'Stale body' }, value: fields }] },
    { expected: changed, directory: { items: [{ kind: 'prompt', id: 'missing-new' }], collapsed: false } },
    { expected: changed, directory, promptEdits: [{ id: 'untouched-prompt', expected: null, value: fields }] },
    { expected: changed, directory, promptEdits: [{ id: 'original-prompt', expected: fields, value: { ...fields, keyword: 'untouched' } }] }
  ]) expect((await f.cli(input)).code).not.toBe(0)
  expect(await readFile(f.configPath)).toEqual(before)
  expect(f.current().appearance.terminalFontSize).toBe(17)
  await f.owner.update(current => ({ ...current, goalsCommonActions: { items: [{ kind: 'prompt', id: 'retained-missing' }], collapsed: false } }))
  const retained = f.current().goalsCommonActions!
  const result = await f.cli({ expected: retained, directory: { ...retained, collapsed: true } })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout).result.issues).toEqual([{ ref: retained.items[0], code: 'PROMPT_NOT_FOUND', message: expect.any(String) }])
})

it('failed original saves retain configuration and Session; inspect never retries or invents a past acknowledgement', async () => {
  const f = await fixture(), before = await readFile(f.configPath), sessions = await readFile(f.original.store.path)
  f.save.mockRejectedValueOnce(new Error('Original configuration save unavailable'))
  const failed = await f.cli({ expected: null, directory: { items: [], collapsed: true } })
  expect(failed.code).not.toBe(0); expect(f.save).toHaveBeenCalledTimes(1)
  const observed = await f.cli(); expect(observed.code, observed.stderr).toBe(0)
  expect(JSON.parse(observed.stdout).result.directory).toBeNull()
  expect(JSON.parse(observed.stdout).result).not.toHaveProperty('diskDurability')
  expect(f.save).toHaveBeenCalledTimes(1); expect(await readFile(f.configPath)).toEqual(before)
  expect(await readFile(f.original.store.path)).toEqual(sessions)
})

it('GUI common-action save calls the same typed owner and retains a newer configuration publication while its reply is delayed', async () => {
  const f = await fixture()
  const { api } = await import('../src/renderer/src/lib/api.js')
  const { useAppStore } = await import('../src/renderer/src/store.js')
  const { saveGoalsCommonActions } = await import('../src/renderer/src/lib/goals-common-actions-config.js')
  const previous = useAppStore.getState().config; cleanup.push(() => { useAppStore.setState({ config: previous }) })
  useAppStore.setState({ config: f.current() })
  let release!: () => void
  const delay = new Promise<void>(resolve => { release = resolve })
  let saved!: AppConfig
  const call = vi.spyOn(api.config, 'configureGoalsCommonActions').mockImplementation(async input => {
    saved = await configureGoalsCommonActions(f.owner, input); await delay; return saved
  })
  const pending = saveGoalsCommonActions({ expectedDirectory: undefined, directory: { items: [{ kind: 'prompt', id: 'original-prompt' }], collapsed: true },
    prompts: { expected: f.current().composerShortcuts!, value: f.current().composerShortcuts!.map(prompt => prompt.id === 'original-prompt' ? { ...prompt, body: 'GUI instruction' } : prompt) } })
  await vi.waitFor(() => expect(saved).toBeTruthy())
  const later = await f.owner.update(current => ({ ...current, appearance: { ...current.appearance, terminalFontSize: 19 } }))
  useAppStore.setState({ config: later }); release(); await pending
  expect(call).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().config).toBe(later)
  expect(f.current().composerShortcuts!.find(prompt => prompt.id === 'original-prompt')!.body).toBe('GUI instruction')
})
