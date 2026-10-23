// @vitest-environment happy-dom
import { fixtureFileUrl as _tailFixtureFileUrl, fixturePath as _tailFixturePath } from "../../../test/fixture-values.mjs"
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { WorkbenchWindowDocument } from '../src/shared/workbench-windows'
import { localRuntimeConnector } from './helpers/local-runtime-connector'

const bridge = vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false); return ({
  directory: '', api: null as AgentMuxPreloadApi | null,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  invoke: vi.fn(), open: vi.fn(), save: vi.fn(), confirm: vi.fn()
}) })
vi.mock('electron', () => ({
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  app: { getPath: () => bridge.directory || tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (_key: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.assign(window, { agentmux: api }) } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn(), sendSync: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, clipboard: {}, nativeImage: {}, shell: {}, session: {}, safeStorage: {},
  dialog: { showOpenDialog: bridge.open, showSaveDialog: bridge.save, showMessageBox: bridge.confirm }, Menu: {}, webContents: {}
}))
// The actual Main registration is retained. No test starts the person's IPC endpoint or connectors.
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/connectors', async actual => ({ ...await actual<typeof import('@agentmux/connectors')>(), createConnectionServices: async () => ({
  connections: { list: async () => [] }, secrets: {}, close: async () => {}
}) }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import '../src/preload/index'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { getThemeCatalog, DEFAULT_THEME_ID } from '@agentmux/client-ui/theme'
import { RuntimeController } from '../src/main/runtime-controller'
import { ScratchTopics } from '../src/main/scratch-topics'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { registerIpc } from '../src/main/ipc'
import { WorkbenchWindows } from '../src/main/workbench-windows'
import { WorkbenchWindowStore } from '../src/main/workbench-window-store'
import { NotesStorageOwner } from '../src/main/notes-storage-owner'
import { WORKBENCH_WINDOW_REQUEST } from '../src/shared/workbench-windows'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { ThemeLibrary } from '../src/renderer/src/components/settings/ThemeLibrary'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { useAppStore } from '../src/renderer/src/store'
import { composerSession } from './helpers/composer-dom-fixture'

let id = 1000
class Contents extends EventEmitter {
  id = ++id; mainFrame = { url: _tailFixtureFileUrl("private/index.html"), framesInSubtree: [] }
  getURL = () => this.mainFrame.url
  isDestroyed = () => false
  setBackgroundThrottling = vi.fn()
  setWindowOpenHandler = vi.fn()
  send = vi.fn()
}
class NativeWindow extends EventEmitter {
  id = ++id; webContents = new Contents(); destroyed = false; visible = true; focused = false
  isDestroyed = () => this.destroyed
  isVisible = () => this.visible
  isMinimized = () => false
  isMaximized = () => false
  isFocused = () => this.focused
  getBounds = () => ({ x: 10, y: 20, width: 1100, height: 760 })
  getNormalBounds = this.getBounds
  getBackgroundColor = () => '#101216'
  setBackgroundColor = vi.fn()
  showInactive = () => { this.visible = true }
  show = () => { this.visible = true }
  hide = () => { this.visible = false }
  focus = () => { this.focused = true }
  restore = vi.fn()
  maximize = vi.fn()
  destroy = () => { this.destroyed = true; this.emit('closed') }
  close = () => { let prevented = false; this.emit('close', { preventDefault: () => { prevented = true } }); if (!prevented) this.destroy() }
}

