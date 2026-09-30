// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { act, createElement, Fragment, useMemo } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, type AgentMuxAgentSession } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'

const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api; window.agentmux = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => '/private-focus-closed-renderer' },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
// Isolate the Electron service shell and PTY painting only. Core/private Run,
// lifecycle, FileStore, built-in Reader, IPC/preload, Workbench/modal and Focus are real.
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-closed-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: ({ sessionId }: { sessionId: string }) => <output data-session-id={sessionId}>{sessionId}</output> }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { listProbeProcesses, stopProbeProcesses } from '../scripts/probe-process.mjs'

const HOUR = 3_600_000, BODY = 'The original user input survives ordinary Agent close'
const baseline = useAppStore.getState(), nodes: HTMLElement[] = [], roots: Root[] = []
let directory: string, store: AgentMuxFileAgentSessionStore, client: AgentMuxClient, controller: RuntimeController
let disposeIpc: (() => Promise<void>) | undefined, config: AppConfig, now: number
const agents = new Map<string, AgentMuxAgentSession>(), native = new Map<string, string>()
const originalPids = new Map<string, number>(), captured = new Map<string, string>()
let closeHistory: ReturnType<typeof useAppStore.getState>['agentFocus'], sourceCalls: ReturnType<typeof vi.spyOn>
const sender = Object.assign(new EventEmitter(), { id: 391, isDestroyed: () => false, send: vi.fn() })

async function wait(check: () => Promise<void> | void, budget = 15_000) {
  const end = Date.now() + budget
  while (true) {
    try { await check(); return } catch (error) { if (Date.now() >= end) throw error }
    await act(async () => { await new Promise(done => setTimeout(done, 10)) })
  }
}
const reference = (name: string): SessionHistoryReference => ({ hostId: 'local', agentSessionId: agents.get(name)!.agentSessionId })
function timelineOnly() {
  const selector = useMemo(createFocusProjectionSelector, []), projection = useAppStore(selector)
  const history = useAppStore(state => state.agentFocus.execution.history)
  return <RecentFocusTimeline contexts={projection.contexts} entries={history} currentSessionId={null} onSelect={() => { throw new Error('History inspection must not navigate execution') }} />
}
async function mount(workbench = false) {
  const element = document.createElement('div'); document.body.append(element); nodes.push(element)
  const root = createRoot(element); roots.push(root)
  await act(async () => root.render(createElement(Fragment, null, workbench ? createElement(WorkspaceWorkbench, { workspaceId: 'alpha' }) : null, workbench ? createElement(WorkspaceWorkbench, { workspaceId: 'beta' }) : null, createElement(timelineOnly))))
  return element
}
async function click(label: string) {
  const node = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
  expect(node).not.toBeNull(); expect(node!.disabled).toBe(false)
  await act(async () => node!.click())
}
async function action(text: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  expect(node).toBeDefined(); expect(node!.disabled).toBe(false)
  await act(async () => node!.click())
}
async function select(name: string) {
  if (!document.querySelector('[aria-label="Input records Context"]')) await click('View input records')
  const id = reference(name).agentSessionId
  await wait(() => expect(document.querySelector(`[aria-label="Input records Context"] option[value="${id}"]`)).not.toBeNull())
  await act(async () => { const node = document.querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!; node.value = id; node.dispatchEvent(new Event('change', { bubbles: true })) })
}
const inputs = () => [...document.querySelectorAll<HTMLButtonElement>('[data-input-message-id]')]
const markers = () => [...document.querySelectorAll<HTMLButtonElement>('[data-message-id]')]
async function readonlyClients() {
  const calls = { create: vi.spyOn(client, 'createAgent'), stop: vi.spyOn(client, 'stopAgent'), resume: vi.spyOn(client, 'resumeAgent') }
  return () => { expect(calls.create.mock.calls).toEqual([]); expect(calls.stop.mock.calls).toEqual([]); expect(calls.resume.mock.calls).toEqual([]) }
}

