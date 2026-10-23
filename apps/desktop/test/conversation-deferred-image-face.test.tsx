// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, loadAgentSessions, type AgentMuxStoredAgentSession } from '@agentmux/core'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { ConversationView } from '@agentmux/client-ui/components/ConversationView'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { recordedRaster } from '../../../packages/core/test/helpers/recorded-raster.js'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import { localRuntimeConnector } from './helpers/local-runtime-connector'
const bridge = await vi.hoisted(async () => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'amx-deferred-face-main-')) }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.directory, getAppPath: () => new URL('../', import.meta.url).pathname, isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  safeStorage: {}, clipboard: {}, dialog: {}, nativeImage: {}, shell: {} }))
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/core/notebook-store', async original => { const actual = await original<typeof import('@agentmux/core/notebook-store')>(); return { ...actual, AgentMuxNotesStorage: class extends actual.AgentMuxNotesStorage { constructor(locator?: string, directory?: string, ports?: ConstructorParameters<typeof actual.AgentMuxNotesStorage>[2]) { super(locator ?? bridge.directory + '/notes-location.json', directory ?? bridge.directory + '/notes', ports) } } } })
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [], snapshot: async () => ({ demands: [] }), subscribe: () => () => {} }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'owned-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { setPresentationWindowOwner() {} dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { resourceProcessIds() { return [] } dispose() {} } }))
vi.mock('@agentmux/connectors', async actual => ({ ...await actual<typeof import('@agentmux/connectors')>(), createConnectionServices: async () => ({ connections: { list: async () => [] }, secrets: {}, close: async () => {} }) }))
import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
const closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { window.getSelection()?.removeAllRanges(); for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
afterAll(() => rm(bridge.directory, { recursive: true, force: true }))
const flush = (check: () => void) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }); check() }, { timeout: 15_000 })
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  const directory = await mkdtemp(join(tmpdir(), 'amx-deferred-face-')); closes.push(() => rm(directory, { recursive: true, force: true }))
  const image = recordedRaster(), path = join(directory, 'original.jsonl'), storePath = join(directory, 'sessions.json')
  await writeFile(path, JSON.stringify({ type: 'user', uuid: 'original-image-record', sessionId: 'original-native', user_message_uuid: 'original-image-turn', message: { role: 'user', content: [
    { type: 'text', text: 'Keep **selected original prose** beside this picture.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.bytes.toString('base64') } }, { type: 'text', text: 'Original trailing text.' }
  ] } }) + '\n')
  const store = new AgentMuxFileAgentSessionStore(storePath), session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId: 'claude', executorId: 'original-claude', hostId: 'local', workspacePath: directory,
    run: { runId: 'healthy-original-run' }, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), hookBindingId: 'original-hook', hookToken: 'original-private-authority', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const originalSource = await readFile(path)
  const client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(kernel, key).mockImplementation(() => { throw new Error('Image reading must not operate Runtime') }))
  const controller = new RuntimeController(store, localRuntimeConnector)
  closes.push(async () => { await controller.dispose(); await client.dispose(); expect((await loadAgentSessions(store))[0]).toEqual(session); expect(await readFile(path)).toEqual(originalSource); expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]) })
  controller.commit({ hosts: [{ id: 'local', config: { id: 'local', kind: 'local', label: 'Original Host' }, client, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: { 'original-claude': { label: 'Original Claude', providerId: 'claude', command: 'owned-original-claude', args: ['--original-reader'], env: {}, injectAgentMuxGuide: false } } }
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', bridge.directory)
  await mkdir(join(bridge.directory, 'notes'), { recursive: true })
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 771, isDestroyed: () => false, send: vi.fn() })
  closes.push(await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow,
    runtime: controller, applicationAccess: {} as never, workbenchWindows: { setNativeOwner: () => () => {} } as never, progressLoops: { subscribe: () => () => {} } as never, configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as unknown as ConfigStore,
    scratchTopics: { setNameAudit: vi.fn() } as unknown as ScratchTopics, workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as unknown as WorkspaceFiles }))
  bridge.invoke.mockImplementation((channel: string, subject: unknown, request: unknown) => {
    const handler = bridge.handlers.get(channel); if (!handler) throw new Error('Original IPC handler missing: ' + channel)
    return handler({ sender } as unknown as IpcMainInvokeEvent, subject, request)
  })
  await bridge.api!.notesStorage.inspect()
  const wire = await client.readAgentConversation({ hostId: 'local', agentSessionId: session.agentSessionId, limit: 10 }), accepted = consumeConversationWindowPage(wire)
  expect(accepted.kind).toBe('complete'); if (accepted.kind !== 'complete') throw new Error('Original reader frame must be complete')
  const reading = projectConversationWindow(accepted.snapshot), page = reading.historyPage!, item = page.items[0]!, part = item.contentParts[1]!
  expect(part).toMatchObject({ kind: 'resource', resourceType: 'text', content: { kind: 'resource' }, contentEligibility: 'unconfirmed' })
  if (part.kind !== 'resource') throw new Error('Original signed wrapper required')
  const control = { hostId: 'local', agentSessionId: session.agentSessionId }
  const read = (input: Parameters<AgentMuxPreloadApi['sessions']['historyResource']>[1]) => bridge.api!.sessions.historyResource(control, input)
  const resources = vi.spyOn(client, 'sessionHistoryResource'), clipboard = vi.fn(async (_text: string) => true)
  const platform: ClientUiPlatform = { copyText: clipboard, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  closes.push(async () => { await act(async () => root.unmount()); host.remove() })
  const render = async (active = true, reader = read) => act(async () => root.render(<ClientUiProvider platform={platform}><textarea defaultValue="Keep this unsent draft" /><ConversationView sessionId={session.agentSessionId} executionHostId="local" page={page} timeline={reading.captured}
    records={reading.records} originalRecords={reading.originalRecords} coverage={reading.timeline.coverage} active={active} readHistoryResource={reader} /></ClientUiProvider>))
  await render()
  const complete = async () => {
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Read complete content'))!.click())
    await flush(() => expect(host.querySelector('button[aria-label="Copy complete content"]')).not.toBeNull())
  }
  return { host, root, render, read, complete, resources, image, part, page, client, controller, control, config, clipboard, directory }
}

