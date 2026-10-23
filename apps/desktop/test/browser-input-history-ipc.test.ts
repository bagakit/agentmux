// @vitest-environment happy-dom
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, BrowserInputHistoryTarget, BrowserInputHistoryScope, BrowserProfileSummary } from '../src/shared/contracts.js'

type TestOwner = { workspaceId: string | null; storage: { mode: 'normal' | 'private'; profileId: string | null }; url: string }
const bridge = vi.hoisted(() => ({
  root: '', api: null as AgentMuxPreloadApi | null,
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  invoke: vi.fn(), owners: new Map<string, TestOwner>(), defaultProfile: () => '',
  navigate: vi.fn(), manager: null as unknown
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  app: { getPath: () => bridge.root || tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
  ipcMain: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => bridge.handlers.set(channel, listener),
    removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
  webFrame: { getZoomFactor: () => 1 }, clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}, safeStorage: {}
}))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} } }))
// Unrelated connector startup must not open the person's durable connection store.
vi.mock('../../../packages/connectors/src/connection-services.js', () => ({ createConnectionServices: async () => ({
  connections: { list: async () => [] }, secrets: {}, close: async () => {}
}) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../src/main/browser-view-manager.js', async original => {
  const actual = await original<typeof import('../src/main/browser-view-manager.js')>()
  return { ...actual, BrowserViewManager: class extends actual.BrowserViewManager {
    constructor(...args: ConstructorParameters<typeof actual.BrowserViewManager>) {
      super(...args)
      bridge.manager = this
      bridge.defaultProfile = () => args[1].defaultProfileId()
      // Only the native page substrate is a Source double. The production scope getter below stays real.
      ;(this as unknown as { entries: Map<string, TestOwner> }).entries = bridge.owners
    }
    async navigate(id: string, text: string) {
      const owner = bridge.owners.get(id)
      if (!owner) throw new Error('Unknown test native page')
      bridge.navigate(id, text)
      owner.url = text
      return { id, mode: owner.storage.mode, profileId: owner.storage.profileId, url: text } as import('../src/shared/contracts.js').BrowserSnapshot
    }
    dispose() { bridge.owners.clear(); super.dispose() }
  } }
})

import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'
import '../src/preload/index.js'

const roots: string[] = []
const channels = ['browser:listInputHistory', 'browser:recordInputHistory', 'browser:removeInputHistory', 'browser:clearInputHistory']
afterEach(async () => {
  vi.restoreAllMocks()
  bridge.navigate.mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, maxRetries: 3, retryDelay: 50 })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-input-history-ipc-'))
  roots.push(root); bridge.root = root; bridge.owners.clear(); bridge.handlers.clear()
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [
    { id: 'resource-workspace', name: 'Resource', hostId: 'local', path: root, kind: 'folder' as const },
    { id: 'display-workspace', name: 'Display', hostId: 'local', path: join(root, 'display'), kind: 'folder' as const }
  ] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  const sender = Object.assign(new EventEmitter(), { id: 732, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow,
    runtime, configStore: { get: async () => config, validate: (value: unknown) => value, save: async (value: unknown) => value } as never, progressLoops: { subscribe: () => () => {} } as never,
    // History requests do not create a native workface window; retain the original IPC owner port.
    workbenchWindows: { setNativeOwner: () => () => {} } as Parameters<typeof registerIpc>[0]['workbenchWindows'],
    scratchTopics: new ScratchTopics(), workspaceFiles: { listFiles: async () => [], dispose: async () => {} } as never })
  const invoke = async (channel: string, values: unknown[], actualSender: unknown = sender) => {
    const handler = bridge.handlers.get(channel)
    expect(handler, `Actual registered channel missing: ${channel}`).toBeTypeOf('function')
    return await handler!({ sender: actualSender } as IpcMainInvokeEvent, ...values)
  }
  bridge.invoke.mockImplementation(async (channel: string, ...values: unknown[]) => structuredClone(await invoke(channel, values)))
  expect(bridge.api).not.toBeNull()
  const profiles = await bridge.api!.browser.listProfiles()
  expect(profiles.length).toBeGreaterThan(0)
  const defaultProfile = profiles.find(profile => profile.isDefault)
  expect(defaultProfile).toBeDefined()
  expect(defaultProfile!.id).toBe(bridge.defaultProfile())
  bridge.owners.set('history-page', { workspaceId: 'resource-workspace', storage: { mode: 'normal', profileId: defaultProfile!.id }, url: 'about:blank' })
  const target: BrowserInputHistoryTarget = { kind: 'browser', browserId: 'history-page', profileId: defaultProfile!.id }
  const scope: BrowserInputHistoryScope = { workspaceId: 'resource-workspace', profileId: defaultProfile!.id }
  const path = join(root, 'browser-input-history', `${createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.profileId])).digest('hex')}.json`)
  const complete = async () => {
    try { await dispose() }
    catch (error) {
      if (error instanceof AggregateError) throw new AggregateError(error.errors, error.errors.map(item => `${item.message}: ${item.cause}`).join('\n'))
      throw error
    }
  }
  return { root, config, sender, invoke, api: bridge.api!.browser, target, scope, path, dispose: complete }
}