beforeAll(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  directory = await mkdtemp(join(tmpdir(), 'amx-closed-focus-'))
  for (const name of Object.keys(process.env).filter(name => /^AGENTMUX_(?:ENV|CLI|AGENT_SESSION(?:_.*)?|AGENT_CAPABILITY|HOOK(?:_.*)?|PROVIDER_ID|EXECUTOR_ID|LIFECYCLE_OPERATION_ID|USAGE_TRANSCRIPT_FORMAT)$/.test(name))) vi.stubEnv(name, '')
  for (const [key, value] of Object.entries({ AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })) vi.stubEnv(key, value)
  store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json')); client = new AgentMuxClient({ store })
  const cli = join(directory, 'fixture-cli.mjs')
  const original = await readFile(resolve('packages/core/test/fixtures/fake-codex-cli.mjs'), 'utf8')
  const anchor = 'payload: { session_id: `native-${agentSessionId}`'
  expect(original.split(anchor).length).toBeGreaterThan(1)
  await writeFile(cli, original
    .replace('const request = async (body) => {', 'const request = async (body) => { body = { ...body, payload: { ...body.payload, hook_event_name: body.eventName } };')
    // Claude has no Codex Kitty-handshake contract. This private history fixture
    // publishes its actual Claude Hook identity without waiting on that foreign TUI protocol.
    .replace('await handshake\n', "if (providerId === 'codex') await handshake\n")
    .replaceAll(anchor, 'payload: { transcript_path: process.env.AGENTMUX_PRIVATE_TRANSCRIPT, session_id: `native-${agentSessionId}`'))
  await client.connect(); now = Date.now()
  for (const name of ['keep', 'closed', 'unfocused']) {
    const workspacePath = join(directory, name === 'closed' ? 'beta' : 'alpha'), transcriptPath = join(directory, `${name}.jsonl`)
    await mkdir(workspacePath, { recursive: true })
    const agent = await client.createAgent({ createOperationId: randomUUID(), executorId: 'private-claude', providerId: 'claude', workspacePath,
      commandOverride: process.execPath, args: [cli], env: { AGENTMUX_FAKE_READY_MODE: 'before', AGENTMUX_PRIVATE_TRANSCRIPT: transcriptPath }, prompt: BODY,
      injectAgentMuxGuide: false, cols: 80, rows: 24 })
    agents.set(name, agent)
    await wait(async () => expect((await client.sessionHistorySources()).find(item => item.agentSessionId === agent.agentSessionId)?.history?.nativeHandle?.kind).toBe('provider'))
    const handle = (await client.sessionHistorySources()).find(item => item.agentSessionId === agent.agentSessionId)!.history!.nativeHandle
    expect(handle?.kind).toBe('provider')
    const nativeId = handle?.kind === 'provider' ? handle.sessionId : ''
    expect(nativeId.length).toBeGreaterThan(0); native.set(name, nativeId)
    const records = [{ id: 'one', body: BODY, at: now - HOUR }, { id: 'two', body: BODY }, { id: 'outside', body: 'Outside the original window', at: now - 8 * HOUR }]
    await writeFile(transcriptPath, records.map(item => JSON.stringify({ sessionId: nativeId, uuid: item.id, type: 'user', message: { role: 'user', content: item.body }, ...('at' in item ? { timestamp: new Date(item.at!).toISOString() } : {}) })).join('\n') + '\n')
    const page = await client.sessionHistoryPage(agent.agentSessionId, { limit: 30 })
    expect(page.items.map(item => item.kind)).toEqual(['user-message', 'user-message', 'user-message'])
    expect(page.source.nativeSessionId).toBe(nativeId)
    const timeline = await client.sessionTimeline(agent.agentSessionId)
    const messages = timeline.items.filter(item => item.kind === 'user_message' && item.source === 'user')
    expect(messages).toHaveLength(1); expect(messages[0]!.content).toBe(BODY); captured.set(name, `captured:${messages[0]!.id}`)
    const run = (await client.listRuns()).find(run => run.runId === agent.run.runId)!
    expect(run.state).toBe('running'); expect(run.pid).toBeGreaterThan(1)
    if (typeof run.pid !== 'number') throw new Error('The private Run must expose its actual PID')
    originalPids.set(name, run.pid)
  }
  controller = new RuntimeController(store)
  controller.commit({ hosts: [{ id: 'local', client, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  config = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: { 'private-claude': { providerId: 'claude', label: 'Private reader', command: process.execPath, args: [cli], env: {}, injectAgentMuxGuide: false } },
    workspaces: ['alpha', 'beta'].map(id => ({ id, hostId: 'local', kind: 'folder' as const, name: id === 'alpha' ? 'Alpha' : 'Beta', path: join(directory, id) })) }
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  disposeIpc = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime: controller,
    configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {}, pauseTarget: async () => {} } as never, scratchTopics: {} as never, workspaceFiles: { dispose: async () => {} } as never })
  bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => { const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function'); return handler!({ sender } as unknown as IpcMainInvokeEvent, ...args) })
  sourceCalls = vi.spyOn(api.sessions, 'historySources')
}, 45_000)

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  document.getElementById('agentmux-window-overlay-host')?.remove()
  useAppStore.setState(baseline, true)
})
afterAll(async () => {
  if (client) { for (const agent of client.agentSessions()) await client.stopAgent(agent.agentSessionId, agent.run).catch(() => {}); await disposeIpc?.(); await client.dispose() }
  if (directory) { await stopProbeProcesses(process.pid + 1_000_000_000, directory); expect(await listProbeProcesses(-1, directory)).toEqual([]); await rm(directory, { recursive: true, force: true }) }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

it('actual last Tab confirms default retirement while keepSession close preserves the original private Run; archived Focus reads original IDs and observed Beta', async () => {
  const snapshot = await controller.snapshot(config)
  expect(snapshot.sessions.map(item => item.id).sort()).toEqual([...agents.values()].map(item => item.agentSessionId).sort())
  const tabs = Object.fromEntries([...agents].map(([name, agent]) => [name, createWorkbenchTab(name, { kind: 'agent', regionId: `${name}-region`, phase: 'attached', workspaceId: name === 'closed' ? 'beta' : 'alpha', sessionId: agent.agentSessionId })]))
  useAppStore.setState({ config, sessions: snapshot.sessions, timelines: snapshot.timelines, agentFocus: EMPTY_AGENT_FOCUS, tabs,
    layouts: { alpha: createWorkspaceLayout('alpha-group', ['keep', 'unfocused']), beta: createWorkspaceLayout('beta-group', ['closed']) }, loading: false, mainSurface: 'workbench', activeWorkspaceId: 'beta',
    dirtyDocuments: {}, closingWorkbenchViews: {}, closeTabRequest: null, error: null, prewarmTerminal: vi.fn(), agentComposerDrafts: { [reference('keep').agentSessionId]: 'Original unsent draft' } })
  useAppStore.getState().focusExecutionSession(reference('closed').agentSessionId)
  closeHistory = useAppStore.getState().agentFocus
  expect(closeHistory.execution.history.map(item => item.sessionId)).toContain(reference('closed').agentSessionId)
  expect(closeHistory.execution.history.map(item => item.sessionId)).not.toContain(reference('unfocused').agentSessionId)
  await mount(true)
  const stop = vi.spyOn(api.sessions, 'stop')
  const close = document.querySelector<HTMLButtonElement>('[data-workbench-tab-id="closed"] .workbench-tab__close')!
  expect(close).not.toBeNull(); await act(async () => close.click())
  expect(document.querySelector('[role="dialog"]')).not.toBeNull(); await action('Stop & Close')
  await wait(() => expect(useAppStore.getState().tabs.closed).toBeUndefined())
  expect(stop.mock.calls.map(call => call[0].kind === 'agent' ? call[0].agentSessionId : null)).toEqual([reference('closed').agentSessionId])
  expect(bridge.invoke.mock.calls.filter(call => call[0] === 'sessions:stop').map(call => call[1].agentSessionId)).toEqual([reference('closed').agentSessionId])
  expect((await client.sessionHistorySources()).find(item => item.agentSessionId === reference('closed').agentSessionId)?.state).toBe('retired')
  // Close the inactive candidate while the keep Tab still owns Alpha focus.
  // Closing the active keep Tab first would legitimately focus its fallback.
  const neverX = document.querySelector<HTMLButtonElement>('[data-workbench-tab-id="unfocused"] .workbench-tab__close')!
  expect(neverX).not.toBeNull(); await act(async () => neverX.click()); await action('Stop & Close')
  await wait(() => expect(useAppStore.getState().tabs.unfocused).toBeUndefined())
  expect(stop.mock.calls.map(call => call[0].kind === 'agent' ? call[0].agentSessionId : null)).toEqual([reference('closed').agentSessionId, reference('unfocused').agentSessionId])
  expect((await client.sessionHistorySources()).find(item => item.agentSessionId === reference('unfocused').agentSessionId)?.state).toBe('retired')
  const keepX = document.querySelector<HTMLButtonElement>('[data-workbench-tab-id="keep"] .workbench-tab__close')!
  expect(keepX).not.toBeNull(); await act(async () => keepX.click()); await action('Keep Session & Close')
  await wait(() => expect(useAppStore.getState().tabs.keep).toBeUndefined())
  expect(stop.mock.calls).toHaveLength(2)
  const survivor = (await client.listRuns()).find(run => run.runId === agents.get('keep')!.run.runId)!
  expect(survivor.state).toBe('running'); expect(survivor.pid).toBe(originalPids.get('keep'))
  expect(useAppStore.getState().agentComposerDrafts[reference('keep').agentSessionId]).toBe('Original unsent draft')
  closeHistory = useAppStore.getState().agentFocus
  expect(closeHistory.execution.history.map(item => item.sessionId)).not.toContain(reference('unfocused').agentSessionId)
  await act(async () => useAppStore.setState({ sessions: (await controller.snapshot(config)).sessions }))
  expect(useAppStore.getState().sessions.map(item => item.id)).toEqual([reference('keep').agentSessionId])
  const noControl = await readonlyClients()
  await select('closed')
  await wait(() => expect(inputs().map(item => item.dataset.inputMessageId)).toEqual([`native:claude:${native.get('closed')}:one`, `native:claude:${native.get('closed')}:two`, `native:claude:${native.get('closed')}:outside`, captured.get('closed')]))
  expect(document.querySelector(`[data-focus-timeline-id="${reference('closed').agentSessionId}"]`)?.getAttribute('data-history-only')).toBe('true')
  expect(document.querySelector(`[data-focus-timeline-id="${reference('closed').agentSessionId}"]`)?.closest('[data-timeline-project]')?.textContent).toContain('Beta')
  noControl()
}, 25_000)

it('discovers the genuinely retired never-focused source, preserves native/captured equal bodies and unknown time without live control or guessed project', async () => {
  expect((await client.sessionHistorySources()).find(item => item.agentSessionId === reference('unfocused').agentSessionId)?.state).toBe('retired')
  expect(closeHistory.execution.history.map(item => item.sessionId)).not.toContain(reference('unfocused').agentSessionId)
  useAppStore.setState({ config, sessions: [], timelines: {}, agentFocus: closeHistory, tabs: {}, layouts: {}, mainSurface: 'agents' })
  await mount(); const noControl = await readonlyClients(); await select('unfocused')
  await wait(() => expect(inputs()).toHaveLength(4))
  expect(inputs().map(item => item.dataset.inputMessageId)).toEqual([`native:claude:${native.get('unfocused')}:one`, `native:claude:${native.get('unfocused')}:two`, `native:claude:${native.get('unfocused')}:outside`, captured.get('unfocused')])
  expect(inputs().filter(item => item.textContent!.includes(BODY))).toHaveLength(3)
  expect(markers().map(item => item.dataset.messageId)).toEqual([`native:claude:${native.get('unfocused')}:one`, captured.get('unfocused')])
  expect(document.querySelector(`[data-focus-timeline-id="${reference('unfocused').agentSessionId}"]`)?.closest('[data-timeline-project]')?.textContent).toContain('Project not recorded')
  await act(async () => inputs()[1]!.click())
  expect(document.querySelector('[data-input-preview-id]')?.textContent).toContain(BODY)
  expect(document.querySelector('.recent-focus__message-preview')?.textContent).toContain('Record time unknown')
  expect(document.querySelector('.recent-focus__source-details')?.textContent).toContain('Message-time project: Not recorded')
  noControl()
})

it('window navigation filters facts without more pages or projector work, and unrelated output never changes the retained snapshot or Run', async () => {
  useAppStore.setState({ config, sessions: [], timelines: {}, agentFocus: closeHistory, tabs: {}, layouts: {}, mainSurface: 'agents' })
  const page = vi.spyOn(api.sessions, 'historyPage'), timeline = vi.spyOn(api.sessions, 'timeline'), projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
  await mount(); await select('unfocused'); await wait(() => expect(inputs()).toHaveLength(4))
  const before = [sourceCalls.mock.calls.length, page.mock.calls.length, timeline.mock.calls.length, projector.mock.calls.length]
  expect(page.mock.calls.map(call => call[1]?.limit)).toEqual([30])
  expect(page.mock.calls[0]![0]).toEqual(reference('unfocused'))
  const noControl = await readonlyClients()
  await click('Previous focus window'); await wait(() => expect(markers()).toEqual([]))
  expect(document.querySelector(`[data-focus-timeline-id="${reference('unfocused').agentSessionId}"]`)).toBeNull()
  await click('Return to current focus window'); await wait(() => expect(markers()).toHaveLength(2))
  for (let index = 0; index < 20; index++) await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: index, items: [] } } })))
  expect([sourceCalls.mock.calls.length, page.mock.calls.length, timeline.mock.calls.length, projector.mock.calls.length]).toEqual(before)
  const run = (await client.listRuns()).find(item => item.runId === agents.get('keep')!.run.runId)!
  expect(run.state).toBe('running'); expect(run.pid).toBe(originalPids.get('keep'))
  noControl()
})
