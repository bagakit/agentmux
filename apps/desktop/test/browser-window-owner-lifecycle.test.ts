import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'

const wire = vi.hoisted(() => ({ root: '', handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: () => wire.root, getAppPath: () => process.cwd(), isPackaged: false },
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  ipcMain: { handle: (channel: string, handler: unknown) => wire.handlers.set(channel, handler),
    removeHandler: (channel: string) => wire.handlers.delete(channel), on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, safeStorage: {}, session: {}
}))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
vi.mock('../../../packages/connectors/src/connection-services.js', () => ({ createConnectionServices: async () => ({
  connections: { list: async () => [] }, secrets: {}, close: async () => {}
}) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))

import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { ScratchTopics } from '../src/main/scratch-topics.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'

const roots: string[] = []
const runtimes: RuntimeController[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })))
})

async function fixture(disposeFiles = vi.fn(async () => {})) {
  const root = await mkdtemp(join(tmpdir(), 'amx-window-owner-'))
  roots.push(root); wire.root = root; wire.handlers.clear()
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  runtimes.push(runtime)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  let departed = false
  const contents = Object.assign(new EventEmitter(), { id: 731, isDestroyed: () => departed, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  const host = Object.assign(new EventEmitter(), { id: 37, setBackgroundColor: vi.fn(), isDestroyed: () => departed, webContents: contents })
  Object.defineProperty(host, 'webContents', { get() { if (departed) throw new Error('Object has been destroyed'); return contents } })
  const releaseNative = vi.fn()
  const dispose = await registerIpc({ initialConfig: config, window: host as unknown as BrowserWindow,
    workbenchWindows: { setNativeOwner: () => releaseNative } as never,
    runtime, configStore: { get: async () => config, validate: (value: unknown) => value, save: async (value: unknown) => value } as never,
    progressLoops: { subscribe: () => () => {} } as never, scratchTopics: new ScratchTopics(),
    workspaceFiles: { listFiles: async () => [], dispose: disposeFiles } as never })
  return { host, contents, disposeFiles, releaseNative, runtime, dispose,
    depart() { departed = true; contents.emit('destroyed'); host.emit('closed') } }
}

it('closed workbench owners release the exact registered IPC document after native getters are gone', async () => {
  const f = await fixture()
  expect(f.contents.listenerCount('render-process-gone')).toBeGreaterThan(0)
  expect(f.contents.listenerCount('did-start-navigation')).toBeGreaterThan(0)
  expect(wire.handlers.size).toBeGreaterThan(0)
  f.depart()
  expect(() => f.host.webContents).toThrow('Object has been destroyed')
  await expect(f.dispose()).resolves.toBeUndefined()
  expect(f.contents.listenerCount('render-process-gone')).toBe(0)
  expect(f.contents.listenerCount('did-start-navigation')).toBe(0)
  expect(f.disposeFiles).toHaveBeenCalledTimes(1)
  expect(f.releaseNative).toHaveBeenCalledTimes(1)
  expect(wire.handlers.size).toBe(0)
})

it('closed workbench owners retain an actual disposal error and still release later IPC owners', async () => {
  const failure = new Error('Exact workspace file cleanup failed')
  const f = await fixture(vi.fn(async () => { throw failure }))
  f.depart()
  await expect(f.dispose()).rejects.toMatchObject({ errors: [expect.objectContaining({ cause: failure })] })
  expect(f.contents.listenerCount('did-start-navigation')).toBe(0)
  expect(f.releaseNative).toHaveBeenCalledTimes(1)
  expect(wire.handlers.size).toBe(0)
})
