const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
const fixture = vi.hoisted(() => ({ root: '', handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>() }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, app: { getPath: () => fixture.root || tmpdir(), getAppPath: () => fixture.root || tmpdir() },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => fixture.handlers.set(channel, handler), removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, session: {}
}))
vi.mock('@agentmux/core', async actual => ({ ...await actual<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/agent-notifier.js', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { DEFAULT_CONFIG } from '../src/main/config-store.js'
import { registerIpc } from '../src/main/ipc.js'
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'

const roots: string[] = []
const id = '11111111-1111-4111-8111-111111111111'
const valid = JSON.stringify({ version: 1, defaultProfileId: id, profiles: [{ id, label: 'Original', createdAt: _reshape_fixtureEpoch(0, 0, 1), source: null }], pendingImports: [] })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true }))) })

it.each(['json', 'schema', 'io'] as const)('keeps host IPC available on actual original Profile %s failure and explicitly retries the original metadata', async shape => {
  const root = await mkdtemp(join(tmpdir(), 'amx-profile-isolation-')); roots.push(root); fixture.root = root; fixture.handlers.clear()
  const path = join(root, 'browser-profiles.json'), broken = shape === 'json' ? '{' : '{"version":1}'
  if (shape === 'io') { await mkdir(path); await writeFile(join(path, 'kept'), 'original unmodified bytes') } else await writeFile(path, broken)
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'resource', name: 'Original', hostId: 'local', path: root, kind: 'folder' as const }] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  // Core transport and native window are declared test substrates; no Run is launched or stopped.
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  const runtimeDispose = vi.spyOn(runtime, 'dispose')
  const sender = Object.assign(new EventEmitter(), { id: 731, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  let startupError: unknown = null
  const dispose = await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {} } as never,
    scratchTopics: { setNameAudit: vi.fn() } as never, workspaceFiles: { dispose: async () => {} } as never }).catch(error => { startupError = error; return null })
  expect(startupError, 'Browser Profile failure must not abort host IPC availability').toBeNull()
  expect(dispose).toBeTypeOf('function')
  const invoke = async (channel: string, ...values: unknown[]) => {
    const handler = fixture.handlers.get(channel); expect(handler, `Missing actual production handler ${channel}`).toBeTypeOf('function')
    return await handler!({ sender } as IpcMainInvokeEvent, ...values)
  }
  try {
    expect(await invoke('config:get')).toEqual(config)
    expect(fixture.handlers.has('sessions:snapshot')).toBe(true); expect(fixture.handlers.has('sessions:write')).toBe(true)
    expect(await invoke('providers:list')).toEqual(await runtime.providerCatalog()); expect(runtimeDispose).not.toHaveBeenCalled()
    await expect(invoke('browser:create', 'original-browser', 'https://example.invalid/', 'resource', id)).rejects.toThrow('Browser Profiles could not be loaded')
    await expect(invoke('browser:listProfiles')).rejects.toThrow('Original profile data is kept')
    if (shape === 'io') { expect(await readFile(join(path, 'kept'), 'utf8')).toBe('original unmodified bytes'); await rm(path, { recursive: true }) }
    else expect(await readFile(path, 'utf8')).toBe(broken)
    await writeFile(path, valid) // Explicit fixture repair preserves the original stable Profile identity.
    let retryError: unknown = null
    const profiles = await invoke('browser:listProfiles').catch(error => { retryError = error; return [] }) as { id: string }[]
    expect(retryError, 'The explicit Profile retry must re-read the repaired original file').toBeNull()
    expect(profiles.map(profile => profile.id)).toEqual([id]); expect(await readFile(path, 'utf8')).toBe(valid)
    const read = vi.spyOn(BrowserProfileStore.prototype, 'listProfiles')
    expect(await invoke('browser:listProfiles')).toEqual(profiles); expect(read).not.toHaveBeenCalled()
    expect(await invoke('config:get')).toEqual(config); expect(runtimeDispose).not.toHaveBeenCalled()
  } finally { await dispose!() }
})

