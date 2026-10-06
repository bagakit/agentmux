import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi } from '../src/shared/contracts.js'
import type { RuntimeController } from '../src/main/runtime-controller.js'
import type { ConfigStore } from '../src/main/config-store.js'
import type { ScratchTopics } from '../src/main/scratch-topics.js'
import type { WorkspaceFiles } from '../src/main/workspace-files.js'

const fixture = vi.hoisted(() => ({
  path: '',
  api: undefined as unknown as AgentMuxPreloadApi,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  invokes: [] as Array<{ channel: string; values: unknown[] }>,
  sender: { id: 1, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), off: vi.fn(), session: { flushStorageData: vi.fn() } }
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  app: { getPath: () => fixture.path, getAppPath: () => fixture.path },
  contextBridge: { exposeInMainWorld: (_key: string, value: AgentMuxPreloadApi) => { fixture.api = value } },
  webFrame: { getZoomFactor: () => 1 },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => fixture.handlers.set(channel, handler), removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  ipcRenderer: { async invoke(channel: string, ...values: unknown[]) {
    fixture.invokes.push({ channel, values })
    const handler = fixture.handlers.get(channel)
    if (!handler) throw new Error(`Missing registered Main handler: ${channel}`)
    return await handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, ...values)
  }, on: vi.fn(), off: vi.fn(), send: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [] }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'isolated-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown' }), dispose() {} }) }))

import '../src/preload/index.js'
import { LocalExecutionHost } from '@agentmux/core'
import { registerIpc } from '../src/main/ipc.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { GIT_NONINTERACTIVE_ENV } from '@agentmux/git'

let root: string
let dispose: (() => Promise<void>) | undefined
let targetOid: string
let host: LocalExecutionHost
beforeEach(async () => {
  fixture.handlers.clear(); fixture.invokes.length = 0
  root = await mkdtemp(join(tmpdir(), 'agentmux-commit-ipc-'))
  fixture.path = root
  host = new LocalExecutionHost()
  const git = async (...args: string[]) => {
    const result = await host.run('git', ['-C', root, ...args], { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
    return result.stdout.trim()
  }
  await git('init', '-b', 'base'); await git('config', 'user.name', 'Private'); await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(root, 'one.txt'), 'base\n'); await git('add', '--all'); await git('commit', '-m', 'Base')
  await git('switch', '-c', 'target'); await writeFile(join(root, 'one.txt'), 'target\n'); await git('add', '--all'); await git('commit', '-m', 'Target\n\nComplete target body'); targetOid = await git('rev-parse', 'HEAD')
  await git('switch', 'base'); await writeFile(join(root, 'one.txt'), 'dirty decoy\n')
  const runtime = { resourceSampler: { setObservationSources: () => () => {} }, setContinuousProgressInputObserver: () => () => {}, setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {}, executionHost: (id: string) => { expect(id).toBe('original-host'); return host } } as unknown as RuntimeController
  dispose = await registerIpc({ initialConfig: ({ ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'repo', hostId: 'original-host', path: root, name: 'Private', kind: 'folder' }] }), window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: fixture.sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => ({ ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'repo', hostId: 'original-host', path: root, name: 'Private', kind: 'folder' }] }) } as unknown as ConfigStore,
    scratchTopics: { setNameAudit: () => {} } as unknown as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles,
    progressLoops: { subscribe: () => () => {} } as unknown as Parameters<typeof registerIpc>[0]['progressLoops'] })
  expect(fixture.handlers.has('git:commitDetails')).toBe(true)
  expect(fixture.handlers.has('git:commitDiff')).toBe(true)
}, 20_000)
afterEach(async () => {
  try { await dispose?.() } finally { dispose = undefined; if (root) await rm(root, { recursive: true, force: true }) }
})

it('uses actual preload and registered Main with the neutral owner for full commit/files and fixed blobs', async () => {
  const input = { oid: targetOid }
  const result = await fixture.api.git.commitDetails('repo', input)
  expect(result.kind).toBe('ready')
  if (result.kind !== 'ready') throw new Error('No actual commit snapshot')
  expect(result.commit.oid).toBe(targetOid)
  expect(result.commit.message).toBe('Target\n\nComplete target body\n')
  expect(result.commit.parents).toHaveLength(1)
  expect(result.entries).toEqual([{ path: 'one.txt', origPath: null, change: 'modified' }])
  const descriptor = { kind: 'commit' as const, snapshot: result.snapshot, file: { path: 'one.txt', origPath: null } }
  const diff = await fixture.api.git.commitDiff('repo', descriptor)
  expect(diff.old).toEqual({ present: true, binary: false, text: 'base\n' })
  expect(diff.new).toEqual({ present: true, binary: false, text: 'target\n' })
  expect(await import('node:fs/promises').then(fs => fs.readFile(join(root, 'one.txt'), 'utf8'))).toBe('dirty decoy\n')
  expect(fixture.invokes).toEqual([
    { channel: 'git:commitDetails', values: ['repo', input] },
    { channel: 'git:commitDiff', values: ['repo', descriptor] }
  ])
  await dispose!(); dispose = undefined
  expect(fixture.handlers.has('git:commitDetails')).toBe(false)
  expect(fixture.handlers.has('git:commitDiff')).toBe(false)
})

it('preserves exact target and commit failures through both bridge layers', async () => {
  await expect(fixture.api.git.commitDetails('missing', { oid: targetOid })).rejects.toThrow('Unknown workspace')
  await expect(fixture.api.git.commitDetails('repo', { oid: 'HEAD' })).rejects.toThrow('complete commit object ID')
  const result = await fixture.api.git.commitDetails('repo', { oid: targetOid })
  if (result.kind !== 'ready') throw new Error('No actual commit snapshot')
  await expect(fixture.api.git.commitDiff('repo', { kind: 'commit', snapshot: { ...result.snapshot, hostId: 'another-host' }, file: { path: 'one.txt', origPath: null } })).rejects.toThrow('no longer refers')
})
