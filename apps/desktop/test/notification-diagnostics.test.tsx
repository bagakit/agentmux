// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AgentMuxControlRequest } from '@agentmux/core'
import type { AgentMuxRpcServiceOptions } from '../../../packages/core/src/public-rpc-service'

const fixture = vi.hoisted(() => ({ root: '', socket: '', generation: 1, loading: false, active: false,
  ports: null as AgentMuxRpcServiceOptions | null,
  handlers: new Map<string, (...args: any[]) => unknown>(), events: new Map<string, (...args: any[]) => void>(),
  sender: null as any, hold: false, pending: [] as AgentMuxControlRequest[], sent: [] as AgentMuxControlRequest[],
  replies: [] as unknown[], receive: null as ((request: AgentMuxControlRequest) => void) | null,
  cancel: null as ((request: any) => void) | null
}))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
  app: { getPath: () => fixture.root || tmpdir(), getAppPath: () => fixture.root || tmpdir() },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => unknown) => fixture.handlers.set(name, handler),
    removeHandler: (name: string) => fixture.handlers.delete(name),
    on: (name: string, handler: (...args: any[]) => void) => fixture.events.set(name, handler),
    removeListener: (name: string) => fixture.events.delete(name), off: (name: string) => fixture.events.delete(name) },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('@agentmux/core', async original => {
  const actual = await original<typeof import('@agentmux/core')>()
  return { ...actual, AgentMuxControlServer: class extends actual.AgentMuxControlServer {
    constructor(ports: ConstructorParameters<typeof actual.AgentMuxControlServer>[0]) {
      fixture.ports = ports
      // Only the test-owned transport differs. Main registers its original ports and real RPC service.
      super({ ...ports, socketPath: fixture.socket, http: undefined })
    }
  } }
})
vi.mock('@agentmux/demand', async original => ({ ...await original<typeof import('@agentmux/demand')>(),
  openDemandStore: () => ({ list: async () => [], snapshot: async () => ({ demands: [] }), subscribe: () => () => {} }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { setPresentationWindowOwner() {} async release() {} dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown' }), dispose() {} }) }))
vi.mock('../src/main/notes-storage-owner', () => ({ NotesStorageOwner: class { async initialize() {} } }))

import { registerIpc } from '../src/main/ipc'
import { GlobalSystemNotices } from '../src/renderer/src/components/GlobalSystemNotices'
import { createRendererControlApi } from '../src/renderer/src/lib/control-api'
import { useAppStore } from '../src/renderer/src/store'
import { CONTROL_REQUEST_CHANNEL, CONTROL_RESPONSE_CHANNEL, CONTROL_CANCEL_CHANNEL } from '../src/shared/contracts'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { parseDiagnosticEvidenceResult } from '../../../packages/core/src/diagnostic-evidence-codec'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { toggleNotificationCenter } from './helpers/notification-center'
import { sourceMoteDiagnosticsCli, stageMoteSourceListener } from './helpers/mote-diagnostics-cli'

const dom = composerDOM(), cleanup: Array<() => void | Promise<void>> = []
const target = { domain: 'client.notifications' as const, hostId: 'local', list: {} }
const renderer = { kind: 'bundled', id: 'a'.repeat(64), identity: { shell: 'private-shell', ctxmux: 'private-ctxmux' } } as const
const markers = { shell: 'PRIVATE_SHELL_ORIGINAL_SENTINEL', session: 'PRIVATE_SESSION_LABEL_SENTINEL',
  activity: 'PRIVATE_ACTIVITY_BODY_SENTINEL', chrome: 'PRIVATE_NATIVE_CHROME_SENTINEL' }
function seed() {
  const session = composerSession('notification-original-session')
  useAppStore.setState({ sessions: [{ ...session, label: markers.session, status: { state: 'working', source: 'native-hook', observedAt: Date.now() },
    nativeSourceObservation: { state: 'unknown', run: session.control.run, observedAt: 1, reason: 'current-main-unconfirmed' } }],
    environmentWarning: markers.shell, agentComposerDrafts: { [session.id]: 'Keep exact original unsent input' } } as never)
  useAppStore.getState().reportError(markers.activity)
}
async function mount() {
  await dom.render(<><textarea aria-label="Original composer" defaultValue="Keep exact original DOM input" /><GlobalSystemNotices nativeOverlayWarning={markers.chrome} /></>)
  dom.container.querySelector('textarea')!.focus()
  expect(dom.container.querySelector('.global-system-notices__details')?.getAttribute('data-state')).toBe('closed')
  expect(dom.container.querySelectorAll('.notification-item')).toHaveLength(0)
}
async function main() {
  await stageMoteSourceListener()
  fixture.sender = Object.assign(new EventEmitter(), { id: 317, isDestroyed: () => false, isLoadingMainFrame: () => fixture.loading,
    mainFrame: { framesInSubtree: [] }, session: { flushStorageData: vi.fn() }, send: (channel: string, request: AgentMuxControlRequest) => {
      if (channel === CONTROL_CANCEL_CHANNEL) { fixture.cancel?.(request); return }
      if (channel !== CONTROL_REQUEST_CHANNEL) return
      fixture.sent.push(structuredClone(request))
      if (fixture.hold) fixture.pending.push(request)
      else fixture.receive?.(request)
    } })
  const control = createRendererControlApi({
    onRequest: listener => { fixture.receive = listener; return () => { fixture.receive = null } },
    onCancellation: listener => { fixture.cancel = listener; return () => { fixture.cancel = null } },
    respond: response => {
      fixture.replies.push(structuredClone(response))
      fixture.events.get(CONTROL_RESPONSE_CHANNEL)?.({ sender: fixture.sender }, structuredClone(response))
    }
  })
  cleanup.push(control.onRequest((request, signal) => useAppStore.getState().executeControl(request, signal)))
  const runtime = { resourceSampler: { setObservationSources: () => () => {} }, setContinuousProgressInputObserver: () => () => {},
    setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {},
    observeCoreEvents: () => () => {}, observeInputOccupation: () => () => {},
    rpcClients: () => [], connectedRuntimeIdentities: () => [], rendererGeneration: () => fixture.generation }
  const config = useAppStore.getState().config!
  const dispose = await registerIpc({ initialConfig: config,
    window: { setBackgroundColor: vi.fn(), id: 99, isDestroyed: () => false, webContents: fixture.sender } as unknown as BrowserWindow,
    workbenchWindows: { setNativeOwner: () => () => {} } as never,
    runtime: runtime as never, configStore: { get: async () => config } as never,
    scratchTopics: { setNameAudit: () => {}, normalizeDirectoryIdentities: async () => {} } as never,
    workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), write: vi.fn(), dispose: async () => {} } as never,
    progressLoops: { subscribe: () => () => {} } as never,
    loadedPackage: { schema: 'agentmux.package-identity.v1', sourceCommit: 'private-package', sourceTree: 'private-tree', appVersion: '1', platform: 'darwin', arch: 'arm64' },
    loadedRenderer: () => renderer })
  cleanup.push(dispose)
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: fixture.socket } })
  cleanup.push(() => rpc.dispose())
  return rpc
}
const data = (result: any) => {
  expect(result.reads, JSON.stringify(result)).toHaveLength(1)
  expect(result.reads[0].availability, JSON.stringify(result)).toBe('found')
  expect(result.reads[0].data?.kind).toBe('client-notifications')
  return result.reads[0].data
}
beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'amx-notice-')); fixture.socket = join(fixture.root, 'control.sock')
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/.test(key) && !key.startsWith('AGENTMUX_NOTIFICATION_DIAGNOSTICS_')) vi.stubEnv(key, undefined)
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', fixture.root); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(fixture.root, 'state'))
  vi.stubEnv('AGENTMUX_DESKTOP_USER_DATA', fixture.root)
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', join(fixture.root, 'sessions.json')); vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(fixture.root, 'messages.ndjson'))
  fixture.generation = 1; fixture.loading = false; fixture.ports = null; fixture.hold = false; fixture.pending = []
  fixture.sent = []; fixture.replies = []; fixture.active = true; fixture.handlers.clear(); fixture.events.clear()
  useAppStore.setState({ loading: false, sessions: [], tabs: {}, notificationEvents: [], noticeReadReceipts: {},
    error: null, lastError: null, errorNoticeContext: null, environmentWarning: '', runtimeOwnershipWarnings: [], runtimeEndpointWarnings: [],
    displacedAgentSessionIds: [], agentSteerQueues: {}, agentSteerInFlight: {}, sessionNameMetadataWarning: null,
    workbenchSaveWarning: null, nameSaveUnconfirmed: null, nameEditFailure: null, desktopNavigationNotice: null,
    startupAgentAvailability: undefined } as never)
})
afterEach(async () => {
  fixture.active = false
  for (const close of cleanup.splice(0).reverse()) await close()
  await rm(fixture.root, { recursive: true, force: true }); vi.unstubAllEnvs()
})

