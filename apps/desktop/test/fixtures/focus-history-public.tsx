// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, loadAgentSessions, type AgentMuxStoredAgentSession } from '@agentmux/core'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../../src/shared/contracts'
const bridge = vi.hoisted(() => ({ api: null as AgentMuxPreloadApi | null, invoke: vi.fn(), handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (_name: string, api: AgentMuxPreloadApi) => { bridge.api = api; window.agentmux = api } },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), off: vi.fn(), send: vi.fn() }, webFrame: { getZoomFactor: () => 1 },
  app: { getPath: () => '/private-focus-retired-renderer' },
  ipcMain: { handle: (channel: string, handler: Function) => bridge.handlers.set(channel, handler), removeHandler: (channel: string) => bridge.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
// Only the Electron service shell is isolated. Core/FileStore/built-in Reader,
// Main controller, registered IPC, preload, Renderer API and mounted UI are real.
vi.mock('@agentmux/core', async original => ({ ...await original<typeof import('@agentmux/core')>(), AgentMuxControlServer: class { async start() {} async stop() {} } }))
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({}) }))
vi.mock('../../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-renderer-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../../src/preload/index'
import { RuntimeController } from '../../src/main/runtime-controller'
import { registerIpc } from '../../src/main/ipc'
import { DEFAULT_CONFIG } from '../../src/main/config-store'
import { useAppStore } from '../../src/renderer/src/store'
import { api } from '../../src/renderer/src/lib/api'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { EMPTY_AGENT_FOCUS } from '../../src/renderer/src/lib/agent-focus'
import { RecentFocusTimeline } from '../../src/renderer/src/components/RecentFocusTimeline'

export const NOW = Date.parse('2026-10-03T12:00:00Z'); export const HOUR = 3_600_000; export const BODY = 'Same original retained input'
const baseline = useAppStore.getState()
const roots: Root[] = [], nodes: HTMLElement[] = [], cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  document.getElementById('agentmux-window-overlay-host')?.remove(); bridge.invoke.mockReset()
})

