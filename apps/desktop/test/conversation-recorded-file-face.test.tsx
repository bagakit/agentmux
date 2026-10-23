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
import { createHash } from 'node:crypto'
import type { AgentMuxPreloadApi, AppConfig } from '../src/shared/contracts'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import { localRuntimeConnector } from './helpers/local-runtime-connector'
const bridge = await vi.hoisted(async () => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: await (await import('node:fs/promises')).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'amx-file-face-main-')) }))
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

const originalBytes = Buffer.from([0, 255, 23, ...Buffer.from('Original recorded file 中文')])
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
async function fixture(kind: 'direct' | 'signed' = 'direct') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  Element.prototype.scrollIntoView = vi.fn()
  const directory = await mkdtemp(join(tmpdir(), 'amx-file-face-')); closes.push(() => rm(directory, { recursive: true, force: true }))
  const bytes = kind === 'signed' ? Buffer.alloc(2 * 1024 * 1024, 79) : originalBytes, otherBytes = Buffer.from('Another original file')
  const providerId = kind === 'direct' ? 'codex' : 'droid', executorId = 'original-' + providerId
  const nativeSessionId = kind === 'direct' ? '00000000-0000-4000-8000-000000000001' : 'original-file-source'
  const mimeType = 'application/octet-stream', reference = `data:${mimeType};base64,${bytes.toString('base64')}`
  const name = kind === 'signed' ? '原始记录中的完整文件名称.bin' : undefined
  const path = join(directory, 'original.jsonl'), storePath = join(directory, 'sessions.json')
  const canonical = (id: string, data: Buffer, label?: string) => ({ type: 'event_msg', payload: { type: 'item_completed', thread_id: nativeSessionId, turn_id: 'turn-' + id, item: {
    type: 'McpToolCall', id, server: 'recorded-server', tool: 'read_document', arguments: {}, status: 'completed', result: { content: [
      { type: 'resource', resource: { uri: 'opaque:original/document', mimeType, blob: data.toString('base64'), ...(label === undefined ? {} : { name: label }) } }
    ] } } } })
  const documentBlock = (data: Buffer, label?: string) => ({ type: 'document', source: { type: 'base64', media_type: mimeType, data: data.toString('base64'), ...(label === undefined ? {} : { name: label }) } })
  const prose = 'Keep **selected original prose** beside this file.'
  const rows = kind === 'direct' ? [
    { type: 'session_meta', payload: { id: nativeSessionId, cwd: directory, history_mode: 'paginated', cli_version: '0.163.0' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: prose }] } },
    canonical('original-file-call', bytes), canonical('other-file-call', otherBytes, 'Other original.bin')
  ] : [
    { type: 'session_start', id: nativeSessionId },
    { type: 'message', id: 'file-record', message: { role: 'user', content: [{ type: 'text', text: prose }, documentBlock(bytes, name), { type: 'text', text: 'Original trailing text.' }] } },
    { type: 'message', id: 'other-file-record', message: { role: 'user', content: [documentBlock(otherBytes, 'Other original.bin')] } }
  ]
  await writeFile(path, rows.map(row => JSON.stringify(row) + '\n').join(''))
  const store = new AgentMuxFileAgentSessionStore(storePath), session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'original-agent', providerId, executorId, hostId: 'local', workspacePath: directory,
    run: { runId: 'healthy-original-file-run' }, retiredRuns: [], createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), hookBindingId: 'original-hook', hookToken: 'original-private-authority', nativeHandle: { kind: 'provider', providerId, sessionId: nativeSessionId, transcriptPath: path } }
  await store.compareAndSwap(null, session)
  const originalSource = await readFile(path), client = new AgentMuxClient({ store }), kernel = Reflect.get(client, 'kernel')
  const controls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(key => vi.spyOn(kernel, key).mockImplementation(() => { throw new Error('Recorded file reading must not operate Runtime') }))
  const controller = new RuntimeController(store, localRuntimeConnector)
  closes.push(async () => { await controller.dispose(); await client.dispose(); expect((await loadAgentSessions(store))[0]).toEqual(session); expect(await readFile(path)).toEqual(originalSource); expect(controls.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]) })
  controller.commit({ hosts: [{ id: 'local', config: { id: 'local', kind: 'local', label: 'Original Host' }, client, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), executors: { [executorId]: { label: 'Original executor', providerId, command: 'owned-original-' + providerId, args: ['--original-reader'], env: {}, injectAgentMuxGuide: false } } }
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', bridge.directory)
  await mkdir(join(bridge.directory, 'notes'), { recursive: true })
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 772, isDestroyed: () => false, send: vi.fn() })
  closes.push(await registerIpc({ initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow,
    runtime: controller, applicationAccess: {} as never, workbenchWindows: { setNativeOwner: () => () => {} } as never, progressLoops: { subscribe: () => () => {} } as never, configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as unknown as ConfigStore,
    scratchTopics: { setNameAudit: vi.fn() } as unknown as ScratchTopics, workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as unknown as WorkspaceFiles }))
  bridge.invoke.mockImplementation((channel: string, subject: unknown, request: unknown) => {
    const handler = bridge.handlers.get(channel); if (!handler) throw new Error('Original IPC handler missing: ' + channel)
    return handler({ sender } as unknown as IpcMainInvokeEvent, subject, request)
  })
  await bridge.api!.notesStorage.inspect()
  const wire = await client.readAgentConversation({ hostId: 'local', agentSessionId: session.agentSessionId, limit: 10 }), accepted = consumeConversationWindowPage(wire)
  expect(accepted.kind).toBe('complete'); if (accepted.kind !== 'complete') throw new Error('The actual Core reading window is required')
  const reading = projectConversationWindow(accepted.snapshot), page = reading.historyPage!
  const item = kind === 'signed' ? page.items.find(item => item.id === 'file-record')! : page.items.find(item => item.contentParts.some(part => part.kind === 'resource' && part.reference === reference))!
  const partIndex = item.contentParts.findIndex(part => part.kind === 'resource'), part = item.contentParts[partIndex]!
  if (part.kind !== 'resource') throw new Error('The actual original file part is required')
  const other = page.items.find(item => item.contentParts.some(part => part.kind === 'resource' && part.reference === `data:${mimeType};base64,${otherBytes.toString('base64')}`))!
  const control = { hostId: 'local', agentSessionId: session.agentSessionId }, read = (input: Parameters<AgentMuxPreloadApi['sessions']['historyResource']>[1]) => bridge.api!.sessions.historyResource(control, input)
  const resources = vi.spyOn(client, 'sessionHistoryResource'), clipboard = vi.fn(async (_text: string) => true)
  const platform: ClientUiPlatform = { copyText: clipboard, overlayContainer: () => document.body, bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
  const blobs: Blob[] = [], downloads: Array<{ href: string; name: string }> = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(value => { if (!(value instanceof Blob)) throw new Error('The standard Blob handoff is required'); blobs.push(value); return 'blob:recorded-file-' + blobs.length })
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { downloads.push({ href: this.href, name: this.download }) })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  let mounted = true
  const unmount = async () => { if (mounted) { await act(async () => root.unmount()); mounted = false } }
  closes.push(async () => { await unmount(); host.remove() })
  const render = async (active = true, target = item, reader = read) => {
    const retained = new Set([target.id, ...page.items.filter(item => item.contentParts.every(part => part.kind === 'text')).map(item => item.id)])
    const selectedPage = { ...page, items: page.items.filter(item => retained.has(item.id)) }
    const records = reading.records.filter(record => retained.has(record.rawId)), originals = reading.originalRecords.filter(record => retained.has(record.rawId))
    await act(async () => root.render(<ClientUiProvider platform={platform}><textarea defaultValue="Keep this unsent draft" /><ConversationView sessionId={session.agentSessionId} executionHostId="local" page={selectedPage} timeline={reading.captured}
      records={records} originalRecords={originals} coverage={reading.timeline.coverage} active={active} readHistoryResource={reader} /></ClientUiProvider>))
  }
  await render()
  const button = (label: string) => [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === label)
  const click = async (label: string) => act(async () => { const action = button(label); expect(action, 'The original mounted action ' + label + ' must be present').toBeDefined(); action!.click() })
  const complete = async () => {
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Read complete content'))!.click())
    await flush(() => expect(button('Download file')).toBeDefined())
  }
  return { host, render, unmount, read, complete, click, button, resources, bytes, part, partIndex, item, other, page, client, clipboard, blobs, downloads, revoke, name, mimeType, reference }
}