it('reads the closed original panel through registered Main, Control IPC, public socket and actual source CLI without acknowledging or focusing', async () => {
  seed(); await mount(); const rpc = await main(), before = useAppStore.getState(), focused = document.activeElement
  const changed = vi.fn(), off = useAppStore.subscribe(changed)
  try {
    const discovery = await rpc.call('system.diagnostics.inspect', {})
    expect(discovery.capabilities.some(capability => capability.domain === 'client.notifications')).toBe(true)
    const safe = await rpc.call('system.diagnostics.inspect', { target }), observed = data(safe)
    expect(observed.items, JSON.stringify(observed.items)).toHaveLength(4)
    expect(observed.items.filter((item: any) => item.section === 'current')).toHaveLength(3)
    expect(observed.items.filter((item: any) => item.section === 'activity')).toHaveLength(1)
    expect(new Set(observed.items.map((item: any) => item.notificationId)).size).toBe(4)
    expect(observed.items.map((item: any) => item.unread)).toEqual([true, true, true, true])
    expect(observed.items.map((item: any) => item.original)).toEqual([null, null, null, null])
    for (const marker of Object.values(markers)) expect(JSON.stringify([safe, fixture.replies])).not.toContain(marker)
    expect(fixture.sent[0]).toMatchObject({ operation: 'inspect.notifications', includeRaw: false })
    const cli = await sourceMoteDiagnosticsCli(fixture.root, {
      mutations: process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_SOURCES, loaded: process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_LOADED, ssr: true
    })
    expect(cli.inputs.some(path => path.endsWith('packages/core/src/agentmux-cli-commands.ts'))).toBe(true)
    const run = await cli.run(['--endpoint', `unix://${fixture.socket}`, 'system', 'diagnostics', 'inspect', '--domain', 'client.notifications', '--host-id', 'local'])
    expect(run.code, run.stderr).toBe(0)
    expect(data(JSON.parse(run.stdout).result).items).toEqual(observed.items)
    for (const marker of Object.values(markers)) expect(run.stdout).not.toContain(marker)
    const item = observed.items.find((value: any) => value.section === 'activity')!
    const exact = await cli.run(['--endpoint', `unix://${fixture.socket}`, 'system', 'diagnostics', 'inspect', '--domain', 'client.notifications', '--host-id', 'local', '--notification-id', item.notificationId, '--include-raw'])
    expect(exact.code, exact.stderr).toBe(0)
    const original = data(JSON.parse(exact.stdout).result).items
    expect(original).toHaveLength(1); expect(original[0].notificationId).toBe(item.notificationId); expect(original[0].version).toBe(item.version)
    expect(original[0].original.detail).toContain(markers.activity)
    expect(() => parseDiagnosticEvidenceResult(JSON.parse(exact.stdout).result, { target: { domain: 'client.notifications', hostId: 'local', notificationId: item.notificationId } })).toThrow()
    expect(useAppStore.getState()).toBe(before); expect(changed).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(focused)
    expect(dom.container.querySelector('textarea')!.value).toBe('Keep exact original DOM input')
    expect(dom.container.querySelector('.global-system-notices__details')?.getAttribute('data-state')).toBe('closed')
    expect(dom.container.querySelectorAll('.notification-item')).toHaveLength(0)
    expect(before.noticeReadReceipts).toEqual({})
    expect(fixture.sent).toHaveLength(3)
    if (process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_RECEIPT) await writeFile(process.env.AGENTMUX_NOTIFICATION_DIAGNOSTICS_RECEIPT,
      JSON.stringify({ boundary: 'actual source CLI → unix RPC → Main registered port → Control IPC → original closed Renderer owner',
        commands: [run, exact], requests: fixture.sent, defaultRead: safe, unchangedStore: true, unchangedFocus: true,
        panelClosed: true, originalSources: observed.items.map((value: any) => value.source), cliInputs: cli.inputs }, null, 2))
  } finally { off() }
})

