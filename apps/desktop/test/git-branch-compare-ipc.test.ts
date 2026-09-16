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
  api: undefined as unknown as AgentMuxPreloadApi,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  invokes: [] as Array<{ channel: string; values: unknown[] }>,
  sender: { id: 1, isDestroyed: () => false, send: vi.fn(), session: { flushStorageData: vi.fn() } }
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/isolated-branch-ipc' },
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
import { GIT_NONINTERACTIVE_ENV } from '../src/main/git-service.js'

let root: string
let dispose: (() => Promise<void>) | undefined
let targetOid: string
let host: LocalExecutionHost
beforeEach(async () => {
  fixture.handlers.clear(); fixture.invokes.length = 0
  root = await mkdtemp(join(tmpdir(), 'agentmux-branch-ipc-'))
  host = new LocalExecutionHost()
  const git = async (...args: string[]) => {
    const result = await host.run('git', ['-C', root, ...args], { env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
    return result.stdout.trim()
  }
  await git('init', '-b', 'base'); await git('config', 'user.name', 'Private'); await git('config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(root, 'one.txt'), 'base\n'); await git('add', '--all'); await git('commit', '-m', 'Base')
  await git('switch', '-c', 'target'); await writeFile(join(root, 'one.txt'), 'target\n'); await git('add', '--all'); await git('commit', '-m', 'Target'); targetOid = await git('rev-parse', 'HEAD')
  await git('switch', 'base'); await writeFile(join(root, 'one.txt'), 'dirty decoy\n')
  const runtime = { resourceSampler: { setObservationSources: () => () => {} }, setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {}, executionHost: () => host } as unknown as RuntimeController
  dispose = await registerIpc({ window: { webContents: fixture.sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => ({ ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'repo', hostId: 'local', path: root, name: 'Private', kind: 'folder' }] }) } as unknown as ConfigStore,
    scratchTopics: {} as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  expect(fixture.handlers.has('git:compareBranches')).toBe(true); expect(fixture.handlers.has('git:branchDiff')).toBe(true)
})
afterEach(async () => {
  try { await dispose?.() } finally { dispose = undefined; if (root) await rm(root, { recursive: true, force: true }) }
})

it('uses actual preload to registered Main to actual private Git for both comparison and pinned file reading', async () => {
  const input = { baseBranch: 'base', targetBranch: 'target', mode: 'two-point' } as const
  const pendingComparison = fixture.api.git.compareBranches('repo', input)
  await expect(pendingComparison).resolves.toMatchObject({ kind: 'ready', snapshot: { targetOid } })
  const comparison = await pendingComparison
  expect(comparison.kind).toBe('ready')
  if (comparison.kind !== 'ready') throw new Error('No actual comparison snapshot')
  expect(comparison.snapshot.targetOid).toBe(targetOid)
  expect(comparison.entries).toEqual([{ path: 'one.txt', origPath: null, change: 'modified' }])
  const descriptor = { snapshot: comparison.snapshot, file: comparison.entries[0]! }
  await expect(fixture.api.git.branchDiff('repo', descriptor)).resolves.toEqual({ path: 'one.txt', old: { present: true, binary: false, text: 'base\n' }, new: { present: true, binary: false, text: 'target\n' }, binary: false, change: 'modified' })
  expect(fixture.invokes).toEqual([{ channel: 'git:compareBranches', values: ['repo', input] }, { channel: 'git:branchDiff', values: ['repo', descriptor] }])
  await dispose!(); dispose = undefined
  expect(fixture.handlers.has('git:compareBranches')).toBe(false); expect(fixture.handlers.has('git:branchDiff')).toBe(false)
})

it('propagates a real missing-ref error through both bridge layers and never invents an empty comparison', async () => {
  await expect(fixture.api.git.compareBranches('repo', { baseBranch: 'missing', targetBranch: 'target', mode: 'merge-base' })).rejects.toThrow()
  expect(fixture.invokes.map(value => value.channel)).toEqual(['git:compareBranches'])
})
