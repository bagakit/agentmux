// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  AgentMuxClient,
  AgentMuxFileAgentSessionStore,
  agentPromptCondition,
  type AgentMuxStoredAgentSession,
  type AgentSessionHistoryPage
} from '@agentmux/core'
import type { AgentMuxPreloadApi, AppConfig, SessionSnapshot } from '../src/shared/contracts'

const { fakeTrustedSender, fakeUntrustedSender, bridge } = vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false)
  const createSender = (id: number) => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
    const removeListener = vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      const list = listeners.get(event)
      if (list) listeners.set(event, list.filter(l => l !== fn))
    })
    return {
      id,
      isDestroyed: () => false,
      send: vi.fn(),
      session: { flushStorageData: vi.fn(), getStoragePath: () => bridge.storagePath },
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        const list = listeners.get(event) ?? []
        list.push(fn)
        listeners.set(event, list)
      }),
      once: vi.fn(),
      off: removeListener,
      removeListener,
      emit: (event: string, ...args: unknown[]) => {
        const list = listeners.get(event)
        if (list) for (const fn of list) fn(...args)
      }
    }
  }
  const trusted = createSender(772)
  const untrusted = createSender(999)
  return {
    fakeTrustedSender: trusted,
    fakeUntrustedSender: untrusted,
    bridge: {
      api: null as AgentMuxPreloadApi | null,
      storagePath: '',
      handlers: new Map<string, (...args: unknown[]) => unknown>(),
      lastSender: trusted as unknown
    }
  }
})

const fakeWindow = {
  webContents: fakeTrustedSender,
  isDestroyed: () => false
}

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, exposedApi: AgentMuxPreloadApi) => {
      bridge.api = exposedApi
      Object.assign(window, { [name]: exposedApi, api: exposedApi })
    }
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      const handler = bridge.handlers.get(channel)
      if (!handler) throw new Error(`No IPC handler registered for: ${channel}`)
      const event = { sender: bridge.lastSender }
      return handler(event, ...args)
    },
    on: vi.fn(),
    off: vi.fn(),
    send: vi.fn()
  },
  webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => bridge.storagePath },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      bridge.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      bridge.handlers.delete(channel)
    },
    on: vi.fn(),
    removeListener: vi.fn()
  },
  clipboard: {},
  dialog: {},
  nativeImage: {},
  shell: {}
}))

vi.mock('@agentmux/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentmux/core')>()),
  AgentMuxControlServer: class {
    async start() {}
    async stop() {}
  }
}))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({
  BrowserProfileManager: class {
    async initialize() {}
    async dispose() {}
  }
}))
vi.mock('../src/main/browser-operation-journal', () => ({
  BROWSER_OPERATION_JOURNAL_FILE: 'private-journal.json',
  BrowserOperationFileStore: class {},
  BrowserOperationJournal: class {
    async ready() {}
  }
}))
vi.mock('../src/main/browser-ref-ledger-store', () => ({
  BrowserRefLedgerStore: class {}
}))
vi.mock('../src/main/browser-view-manager', () => ({
  BrowserViewManager: class {
    dispose() {}
  }
}))
vi.mock('../src/main/agent-notifier', () => ({
  createAgentNotifier: () => ({ dispose() {} })
}))

import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { HOUR_MS } from '../src/renderer/src/lib/focus-time-window'