it('shares concurrent initialization failures and retries without inventing a default Profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-profile-init-')); roots.push(root); const path = join(root, 'browser-profiles.json')
  await writeFile(path, '{'); const store = new BrowserProfileStore(path), manager = new BrowserProfileManager(store), read = vi.spyOn(store, 'listProfiles')
  try {
    const outcomes = await Promise.allSettled([manager.initialize(), manager.initialize()])
    expect(read).toHaveBeenCalledTimes(1); expect(outcomes.every(outcome => outcome.status === 'rejected')).toBe(true)
    const errors = outcomes.map(outcome => outcome.status === 'rejected' ? outcome.reason : null)
    expect(errors[0]).toBe(errors[1]); expect(() => manager.defaultProfileId()).toThrow('Original profile data is kept'); expect(await readFile(path, 'utf8')).toBe('{')
    await writeFile(path, valid); await Promise.all([manager.initialize(), manager.initialize()]); expect(read).toHaveBeenCalledTimes(2); expect(manager.defaultProfileId()).toBe(id)
  } finally { await manager.dispose() }
})

it('does not wait for an unconfirmed Profile read to expose healthy host APIs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-profile-pending-')); roots.push(root); fixture.root = root; fixture.handlers.clear()
  const path = join(root, 'browser-profiles.json'); await writeFile(path, valid)
  let allowRead!: () => void
  const waiting = new Promise<void>(yes => { allowRead = yes }), originalRead = BrowserProfileStore.prototype.listProfiles
  const read = vi.spyOn(BrowserProfileStore.prototype, 'listProfiles').mockImplementation(async function (this: BrowserProfileStore) { await waiting; return await originalRead.call(this) })
  const config = { ...structuredClone(DEFAULT_CONFIG), workspaces: [{ id: 'resource', name: 'Original', hostId: 'local', path: root, kind: 'folder' as const }] }
  const runtime = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), localRuntimeConnector)
  vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], hostSignatures: new Map(), reservedHostIds: [] })
  const runtimeDispose = vi.spyOn(runtime, 'dispose'), sender = Object.assign(new EventEmitter(), { id: 734, isDestroyed: () => false, send: vi.fn(), mainFrame: { framesInSubtree: [] } })
  let dispose: (() => Promise<void>) | null = null, bootstrapError: unknown = null
  const started = registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {} } as never,
    scratchTopics: { setNameAudit: vi.fn() } as never, workspaceFiles: { dispose: async () => {} } as never }).then(value => { dispose = value }).catch(error => { bootstrapError = error })
  try {
    // This is a proof deadline for a protected assertion, never a product timeout/death policy.
    await vi.waitFor(() => expect(dispose, 'Pending Browser-only metadata must not hold the host bootstrap').toBeTypeOf('function'), { timeout: 750 })
    expect(bootstrapError).toBeNull(); expect(runtimeDispose).not.toHaveBeenCalled()
    const handler = fixture.handlers.get('config:get')!; expect(await handler({ sender } as IpcMainInvokeEvent)).toEqual(config)
    const list = fixture.handlers.get('browser:listProfiles')!; expect(list).toBeTypeOf('function')
    let settled = false
    const requested = Promise.resolve(list({ sender } as IpcMainInvokeEvent)).then(result => { settled = true; return result })
    await new Promise(done => setTimeout(done, 15)); expect(settled).toBe(false); expect(read).toHaveBeenCalledTimes(1)
    allowRead(); expect((await requested as { id: string }[]).map(value => value.id)).toEqual([id]); expect(await readFile(path, 'utf8')).toBe(valid)
    expect(runtimeDispose).not.toHaveBeenCalled()
  } finally {
    allowRead(); await started
    if (dispose) await (dispose as () => Promise<void>)()
  }
})
