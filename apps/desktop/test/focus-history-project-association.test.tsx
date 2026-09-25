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
import type { AgentMuxPreloadApi, AppConfig, SessionHistoryReference } from '../src/shared/contracts'
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
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'private-renderer-journal.json', BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ dispose() {} }) }))
import '../src/preload/index'
import { RuntimeController } from '../src/main/runtime-controller'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import * as UserMessages from '@agentmux/core/session-user-messages'
import { observeFocusInputTracks, resolveFocusInputTrack } from '../src/renderer/src/lib/focus-history-timeline'
import { EMPTY_AGENT_FOCUS, type AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'

const NOW = Date.parse('2026-10-03T12:00:00Z'), HOUR = 3_600_000, BODY = 'Same original retained input'
const baseline = useAppStore.getState()
const roots: Root[] = [], nodes: HTMLElement[] = [], cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  for (const node of nodes.splice(0)) node.remove()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  useAppStore.setState(baseline, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  document.getElementById('agentmux-window-overlay-host')?.remove(); bridge.invoke.mockReset()
})

type Input = { id: string; body: string; at?: number }
async function fixture(records: Input[] = [{ id: 'one', body: BODY, at: NOW - HOUR }, { id: 'two', body: BODY }, { id: 'outside', body: 'Outside window', at: NOW - 8 * HOUR }], count = 1, options: { retire?: boolean; native?: boolean; captured?: boolean; entries?: readonly AgentFocusHistoryEntry[] } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.spyOn(Date, 'now').mockReturnValue(NOW)
  const directory = await mkdtemp(join(tmpdir(), 'focus-retired-renderer-'))
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  for (let index = 0; index < count; index++) {
    const id = `archived-${index}`, path = join(directory, `${id}.jsonl`)
    const values = index === 0 ? records : [{ id: `other-${index}`, body: `Unfocused source ${index}`, at: NOW - HOUR }]
    await writeFile(path, values.map(item => JSON.stringify({ sessionId: `native-${id}`, uuid: item.id, type: 'user', message: { role: 'user', content: item.body }, ...(item.at === undefined ? {} : { timestamp: new Date(item.at).toISOString() }) })).join('\n') + '\n')
    const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'private-claude', hostId: 'private-host', workspacePath: directory,
      run: { runId: `not-controlled-${id}` }, retiredRuns: [], createdAt: 1, updatedAt: 1, hookBindingId: `binding-${id}`, hookToken: 'private-secret',
      ...(options.native === false ? {} : { nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: `native-${id}`, transcriptPath: path } }) }
    await store.compareAndSwap(null, session)
    if (index === 0 && options.captured !== false) await store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: { id: 'captured', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', createdAt: NOW - HOUR, updatedAt: NOW - HOUR, title: 'Input', content: BODY } })
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
  const render = () => act(async () => root.render(createElement(RecentFocusTimeline, { contexts: [], entries: options.entries ?? [], currentSessionId: null, onSelect })))
  const wait = async (check: () => void) => { for (let i = 0; i < 150; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { check(); return } catch (error) { if (i === 149) { console.error('Private project-read timeout facts', JSON.stringify({ markers: Array.from(element.querySelectorAll('[data-message-id]')).map(node => node.getAttribute('data-message-id')), inputs: Array.from(document.querySelectorAll('[data-input-message-id]')).map(node => node.getAttribute('data-input-message-id')), coverage: document.querySelector('.recent-focus__input-coverage')?.textContent, error: document.querySelector('.recent-focus__input-error')?.textContent })); throw error } } } }
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
  return { element, render, wait, click, selectSource, button, inputs, markers, counts, calls, client, store, directory, onSelect, noRuntime, reference: { hostId: 'private-host', agentSessionId: 'archived-0' } satisfies SessionHistoryReference }
}

const observed = (project: string, at = NOW - 2 * HOUR, hostId = 'private-host', name = project): AgentFocusHistoryEntry => ({ sessionId: 'archived-0', focusedAt: at, identity: { hostId, name: 'Retained context', kind: 'agent', providerId: 'claude', workspacePath: '/same-path', project: { id: project, name } } })
const association = (entries: AgentFocusHistoryEntry[]) => resolveFocusInputTrack(observeFocusInputTracks(entries), { hostId: 'private-host', agentSessionId: 'archived-0' })

it('organizes real public archived native and captured inputs with the unique observed Context project', async () => {
 const h = await fixture(undefined, 1, { entries: [observed('Alpha')] }); await h.render(); await h.selectSource()
 await h.wait(() => expect(h.markers()).toHaveLength(2))
 const project = h.element.querySelector('[data-timeline-project]')!
 expect(Array.from(h.element.querySelectorAll('[data-timeline-project]')).map(el => el.getAttribute('data-timeline-project'))).toEqual([JSON.stringify(['private-host', 'Alpha'])])
 expect(Array.from(project.querySelectorAll('[data-message-id]')).map(el => el.getAttribute('data-message-id'))).toEqual(['native:claude:native-archived-0:one', 'captured:captured'])
 expect(project.querySelector('.recent-focus__project-heading')!.getAttribute('title')).toContain('Observed Context project; message-time project not recorded')
 expect(h.inputs()).toHaveLength(4)
 expect(document.querySelector('[aria-label="Input records Context"] option[value="archived-0"]')!.textContent).toContain('Alpha (observed Context)')
 expect(document.querySelector('.recent-focus__source-details')!.textContent).toContain('Message-time project: Not recorded'); h.noRuntime()
})