const SESSION_ID = 'focus-author-recipient', SENDER_ID = 'focus-author-sender'
const RUN_ID = `run-${SESSION_ID}`, NOW = Date.parse('2026-10-04T00:00:00Z')
const BODY = 'Same body from independently recorded authors'
let fixtureSequence = 0
const baseline = useAppStore.getState()
const storedSession = (directory: string, id = SESSION_ID): AgentMuxStoredAgentSession => ({
  kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory,
  run: { runId: `run-${id}` }, retiredRuns: [], hookBindingId: `binding-${id}`, hookToken: `private-token-${id}`,
  createdAt: NOW - 4 * HOUR_MS, updatedAt: NOW - 4 * HOUR_MS,
  semanticStatus: { state: 'working', source: 'native-hook', observedAt: NOW - 4 * HOUR_MS },
  ...(id === SESSION_ID ? { nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-author-records', transcriptPath: join(directory, 'native.jsonl') } } : {})
})
const snapshot = (directory: string, id = SESSION_ID): Extract<SessionSnapshot, { kind: 'agent' }> => ({
  id, kind: 'agent', providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: directory,
  label: id === SESSION_ID ? 'Recipient worker' : 'Known sender', createdAt: NOW - 4 * HOUR_MS, updatedAt: NOW - 4 * HOUR_MS,
  agentSessionUpdatedAt: NOW - 4 * HOUR_MS, latestOutputBytes: 0, processState: 'running',
  promptSubmissionPredecessor: null, status: { state: 'running', source: 'run-process', observedAt: NOW - 4 * HOUR_MS },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
})
const runProjection = (acceptedInputBytes: number, workspacePath: string) => ({ runId: RUN_ID, lifecycleOperationId: null, program: 'claude', args: [], workspacePath, pid: 8888,
  state: { type: 'running' as const }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes })

// These transports isolate Electron and ctxmux only. The actual Composer intent,
// registered Main trust/IPC, RuntimeController admission, Core accepted receipt,
// FileStore reread, public projector and Focus components are not mocked.
describe('Focus consumes accepted public message authors without inventing identity', () => {
  let directory: string, client: AgentMuxClient, root: Root, element: HTMLDivElement
  let disposeIpc: (() => Promise<void>) | undefined, disposeBootstrap: (() => void) | undefined
  let captured: Awaited<ReturnType<AgentMuxFileAgentSessionStore['loadTimeline']>>
  let nativePage: AgentSessionHistoryPage
  let writes: string[], acceptedWrites: string[], onSelect: ReturnType<typeof vi.fn>, controls: Array<{ mock: { calls: unknown[][] } }>
  let page: { mock: { calls: unknown[][] } }, catalog: { mock: { calls: unknown[][] } }, timelineRead: { mock: { calls: unknown[][] } }, projector: { mock: { calls: unknown[][] } }
  let publicIds: string[], manualRawId: string
  const dialog = () => document.querySelector<HTMLElement>('.recent-focus__message-preview[role="dialog"]')!
  const wait = async (assertion: () => void) => { for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { assertion(); return } catch (error) { if (i === 99) throw error } } }
  const click = async (node: HTMLElement | null) => { expect(node).not.toBeNull(); await act(async () => { node!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); node!.click() }) }
  const marker = (role: string) => { const node = element.querySelector<HTMLButtonElement>(`.recent-focus__message[data-message-author="${role}"]`); expect(node, `Actual ${role} author marker is present`).not.toBeNull(); return node! }
  const close = () => click(dialog().querySelector('[aria-label="Close message"]'))
  const readInputs = async () => { await click(element.querySelector('[aria-label="View input records"]')); await wait(() => expect(document.querySelectorAll('[data-input-message-id]')).toHaveLength(5)) }
  const body = () => dialog().querySelector<HTMLElement>('[data-input-preview-id]')!
  const noWrites = () => { expect(writes).toEqual(acceptedWrites); expect(controls.map(spy => spy.mock.calls.length)).toEqual(controls.map(() => 0)); expect(useAppStore.getState().agentFocus).toEqual(EMPTY_AGENT_FOCUS) }

  beforeEach(async context => {
    const crowded = context.task.name.includes('crowded minute')
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); bridge.lastSender = fakeTrustedSender; writes = []
    directory = await mkdtemp(join(tmpdir(), 'focus-author-consumer-')); bridge.storagePath = directory
    await mkdir(join(directory, 'Local Storage', 'leveldb'), { recursive: true })
    await writeFile(join(directory, 'native.jsonl'), [
      { uuid: 'native-timed', sessionId: 'native-author-records', type: 'user', message: { role: 'user', content: BODY }, timestamp: new Date(NOW - 60_000).toISOString() },
      { uuid: 'native-untimed', sessionId: 'native-author-records', type: 'user', message: { role: 'user', content: 'Untimed native input, sender not recorded' } }
    ].map(item => JSON.stringify(item)).join('\n') + '\n')
    const storePath = join(directory, 'sessions.json'), store = new AgentMuxFileAgentSessionStore(storePath)
    await store.compareAndSwap(null, storedSession(directory)); await store.compareAndSwap(null, storedSession(directory, SENDER_ID))
    client = new AgentMuxClient({ store })
    const adapter = client as unknown as { registry: { load(host: string): Promise<void> }; connected: boolean; kernel: Record<string, unknown> }
    await adapter.registry.load('local'); adapter.connected = true
    let cursor = 0
    adapter.kernel.isConnected = () => true; adapter.kernel.identity = () => ({ daemonInstanceId: 'private-controlled-adapter-no-runtime', protocolVersion: 1, buildIdentity: 'private' })
    adapter.kernel.status = async () => runProjection(cursor, directory)
    adapter.kernel.input = async (_run: string, operation: { expectedByte: number; data: string }) => { expect(operation.expectedByte).toBe(cursor); const start = cursor; writes.push(operation.data); cursor += Buffer.byteLength(operation.data); return { run: runProjection(cursor, directory), appliedByteRange: { startByte: start, endByte: cursor } } }
    vi.spyOn((client as unknown as { screenEvidence: { wait(): Promise<number> } }).screenEvidence, 'wait').mockResolvedValue(120)
    const runtime = new RuntimeController(store as never)
    runtime.commit({ hosts: [{ id: 'local', client, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    vi.spyOn(runtime, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
    disposeIpc = await registerIpc({ window: fakeWindow as unknown as Parameters<typeof registerIpc>[0]['window'], runtime,
      configStore: { get: async () => DEFAULT_CONFIG, validate: (config: AppConfig) => config, save: async () => {} } as unknown as Parameters<typeof registerIpc>[0]['configStore'],
      progressLoops: { pauseTarget: vi.fn().mockResolvedValue(undefined), subscribe: vi.fn(() => () => {}) } as unknown as Parameters<typeof registerIpc>[0]['progressLoops'],
      scratchTopics: { ready: async () => {} } as unknown as Parameters<typeof registerIpc>[0]['scratchTopics'],
      workspaceFiles: { dispose: async () => {} } as unknown as NonNullable<Parameters<typeof registerIpc>[0]['workspaceFiles']> })
    vi.spyOn(api.config, 'get').mockResolvedValue(DEFAULT_CONFIG)
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [snapshot(directory), snapshot(directory, SENDER_ID)], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
    disposeBootstrap = await useAppStore.getState().initialize()
    const config = { ...DEFAULT_CONFIG, workspaces: [{ id: 'author-project', hostId: 'local', name: 'Author project', path: directory, kind: 'folder' as const }] }
    useAppStore.setState({ config, sessions: [snapshot(directory), snapshot(directory, SENDER_ID)], agentNames: { [SESSION_ID]: 'Recipient worker', [SENDER_ID]: 'Known sender' },
      timelines: {}, tabs: {}, layouts: {}, agentComposerDrafts: {}, agentSteerQueues: {}, agentSteerInFlight: {}, workspaceFileRevisions: {}, agentFocus: EMPTY_AGENT_FOCUS, error: null })
    vi.spyOn(api.sessions, 'refresh').mockImplementation(async () => snapshot(directory))
    element = document.createElement('div'); document.body.append(element); root = createRoot(element)
    vi.spyOn(Date, 'now').mockReturnValue(crowded ? NOW - 50_000 : NOW - 2.5 * HOUR_MS + ++fixtureSequence * 5000)
    await act(async () => { useAppStore.getState().setAgentComposerDraft(SESSION_ID, BODY); root.render(<AgentSessionComposer sessionId={SESSION_ID} />) })
    await click(element.querySelector('button.composer-send'))
    await act(async () => { await useAppStore.getState().flushAgentSteerQueue(SESSION_ID) })
    await wait(() => { expect(writes.join(''), JSON.stringify({error:useAppStore.getState().error,queue:useAppStore.getState().agentSteerQueues,ui:element.textContent})).toContain(BODY); expect(useAppStore.getState().agentSteerQueues[SESSION_ID] ?? []).toEqual([]) })
    vi.mocked(Date.now).mockReturnValue(crowded ? NOW - 40_000 : NOW - 1.5 * HOUR_MS)
    await bridge.api!.sessions.submitPrompt(snapshot(directory).control, BODY, 'known-agent', agentPromptCondition(client.agentSession(SESSION_ID)), SENDER_ID, { allowUncertainTurn: true })
    vi.mocked(Date.now).mockReturnValue(crowded ? NOW - 30_000 : NOW - .5 * HOUR_MS)
    await bridge.api!.sessions.submitPrompt(snapshot(directory).control, BODY, 'unknown-submit', agentPromptCondition(client.agentSession(SESSION_ID)), undefined, { allowUncertainTurn: true })
    vi.mocked(Date.now).mockReturnValue(NOW)
    // The public projection's human record comes exclusively from an actual
    // manual Composer submission and a fresh FileStore reread, never a hand DTO.
    captured = await new AgentMuxFileAgentSessionStore(storePath).loadTimeline(SESSION_ID)
    expect(captured.items).toHaveLength(3)
    manualRawId = captured.items[0]!.id
    expect(captured.items.map(item => [item.authorHuman, item.authorAgentSessionId])).toEqual([[true, undefined], [undefined, SENDER_ID], [undefined, undefined]])
    expect(writes.join('').split(BODY)).toHaveLength(4); acceptedWrites = [...writes]
    nativePage = await client.sessionHistoryPage(SESSION_ID, { limit: 30 })
    const messages = UserMessages.projectSessionUserMessages({ agentSessionId: SESSION_ID, timeline: captured, historyPage: nativePage })
    publicIds = messages.map(message => message.id)
    expect(messages.map(message => [message.rawId, message.author.kind])).toEqual([
      ['native-timed', 'unknown'], ['native-untimed', 'unknown'], [manualRawId, 'human'], ['prompt:known-agent', 'agent'], ['prompt:unknown-submit', 'unknown']
    ])
    expect(new Set(publicIds).size).toBe(5)
    if (process.env.AGENTMUX_FOCUS_AUTHOR_PRODUCER_OUTPUT) await writeFile(process.env.AGENTMUX_FOCUS_AUTHOR_PRODUCER_OUTPUT + (crowded ? '.crowded.json' : ''), JSON.stringify({ schema: 'agentmux.focus-author-public-producer.v1', boundary: 'Private controlled adapter, genuine Composer/manual IPC/Core receipt and fresh FileStore/public projector. No physical human/CLI/Runtime.', captured, nativePage, messages, sources: await client.sessionHistorySources(), sessionId: SESSION_ID, senderId: SENDER_ID, now: NOW, sessions: useAppStore.getState().sessions, config, agentNames: useAppStore.getState().agentNames }, null, 2) + '\n')
    useAppStore.setState({ timelines: { [SESSION_ID]: captured }, agentComposerDrafts: { original: 'Keep the original draft' } })
    controls = ['resume', 'recover', 'stop', 'interrupt', 'write', 'paste'].map(method => vi.spyOn(api.sessions, method as 'resume'))
    catalog = vi.spyOn(api.sessions, 'historySources').mockImplementation(() => client.sessionHistorySources())
    page = vi.spyOn(api.sessions, 'historyPage')
    timelineRead = vi.spyOn(api.sessions, 'timeline')
    projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
    onSelect = vi.fn()
    const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
    await act(async () => root.render(<RecentFocusTimeline contexts={contexts} entries={[]} currentSessionId={SESSION_ID} onSelect={onSelect} />))
    await wait(() => expect(element.querySelectorAll('.recent-focus__message')).toHaveLength(4))
  })
  afterEach(async () => {
    if (root) await act(async () => root.unmount()); element?.remove()
    disposeBootstrap?.(); disposeBootstrap = undefined
    if (disposeIpc) await disposeIpc(); disposeIpc = undefined
    if (client) await client.dispose()
    if (directory) await rm(directory, { recursive: true, force: true })
    useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.getElementById('agentmux-window-overlay-host')?.remove()
  })

  it('uses genuine accepted receipts and the shared role for every non-empty marker, tooltip, avatar and list record', async () => {
    const markers = [...element.querySelectorAll<HTMLElement>('.recent-focus__message')]
    expect(markers.map(item => [item.dataset.messageRawId, item.dataset.messageAuthor])).toEqual([
      ['native-timed', 'unknown'], [manualRawId, 'human'], ['prompt:known-agent', 'agent'], ['prompt:unknown-submit', 'unknown']
    ])
    for (const [role, label, glyph] of [['human', 'Your message', 'lucide-user-round'], ['agent', 'Agent message', 'lucide-bot'], ['unknown', 'sender not recorded', 'lucide-circle-dot']]) {
      const node = marker(role!)
      expect(node.getAttribute('aria-label')).toContain(label); expect(node.title).toContain(role === 'human' ? 'Human message' : role === 'agent' ? 'Agent message' : 'Sender not recorded')
      expect(node.querySelector(`.conversation-avatar--${role} svg.${glyph}`)).not.toBeNull()
    }
    await readInputs()
    const inputs = [...dialog().querySelectorAll<HTMLElement>('[data-input-message-id]')]
    expect(inputs.map(item => [item.dataset.inputMessageId, item.dataset.messageAuthor])).toEqual(publicIds.map((id, i) => [id, ['unknown', 'unknown', 'human', 'agent', 'unknown'][i]]))
    expect(inputs.find(item => item.dataset.messageAuthor === 'human')!.getAttribute('aria-label')).toContain('Human message')
    expect(inputs.find(item => item.dataset.messageAuthor === 'agent')!.getAttribute('aria-label')).toContain('Known sender')
    noWrites()
  })

  it('renders trusted human as You in pinned shared body and excludes Agent fields and sender navigation', async () => {
    await click(marker('human'))
    expect(body().querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('human')
    expect(body().querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(dialog().querySelector('.recent-focus__message-caption')!.textContent).toContain('Human message')
    expect(dialog().querySelectorAll('.log-turn__who')).toHaveLength(1)
    expect(dialog().querySelector('.recent-focus__sender')).toBeNull(); expect(dialog().querySelector('.recent-focus__sender-run')).toBeNull(); expect(dialog().querySelector('.recent-focus__sender-link')).toBeNull()
    expect(body().textContent).toContain(BODY); noWrites(); expect(onSelect.mock.calls).toEqual([])
  })

  it('keeps known Agent exact sender/recipient actions and never associates a sender Run', async () => {
    await click(marker('agent'))
    expect(body().querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('agent')
    expect(body().querySelector('.log-turn__who')?.textContent).toBe('Known sender')
    expect(dialog().textContent).toContain('Sender Run not recorded')
    expect(dialog().textContent).not.toContain(`run-${SENDER_ID}`)
    await click(dialog().querySelector('.recent-focus__sender-link')); expect(onSelect.mock.calls).toEqual([[SENDER_ID]])
    await click(marker('agent')); await click([...dialog().querySelectorAll('button')].find(button => button.textContent === 'Return to Context')!);
    expect(onSelect.mock.calls).toEqual([[SENDER_ID], [SESSION_ID]]); noWrites()
  })

  it('keeps native and programmatic unknown inputs unknown and makes untimed records reachable without a false marker', async () => {
    await click(marker('unknown'))
    // conversation-chat-clarity/T001 changes display only; the Focus record and public author stay unknown.
    expect(dialog().dataset.messageAuthor).toBe('unknown')
    expect(body().querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('human'); expect(body().querySelector('.log-turn__who')?.textContent).toBe('You')
    expect(dialog().textContent).toContain('Sender not recorded'); expect(dialog().textContent).not.toContain('Human message'); expect(dialog().querySelector('.recent-focus__sender-link')).toBeNull()
    await close(); await readInputs()
    const untimed = dialog().querySelector<HTMLElement>(`[data-input-message-id="${publicIds[1]}"]`)!
    expect(untimed.textContent).toContain('Time unknown'); await click(untimed)
    expect(dialog().dataset.messageAuthor).toBe('unknown')
    expect(body().querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('human'); expect(body().textContent).toContain('Untimed native input')
    expect(element.querySelector(`[data-message-id="${publicIds[1]}"]`)).toBeNull(); noWrites(); expect(onSelect.mock.calls).toEqual([])
  })

  it('hover and keyboard focus use the shared author and pinned Escape returns to the original marker', async () => {
    const human = marker('human')
    await act(async () => human.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    await wait(() => expect(document.querySelector('.recent-focus__message-preview[role="tooltip"]')?.getAttribute('data-message-author')).toBe('human'))
    expect(document.querySelector('[role="tooltip"] .conversation-avatar--human')).not.toBeNull()
    await act(async () => human.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    await act(async () => marker('unknown').focus())
    await wait(() => expect(document.querySelector('.recent-focus__message-preview[role="tooltip"]')?.getAttribute('data-message-author')).toBe('unknown'))
    expect(document.querySelector('[role="tooltip"] .conversation-avatar--unknown')).not.toBeNull()
    await act(async () => human.focus()); await click(human); await wait(() => expect(document.activeElement).toBe(dialog()))
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(dialog()).toBeNull(); expect(document.activeElement).toBe(human); noWrites()
  })

  it('keeps pinned human body/Range/draft and source counts across pan, zoom and unrelated output', async () => {
    await click(element.querySelector('[aria-label="Previous focus window"]')); await click(element.querySelector('[aria-label="Next focus window"]'))
    await wait(() => expect(page.mock.calls.length).toBeGreaterThan(1))
    const human = marker('human'); await click(human); const original = body()
    const text = original.querySelector('.log-turn__body')!.firstChild!; expect(text.textContent).toContain(BODY)
    const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString(); expect(selected).toContain(BODY)
    const counts = [catalog.mock.calls.length, page.mock.calls.length, timelineRead.mock.calls.length, projector.mock.calls.length]
    const scale = element.querySelector<HTMLElement>('.recent-focus__time-scale')!
    vi.spyOn(scale, 'getBoundingClientRect').mockReturnValue({ x: 112, y: 28, left: 112, right: 512, top: 28, bottom: 46, width: 400, height: 18, toJSON() {} })
    await act(async () => scale.dispatchEvent(new WheelEvent('wheel', { deltaX: 1000, bubbles: true, cancelable: true })))
    expect(human.isConnected).toBe(false)
    expect(element.querySelector('[data-message-author="human"]')).toBeNull()
    expect(body()).toBe(original); expect(selection.toString()).toBe(selected)
    await click(element.querySelector('[aria-label="Zoom out Focus timeline"]'))
    await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(session => session.id === SENDER_ID ? { ...session, latestOutputBytes: 100 } : session) })))
    expect(body()).toBe(original); expect(selection.toString()).toBe(selected)
    expect([catalog.mock.calls.length, page.mock.calls.length, timelineRead.mock.calls.length, projector.mock.calls.length]).toEqual(counts)
    expect(useAppStore.getState().agentComposerDrafts).toEqual({ original: 'Keep the original draft' }); noWrites(); expect(onSelect.mock.calls).toEqual([])
  })
  it('all four records in a crowded minute remain keyboard addressable and every Input record opens its exact body', async () => {
    const markers = [...element.querySelectorAll<HTMLButtonElement>('.recent-focus__message')]
    expect(markers).toHaveLength(4)
    expect(markers.map(node => node.dataset.messageAuthor)).toEqual(['unknown', 'human', 'agent', 'unknown'])
    expect(new Set(markers.map(node => Math.floor(Number(node.dataset.messageAt) / 60_000))).size).toBe(1)
    for (const node of markers) {
      await act(async () => node.focus())
      expect(document.activeElement).toBe(node)
      const tooltip = document.querySelector<HTMLElement>('.recent-focus__message-preview[role="tooltip"]')!
      expect(tooltip).not.toBeNull(); expect(tooltip.dataset.previewMessageId).toBe(node.dataset.messageId)
      expect(tooltip.dataset.messageAuthor).toBe(node.dataset.messageAuthor)
      expect(tooltip.querySelector(`.conversation-avatar--${node.dataset.messageAuthor}`)).not.toBeNull()
      expect(tooltip.querySelector('.recent-focus__message-excerpt')!.textContent).toContain(BODY)
    }
    await readInputs()
    for (const id of publicIds) {
      const record = dialog().querySelector<HTMLElement>(`[data-input-message-id="${id}"]`)!
      expect(record).not.toBeNull(); await click(record)
      expect(body().dataset.inputPreviewId).toBe(id)
      expect(dialog().dataset.messageAuthor).toBe(record.dataset.messageAuthor)
      expect(body().querySelector('.log-turn')!.getAttribute('data-speaker-role')).toBe(record.dataset.messageAuthor === 'unknown' ? 'human' : record.dataset.messageAuthor)
      expect(body().textContent).toContain(id === publicIds[1] ? 'Untimed native input' : BODY)
    }
    expect(onSelect.mock.calls).toEqual([]); noWrites()
  })

})