it('filters and pages the original notification snapshot and explicitly expires changed-snapshot cursors', async () => {
  seed(); await mount(); const rpc = await main()
  const first = data(await rpc.call('system.diagnostics.inspect', { target: { ...target, list: { limit: 1 } } }))
  expect(first.items).toHaveLength(1); expect(first.total).toBe(4); expect(first.nextCursor).toBeTruthy()
  const second = data(await rpc.call('system.diagnostics.inspect', { target: { ...target, list: { limit: 1, cursor: first.nextCursor } } }))
  expect(second.items).toHaveLength(1); expect(second.items[0].notificationId).not.toBe(first.items[0].notificationId); expect(second.snapshot).toBe(first.snapshot)
  const activity = data(await rpc.call('system.diagnostics.inspect', { target: { ...target, list: { section: 'activity', category: 'operations', unreadOnly: true } } }))
  expect(activity.items).toHaveLength(1); expect(activity.items[0]).toMatchObject({ section: 'activity', category: 'operations', unread: true })
  await act(async () => useAppStore.getState().reportError('A later original event'))
  const stale = await rpc.call('system.diagnostics.inspect', { target: { ...target, list: { limit: 1, cursor: first.nextCursor } } })
  expect(stale.reads[0]).toMatchObject({ availability: 'expired', data: null })
})