it('the mounted common reader face reaches the original preload/Main/Core raster and lightbox with its same outer reference', async () => {
  const f = await fixture()
  expect(f.image.reference.length).toBeGreaterThan(2 * 1024 * 1024)
  expect(f.resources).not.toHaveBeenCalled(); expect(f.host.querySelector('img')).toBeNull()
  const prose = f.host.querySelector('strong')!, draft = f.host.querySelector('textarea')!, range = document.createRange(); range.selectNodeContents(prose); window.getSelection()!.addRange(range)
  await f.complete()
  await flush(() => expect(f.host.querySelector('.md-conversation-image__thumb')).not.toBeNull())
  expect(f.host.querySelector('img')?.getAttribute('src')).toBe(f.image.reference)
  expect(f.resources.mock.calls.at(-1)).toEqual(['original-agent', { source: f.page.source, recordId: 'original-image-record', turnId: 'original-image-turn', partIndex: 1, expectedReference: f.part.reference, representation: 'image', commandOverride: 'owned-original-claude', args: ['--original-reader'], env: {} }])
  expect(f.host.textContent).not.toContain(f.part.reference); expect(f.host.textContent).not.toContain(f.image.bytes.toString('base64'))
  await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="Copy complete content"]')!.click())
  expect(f.clipboard.mock.calls.at(-1)?.[0]).toBe(f.part.reference)
  expect(f.host.querySelector('strong')).toBe(prose); expect(window.getSelection()!.toString()).toBe('selected original prose'); expect(f.host.querySelector('textarea')).toBe(draft)
  await act(async () => f.host.querySelector<HTMLButtonElement>('.md-conversation-image')!.click())
  expect(document.querySelector('[role="dialog"] .md-conversation-image__full')).not.toBeNull()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('.md-conversation-image__full')).toBeNull(); expect(draft.value).toBe('Keep this unsent draft')
  await act(async () => [...f.host.querySelectorAll('button')].find(button => button.textContent==='Close content')!.click())
  expect(f.host.querySelector('img')).toBeNull(); expect(f.host.textContent).toContain('Read complete content')
}, 30_000)

