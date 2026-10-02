const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi } from '../src/shared/contracts'
import type { RuntimeController } from '../src/main/runtime-controller'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'

// Use the existing Git IPC suites' ordinary Electron boundary substitutes.
// The actual preload, registered Main handler, GitService and Git process run;
// unrelated Browser/Control owners are isolated, without starting user services.
const fixture = vi.hoisted(() => ({ path: '', api: undefined as unknown as AgentMuxPreloadApi,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  invokes: [] as Array<{ channel: string; values: unknown[] }>,
  sender: { id: 1, isDestroyed: () => false, send: vi.fn(), once: vi.fn(), off: vi.fn(), session: { flushStorageData: vi.fn() } } }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.path, getAppPath: () => fixture.path },
  contextBridge: { exposeInMainWorld: (_key: string, value: AgentMuxPreloadApi) => { fixture.api = value } },
  webFrame: { getZoomFactor: () => 1 },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  ipcRenderer: { async invoke(channel: string, ...values: unknown[]) {
    fixture.invokes.push({ channel, values }); const handler = fixture.handlers.get(channel)
    if (!handler) throw new Error(`Missing registered Main handler: ${channel}`)
    return await handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, ...values)
  }, on: vi.fn(), off: vi.fn(), send: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [] }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown' }), dispose() {} }) }))

import '../src/preload/index'
import { LocalExecutionHost } from '@agentmux/core'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { GIT_NONINTERACTIVE_ENV } from '../src/main/git-service'

let root: string, dispose: (() => Promise<void>) | undefined, host: LocalExecutionHost
async function git(...args: string[]) {
  const result = await host.run('git', ['-C', root, ...args], {
    env: GIT_NONINTERACTIVE_ENV, timeoutMs: 20_000, maxOutputBytes: 2 * 1024 * 1024 })
  expect(result.exitCode, 'The actual private Git IPC fixture must be valid').toBe(0)
}
beforeEach(async () => {
  fixture.handlers.clear(); fixture.invokes.length = 0
  root = await realpath(await mkdtemp(join(tmpdir(), 'agentmux-project-source-ipc-'))); fixture.path = root
  host = new LocalExecutionHost({ id: 'original-host' })
  await git('init', '-q'); await git('remote', 'add', 'origin', 'git@code.example:Team/project.git')
  const runtime = { resourceSampler: { setObservationSources: () => () => {} }, setContinuousProgressInputObserver: () => () => {},
    setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {},
    executionHost: (id: string) => { expect(id).toBe('original-host'); return host } } as unknown as RuntimeController
  dispose = await registerIpc({ window: { webContents: fixture.sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => ({ ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'repo', hostId: 'original-host', path: root,
      name: 'Original project', kind: 'folder' }] }) } as unknown as ConfigStore,
    scratchTopics: {} as ScratchTopics, workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles,
    progressLoops: { subscribe: () => () => {} } as unknown as Parameters<typeof registerIpc>[0]['progressLoops'] })
  expect(fixture.handlers.has('git:projectIdentity')).toBe(true)
})
afterEach(async () => {
  try { await dispose?.() } finally { dispose = undefined; if (root) await rm(root, { recursive: true, force: true }) }
})

it('reads exact original repository identity through actual preload and registered Main, then releases only its IPC handler', async () => {
  const before = await readFile(join(root, '.git/config'))
  expect(await fixture.api.git.projectIdentity('repo')).toEqual({ kind: 'known', hostId: 'original-host', repoPath: root,
    identities: ['code.example/Team/project'] })
  expect(fixture.invokes).toEqual([{ channel: 'git:projectIdentity', values: ['repo'] }])
  expect(await readFile(join(root, '.git/config'))).toEqual(before)
  await dispose!(); dispose = undefined
  expect(fixture.handlers.has('git:projectIdentity')).toBe(false)
})

it('keeps unavailable source observation distinct across both original bridge layers', async () => {
  await git('remote', 'set-url', 'origin', _hygiene_fixturePath("private/unconfirmed-source.git"))
  expect(await fixture.api.git.projectIdentity('repo')).toMatchObject({ kind: 'unavailable', hostId: 'original-host', workspacePath: root })
  expect(fixture.invokes).toEqual([{ channel: 'git:projectIdentity', values: ['repo'] }])
})
