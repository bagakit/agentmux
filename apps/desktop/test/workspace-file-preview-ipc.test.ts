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

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => '/private-file-preview-ipc' },
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
import { shell } from 'electron'

it('actual preload and registered Main IPC retain Workspace identity, raw PNG bytes and existing external exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-preview-ipc-'))
  const firstRoot = join(root, 'first'), secondRoot = join(root, 'second')
  await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
  const workspaces: WorkspaceRecord[] = [
    { id: 'preview-first', name: 'First', kind: 'folder', hostId: 'local', path: firstRoot },
    { id: 'preview-second', name: 'Second', kind: 'folder', hostId: 'local', path: secondRoot }
  ]
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+3fVbWQAAAABJRU5ErkJggg==', 'base64')
  await Promise.all([writeFile(join(firstRoot, 'same.png'), 'wrong workspace bytes'), writeFile(join(secondRoot, 'same.png'), bytes)])
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore())
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), workspaces }
  const files = new WorkspaceFiles(() => new LocalExecutionHost())
  const snapshot = vi.spyOn(files, 'snapshotBytes')
  const sender = Object.assign(new EventEmitter(), { id: 710, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined
  try {
    dispose = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime,
      configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {} } as never,
      scratchTopics: {} as never, workspaceFiles: files })
    bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      expect(handler, `Missing registered handler: ${channel}`).toBeTypeOf('function')
      // Electron's structured clone carries Uint8Array; this bridge leaves all product callers real.
      return structuredClone(await handler!({ sender } as unknown as IpcMainInvokeEvent, ...values))
    })
    expect(bridge.api).not.toBeNull()
    const result = await bridge.api!.files.readPreview('preview-second', 'same.png')
    expect(result).toEqual({ status: 'ready', kind: 'image', mimeType: 'image/png', bytes: new Uint8Array(bytes),
      revision: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, byteLength: bytes.length, readCost: { payloadBytes: bytes.length } })
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(workspaces[1], 'same.png', {})
    await expect(bridge.api!.files.readPreview('missing-workspace', 'same.png')).rejects.toThrow()
    expect(await bridge.api!.files.readPreview('preview-second', 'same.png', { expectedRevision: 'sha256:old' })).toMatchObject({ status: 'changed' })
    await bridge.api!.files.openSystem('preview-second', 'same.png')
    await bridge.api!.files.reveal('preview-second', 'same.png')
    const originalPath = await realpath(join(secondRoot, 'same.png'))
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(originalPath)
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(originalPath)
    expect(await readFile(join(secondRoot, 'same.png'))).toEqual(bytes)
    expect(await readFile(join(firstRoot, 'same.png'), 'utf8')).toBe('wrong workspace bytes')
  } finally { await dispose?.(); await files.dispose(); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() }
})
