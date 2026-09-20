import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxControlRequest, AgentMuxControlResult } from '@agentmux/core'
import type { AppConfig, AppLinkSchemeChoice } from '../src/shared/contracts.js'
import { RuntimeController, type RuntimePreparation } from '../src/main/runtime-controller.js'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'

const ipc = vi.hoisted(() => ({
  root: '', handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  execute: undefined as ((request: AgentMuxControlRequest) => Promise<AgentMuxControlResult>) | undefined,
  remember: undefined as ((scheme: string, choice: AppLinkSchemeChoice) => Promise<void>) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => ipc.root || tmpdir() },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => ipc.handlers.set(channel, handler),
    removeHandler: (channel: string) => ipc.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class {
    constructor(options: { execute: typeof ipc.execute }) { ipc.execute = options.execute }
    async start() {} async stop() {}
  }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager.js', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal.js', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store.js', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager.js', () => ({ BrowserViewManager: class {
  constructor(_window: unknown, _profiles: unknown, _ledger: unknown, options: { rememberScheme: typeof ipc.remember }) { ipc.remember = options.rememberScheme }
  dispose() {}
} }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { AgentMuxMemoryAgentSessionStore, AGENTMUX_CONTROL_SCHEMA_VERSION, AGENTMUX_CONTROL_MAX_MESSAGE_BYTES } from '@agentmux/core'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store.js'
import { ConfigOwner } from '../src/main/config-owner.js'
import { saveRuntimeConfig } from '../src/main/runtime-config-transaction.js'
import { registerIpc } from '../src/main/ipc.js'
import { executeSettingsControl } from '../src/main/settings-control.js'
import { executeSettingsBrowserControl, forgetBrowserAppLink } from '../src/main/settings-browser-control.js'
import { scalarSettingsSchemaKeys } from './helpers/settings-schema-keys.js'
import { ContinuousProgressLoopManager } from '../src/main/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../src/main/continuous-progress-loop-store.js'

const directories: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const envelope = { schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'browser-settings' } as const
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

async function privateConfig(browser = structuredClone(DEFAULT_CONFIG.browser)) {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-browser-settings-')); directories.push(root); ipc.root = root
  const store = new ConfigStore(join(root, 'config.json'))
  const config = await store.save({ ...structuredClone(DEFAULT_CONFIG), browser,
    workspaces: [{ id: '__scratch__', name: 'Private Topics', path: join(root, 'topics'), hostId: 'local', kind: 'folder' }] })
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
  const runtime = { prepare: vi.fn(async () => preparation), commit: vi.fn(), discard: vi.fn(async () => {}),
    reserveExecutorConfigEdit: vi.fn(async () => () => {}), setTerminalViewColors: vi.fn(), attach: vi.fn(() => () => {}),
    resourceSampler: { setObservationSources: vi.fn(() => () => {}) } } as unknown as RuntimeController
  return { root, store, config, runtime, bytes: () => readFile(store.filePath, 'utf8') }
}
async function fixture(browser?: AppConfig['browser']) {
  const f = await privateConfig(browser); let current = f.config
  const save = vi.fn(async (next: AppConfig) => await saveRuntimeConfig({ runtime: f.runtime, configWriter: f.store, next: f.store.validate(next) }))
  const publish = vi.fn((saved: AppConfig) => { current = saved })
  return { ...f, save, publish, owner: new ConfigOwner({ read: () => current, save, publish }) }
}
const list = (owner: ConfigOwner) => executeSettingsBrowserControl({ ...envelope, operation: 'settings.browser.links.list' }, owner)
const forget = (owner: ConfigOwner, scheme: string) => executeSettingsBrowserControl({ ...envelope, operation: 'settings.browser.links.forget', scheme }, owner)

describe('Browser settings share the sole typed Main owner', () => {
  it('derives every supported scalar from the actual nonempty durable schema, including Browser automation', async () => {
    const f = await fixture(), result = await executeSettingsControl({ ...envelope, operation: 'settings.get' }, f.owner)
    if (result.operation !== 'settings.get') throw new Error('Expected settings.get')
    const discovered = await scalarSettingsSchemaKeys()
    expect(discovered.length).toBeGreaterThan(0); expect(result.entries.length).toBeGreaterThan(0)
    expect(result.entries.map(entry => entry.key).sort()).toEqual(discovered.sort())
    expect(result.entries.find(entry => entry.key === 'browser.agentAutomation')).toEqual({ key: 'browser.agentAutomation', kind: 'boolean', value: false, default: false })
  })

  it('keeps an absent effective false truly unchanged and explicitly enables it without creating remembered answers', async () => {
    const { agentAutomation: _absent, ...browser } = structuredClone(DEFAULT_CONFIG.browser)
    const f = await fixture(browser), bytes = await f.bytes()
    expect(Object.hasOwn(f.owner.current.browser, 'agentAutomation')).toBe(false)
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.agentAutomation', value: 'false' }, f.owner)
    expect(await f.bytes()).toBe(bytes); expect(f.runtime.prepare).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled()
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.agentAutomation', value: 'true' }, f.owner)
    expect(f.owner.current.browser.agentAutomation).toBe(true); expect(f.owner.current.browser.appLinkSchemes).toBeUndefined()
    const committed = await f.bytes(), count = f.publish.mock.calls.length
    await executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.agentAutomation', value: 'true' }, f.owner)
    expect(await f.bytes()).toBe(committed); expect(f.publish).toHaveBeenCalledTimes(count)
    for (const value of ['TRUE', '1', '', 'allow']) await expect(executeSettingsControl({ ...envelope, operation: 'settings.set', key: 'browser.agentAutomation', value }, f.owner)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(await f.bytes()).toBe(committed); expect(f.publish).toHaveBeenCalledTimes(count)
  })

  it('lists exact stored keys and forgets each current answer while preserving its neighbor and unrelated Browser fields', async () => {
    const schemes = ['proof-\u0000-key', '', '  ', 'proof:', '--help', '--input', 'constructor', '__proto__']
    const answers = Object.fromEntries(schemes.map(scheme => [scheme, 'deny' as const]))
    const f = await fixture({ ...structuredClone(DEFAULT_CONFIG.browser), appLinkSchemes: { ...answers, neighbor: 'allow' } })
    expect(Object.keys(f.owner.current.browser.appLinkSchemes!)).toHaveLength(schemes.length + 1)
    expect(await list(f.owner)).toEqual({ operation: 'settings.browser.links.list', entries: Object.entries({ ...answers, neighbor: 'allow' }).map(([scheme, choice]) => ({ scheme, choice })) })
    const toolbar = f.owner.current.browser.toolbar
    for (const scheme of schemes) {
      expect(await forget(f.owner, scheme)).toEqual({ operation: 'settings.browser.links.forget', scheme, changed: true })
      const bytes = await f.bytes(), count = f.publish.mock.calls.length, preparations = vi.mocked(f.runtime.prepare).mock.calls.length
      expect(await forget(f.owner, scheme)).toEqual({ operation: 'settings.browser.links.forget', scheme, changed: false })
      expect(await f.bytes()).toBe(bytes); expect(f.publish).toHaveBeenCalledTimes(count); expect(f.runtime.prepare).toHaveBeenCalledTimes(preparations)
      expect(f.owner.current.browser.appLinkSchemes!.neighbor).toBe('allow'); expect(f.owner.current.browser.toolbar).toEqual(toolbar)
      expect(f.owner.current.browser.agentAutomation).toBe(false)
    }
    expect(await list(f.owner)).toEqual({ operation: 'settings.browser.links.list', entries: [{ scheme: 'neighbor', choice: 'allow' }] })
  })

  it('compares the UI displayed answer, but CLI deletes the answer current when its queued command is processed', async () => {
    const f = await fixture({ ...structuredClone(DEFAULT_CONFIG.browser), appLinkSchemes: { alpha: 'deny', neighbor: 'allow' } })
    const entered = deferred(), held = deferred(), prepare = vi.mocked(f.runtime.prepare).getMockImplementation()!
    vi.mocked(f.runtime.prepare).mockImplementationOnce(async (...args) => { entered.resolve(); await held.promise; return prepare(...args) })
    const native = f.owner.update(current => ({ ...current, browser: { ...current.browser, appLinkSchemes: { ...current.browser.appLinkSchemes, alpha: 'allow' } } }))
    await entered.promise; const command = forget(f.owner, 'alpha'); held.resolve(); await native
    expect(await command).toEqual({ operation: 'settings.browser.links.forget', scheme: 'alpha', changed: true })
    expect(f.owner.current.browser.appLinkSchemes).toEqual({ neighbor: 'allow' })
    await f.owner.update(current => ({ ...current, browser: { ...current.browser, appLinkSchemes: { ...current.browser.appLinkSchemes, alpha: 'allow' } } }))
    const bytes = await f.bytes(), count = f.publish.mock.calls.length
    await expect(forgetBrowserAppLink(f.owner, 'alpha', 'deny')).rejects.toMatchObject({ code: 'CONFIG_CONFLICT', field: 'browser.appLinkSchemes.alpha' })
    expect(await f.bytes()).toBe(bytes); expect(f.publish).toHaveBeenCalledTimes(count)
    expect(f.owner.current.browser.appLinkSchemes).toEqual({ neighbor: 'allow', alpha: 'allow' })
  })

  it('does not treat inherited names as remembered answers and rejects malformed Main inputs before a write', async () => {
    const f = await fixture(), bytes = await f.bytes()
    expect(await forget(f.owner, 'constructor')).toEqual({ operation: 'settings.browser.links.forget', scheme: 'constructor', changed: false })
    for (const scheme of [null, 3, 'x'.repeat(AGENTMUX_CONTROL_MAX_MESSAGE_BYTES + 1)]) {
      await expect(forgetBrowserAppLink(f.owner, scheme as string)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    }
    await expect(forgetBrowserAppLink(f.owner, 'alpha', 'ask' as AppLinkSchemeChoice)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
    expect(await f.bytes()).toBe(bytes); expect(f.publish).not.toHaveBeenCalled(); expect(f.runtime.prepare).not.toHaveBeenCalled()
  })

  it('loads and saves every own answer key through the real durable schema while an unrelated preference changes', async () => {
    const f = await privateConfig()
    const answers = Object.fromEntries([['__proto__', 'deny'], ['constructor', 'allow'], ['neighbor', 'deny']])
    // A valid owned raw file isolates the load path from the schema used by an earlier save.
    const seeded = { ...f.config, browser: { ...f.config.browser, appLinkSchemes: answers } }
    await writeFile(f.store.filePath, `${JSON.stringify(seeded, null, 2)}\n`, { mode: 0o600 })
    const loaded = await f.store.get()
    expect(loaded.browser.appLinkSchemes).toEqual(answers)
    expect(Object.hasOwn(loaded.browser.appLinkSchemes!, '__proto__')).toBe(true)
    const saved = await f.store.save({ ...loaded, copyPathsAsAbsolute: true })
    expect(saved.browser.appLinkSchemes).toEqual(answers)
    expect(JSON.parse(await f.bytes()).browser.appLinkSchemes).toEqual(answers)
    expect(saved.copyPathsAsAbsolute).toBe(true)
    for (const answer of [null, [], 1, Object.fromEntries([['__proto__', 'ask']])]) {
      expect(() => f.store.validate({ ...loaded, browser: { ...loaded.browser, appLinkSchemes: answer } } as AppConfig)).toThrow()
    }
  })

  it('routes registered native answers, public Control and UI Forget through the same actual Main ConfigOwner', async () => {
    const f = await privateConfig(), sender = { id: 918, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } }
    const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
    vi.spyOn(runtime, 'prepare').mockImplementation(vi.mocked(f.runtime.prepare).getMockImplementation()!)
    vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
    const progressLoops = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(f.root, 'loops.json')),
      async () => 'unknown', undefined, async () => { throw new Error('No automatic loop is admitted in the Browser fixture') })
    // The durable private file is already initialized; no default global Topics bootstrap is part of this owner oracle.
    vi.spyOn(f.store, 'get').mockResolvedValue(f.config)
    ipc.handlers.clear(); ipc.execute = undefined; ipc.remember = undefined
    const dispose = await registerIpc({ window: { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
      configStore: f.store, runtime, progressLoops, scratchTopics: {} as ScratchTopics,
      workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
    try {
      expect(ipc.execute).toBeTypeOf('function'); expect(ipc.remember).toBeTypeOf('function')
      const handler = ipc.handlers.get('browser:forgetAppLinkScheme'); expect(handler).toBeTypeOf('function')
      await ipc.remember!('alpha', 'deny'); await ipc.remember!('neighbor', 'allow'); await ipc.remember!('__proto__', 'deny')
      const entries = await ipc.execute!({ ...envelope, operation: 'settings.browser.links.list' })
      expect(entries).toEqual({ operation: 'settings.browser.links.list', entries: [
        { scheme: 'alpha', choice: 'deny' }, { scheme: 'neighbor', choice: 'allow' }, { scheme: '__proto__', choice: 'deny' }
      ] })
      await ipc.remember!('alpha', 'allow'); const bytes = await f.bytes(), publications = sender.send.mock.calls.length
      await expect(handler!({ sender } as unknown as IpcMainInvokeEvent, 'alpha', 'deny')).rejects.toMatchObject({ code: 'CONFIG_CONFLICT' })
      expect(await f.bytes()).toBe(bytes); expect(sender.send).toHaveBeenCalledTimes(publications)
      await expect(handler!({ sender } as unknown as IpcMainInvokeEvent, 'alpha', undefined)).rejects.toMatchObject({ code: 'INVALID_SETTING_VALUE' })
      await expect(ipc.execute!({ ...envelope, operation: 'settings.browser.links.forget', scheme: 'alpha' })).resolves.toEqual({ operation: 'settings.browser.links.forget', scheme: 'alpha', changed: true })
      expect(JSON.parse(await f.bytes()).browser.appLinkSchemes).toEqual(Object.fromEntries([['neighbor', 'allow'], ['__proto__', 'deny']]))
      expect(sender.send).toHaveBeenCalledTimes(publications + 1)
      await handler!({ sender } as unknown as IpcMainInvokeEvent, '__proto__', 'deny')
      expect(JSON.parse(await f.bytes()).browser.appLinkSchemes).toEqual({ neighbor: 'allow' })
      expect(sender.send).toHaveBeenCalledTimes(publications + 2)
    } finally { await dispose(); await progressLoops.stop() }
  })
})
