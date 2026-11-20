// @vitest-environment happy-dom
import { act } from 'react'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, HostConfig } from '../src/shared/contracts'
import { CONFIG_CHANGED_CHANNEL } from '../src/shared/contracts'

const bridge = vi.hoisted(() => ({
  api: null as AgentMuxPreloadApi | null,
  invoke: vi.fn(),
  handlers: new Map<string, (...args: any[]) => any>(),
  renderer: new Map<string, Set<(...args: any[]) => any>>(),
  main: new Map<string, Set<(...args: any[]) => any>>(),
  storagePath: '', controlPath: '', sender: null as any,
}))
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))
vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (name: string, value: AgentMuxPreloadApi) => { bridge.api = value; Object.assign(window, { [name]: value }) } },
  ipcRenderer: {
    invoke: bridge.invoke,
    on: (channel: string, fn: (...args: any[]) => any) => { const set = bridge.renderer.get(channel) ?? new Set(); set.add(fn); bridge.renderer.set(channel, set) },
    off: (channel: string, fn: (...args: any[]) => any) => bridge.renderer.get(channel)?.delete(fn),
    removeListener: (channel: string, fn: (...args: any[]) => any) => bridge.renderer.get(channel)?.delete(fn),
    send: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel),
    on: (channel: string, fn: (...args: any[]) => any) => { const set = bridge.main.get(channel) ?? new Set(); set.add(fn); bridge.main.set(channel, set) },
    off: (channel: string, fn: (...args: any[]) => any) => bridge.main.get(channel)?.delete(fn),
    removeListener: (channel: string, fn: (...args: any[]) => any) => bridge.main.get(channel)?.delete(fn),
  },
  globalShortcut: { register: () => true, unregister: vi.fn() },
  webFrame: { getZoomFactor: () => 1 },
  app: { once: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), getPath: () => bridge.storagePath,
    getAppPath: () => join(process.cwd(), 'apps/desktop'), getAppMetrics: () => [], isPackaged: false },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, safeStorage: {},
}))
vi.mock('../src/main/browser-external-owner', () => ({ ExternalBrowserOwner: class { has() { return false } dispose() {} } }))
vi.mock('@agentmux/core', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/core')>()
  class PrivateControlServer {
    private readonly inner: InstanceType<typeof actual.AgentMuxControlServer>
    constructor(options: any) { this.inner = new actual.AgentMuxControlServer({ ...options, socketPath: bridge.controlPath }) }
    get path() { return this.inner.path }
    start() { return this.inner.start() }
    stop() { return this.inner.stop() }
  }
  return { ...actual, AgentMuxControlServer: PrivateControlServer }
})
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('@agentmux/connectors', async actual => ({ ...await actual<typeof import('@agentmux/connectors')>(),
  createConnectionServices: async () => ({ connections: { list: async () => [] }, secrets: {}, close: async () => {} }) }))
vi.mock('../../../packages/browser/src/browser-operation-journal.ts', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../../../packages/browser/src/browser-ref-ledger-store.ts', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-profile-manager', async () => ({ BrowserProfileManager: (await import('./helpers/settings-ipc-fixture.js')).SettingsBrowserProfiles }))
vi.mock('../src/main/browser-view-manager', async () => ({ BrowserViewManager: (await import('./helpers/settings-ipc-fixture.js')).SettingsBrowserViews }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../src/main/notes-storage-owner.js', async () => ({ NotesStorageOwner: (await import('./helpers/settings-ipc-fixture.js')).SettingsNotesStorage }))
await vi.hoisted(async () => { await import('../src/preload/index') })
import '../src/preload/index'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController, type RuntimePreparation } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { ConfigStore, DEFAULT_CONFIG } from '../src/main/config-store'
import { localRuntimeConnector } from './helpers/local-runtime-connector'
import { prepareSettingsIpcDirectory, settingsScratchTopics, settingsWorkbenchWindows, settingsWorkspaceFiles } from './helpers/settings-ipc-fixture'
import { testWorkbenchUserState } from './helpers/workbench-user-state-fixture'
import { testAppDocumentSources } from './helpers/app-document-fixture'
import { hostsSettingsModule } from '../src/renderer/src/components/settings/modules/hosts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { installNoteCanvasGeometry } from './helpers/note-canvas-dom'

const dom = composerDOM()
const publicKey = 'nodekey:' + 'a'.repeat(64)
let directory: string, configStore: ConfigStore, config: AppConfig, runtime: RuntimeController
let dispose: (() => Promise<void>) | undefined
const session = composerSession('original-tailcat-product')

beforeEach(async () => {
  installNoteCanvasGeometry()
  directory = await mkdtemp(join(tmpdir(), 'amux-tailcat-product-'))
  bridge.storagePath = directory; bridge.controlPath = join(directory, 'desktop.sock')
  bridge.handlers.clear(); bridge.renderer.clear(); bridge.main.clear(); bridge.invoke.mockReset()
  await prepareSettingsIpcDirectory(directory)
  const local: HostConfig = { ...DEFAULT_CONFIG.hosts.find(host => host.kind === 'local')!, id: 'local',
    tailcat: { enabled: true, keyFile: 'saved-product-server', allowedClients: [publicKey] } }
  const remote = { id: 'product-remote', kind: 'ssh' as const, label: 'Product remote', hostname: '', runtimeId: 'original-product-runtime',
    transport: 'tailcat' as const, tailcat: { address: 'tcproductfixture', keyFile: 'saved-product-client' } }
  configStore = new ConfigStore(join(directory, 'config.json'))
  config = await configStore.save({ ...structuredClone(DEFAULT_CONFIG), hosts: [local, remote],
    workspaces: [{ id: 'product-workspace', name: 'Private product', hostId: 'local', path: directory, kind: 'folder' }] })
  runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  const preparation: RuntimePreparation = { hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() }
  vi.spyOn(runtime, 'prepare').mockResolvedValue(preparation)
  vi.spyOn(runtime, 'attach').mockReturnValue(() => {})
  vi.spyOn(runtime, 'callOriginalCore').mockImplementation(async (_hostId, method) => {
    if (method === 'settings.hosts.inspect') return { routeHostId: 'local', configuration: config.hosts[0], tailcat: { state: 'disabled' } } as never
    throw new Error(`Unrelated external transport is controlled: ${method}`)
  })
  bridge.sender = Object.assign(new EventEmitter(), {
    id: 913, isDestroyed: () => false, isLoadingMainFrame: () => false, getOSProcessId: () => 913,
    mainFrame: { framesInSubtree: [] as [] },
    send: (channel: string, ...values: unknown[]) => {
      if (channel === CONFIG_CHANGED_CHANNEL) { config = values[0] as AppConfig; useAppStore.setState({ config }) }
      for (const fn of bridge.renderer.get(channel) ?? []) fn({}, ...values)
    },
  })
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler, channel).toBeTypeOf('function')
    return handler!({ senderFrame: Reflect.get(bridge.sender as object, 'mainFrame'), sender: bridge.sender } as IpcMainInvokeEvent, ...values)
  })
  const workspaceFiles = settingsWorkspaceFiles()
  Reflect.set(workspaceFiles, 'readDirectory', vi.fn(async () => { throw new Error('No workspace directory read in this Tailcat product test') }))
  dispose = await registerIpc({
    workbenchWindows: settingsWorkbenchWindows({ webContents: bridge.sender } as unknown as BrowserWindow),
    workbenchUserState: testWorkbenchUserState(), appDocumentSources: testAppDocumentSources(bridge.sender),
    initialConfig: config, window: { id: 913, setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: bridge.sender } as unknown as BrowserWindow,
    configStore, runtime, applicationAccess: {} as never, scratchTopics: settingsScratchTopics(), workspaceFiles,
  })
  useAppStore.setState({ config, sessions: [session], hostChecks: {}, tailcatConnectionDrafts: {} })
})

