import { testWorkbenchUserState } from './helpers/workbench-user-state-fixture'
// @vitest-environment happy-dom
const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { testAppDocumentSources } from "./helpers/app-document-fixture"
import { localRuntimeConnector } from './helpers/local-runtime-connector.js'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, DurableAgentMuxMessageQueue } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'
import { RuntimeController } from '../src/main/runtime-controller'
import { act } from 'react'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>(), directory: '' }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
  safeStorage: { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: vi.fn(async () => {}), decryptStringAsync: vi.fn(async () => {}) },
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api; Object.defineProperty(window, 'agentmux', { configurable: true, value: api }) } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  app: { on: vi.fn(), off: vi.fn(), once: vi.fn(), getPath: () => bridge.directory, getAppPath: () => join(process.cwd(), 'apps/desktop'), isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async importOriginal => ({ ...await importOriginal<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class {
  readonly cookieFiles = { setFileOwner() {}, setConfirmationHandler() {} }
  readonly extensions = { setConfirmationHandler() {} }
  onChange() { return () => {} } onEnvironmentApplicationChange() { return () => {} }
  async initialize() {} async dispose() {}
} }))
vi.mock('@agentmux/browser/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-retired-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('@agentmux/browser/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} async release() {} async flushProfileActivity() {} setPresentationWindowOwner() {} } }))
vi.mock('../src/main/native-overlay-windows', () => ({ NativeOverlayWindows: class { dispose() {} resourceProcessIds() { return [] } } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

import { installCollaborationCanvasGeometry } from './helpers/collaboration-canvas-dom'
import { installCollaborationLayoutLoopback, settleCollaborationCanvas } from './helpers/collaboration-layout-loopback'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { createClientUiRoot } from './helpers/client-ui-render'
import { createAgentInformationRoot } from './helpers/agent-information-root'
import { AgentMuxRpcService } from '@agentmux/core'
import { parseAgentMuxCliInvocation } from '../../../packages/core/src/agentmux-cli-commands'
import type { DemandProjection } from '../src/renderer/src/lib/global-demand-board'

function recordRoot(path: string) {
  if (process.env.GOAL_IDENTITIES_ROOTS) appendFileSync(process.env.GOAL_IDENTITIES_ROOTS, JSON.stringify({ path, createdAt: new Date().toISOString() }) + '\n')
}
async function closeFixture(root: string, clients: AgentMuxClient[], dispose?: () => Promise<void>, unmount?: () => void, container?: HTMLElement) {
  const failures: unknown[] = []
  for (const close of [() => act(async () => unmount?.()), () => dispose?.(), ...clients.map(client => () => client.dispose()), () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })]) {
    try { await close() } catch (failure) { failures.push(failure); console.error(failure) }
  }
  container?.remove(); vi.unstubAllEnvs(); vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Private identity fixture cleanup failed')
}

it('the real map resolves an original journal endpoint through preload IPC and one exact Core Store read without recursive history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'map-identity-')); bridge.directory = root; vi.stubEnv('AGENTMUX_STATE_DIRECTORY', root)
  recordRoot(root)
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), client = new AgentMuxClient({ store })
  const owner = composerSession('known-owner'), related = composerSession('late-peer')
  await store.compareAndSwap(null, { ...agentCreationFixture(owner), hookBindingId: 'private-hook', hookToken: 'private-token' })
  const queue = new DurableAgentMuxMessageQueue(client.agentMessageQueuePath())
  await queue.append({ messageId: 'original-link', operationId: 'original-send', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: owner.id }, recipient: { kind: 'agent-session', agentSessionId: related.id },
    senderSessionId: owner.id, senderRunId: owner.control.run.runId, recipientSessionId: related.id, recipientRunId: related.control.run.runId,
    threadId: 'thread-original', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: 'Unopened original content' })
  const events = client.listMessageEvents.bind(client); let inserted = false
  const eventsRead = vi.spyOn(client, 'listMessageEvents').mockImplementation(async input => {
    if (!inserted) { inserted = true; await store.compareAndSwap(null, { ...agentCreationFixture(related), hookBindingId: 'private-hook', hookToken: 'private-token' }) }
    return events(input)
  })
  const exact = vi.spyOn(client, 'sessionHistorySources'), inventory = vi.spyOn(client, 'readAgentSessions')
  const bodies = [vi.spyOn(client, 'sessionHistoryPage'), vi.spyOn(client, 'readMessage'), vi.spyOn(client, 'sessionTimeline')]
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(Error('No Runtime connection needed'))
  const kernel = (client as unknown as { kernel: Record<string, () => Promise<void>> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  const controller = new RuntimeController(store, localRuntimeConnector)
  controller.commit({ hosts: [{ id: 'local', config: { id: 'local', kind: 'local', label: 'Local' }, client,
    executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config = structuredClone(composerConfig), sender = Object.assign(new EventEmitter(), { id: 97, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined, unmount: (() => void) | undefined, container: HTMLDivElement | undefined
  try {
    dispose = await registerIpc({ workbenchUserState: testWorkbenchUserState(), appDocumentSources: testAppDocumentSources(sender), initialConfig: config, window: { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow, runtime: controller,
      workbenchWindows: { setNativeOwner: () => () => {} } as never,
      configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as never,
      progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
      workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as never })
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => { const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function'); return handler!({ senderFrame: Reflect.get(sender as object, 'mainFrame'), sender } as unknown as IpcMainInvokeEvent, ...args) })
    installCollaborationCanvasGeometry(); installCollaborationLayoutLoopback()
    const { AgentCollaborationMap } = await import('../src/renderer/src/components/AgentCollaborationMap'), { useAppStore } = await import('../src/renderer/src/store')
    const opened = vi.fn(), focused = vi.fn()
    useAppStore.setState({ config, sessions: [owner], tabs: {}, layouts: {}, scratchTopicSnapshots: {}, timelines: {}, agentNames: { [related.id]: 'Related task' } })
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    container = document.createElement('div'); document.body.append(container); const renderer = createAgentInformationRoot(container); unmount = () => renderer.unmount()
    await act(async () => renderer.render(<AgentCollaborationMap request={{ kind: 'focus', subject: { hostId: 'local', agentSessionId: owner.id }, name: 'Owner' }} onOpen={opened} onViewInFocus={focused} />))
    await settleCollaborationCanvas(() => expect(container!.querySelector('[data-session-id="late-peer"]')).not.toBeNull())
    expect(exact.mock.calls.filter(([input]) => input?.agentSessionId)).toEqual([[{ agentSessionId: related.id }]])
    expect(eventsRead.mock.calls.length).toBeGreaterThan(0)
    expect(eventsRead.mock.calls.every(([input]) => input.participantSessionId === owner.id)).toBe(true)
    expect(inventory).not.toHaveBeenCalled(); for (const body of bodies) expect(body).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Unopened original content')
    const point = container.querySelector<HTMLButtonElement>('[data-session-id="late-peer"]')!
    await act(async () => point.click())
    expect(container.textContent).toContain('Related task')
    const affiliation = container.querySelector('[aria-label="Area affiliation"]')!
    expect(affiliation.textContent).toContain('Workspace association'); expect(affiliation.textContent).toContain(config.workspaces[0]!.name)
    expect(affiliation.textContent).toContain(related.workspacePath); expect(affiliation.textContent).not.toContain('Display binding')
    await act(async () => [...container!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('View in Focus'))!.click())
    expect(focused).toHaveBeenLastCalledWith({ hostId: 'local', agentSessionId: related.id }, related.id)
    expect(opened).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled(); for (const control of controls) expect(control).not.toHaveBeenCalled()
    // The existing public discovery consumes the same exact Store selector; no new Graph RPC.
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client }] })
    const status = vi.spyOn(client, 'statusAgent').mockRejectedValue(Error('Current Run unobserved'))
    const page = await service.call('agent.ls', { agentSessionId: related.id })
    expect(page.unavailableSessions.map(item => item.session.agentSessionId)).toEqual([related.id])
    expect(status).toHaveBeenCalledExactlyOnceWith(related.id); expect(inventory).not.toHaveBeenCalled()
  } finally {
    await closeFixture(root, [client], dispose, unmount, container)
  }
}, 20_000)

it('exact metadata distinguishes semantic Runtime ownership, unavailable routes and a changed owner during the read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'map-owner-'))
  recordRoot(root)
  const stores = ['local', 'remote'].map(name => new AgentMuxFileAgentSessionStore(join(root, name + '.json')))
  const clients = stores.map(store => new AgentMuxClient({ store }))
  let epoch = 'original-owner'
  const identity = (runtimeId: string) => ({ runtimeId, ownerInstanceId: epoch, protocolVersion: 2, processId: null, ctxmux: null, availability: 'connected' })
  Object.assign(clients[0]!, { runtimeOwnerIdentity: () => identity('local-runtime') })
  Object.assign(clients[1]!, { runtimeOwnerIdentity: () => identity('foreign-runtime') })
  for (const [index, store] of stores.entries()) await store.compareAndSwap(null, { ...agentCreationFixture(composerSession('same-id', index ? 'claude' : 'codex')), hookBindingId: 'private-hook', hookToken: 'private-token' })
  const controller = new RuntimeController(stores[0]!, localRuntimeConnector)
  const hosts = clients.map((client, index) => ({ id: index ? 'original-remote' : 'local', config: index
    ? { id: 'original-remote', kind: 'ssh' as const, label: 'Remote', hostname: 'remote.invalid' }
    : { id: 'local', kind: 'local' as const, label: 'Local' }, client, executionHost: { dispose: vi.fn() } as never }))
  controller.commit({ hosts, removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const localRead = vi.spyOn(clients[0]!, 'sessionHistorySources'), remoteRead = vi.spyOn(clients[1]!, 'sessionHistorySources')
  try {
    const reference = { runtimeId: 'foreign-runtime', agentSessionId: 'same-id' }
    expect(await controller.sessionHistorySource(reference)).toMatchObject({ source: { hostId: 'original-remote', agentSessionId: 'same-id', history: { providerId: 'claude' } }, issue: null })
    expect(remoteRead).toHaveBeenCalledExactlyOnceWith({ agentSessionId: 'same-id' }); expect(localRead).not.toHaveBeenCalled()
    expect(await controller.sessionHistorySource({ runtimeId: 'ctxmux-instance', agentSessionId: 'same-id' })).toMatchObject({ source: null, issue: { code: 'RUNTIME_UNAVAILABLE' } })
    remoteRead.mockResolvedValueOnce([{ hostId: 'local', agentSessionId: 'another-id', state: 'active' }])
    expect(await controller.sessionHistorySource(reference)).toMatchObject({ source: null, issue: { code: 'CONTROL_PROTOCOL_ERROR' } })
    let release!: (value: import('@agentmux/core').AgentSessionHistoryDescriptor[]) => void
    remoteRead.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = controller.sessionHistorySource(reference)
    epoch = 'replacement-owner'
    release([{ hostId: 'local', agentSessionId: 'same-id', state: 'retired' }])
    expect(await pending).toMatchObject({ source: null, issue: { code: 'EXECUTOR_HOST_CHANGED' } })
    Object.assign(clients[0]!, { runtimeOwnerIdentity: () => identity('foreign-runtime') })
    expect(await controller.sessionHistorySource(reference)).toMatchObject({ source: null, issue: { code: 'AMBIGUOUS_AGENT_SESSION' } })
    expect(localRead).not.toHaveBeenCalled()
  } finally { await Promise.all(clients.map(client => client.dispose())); await rm(root, { recursive: true, force: true }); vi.restoreAllMocks() }
})

it.each(['active', 'retired'] as const)('the real Goal Team reads its %s original source through preload IPC and one exact durable Core owner', async state => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-exact-identity-')); bridge.directory = directory; vi.stubEnv('AGENTMUX_STATE_DIRECTORY', directory)
  recordRoot(directory)
  const stores = ['local', 'worker'].map(name => new AgentMuxFileAgentSessionStore(join(directory, name + '.json')))
  const clients = stores.map(store => new AgentMuxClient({ store })), sid = 'original-goal-worker', hostId = 'worker-host'
  const session = { ...agentCreationFixture(composerSession(sid, 'claude')), hookBindingId: 'private-original-hook', hookToken: 'private-original-token' }
  await stores[0]!.compareAndSwap(null, { ...agentCreationFixture(composerSession(sid, 'codex')), hookBindingId: 'foreign-hook', hookToken: 'foreign-token' })
  await stores[1]!.compareAndSwap(null, session)
  if (state === 'retired') {
    const reservation = { reservationId: 'private-retirement', ownerId: 'private-owner', ownerPid: process.pid, kind: 'stop' as const,
      agentSessionId: sid, operationId: 'original-retirement', expiresAt: Date.now() + 60000, expectedRun: session.run,
      stopOperation: { daemonInstance: 'private-daemon', operationKey: 'original-retirement', runId: session.run.runId } }
    await stores[1]!.reserveLifecycle(reservation); await stores[1]!.commitLifecycle(reservation, null)
  }
  for (const [index, client] of clients.entries()) Object.assign(client, { runtimeOwnerIdentity: () => ({ runtimeId: 'private-runtime-' + index,
    ownerInstanceId: 'private-owner-' + index, protocolVersion: 2, processId: null, ctxmux: null, availability: 'connected' }) })
  const exact = clients.map(client => vi.spyOn(client, 'sessionHistorySources')), inventory = clients.map(client => vi.spyOn(client, 'readAgentSessions'))
  const controls = clients.flatMap(client => {
    const kernel = (client as unknown as { kernel: Record<string, () => Promise<void>> }).kernel
    return ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name))
  })
  const bodies = clients.flatMap(client => [vi.spyOn(client, 'sessionHistoryPage'), vi.spyOn(client, 'sessionTimeline')])
  const controller = new RuntimeController(stores[0]!, localRuntimeConnector)
  const config = { ...structuredClone(composerConfig), hosts: [...composerConfig.hosts, { id: hostId, kind: 'ssh' as const, label: 'Original worker owner', hostname: 'private.invalid' }] }
  controller.commit({ hosts: clients.map((client, index) => ({ id: config.hosts[index]!.id, config: config.hosts[index]!, client,
    executionHost: { dispose: vi.fn() } as never })), removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 98, isDestroyed: () => false, send: vi.fn() })
  let dispose: (() => Promise<void>) | undefined, container: HTMLDivElement | undefined, unmount: (() => void) | undefined
  try {
    dispose = await registerIpc({ workbenchUserState: testWorkbenchUserState(), appDocumentSources: testAppDocumentSources(sender), initialConfig: config,
      window: { setBackgroundColor: vi.fn(), webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow, runtime: controller,
      workbenchWindows: { setNativeOwner: () => () => {} } as never, configStore: { get: async () => config, validate: (next: AppConfig) => next, save: async (next: AppConfig) => next } as never,
      progressLoops: { subscribe: () => () => {} } as never, scratchTopics: { setNameAudit: vi.fn() } as never,
      workspaceFiles: { read: vi.fn(), listFiles: vi.fn(), dispose: async () => {} } as never })
    bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
      return handler!({ senderFrame: Reflect.get(sender as object, 'mainFrame'), sender } as unknown as IpcMainInvokeEvent, ...args)
    })
    const { GoalExecution } = await import('../src/renderer/src/components/GoalExecution'), { useAppStore } = await import('../src/renderer/src/store')
    vi.spyOn(useAppStore.getState(), 'executeControl').mockResolvedValue({ operation: 'demand.show', goalContinuations: [] } as never)
    const goal: DemandProjection = { id: 'original-metadata-goal', title: 'Keep this original work', description: 'Original intent', status: 'in_progress', priority: 'normal',
      projectId: null, projectName: null, workspacePath: null, sessions: [], source: 'default-topic', sessionIds: [sid, 'bare-reference', 'healthy'], assigneeSessionIds: [sid], supervisorSessionId: null,
      participations: [{ id: 'original-participation', operationId: 'original-participation', kind: 'discussion', hostId, agentSessionId: sid, entryPoint: 'goal.discuss', recordedAt: 1 },
        { id: 'healthy-source', operationId: 'healthy-source', kind: 'discussion', hostId: 'local', agentSessionId: 'healthy', entryPoint: 'goal.discuss', recordedAt: 1 }], createdAt: 1, updatedAt: 1 }
    const drafts = { [sid]: 'Keep the original unsent draft' }
    useAppStore.setState({ config, sessions: [composerSession('healthy')], timelines: {}, agentNames: {}, scratchTopicSnapshots: {},
      goalAgentCreationDrafts: {}, goalAgentSelectionDrafts: {}, agentComposerDrafts: drafts })
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement('div'); document.body.append(container)
    const renderer = createAgentInformationRoot(container); unmount = () => renderer.unmount()
    await act(async () => renderer.render(<GoalExecution demand={goal} onUpdate={async () => false} />))
    const identity = () => container!.querySelector<HTMLElement>('[data-goal-team-identity]')
    await vi.waitFor(() => expect(identity()?.textContent).toContain(state === 'retired' ? 'Retired Session' : 'Retained Session'))
    expect(identity()?.textContent).toContain('claude'); expect(identity()?.textContent).not.toContain('codex')
    expect(identity()?.textContent).toContain(hostId); expect(identity()?.querySelector('[data-session-id]')).toBeNull()
    expect(container.querySelectorAll('button.focus-context')).toHaveLength(1)
    expect(exact[1]).toHaveBeenCalledExactlyOnceWith({ agentSessionId: sid }); expect(exact[0]).not.toHaveBeenCalled()
    expect(bridge.invoke.mock.calls.some(([channel, value]) => channel === 'sessions:historySource' && JSON.stringify(value) === JSON.stringify({ hostId, agentSessionId: sid }))).toBe(true)
    for (const read of [...inventory, ...bodies, ...controls]) expect(read).not.toHaveBeenCalled()
    expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
    // Existing CLI discovery consumes the same exact original store, retaining
    // unavailable active metadata/retired sources without creating a new API.
    const invocation = await parseAgentMuxCliInvocation(['agent', 'ls', '--session', sid])
    expect(invocation.command.method).toBe('agent.ls')
    const status = vi.spyOn(clients[1]!, 'statusAgent').mockRejectedValue(new Error('Current Run not observed in this fixture'))
    const service = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: clients[1]! }] })
    const page = await service.call('agent.ls', invocation.params as never)
    expect(state === 'retired' ? page.retired.map(item => item.agentSessionId) : page.unavailableSessions.map(item => item.session.agentSessionId)).toEqual([sid])
    if (state === 'active') expect(status).toHaveBeenCalledExactlyOnceWith(sid)
    else expect(status).not.toHaveBeenCalled()
    for (const read of inventory) expect(read).not.toHaveBeenCalled()
  } finally {
    await closeFixture(directory, clients, dispose, unmount, container)
  }
}, 20000)