it('prepares a direct original file download through mounted View, preload, Main and the real Core only after explicit action', async () => {
  const f = await fixture()
  expect(f.resources).not.toHaveBeenCalled(); expect(f.downloads).toEqual([])
  const prose = f.host.querySelector('strong')!, draft = f.host.querySelector('textarea')!, range = document.createRange(); range.selectNodeContents(prose); window.getSelection()!.addRange(range)
  const originalIdentity = [...f.host.querySelectorAll('.log-turn')].map(turn => [turn.getAttribute('data-conversation-author'), turn.getAttribute('data-conversation-role'), turn.querySelector('.log-turn__who')?.textContent])
  await f.click('Download file')
  await flush(() => expect(f.downloads).toHaveLength(1))
  const handed = Buffer.from(await f.blobs[0]!.arrayBuffer())
  expect(handed).toEqual(f.bytes); expect(digest(handed)).toBe(digest(f.bytes)); expect(f.blobs[0]!.type).toBe(f.mimeType)
  expect(f.downloads[0]!.name).toBe('Attachment (original name unavailable).bin')
  expect(f.resources.mock.calls.at(-1)).toEqual(['original-agent', { source: f.page.source, recordId: f.item.id, turnId: f.item.turnId, partIndex: f.partIndex,
    expectedReference: f.part.reference, representation: 'file', commandOverride: 'owned-original-codex', args: ['--original-reader'], env: {} }])
  expect(f.host.textContent).not.toContain(f.part.reference); expect(f.host.textContent).not.toContain(f.bytes.toString('base64'))
  expect(f.host.querySelector('strong')).toBe(prose); expect(window.getSelection()!.toString()).toBe('selected original prose'); expect(f.host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Keep this unsent draft')
  expect([...f.host.querySelectorAll('.log-turn')].map(turn => [turn.getAttribute('data-conversation-author'), turn.getAttribute('data-conversation-role'), turn.querySelector('.log-turn__who')?.textContent])).toEqual(originalIdentity)
  await flush(() => expect(f.revoke).toHaveBeenCalledWith(f.downloads[0]!.href))
}, 30_000)

it('reads the original signed file envelope explicitly, then downloads exact bytes by the same outer reference and keeps Copy intact', async () => {
  const f = await fixture('signed')
  expect(f.part).toMatchObject({ resourceType: 'text', content: { kind: 'resource' }, contentEligibility: 'unconfirmed' })
  expect(f.reference.length).toBeGreaterThan(2 * 1024 * 1024); expect(f.resources).not.toHaveBeenCalled()
  const prose = f.host.querySelector('strong')!, draft = f.host.querySelector('textarea')!
  await f.complete()
  expect(f.resources.mock.calls.some(([, input]) => input.representation === 'file')).toBe(false); expect(f.blobs).toHaveLength(0)
  await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="Copy complete content"]')!.click())
  expect(f.clipboard.mock.calls.at(-1)?.[0]).toBe(f.part.reference)
  await f.click('Download file'); await flush(() => expect(f.downloads).toHaveLength(1))
  const handed = Buffer.from(await f.blobs[0]!.arrayBuffer())
  expect(handed.length).toBe(f.bytes.length); expect(handed.equals(f.bytes)).toBe(true); expect(digest(handed)).toBe(digest(f.bytes)); expect(f.downloads[0]!.name).toBe(f.name)
  expect(f.resources.mock.calls.at(-1)).toEqual(['original-agent', { source: f.page.source, recordId: f.item.id, partIndex: f.partIndex, expectedReference: f.part.reference,
    representation: 'file', commandOverride: 'owned-original-droid', args: ['--original-reader'], env: {} }])
  expect(f.resources.mock.calls.filter(([, input]) => input.representation === 'file')).toHaveLength(1)
  expect(f.host.textContent).toContain(f.name); expect(f.host.textContent).not.toContain(f.part.reference); expect(f.host.textContent?.includes(f.reference)).toBe(false)
  expect(f.host.querySelector('strong')).toBe(prose); expect(f.host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Keep this unsent draft')
  await act(async () => [...f.host.querySelectorAll<HTMLButtonElement>('button[aria-label="Copy message"]')].find(button => button.closest('[data-native-record-id]')?.getAttribute('data-native-record-id') === f.item.id)!.click())
  await flush(() => expect(f.clipboard.mock.calls.at(-1)?.[0].includes(f.reference)).toBe(true))
  expect(f.clipboard.mock.calls.at(-1)?.[0]).toContain('Original trailing text.'); expect(f.resources.mock.calls.filter(([, input]) => input.representation === 'file')).toHaveLength(1)
  await f.click('Close content'); expect(f.button('Download file')).toBeUndefined()
}, 30_000)

it('rejects a foreign original resource response and retries the same exact file without replacing prose or the draft', async () => {
  const f = await fixture(), real = AgentMuxClient.prototype.sessionHistoryResource.bind(f.client)
  let foreign = true
  f.resources.mockImplementation(async (id, input) => { const original = await real(id, input); return foreign ? { ...original, recordId: 'foreign-record' } : original })
  const prose = f.host.querySelector('strong')!, draft = f.host.querySelector('textarea')!
  await f.click('Download file'); await flush(() => expect(f.button('Retry download')).toBeDefined())
  expect(f.downloads).toEqual([]); expect(f.blobs).toHaveLength(0)
  foreign = false; await f.click('Retry download'); await flush(() => expect(f.downloads).toHaveLength(1))
  expect(Buffer.from(await f.blobs[0]!.arrayBuffer())).toEqual(f.bytes)
  expect(f.resources.mock.calls.map(([, input]) => [input.expectedReference, input.representation])).toEqual([[f.part.reference, 'file'], [f.part.reference, 'file']])
  expect(f.host.querySelector('strong')).toBe(prose); expect(f.host.querySelector('textarea')).toBe(draft); expect(draft.value).toBe('Keep this unsent draft')
}, 30_000)

it.each(['record', 'hidden', 'unmounted'] as const)('does not hand a late file to download after its original face is %s', async transition => {
  const f = await fixture(), real = AgentMuxClient.prototype.sessionHistoryResource.bind(f.client)
  let release!: () => void; const held = new Promise<void>(done => { release = done }); closes.push(() => release())
  f.resources.mockImplementation(async (id, input) => { const result = await real(id, input); if (input.representation === 'file') await held; return result })
  await f.click('Download file'); await flush(() => expect(f.resources).toHaveBeenCalled())
  const late = f.resources.mock.results.at(-1)!.value
  if (transition === 'record') await f.render(true, f.other)
  else if (transition === 'hidden') await f.render(false)
  else await f.unmount()
  await act(async () => { release(); await late })
  expect(f.downloads).toHaveLength(0); expect(f.blobs).toHaveLength(0)
}, 30_000)