afterEach(async () => {
  await dispose?.(); dispose = undefined
  await runtime?.dispose()
  bridge.handlers.clear(); bridge.renderer.clear(); bridge.main.clear()
  await rm(directory, { recursive: true, force: true })
})

async function show(hostId = 'local') {
  const Pane = hostsSettingsModule.Pane
  await dom.render(<Pane config={config} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={{ section: 'hosts', hostId }} />)
}
function visibleIncoming() {
  return [...dom.container.querySelectorAll<HTMLElement>('[data-settings-field="incoming"]')]
    .filter(node => !node.hidden && !node.closest('[hidden]') && !node.inert && !node.closest('[inert]'))
}

it('the relocated local Connection saves exactly its original Tailcat slice through real preload, Main RPC and private config', async () => {
  const before = JSON.parse(await readFile(configStore.filePath, 'utf8')) as AppConfig
  const diskWrites = vi.spyOn(configStore, 'save')
  const saveHosts = vi.spyOn(api.config, 'save')
  await show()
  await vi.waitFor(() => expect(visibleIncoming()).toHaveLength(1))
  const incoming = visibleIncoming()
  expect(incoming).toHaveLength(1)
  expect(dom.container.querySelector('[data-resource-editor="local"][data-host-view="connection"]')).not.toBeNull()
  const toggle = incoming[0]!.querySelector<HTMLInputElement>('[aria-label="Allow Tailcat connections"]')
  expect(toggle?.checked).toBe(true)
  expect(toggle?.type).toBe('checkbox')
  expect(toggle?.getAttribute('role')).toBe('switch')
  expect(toggle?.classList.contains('ui-switch')).toBe(true)
  const label = toggle!.closest('label')!
  expect(toggle!.labels?.[0]).toBe(label)
  await act(async () => label.querySelector('strong')!.click())
  expect(toggle?.checked).toBe(false)
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'hosts:configureTailcat')).toHaveLength(0)
  await act(async () => incoming[0]!.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!.click())
  await vi.waitFor(async () => {
    const current = JSON.parse(await readFile(configStore.filePath, 'utf8')) as AppConfig
    expect(current.hosts[0]).toMatchObject({ tailcat: { ...before.hosts[0]!.tailcat!, enabled: false } })
  })
  const after = JSON.parse(await readFile(configStore.filePath, 'utf8')) as AppConfig
  expect(after).toEqual({ ...before, hosts: [{ ...before.hosts[0]!, tailcat: { ...before.hosts[0]!.tailcat!, enabled: false } }, before.hosts[1]!] })
  expect(diskWrites).toHaveBeenCalledTimes(1)
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'hosts:configureTailcat')).toHaveLength(1)
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'config:save')).toHaveLength(0)
  expect(saveHosts).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toEqual([session])
  await show('product-remote')
  await vi.waitFor(() => expect(visibleIncoming()).toHaveLength(0))
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Tailcat address"]')?.value).toBe('tcproductfixture')
  const runtimeLabel = [...dom.container.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === 'Bound Runtime ID')
  expect(runtimeLabel?.querySelector('input')?.value).toBe('original-product-runtime')
})