it('image read/decode failure retries only its original outer resource without replacing prose or draft', async () => {
  const f = await fixture(), real = AgentMuxClient.prototype.sessionHistoryResource.bind(f.client)
  let unavailable = true
  f.resources.mockImplementation((id, input) => input.representation === 'image' && unavailable ? Promise.reject(new Error('Original image source temporarily unavailable.')) : real(id, input))
  const prose = f.host.querySelector('strong')!, draft = f.host.querySelector('textarea')!
  await f.complete(); await flush(() => expect(f.host.querySelector('[aria-label="Retry image"]')).not.toBeNull())
  expect(f.host.textContent).toContain('Recorded image'); expect(f.host.textContent).not.toContain(f.part.reference)
  unavailable = false
  await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="Retry image"]')!.click())
  await flush(() => expect(f.host.querySelector('img')).not.toBeNull())
  await act(async () => f.host.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(f.host.querySelector('img')).toBeNull(); expect(f.host.textContent).toContain('could not be decoded')
  await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="Retry image"]')!.click())
  await flush(() => expect(f.host.querySelector('img')).not.toBeNull())
  expect(f.resources.mock.calls.filter(([, input]) => input.representation === 'image').map(([, input]) => input.expectedReference)).toEqual([f.part.reference, f.part.reference, f.part.reference])
  expect(f.host.querySelector('strong')).toBe(prose); expect(f.host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Keep this unsent draft')
}, 30_000)

it('closing an original complete resource ignores its late raster without reopening the image or viewer', async () => {
  const f = await fixture(), real = AgentMuxClient.prototype.sessionHistoryResource.bind(f.client)
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve })
  f.resources.mockImplementation(async (id, input) => { if (input.representation === 'image') await held; return real(id, input) })
  await f.complete(); await flush(() => expect(f.resources.mock.calls.some(([, input]) => input.representation === 'image')).toBe(true))
  const late = f.resources.mock.results.at(-1)!.value
  await act(async () => [...f.host.querySelectorAll('button')].find(button => button.textContent==='Close content')!.click())
  await act(async () => { release(); await late })
  expect(f.host.querySelector('img')).toBeNull(); expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(f.host.textContent).toContain('Read complete content')
  expect(f.host.textContent).toContain('selected original prose')
}, 30_000)

it('the same existing unmanaged face reaches its original Main allowlist and Core without accepting Renderer invocation', async () => {
  const f = await fixture(), { ConversationResourceText } = await import('@agentmux/client-ui/components/ConversationResourceText')
  const nativeHome = join(f.directory, 'native-home'), nativeDirectory = join(nativeHome, 'projects', 'original')
  await mkdir(nativeDirectory, { recursive: true })
  await writeFile(join(nativeDirectory, 'original-unmanaged.jsonl'), JSON.stringify({ type: 'user', uuid: 'unmanaged-image', sessionId: 'original-unmanaged', cwd: f.directory, isSidechain: false, message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: f.image.bytes.toString('base64') } }] } }) + '\n')
  const config = { ...f.config, executors: { ...f.config.executors, 'original-claude': { ...f.config.executors['original-claude']!, env: { CLAUDE_CONFIG_DIR: nativeHome } } } }
  const catalog = await f.client.listNativeAgentSessions({ providerId: 'claude', workspacePath: f.directory, env: { CLAUDE_CONFIG_DIR: nativeHome } })
  expect(catalog.sessions).toHaveLength(1)
  const nativeSource = catalog.sessions[0]!.source
  const page = await f.controller.nativeAgentHistory({ hostId: 'local', executorId: 'original-claude', source: nativeSource, limit: 10 }, config), item = page.items[0]!, part = item.contentParts[0]!
  if (part.kind !== 'resource') throw new Error('Original native signed image part required')
  const record = { source: page.source, recordId: item.id }
  const reads: Parameters<AgentMuxPreloadApi['sessions']['historyResource']>[1][] = []
  const read = (input: Parameters<AgentMuxPreloadApi['sessions']['historyResource']>[1]) => { reads.push(input); return f.controller.nativeAgentHistoryResource({ hostId: 'local', executorId: 'original-claude', nativeSource, ...input }, config) }
  const platform: ClientUiPlatform = { copyText: async () => true, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  await act(async () => f.root.render(<ClientUiProvider platform={platform}><ConversationResourceText part={part} partIndex={0} record={record} readResource={read} /></ClientUiProvider>))
  await act(async () => [...f.host.querySelectorAll('button')].find(button => button.textContent?.includes('Read complete content'))!.click())
  await flush(() => expect(f.host.querySelector('img')).not.toBeNull())
  expect(f.host.querySelector('img')?.getAttribute('src')).toBe(f.image.reference)
  expect(reads.at(-1)).toEqual({ ...record, partIndex: 0, expectedReference: part.reference, representation: 'image' })
  const input = { hostId: 'local', executorId: 'original-claude', nativeSource, ...reads.at(-1)! }
  await expect(f.controller.nativeAgentHistoryResource({ ...input, commandOverride: 'foreign-command', env: { UNTRUSTED: 'foreign' } } as never, config)).rejects.toHaveProperty('code', 'INVALID_CONTROL_REQUEST')
}, 30_000)