const target = { kind: 'tab' as const, displayWorkspaceId: 'private-display', groupId: 'private-group', tabId: 'original-tab' }
const actor = { actor: { kind: 'user' as const, id: 'desktop' } }
const cleanups: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  bridge.handlers.clear(); bridge.invoke.mockReset(); bridge.open.mockReset(); bridge.save.mockReset(); bridge.confirm.mockReset()
  bridge.open.mockResolvedValue({ canceled: true, filePaths: [] })
  bridge.save.mockResolvedValue({ canceled: true })
  bridge.confirm.mockResolvedValue({ response: 0 })
})
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'amx-native-dialog-window-'))
  bridge.directory = directory
  const main = new NativeWindow(), children: NativeWindow[] = []
  const owner = new WorkbenchWindows(main as unknown as BrowserWindow, new WorkbenchWindowStore(join(directory, 'windows.json')),
    () => [{ x: 0, y: 0, width: 1800, height: 1100 }])
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame } as unknown as IpcMainInvokeEvent
  main.webContents.send.mockImplementation((channel: string, request: any) => {
    if (channel !== WORKBENCH_WINDOW_REQUEST) return
    queueMicrotask(() => {
      if (request.action === 'open') {
        const details = { url: request.url, frameName: request.frameName }
        expect(owner.windowOpen(details as never, () => {})).toMatchObject({ action: 'allow' })
        const child = new NativeWindow(); children.push(child)
        owner.createdWindow(child as unknown as BrowserWindow, details)
      }
      owner.accept(event as never, { requestId: request.requestId, windowId: request.windowId,
        documentGeneration: request.documentGeneration, outcome: 'applied', message: null })
    })
  })
  const mainScope = await owner.rendererReady(event)
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [
    { id: 'original-resource', hostId: 'local', path: directory, name: 'Original', kind: 'folder' as const }
  ] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  const stop = vi.spyOn(runtime, 'stopSession')
  // A dialog-route fixture must not run an unrelated migration against the person's Notes directory.
  vi.spyOn(NotesStorageOwner.prototype, 'initialize').mockResolvedValue(undefined as never)
  const saveConfig = vi.fn(async (value: unknown) => value)
  const dispose = await registerIpc({ initialConfig: config, window: main as unknown as BrowserWindow, workbenchWindows: owner,
    runtime, configStore: { get: async () => config, validate: (value: unknown) => value, save: saveConfig } as never,
    progressLoops: { subscribe: () => () => {} } as never, scratchTopics: new ScratchTopics(),
    workspaceFiles: { listFiles: async () => [], dispose: async () => {} } as never })
  const invoke = async (channel: string, values: unknown[], sender: unknown = main.webContents) => {
    const handler = bridge.handlers.get(channel)
    expect(handler, `Actual Main channel missing: ${channel}`).toBeTypeOf('function')
    return await handler!({ ...event, sender } as IpcMainInvokeEvent, ...values)
  }
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => structuredClone(await invoke(channel, values)))
  cleanups.push(async () => { try { await dispose() } finally { owner.dispose(); await rm(directory, { recursive: true, force: true }) } })
  const openChild = async (operationId: string) => {
    const page = await owner.call('app.window.open', { operationId, target }, actor)
    expect(page.recordedOperation?.state).toBe('confirmed')
    return { windowId: page.recordedOperation!.windowId!, documentGeneration: page.recordedOperation!.documentGeneration! }
  }
  const childScope = await openChild('original-open')
  expect(children).toHaveLength(1)
  return { directory, main, children, owner, mainScope, childScope, openChild, event, invoke, config, saveConfig, stop, api: bridge.api! }
}