it('reports a missing or navigated Renderer owner as unavailable and never substitutes an empty list', async () => {
  const rpc = await main()
  expect((await rpc.call('system.diagnostics.inspect', { target })).reads[0]).toMatchObject({ availability: 'unavailable', data: null })
  seed(); await mount(); expect(data(await rpc.call('system.diagnostics.inspect', { target })).items).toHaveLength(4)
  fixture.hold = true
  const query = rpc.call('system.diagnostics.inspect', { target })
  await vi.waitFor(() => expect(fixture.pending).toHaveLength(1))
  fixture.generation++
  fixture.receive!(fixture.pending.shift()!)
  expect((await query).reads[0]).toMatchObject({ availability: 'unavailable', data: null })
  fixture.hold = false
  expect(data(await rpc.call('system.diagnostics.inspect', { target })).items).toHaveLength(4)
  const headless = new AgentMuxRpcService()
  expect((await headless.call('system.diagnostics.inspect', { target })).reads[0]?.availability).toBe('unsupported')
})

it('returns complete original text only when requested and reports omitted raw material under the original query budget', async () => {
  const complete = markers.shell + '\n' + 'original multiline detail\n'.repeat(600) + 'FINAL_ORIGINAL_SENTINEL'
  seed(); useAppStore.setState({ environmentWarning: complete }); useAppStore.getState().reportError(complete)
  const event = useAppStore.getState().notificationEvents.at(-1)!
  await mount(); const rpc = await main(), stringify = vi.spyOn(JSON, 'stringify')
  await toggleNotificationCenter(dom.container, 'open')
  await dom.click('[role="tab"][data-section="history"]')
  expect(stringify.mock.calls.filter(call => call[0] === event)).toHaveLength(0)
  await toggleNotificationCenter(dom.container, 'closed')
  const safe = data(await rpc.call('system.diagnostics.inspect', { target }))
  expect(stringify.mock.calls.filter(call => call[0] === event).length).toBeGreaterThan(0)
  stringify.mockRestore()
  const item = safe.items.find((entry: any) => entry.source === 'environment')!
  expect(item).toBeDefined()
  const query = { target: { domain: 'client.notifications' as const, hostId: 'local', notificationId: item.notificationId }, includeRaw: true }
  const bounded = await rpc.call('system.diagnostics.inspect', { ...query, budget: { maxBytes: 4096 } })
  expect(bounded.reads[0]).toMatchObject({ availability: 'found', completeness: 'partial',
    raw: { returned: 'withheld' }, data: { omissions: ['raw-query-budget'], items: [{ original: null }] } })
  expect(JSON.stringify(bounded)).not.toContain('FINAL_ORIGINAL_SENTINEL')
  const raw = await rpc.call('system.diagnostics.inspect', query), original = data(raw).items[0]
  expect(original.original.detail).toContain(complete)
  expect(original.notificationId).toBe(item.notificationId); expect(original.version).toBe(item.version)
  expect(raw.reads[0]).toMatchObject({ completeness: 'complete', raw: { returned: 'included' }, data: { omissions: [] } })
})

