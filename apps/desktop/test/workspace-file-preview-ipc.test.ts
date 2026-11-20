// @vitest-environment happy-dom
import { settingsScratchTopics, settingsWorkbenchWindows, prepareSettingsIpcDirectory } from './helpers/settings-ipc-fixture'
import { testWorkbenchUserState } from './helpers/workbench-user-state-fixture'
import { testAppDocumentSources } from "./helpers/app-document-fixture"
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxMemoryAgentSessionStore, LocalExecutionHost } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, WorkspaceRecord } from '../src/shared/contracts'
import { WorkspaceFiles } from '../src/main/workspace-files'
import { RuntimeController } from '../src/main/runtime-controller'

const bridge = vi.hoisted(() => ({ root: '', api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  globalShortcut: { register: () => true, unregister: vi.fn(), isRegistered: () => false },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.root, getAppPath: () => process.cwd() + '/apps/desktop', on: vi.fn(), off: vi.fn(), once: vi.fn(), removeListener: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => bridge.handlers.set(channel, handler),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: { openPath: vi.fn(async () => ''), showItemInFolder: vi.fn() }
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', async () => ({ BrowserProfileManager: (await import('./helpers/settings-ipc-fixture')).SettingsBrowserProfiles }))
vi.mock('../../../packages/browser/src/browser-operation-journal.ts', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-preview.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../../../packages/browser/src/browser-ref-ledger-store.ts', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', async () => ({ BrowserViewManager: (await import('./helpers/settings-ipc-fixture')).SettingsBrowserViews }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { shell } from 'electron'

it('actual preload and registered Main IPC retain Workspace identity, raw PNG bytes and existing external exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-preview-ipc-'))
  bridge.root = root
  await prepareSettingsIpcDirectory(root)
  const firstRoot = join(root, 'first'), secondRoot = join(root, 'second')
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
  const workspaces: WorkspaceRecord[] = [
    { id: 'preview-first', name: 'First', kind: 'folder', hostId: 'local', path: firstRoot },
    { id: 'preview-second', name: 'Second', kind: 'folder', hostId: 'local', path: secondRoot }
  ]
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg==', 'base64')
  await Promise.all([writeFile(join(firstRoot, 'same.png'), 'wrong workspace bytes'), writeFile(join(secondRoot, 'same.png'), bytes)])
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), workspaces }
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const snapshot = vi.spyOn(files, 'snapshotBytes')
  const sender = Object.assign(new EventEmitter(), { id: 710, isDestroyed: () => false, mainFrame: { framesInSubtree: [] }, send: vi.fn() })
  const window = { isDestroyed: () => false, setBackgroundColor: vi.fn(), webContents: sender } as unknown as BrowserWindow
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await registerIpc({ workbenchUserState: testWorkbenchUserState(), appDocumentSources: testAppDocumentSources(sender), initialConfig: config, window, workbenchWindows: settingsWorkbenchWindows(window), applicationAccess: {} as never, runtime,
      configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {} } as never,
      scratchTopics: settingsScratchTopics(), workspaceFiles: files })
    bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      expect(handler, `Missing registered handler: ${channel}`).toBeTypeOf('function')
      // Electron's structured clone carries Uint8Array; this bridge leaves all product callers real.
      return structuredClone(await handler!({ senderFrame: Reflect.get(sender as object, 'mainFrame'), sender } as unknown as IpcMainInvokeEvent, ...values))
    })
    expect(bridge.api).not.toBeNull()
    const result = await bridge.api!.files.readPreview('preview-second', 'same.png')
    expect(result).toEqual({ status: 'ready', kind: 'image', mimeType: 'image/png', bytes: new Uint8Array(bytes),
      revision: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteLength: bytes.length, readCost: { payloadBytes: bytes.length } })
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(workspaces[1], 'same.png', {})
    await expect(bridge.api!.files.readPreview('missing-workspace', 'same.png')).rejects.toThrow()
    expect(await bridge.api!.files.readPreview('preview-second', 'same.png', { expectedRevision: 'sha256:old' })).toMatchObject({ status: 'changed' })
    await bridge.api!.files.openSystem({ kind: 'workspace', workspaceId: 'preview-second', path: 'same.png' })
    await bridge.api!.files.reveal({ kind: 'workspace', workspaceId: 'preview-second', path: 'same.png' })
    const originalPath = await realpath(join(secondRoot, 'same.png'))
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(originalPath)
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(originalPath)
    const original = { hostId: 'local', workspaceId: workspaces[0]!.id, workspacePath: firstRoot }
    const source = { target: { hostId: 'local', expectedRuntimeId: 'original-runtime' },
      resource: { ...original, zoneId: 'first-zone', zonePath: firstRoot, path: 'same.png' },
      query: { zoneId: 'first-zone', path: 'same.png', expectedResource: original } }
    const stat = vi.spyOn(runtime, 'sourceFilesCall').mockRejectedValue(new Error('Original Source unavailable'))
    await expect(bridge.api!.files.openSystem({ kind: 'source', source })).rejects.toThrow('Original Source unavailable')
    await expect(bridge.api!.files.reveal({ kind: 'source', source })).rejects.toThrow('Original Source unavailable')
    vi.spyOn(runtime, 'executionHost').mockReturnValue(new LocalExecutionHost())
    await expect(bridge.api!.workspaces.addFromFile({ kind: 'source', source }, { hostId: 'local', path: secondRoot })).rejects.toThrow('Original Source unavailable')
    expect(stat).toHaveBeenCalledWith(source.target, 'file.stat', source.query)
    expect(shell.openPath).toHaveBeenCalledTimes(1)
    expect(shell.showItemInFolder).toHaveBeenCalledTimes(1)
    const witness = { device: '1', inode: '2', size: '1', ctimeNs: '1', mtimeNs: '1', birthtimeNs: null }
    stat.mockResolvedValue({ carrierCurrent: true, result: { resource: source.resource, result: { status: 'observed',
      observation: { root: witness, parent: witness, parentPath: '.', entry: { kind: 'file', witness },
        implementation: { platform: 'darwin', stat: 'native', mkdir: 'native-no-replace' } } } } })
    await bridge.api!.files.openSystem({ kind: 'source', source })
    await bridge.api!.files.reveal({ kind: 'source', source })
    const firstPath = await realpath(join(firstRoot, 'same.png'))
    expect(shell.openPath).toHaveBeenLastCalledWith(firstPath)
    expect(shell.showItemInFolder).toHaveBeenLastCalledWith(firstPath)
    expect(await readFile(join(secondRoot, 'same.png'))).toEqual(bytes)
    expect(await readFile(join(firstRoot, 'same.png'), 'utf8')).toBe('wrong workspace bytes')
  } finally { await dispose?.(); await files.dispose(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() }
})