const selected = getThemeCatalog().items.find(theme => theme.id === DEFAULT_THEME_ID)!
const theme = { id: selected.id, ...selected.value }
function library(scope: WorkbenchWindowDocument, doc: Document, onSave = vi.fn()) {
  return <WorkbenchDocumentContext.Provider value={{ document: doc, window: scope }}>
    <ThemeLibrary selected={selected} appearance={{}} active editing={false} onCustomize={() => {}} onSave={onSave} />
    <textarea aria-label="Original protected draft" defaultValue="keep this original draft" />
  </WorkbenchDocumentContext.Provider>
}
async function pressExport(container: Element) {
  const button = Array.from(container.querySelectorAll('button')).find(node => node.textContent?.includes('Export selected theme'))
  expect(button).toBeDefined()
  await act(async () => { button!.click(); await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('native dialogs use their actual workface Window through the original shared Root bridge', () => {
  it('opens the actual Composer reference-files action in its original workface without sending or changing its draft on cancellation', async () => {
    const f = await fixture(), previous = useAppStore.getState(), sid = 'original-dialog-agent'
    const session = { ...composerSession(sid), workspacePath: f.directory }
    useAppStore.setState({ config: f.config, sessions: [session], providerCatalog: [], timelines: {},
      agentNames: {}, agentComposerDrafts: { [sid]: 'unfinished original message' }, agentSteerQueues: {},
      agentComposerHistory: {}, agentComposerHistoryNavigation: {}, error: null })
    cleanups.push(async () => { useAppStore.setState(previous, true) })
    const iframe = document.createElement('iframe'); document.body.append(iframe)
    const childDocument = iframe.contentDocument!, container = childDocument.createElement('div'); childDocument.body.append(container)
    const root = createRoot(container)
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); iframe.remove() })
    const controls = ['send', 'interrupt', 'enqueueAgentSteer'].map(method => vi.spyOn(useAppStore.getState(), method as 'send'))
    const renderComposer = async (scope: WorkbenchWindowDocument, doc: Document) => {
      await act(async () => root.render(<WorkbenchDocumentContext.Provider value={{ document: doc, window: scope }}>
        <DesktopClientUiProvider document={doc}><AgentSessionComposer sessionId={sid} /></DesktopClientUiProvider>
      </WorkbenchDocumentContext.Provider>))
    }
    await renderComposer(f.childScope, childDocument)
    const editor = container.querySelector<HTMLElement>('[role="textbox"]')!
    expect(editor).not.toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show the message tool row"]')!.click())
    const attach = container.querySelector<HTMLButtonElement>('[aria-label="Reference files for the Agent to read"]')!
    expect(attach).not.toBeNull(); expect(attach.disabled).toBe(false)
    await act(async () => attach.click())
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(1))
    expect(bridge.open).toHaveBeenLastCalledWith(f.children[0], { properties: ['openFile', 'multiSelections'], defaultPath: f.directory })
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('unfinished original message')
    expect(useAppStore.getState().sessions[0]).toBe(session)
    await f.owner.call('app.window.return', { operationId: 'composer-return', ...f.childScope }, actor)
    document.body.append(container); await renderComposer(f.mainScope, document)
    expect(container.querySelector('[role="textbox"]')).toBe(editor)
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Reference files for the Agent to read"]')!.click())
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledTimes(2))
    expect(bridge.open).toHaveBeenLastCalledWith(f.main, expect.any(Object))
    expect(useAppStore.getState().agentComposerDrafts[sid]).toBe('unfinished original message')
    for (const control of controls) expect(control).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('runs actual ThemeLibrary → api → preload → registered Main → original WorkbenchWindows across move/return', async () => {
    const f = await fixture(), iframe = document.createElement('iframe')
    document.body.append(iframe)
    const childDocument = iframe.contentDocument!, container = childDocument.createElement('div')
    childDocument.body.append(container)
    const root: Root = createRoot(container), onSave = vi.fn()
    cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); iframe.remove() })
    await act(async () => root.render(library(f.childScope, childDocument, onSave)))
    const draft = container.querySelector('textarea')!
    draft.value = 'edited original draft and selection'
    draft.setSelectionRange(7, 15)
    await pressExport(container)
    expect(bridge.save).toHaveBeenLastCalledWith(f.children[0], expect.objectContaining({ defaultPath: expect.stringContaining('.agentmux-theme.json') }))
    expect(container.textContent).toContain('Export cancelled. Saved themes and files are unchanged.')
    expect(bridge.invoke.mock.calls.filter(([channel]) => channel === 'ui:exportTheme')).toHaveLength(1)
    expect(f.children[0]).not.toBe(f.main)
    expect(f.event.sender).toBe(f.main.webContents) // Moving DOM does not create another preload bridge.

    const returned = await f.owner.call('app.window.return', { operationId: 'original-return', ...f.childScope }, actor)
    expect(returned.recordedOperation?.state).toBe('confirmed')
    await pressExport(container) // A stale retained render cannot silently choose another Window.
    expect(bridge.save).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Export failed: The exact original native window document is no longer current.')
    expect(draft.value).toBe('edited original draft and selection')
    document.body.append(container)
    await act(async () => root.render(library(f.mainScope, document, onSave)))
    const exported = join(f.directory, 'returned-original.agentmux-theme.json')
    bridge.save.mockResolvedValueOnce({ canceled: false, filePath: exported })
    await pressExport(container)
    expect(bridge.save).toHaveBeenLastCalledWith(f.main, expect.any(Object))
    await act(async () => { await vi.waitFor(async () => expect(JSON.parse(await readFile(exported, 'utf8'))).toEqual(theme)) })
    expect(container.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('edited original draft and selection')
    expect([draft.selectionStart, draft.selectionEnd]).toEqual([7, 15])
    expect(onSave).not.toHaveBeenCalled(); expect(f.saveConfig).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
  })

  it('routes all existing native dialog methods to the real child owner and preserves cancellation and retained files', async () => {
    const f = await fixture(), scope = f.childScope
    expect(await f.api.ui.chooseFiles({ defaultPath: f.directory }, scope)).toBeNull()
    expect(bridge.open).toHaveBeenLastCalledWith(f.children[0], { properties: ['openFile', 'multiSelections'], defaultPath: f.directory })
    expect(await f.api.workspaces.chooseLocalFolder(scope)).toBeNull()
    expect(bridge.open).toHaveBeenLastCalledWith(f.children[0], { properties: ['openDirectory'] })
    expect(await f.api.workspaces.rebindLocalFolder('original-resource', scope)).toBeNull()
    expect(bridge.open).toHaveBeenLastCalledWith(f.children[0], expect.objectContaining({ properties: ['openDirectory'] }))
    expect(await f.api.ui.exportTheme(theme, scope)).toEqual({ status: 'cancelled' })
    expect(bridge.save).toHaveBeenLastCalledWith(f.children[0], expect.any(Object))

    const selection = 'upload-Ab12Cd', snapshot = join(f.directory, 'browser-uploads', selection)
    await mkdir(join(snapshot, '0'), { recursive: true }); await writeFile(join(snapshot, '0', 'original.txt'), 'keep')
    await writeFile(join(snapshot, 'selection.json'), JSON.stringify({ version: 1, workspaceId: 'original-resource', browserId: 'original-browser',
      navigationId: 'original-document', operationId: 'original-operation', documentSurvivesClient: true, bytes: 4,
      files: [{ path: 'original.txt', name: 'original.txt', byteLength: 4, revision: 'original-revision' }] }))
    expect((await f.api.browser.listRetainedUploads()).selectionCount).toBe(1)
    expect(await f.api.browser.discardRetainedUpload(selection, scope)).toBe(false)
    expect(bridge.confirm).toHaveBeenLastCalledWith(f.children[0], expect.objectContaining({ defaultId: 0, cancelId: 0 }))
    expect(await readFile(join(snapshot, '0', 'original.txt'), 'utf8')).toBe('keep')
    expect(f.saveConfig).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
    expect(f.config.workspaces[0]!.path).toBe(f.directory)
  })

  it('rejects stale generations and foreign senders for every path without opening a replacement or losing original capability', async () => {
    const f = await fixture(), stale = { ...f.childScope, documentGeneration: 'retired-document-generation' }
    const paths = [
      { channel: 'ui:chooseFiles', values: [undefined, stale], run: () => f.api.ui.chooseFiles(undefined, stale) },
      { channel: 'workspaces:chooseLocalFolder', values: [stale], run: () => f.api.workspaces.chooseLocalFolder(stale) },
      { channel: 'workspaces:rebindLocalFolder', values: ['original-resource', stale], run: () => f.api.workspaces.rebindLocalFolder('original-resource', stale) },
      { channel: 'ui:exportTheme', values: [theme, stale], run: () => f.api.ui.exportTheme(theme, stale) },
      { channel: 'browser:discardRetainedUpload', values: ['exact-retained-selection', stale], run: () => f.api.browser.discardRetainedUpload('exact-retained-selection', stale) }
    ]
    expect(paths).toHaveLength(5)
    for (const path of paths) {
      await expect(path.run()).rejects.toThrow('no longer current')
      await expect(f.invoke(path.channel, path.values, { id: f.main.webContents.id })).rejects.toThrow('Untrusted')
    }
    expect(bridge.open).not.toHaveBeenCalled(); expect(bridge.save).not.toHaveBeenCalled(); expect(bridge.confirm).not.toHaveBeenCalled()
    bridge.open.mockResolvedValueOnce({ canceled: false, filePaths: [_tailFixturePath("private/original-file.txt")] })
    expect(await f.api.ui.chooseFiles(undefined, f.childScope)).toEqual([_tailFixturePath("private/original-file.txt")])
    expect(bridge.open).toHaveBeenLastCalledWith(f.children[0], expect.any(Object))
    expect(f.owner.windowForDocument(f.childScope)).toBe(f.children[0])
    expect(f.stop).not.toHaveBeenCalled(); expect(f.children).toHaveLength(1)
  })

  it('resolves reopened document generations through the same owner and keeps explicit global Main callers at Main', async () => {
    const f = await fixture()
    await f.owner.call('app.window.return', { operationId: 'return-and-reopen', ...f.childScope }, actor)
    const reopened = await f.openChild('new-presentation')
    expect(reopened).not.toEqual(f.childScope)
    await expect(f.api.ui.chooseFiles(undefined, f.childScope)).rejects.toThrow('no longer current')
    expect(await f.api.ui.chooseFiles(undefined, reopened)).toBeNull()
    expect(bridge.open).toHaveBeenLastCalledWith(f.children[1], expect.any(Object))
    expect(await f.api.ui.chooseFiles()).toBeNull()
    expect(bridge.open).toHaveBeenLastCalledWith(f.main, expect.any(Object))
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('does not discard retained files when its exact original parent ends while confirmation is pending', async () => {
    const f = await fixture(), selection = 'upload-Ab12Cd', snapshot = join(f.directory, 'browser-uploads', selection)
    await mkdir(join(snapshot, '0'), { recursive: true }); await writeFile(join(snapshot, '0', 'original.txt'), 'keep')
    await writeFile(join(snapshot, 'selection.json'), JSON.stringify({ version: 1, workspaceId: 'original-resource', browserId: 'original-browser',
      navigationId: 'original-document', operationId: 'original-operation', documentSurvivesClient: true, bytes: 4,
      files: [{ path: 'original.txt', name: 'original.txt', byteLength: 4, revision: 'original-revision' }] }))
    let answer!: (value: { response: number }) => void
    bridge.confirm.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const pending = f.api.browser.discardRetainedUpload(selection, f.childScope)
    await vi.waitFor(() => expect(bridge.confirm).toHaveBeenCalledTimes(1))
    expect(bridge.confirm.mock.calls[0]![0]).toBe(f.children[0])
    f.children[0]!.destroy(); answer({ response: 1 })
    expect(await pending).toBe(false)
    expect(await readFile(join(snapshot, '0', 'original.txt'), 'utf8')).toBe('keep')
    expect((await f.api.browser.listRetainedUploads()).selectionCount).toBe(1)
    expect(f.stop).not.toHaveBeenCalled()
  })
})
