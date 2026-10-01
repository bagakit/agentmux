import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore, LocalExecutionHost } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { RuntimeController } from '../src/main/runtime-controller'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => '/private-file-preview-ipc', getAppPath: () => '/private-file-preview-ipc', isPackaged: false },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-preview.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { BOOKMARK_FILE_MAX_BYTES, emitWebloc } from '../src/shared/bookmark-file'

const initialState = useAppStore.getState()
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initialState, true) })


it('registered bookmark IPC and Store report a byte-budget rejection without falling through to text or replacing the original workbench', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-bookmark-ipc-'))
  const workspace: WorkspaceRecord = { id: 'bookmark-project', name: 'Bookmarks', kind: 'folder', hostId: 'local', path: root }
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), workspaces: [workspace] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const sender = Object.assign(new EventEmitter(), { id: 711, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined
  try {
    await writeFile(join(root, 'Numeric.webloc'), emitWebloc('placeholder').replace('placeholder', 'https://example.invalid/?a=&#38;b=&#x4E2D;&#x1F642;'))
    await writeFile(join(root, 'Large.webloc'), emitWebloc('https://example.invalid/large'))
    await truncate(join(root, 'Large.webloc'), BOOKMARK_FILE_MAX_BYTES + 1)
    dispose = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime,
      configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {} } as never,
      scratchTopics: {} as never, workspaceFiles: files })
    bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      expect(handler, `Missing registered handler: ${channel}`).toBeTypeOf('function')
      return structuredClone(await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values))
    })
    expect(bridge.api).not.toBeNull()
    expect(await bridge.api!.files.readBookmark(workspace.id, 'Numeric.webloc')).toEqual({ url: 'https://example.invalid/?a=&b=中🙂', binary: false })
    const limit = await bridge.api!.files.readBookmark(workspace.id, 'Large.webloc').then(() => ({ status: 'unexpected-read' }), error => ({ code: error.code }))
    expect(limit).toEqual({ code: 'WORKSPACE_FILE_BYTE_LIMIT' })
    const originalTab = createWorkbenchTab('original-view', { regionId: 'original-region', kind: 'agent', phase: 'attached', workspaceId: workspace.id, sessionId: 'controlled-healthy-session' })
    const originalLayout = createWorkspaceLayout('original-group', [originalTab.id])
    useAppStore.setState({ config, activeWorkspaceId: workspace.id, tabs: { [originalTab.id]: originalTab }, layouts: { [workspace.id]: originalLayout }, documents: {}, documentIssues: {}, error: null })
    // Ordinary Electron rejects an invoke with a message, without preserving custom error.code.
    vi.spyOn(api.files, 'readBookmark').mockImplementation(async (id, path) => {
      try { return await bridge.api!.files.readBookmark(id, path) }
      catch (error) { throw new Error(`Error invoking bookmark preview: ${(error as Error).message}`) }
    })
    const read = vi.spyOn(api.files, 'read').mockImplementation((id, path) => bridge.api!.files.read(id, path))
    const create = vi.spyOn(api.browser, 'create')
    const before = useAppStore.getState(), topology = { tabs: structuredClone(before.tabs), layouts: structuredClone(before.layouts), sessions: structuredClone(before.sessions), activeWorkspaceId: before.activeWorkspaceId }
    expect(await useAppStore.getState().openFile('Large.webloc', undefined, undefined, workspace.id)).toBe(false)
    const after = useAppStore.getState()
    expect(after.error).toContain('4 MiB preview limit')
    expect(read).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(after.documents).toEqual({})
    expect({ tabs: after.tabs, layouts: after.layouts, sessions: after.sessions, activeWorkspaceId: after.activeWorkspaceId }).toEqual(topology)
  } finally { await dispose?.(); await files.dispose(); await rm(root, { recursive: true, force: true }) }
})