describe('actual preload and registered Main input-history path', () => {
  it('private input does not read or write persistent history, through actual preload and Main handlers', async () => {
    const f = await fixture()
    try {
      await f.api.recordInputHistory(f.target, 'normal-kept')
      const before = await readFile(f.path, 'utf8'), files = await readdir(join(f.root, 'browser-input-history'))
      bridge.owners.set('private-input', { workspaceId: 'resource-workspace', storage: { mode: 'private', profileId: null }, url: 'about:blank' })
      const target: BrowserInputHistoryTarget = { kind: 'browser', browserId: 'private-input', profileId: null }
      expect(await f.api.listInputHistory(target)).toEqual({ scope: { workspaceId: 'resource-workspace', profileId: null }, entries: [] })
      const recorded = await f.api.recordInputHistory(target, 'private-secret-input')
      expect(await readFile(f.path, 'utf8'), 'private input must not change the real persistent history bytes').toBe(before)
      expect(recorded).toMatchObject({ entries: [], outcome: 'private' })
      expect(await readdir(join(f.root, 'browser-input-history'))).toEqual(files)
      expect((await f.api.listInputHistory(f.target)).entries.map(row => row.text)).toEqual(['normal-kept'])
    } finally { await f.dispose() }
  })
  it('round-trips real durable history through the original resource Workspace, not another display location', async () => {
    const f = await fixture()
    try {
      expect(await f.api.listInputHistory(f.target)).toEqual({ scope: f.scope, entries: [] })
      const first = await f.api.recordInputHistory(f.target, 'first human query')
      expect(first).toEqual({ scope: f.scope, entries: [{ text: 'first human query', submittedAt: expect.any(Number) }], outcome: 'recorded' })
      await f.api.recordInputHistory(f.target, 'https://example.invalid/p?q=%2B#fragment')
      expect((await f.api.listInputHistory({ kind: 'workspace', workspaceId: 'resource-workspace' })).entries.map(entry => entry.text))
        .toEqual(['https://example.invalid/p?q=%2B#fragment', 'first human query'])
      expect(await f.api.listInputHistory({ kind: 'workspace', workspaceId: 'display-workspace' })).toEqual({ scope: { ...f.scope, workspaceId: 'display-workspace' }, entries: [] })
      expect((await f.api.removeInputHistory(f.target, first.scope, 'first human query')).entries.map(entry => entry.text))
        .toEqual(['https://example.invalid/p?q=%2B#fragment'])
      expect(JSON.parse(await readFile(f.path, 'utf8')).scope).toEqual(f.scope)
      expect(await f.api.clearInputHistory(f.target, first.scope)).toEqual({ scope: f.scope, entries: [] })
      expect(bridge.invoke.mock.calls.filter(([channel]) => channels.includes(channel)).length).toBeGreaterThan(0)
    } finally { await f.dispose() }
  })

  it('uses the actual Profile manager default before creation and rejects stale Browser/Profile, null and unknown resources', async () => {
    const f = await fixture()
    try {
      const launcher = { kind: 'workspace', workspaceId: 'resource-workspace' } as const
      expect((await f.api.recordInputHistory(launcher, 'before create search')).scope).toEqual(f.scope)
      const profile: BrowserProfileSummary = await f.api.createProfile('Other History Profile')
      expect(profile.id).not.toBe(f.scope.profileId)
      bridge.owners.get('history-page')!.storage.profileId = profile.id
      await expect(f.api.listInputHistory(f.target)).rejects.toThrow('Profile changed')
      const switched = { ...f.target, profileId: profile.id } as BrowserInputHistoryTarget
      const actual = await f.api.recordInputHistory(switched, 'other profile input')
      expect(actual.scope).toEqual({ ...f.scope, profileId: profile.id })
      expect((await f.api.listInputHistory(launcher)).entries.map(entry => entry.text)).toEqual(['before create search'])
      await expect(f.api.removeInputHistory(switched, f.scope, 'other profile input')).rejects.toThrow('scope changed')
      await expect(f.api.clearInputHistory(switched, f.scope)).rejects.toThrow('scope changed')
      expect((await f.api.listInputHistory(switched)).entries.map(entry => entry.text)).toEqual(['other profile input'])
      bridge.owners.get('history-page')!.workspaceId = null
      await expect(f.api.listInputHistory(switched)).rejects.toThrow('no verified Workspace')
      bridge.owners.get('history-page')!.workspaceId = 'absent-workspace'
      await expect(f.api.recordInputHistory(switched, 'unbound')).rejects.toThrow('Unknown workspace')
      await expect(f.api.listInputHistory({ kind: 'workspace', workspaceId: 'absent-workspace' })).rejects.toThrow('Unknown workspace')
      bridge.owners.delete('history-page')
      await expect(f.api.listInputHistory(switched)).rejects.toThrow('Unknown browser')
    } finally { await f.dispose() }
  })

  it('rejects another sender for every history channel while native navigation has no recording side effect', async () => {
    const f = await fixture()
    try {
      const foreign = { id: f.sender.id }
      const values: unknown[][] = [[f.target], [f.target, 'foreign input'], [f.target, f.scope, 'foreign input'], [f.target, f.scope]]
      expect(channels).toHaveLength(4)
      for (const [index, channel] of channels.entries()) {
        await expect(f.invoke(channel, values[index]!, foreign)).rejects.toThrow('Untrusted Browser input history sender')
      }
      expect(await f.api.listInputHistory(f.target)).toEqual({ scope: f.scope, entries: [] })
      await f.invoke('browser:navigate', ['history-page', 'agent page navigation'], foreign)
      expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('history-page', 'agent page navigation')
      expect(await f.api.listInputHistory(f.target)).toEqual({ scope: f.scope, entries: [] })
      await expect(readdir(join(f.root, 'browser-input-history'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.dispose() }
  })

  it('does not turn corrupt-history failure into navigation failure or an empty successful list', async () => {
    const f = await fixture()
    try {
      await f.api.recordInputHistory(f.target, 'initial human input')
      const raw = Buffer.from('{invalid retained input history')
      await writeFile(f.path, raw)
      await expect(f.api.listInputHistory(f.target)).rejects.toThrow()
      await expect(f.api.recordInputHistory(f.target, 'later human input')).rejects.toThrow()
      await f.api.navigate('history-page', 'normal navigation still allowed')
      expect(bridge.navigate).toHaveBeenCalledExactlyOnceWith('history-page', 'normal navigation still allowed')
      expect(await readFile(f.path)).toEqual(raw)
      expect(bridge.owners.get('history-page')).toEqual({ workspaceId: f.scope.workspaceId, storage: { mode: 'normal', profileId: f.scope.profileId }, url: 'normal navigation still allowed' })
    } finally { await f.dispose() }
  })
})