export type Input = { id: string; body: string; at?: number }
export async function fixture(records: Input[] = [{ id: 'one', body: BODY, at: NOW - HOUR }, { id: 'two', body: BODY }, { id: 'outside', body: 'Outside window', at: NOW - 8 * HOUR }], count = 1, options: { retire?: boolean; native?: boolean; recordsBySource?: (index: number) => Input[]; capturedPerSource?: number } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const directory = await mkdtemp(join(tmpdir(), 'focus-retired-renderer-'))
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  for (let index = 0; index < count; index++) {
    const id = `archived-${index}`, path = join(directory, `${id}.jsonl`)
    const values = options.recordsBySource ? options.recordsBySource(index) : index === 0 ? records : [{ id: `other-${index}`, body: `Unfocused source ${index}`, at: NOW - HOUR }]
    await writeFile(path, values.map(item => JSON.stringify({ sessionId: `native-${id}`, uuid: item.id, type: 'user', message: { role: 'user', content: item.body }, ...(item.at === undefined ? {} : { timestamp: new Date(item.at).toISOString() }) })).join('\n') + '\n')
    const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'private-claude', hostId: 'private-host', workspacePath: directory,
      run: { runId: `not-controlled-${id}` }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: `binding-${id}`, hookToken: 'private-secret',
      ...(options.native === false ? {} : { nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: `native-${id}`, transcriptPath: path } }) }
    await store.compareAndSwap(null, session)
    if (index === 0) await store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: { id: 'captured', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', createdAt: NOW - HOUR, updatedAt: NOW - HOUR, title: 'Input', content: BODY } })
    for (let n = 0; n < (options.capturedPerSource ?? 0); n++) await store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: { id: `input-${index}-${n}`, agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', createdAt: NOW - HOUR, updatedAt: NOW - HOUR, title: 'Input', content: `Actual captured ${index}-${n}` } })
    const reservation = { kind: 'stop' as const, reservationId: `retire-${id}`, ownerId: 'private-owner', ownerPid: process.pid, agentSessionId: id,
      expectedRun: session.run, operationId: `op-${id}`, expiresAt: Date.now() + 60_000,
      stopOperation: { daemonInstance: 'no-runtime', operationKey: `no-stop-${id}`, runId: session.run.runId } }
    if (options.retire !== false) { await store.reserveLifecycle(reservation); await store.commitLifecycle(reservation, null) }
  }
  const client = new AgentMuxClient({ store })
  const kernel = (client as unknown as { kernel: Record<string, (...args: unknown[]) => unknown> }).kernel
  const controls = ['start', 'input', 'resize', 'stop', 'attach', 'status'].map(name => vi.spyOn(kernel, name).mockImplementation(() => { throw new Error(`Unexpected Run control ${name}`) }))
  const connect = vi.spyOn(client, 'connect').mockRejectedValue(new Error('No private Runtime'))
  const controller = new RuntimeController(store)
  controller.commit({ hosts: [{ id: 'private-host', client, executionHost: { kind: 'local', dispose: vi.fn() } as never }], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [], workspaces: [], executors: { 'private-claude': { providerId: 'claude', label: 'Private', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false } } }
  vi.spyOn(controller, 'prepare').mockResolvedValue({ hosts: [], removedHostIds: [], reservedHostIds: [], hostSignatures: new Map() })
  const sender = Object.assign(new EventEmitter(), { id: 91, isDestroyed: () => false, send: vi.fn() })
  const dispose = await registerIpc({ window: { webContents: sender } as unknown as BrowserWindow, runtime: controller,
    configStore: { get: async () => config } as never, progressLoops: { subscribe: () => () => {} } as never,
    scratchTopics: {} as never, workspaceFiles: { dispose: async () => {} } as never })
  bridge.invoke.mockImplementation((channel: string, ...args: unknown[]) => {
    const handler = bridge.handlers.get(channel); expect(handler).toBeTypeOf('function')
    return handler!({ sender } as unknown as IpcMainInvokeEvent, ...args)
  })
  cleanups.push(async () => { await dispose(); await client.dispose(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }) })
  expect(bridge.api).not.toBeNull()
  const sources = await bridge.api!.sessions.historySources()
  expect(sources.map(source => [source.agentSessionId, source.state])).toEqual(Array.from({ length: count }, (_, i) => [`archived-${i}`, options.retire === false ? 'active' : 'retired']))
  bridge.invoke.mockClear()
  const calls = { catalogue: vi.spyOn(api.sessions, 'historySources'), page: vi.spyOn(api.sessions, 'historyPage'), timeline: vi.spyOn(api.sessions, 'timeline'), projector: vi.spyOn(UserMessages, 'projectSessionUserMessages') }
  useAppStore.setState({ config, sessions: [], timelines: {}, agentFocus: EMPTY_AGENT_FOCUS, tabs: {}, layouts: {}, mainSurface: 'agents' })
  const element = document.createElement('div'); document.body.append(element); nodes.push(element)
  const root = createRoot(element); roots.push(root)
  const onSelect = vi.fn()
  const render = () => act(async () => root.render(createElement(RecentFocusTimeline, { contexts: [], entries: [], currentSessionId: null, onSelect })))
  const wait = async (check: () => void) => { for (let i = 0; i < 150; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { check(); return } catch (error) { if (i === 149) throw error } } }
  const click = (label: string) => act(async () => { const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); expect(button).not.toBeNull(); button!.click() })
  const selectSource = async (id = 'archived-0') => {
    if (!document.querySelector('[aria-label="Input records Context"]')) await click('View input records')
    await wait(() => expect(document.querySelector(`[aria-label="Input records Context"] option[value="${id}"]`)).not.toBeNull())
    await act(async () => { const select = document.querySelector<HTMLSelectElement>('[aria-label="Input records Context"]')!; select.value = id; select.dispatchEvent(new Event('change', { bubbles: true })) })
  }
  const button = async (text: string) => act(async () => { const target = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === text); expect(target).not.toBeUndefined(); expect(target!.disabled).toBe(false); target!.click() })
  const inputs = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-input-message-id]'))
  const markers = () => Array.from(element.querySelectorAll<HTMLButtonElement>('[data-message-id]'))
  const counts = () => [calls.catalogue.mock.calls.length, calls.page.mock.calls.length, calls.timeline.mock.calls.length, calls.projector.mock.calls.length]
  const noRuntime = () => { expect(connect.mock.calls).toEqual([]); expect(controls).toHaveLength(6); for (const control of controls) expect(control.mock.calls).toEqual([]); expect(onSelect.mock.calls).toEqual([]); expect(useAppStore.getState().sessions).toEqual([]) }
  return { element, root, render, wait, click, selectSource, button, inputs, markers, counts, calls, client, store, directory, onSelect, noRuntime, realPage: bridge.api!.sessions.historyPage.bind(bridge.api!.sessions), reference: { hostId: 'private-host', agentSessionId: 'archived-0' } satisfies SessionHistoryReference }
}