it('preserves every selected source and reports incomplete source coverage independently of retained facts', async () => {
  seed()
  useAppStore.setState({ runtimeOwnershipWarnings: ['original-host'],
    sessionNameMetadataWarning: { code: 'ORIGINAL_NAME_OBSERVATION', message: 'Original saved-name cause', recovery: 'Original name recovery' },
    workbenchSaveWarning: 'Original unconfirmed save',
    desktopNavigationNotice: { step: 'Original navigation step', message: 'Original navigation cause', recovery: 'Original navigation recovery' } } as never)
  await mount(); const rpc = await main()
  const original = data(await rpc.call('system.diagnostics.inspect', { target }))
  expect(original.items.map((item: any) => item.source).sort()).toEqual([
    'environment', 'runtime-ownership', 'session-names', 'sessions', 'workbench-save', 'native-chrome', 'desktop-navigation', 'events'
  ].sort())
  expect(original.items.find((item: any) => item.source === 'sessions')?.subject).toMatchObject({
    kind: 'agent', hostId: 'local', agentSessionId: 'notification-original-session', runId: 'run-notification-original-session'
  })
  expect(original.coverage).toEqual({ state: 'available', unavailableSources: [] })
  await act(async () => useAppStore.setState({ environmentWarning: undefined, runtimeOwnershipWarnings: undefined }))
  const partial = await rpc.call('system.diagnostics.inspect', { target })
  expect(partial.reads[0]?.completeness).toBe('partial')
  const observed = data(partial)
  expect(observed.items).toHaveLength(6)
  expect(observed.coverage.state).toBe('partial')
  expect(observed.coverage.unavailableSources.sort()).toEqual(['environment', 'runtime-ownership'])
  const unknown = { domain: 'client.notifications' as const, hostId: 'local', notificationId: 'sha256:' + '0'.repeat(64) }
  expect((await rpc.call('system.diagnostics.inspect', { target: unknown })).reads[0]).toMatchObject({ availability: 'unavailable', data: null })
  await act(async () => useAppStore.setState({ environmentWarning: '', runtimeOwnershipWarnings: [] }))
  expect((await rpc.call('system.diagnostics.inspect', { target: unknown })).reads[0]).toMatchObject({ availability: 'not-found', data: null })
})