it('keeps conflicting outside-window observations unknown without losing the in-window focus identity', async () => {
 const h = await fixture(undefined, 1, { entries: [observed('Alpha'), observed('Beta', NOW - 20 * HOUR)] }); await h.render(); await h.selectSource()
 await h.wait(() => expect(h.markers()).toHaveLength(2))
 const group = h.element.querySelector('[data-timeline-project="unknown-project"]')!
 expect(group).not.toBeNull(); expect(group.querySelectorAll('[data-message-id]')).toHaveLength(2)
 const alpha = Array.from(h.element.querySelectorAll('[data-timeline-project]')).find(el => el.getAttribute('data-timeline-project') === JSON.stringify(['private-host', 'Alpha']))!
 expect(alpha).not.toBeUndefined()
 const focus = alpha.querySelector('.recent-focus__segment')!
 expect(focus.getAttribute('title')).toContain('Alpha')
 expect(document.querySelector('[aria-label="Input records Context"] option[value="archived-0"]')!.textContent).toContain('Project not recorded')
 expect(document.querySelector('.recent-focus__source-details')!.textContent).toContain('Not recorded or conflicting'); h.noRuntime()
})

it('does not borrow a same-path project from a different Host', async () => {
 const h = await fixture(undefined, 1, { entries: [observed('Decoy', NOW - 2 * HOUR, 'other-host')] }); await h.render(); await h.selectSource()
 await h.wait(() => expect(h.markers()).toHaveLength(2))
 expect(h.element.querySelector('[data-timeline-project="unknown-project"] [data-message-id]')).not.toBeNull()
 expect(document.querySelector('[aria-label="Input records Context"] option[value="archived-0"]')!.textContent).not.toContain('Decoy')
 expect(document.querySelector('[aria-label="Input records Context"] option[value="archived-0"]')!.textContent).toContain('Project not recorded'); h.noRuntime()
})

it('does not invent project or tracks for metadata-only sources and keeps genuinely unknown inputs readable', async () => {
 const h = await fixture(); await h.render(); await h.click('View input records')
 await h.wait(() => expect(document.querySelector('[aria-label="Input records Context"] option[value="archived-0"]')).not.toBeNull())
 expect(h.element.querySelectorAll('[data-timeline-project]')).toHaveLength(0)
 expect(h.counts().slice(0, 3)).toEqual([1, 0, 0])
 await h.selectSource(); await h.wait(() => expect(h.markers()).toHaveLength(2))
 expect(h.element.querySelector('[data-timeline-project="unknown-project"]')).not.toBeNull()
 expect(h.inputs().map(el => el.dataset.inputMessageId)).toEqual(['native:claude:native-archived-0:one', 'native:claude:native-archived-0:two', 'native:claude:native-archived-0:outside', 'captured:captured']); h.noRuntime()
})

it('uses the latest actual observed name without altering the retained events or accepting another Session', () => {
 const entries = [observed('A', NOW - 2 * HOUR, 'private-host', 'Old name'), observed('A', NOW - HOUR, 'private-host', 'New name'), { ...observed('B'), sessionId: 'decoy-session' }]
 const before = JSON.stringify(entries); const result = association(entries)
 expect(result.key).toBe(JSON.stringify([JSON.stringify(['private-host', 'A']), 'archived-0']))
 expect(result.identity?.project).toEqual({ id: 'A', name: 'New name' }); expect(JSON.stringify(entries)).toBe(before)
})

it('checks the complete retained history for conflicts and leaves empty or projectless identities unknown', () => {
 const entries = Array.from({ length: 2000 }, (_, index) => observed(index === 0 ? 'Conflict' : 'A', NOW - index * HOUR))
 expect(association(entries).identity).toBeUndefined(); expect(association(entries).key).toBe(JSON.stringify(['unknown-project', 'archived-0']))
 expect(association([]).identity).toBeUndefined()
 const entry = observed('A'); delete entry.identity!.project; expect(association([entry]).identity).toBeUndefined()
})

it('keeps selected source metadata off the timeline until its first real page is read', async () => {
 const h = await fixture(undefined, 1, { captured: false }); await h.render()
 let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
 h.calls.page.mockImplementationOnce(async (reference, options) => { await gate; return bridge.api!.sessions.historyPage(reference, options) })
 await h.selectSource(); await h.wait(() => expect(h.calls.page).toHaveBeenCalledTimes(1))
 expect(h.element.querySelectorAll('[data-timeline-project]')).toHaveLength(0)
 release(); await h.wait(() => expect(h.markers()).toHaveLength(1)); h.noRuntime()
})
