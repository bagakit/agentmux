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
import { EMPTY_AGENT_FOCUS } from '../src/renderer/src/lib/agent-focus'
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
async function fixture(records: Input[] = [{ id: 'one', body: BODY, at: NOW - HOUR }, { id: 'two', body: BODY }, { id: 'outside', body: 'Outside window', at: NOW - 8 * HOUR }], count = 1, options: { retire?: boolean; native?: boolean } = {}) {
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
    if (index === 0) await store.applyTimelineMutation({ type: 'append', agentSessionId: id, item: { id: 'captured', agentSessionId: id, kind: 'user_message', source: 'user', status: 'complete', createdAt: NOW - HOUR, updatedAt: NOW - HOUR, title: 'Input', content: BODY } })
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
  return { element, render, wait, click, selectSource, button, inputs, markers, counts, calls, client, store, directory, onSelect, noRuntime, reference: { hostId: 'private-host', agentSessionId: 'archived-0' } satisfies SessionHistoryReference }
}

it('keeps Input records usable with only truly retired, never-focused public sources and no live Session', async () => {
  const h = await fixture(); await h.render()
  const input = h.element.querySelector<HTMLButtonElement>('[aria-label="View input records"]')!
  expect(input).not.toBeNull(); expect(input.disabled).toBe(false)
  await h.click('View input records')
  await h.wait(() => expect(document.querySelector('[aria-label="Input records Context"]')!.textContent).toContain('Claude · archived-0'))
  h.noRuntime()
})


it('reads actual archived native/native/captured equal bodies as three IDs; unknown time stays readable without an invented position', async () => {
  const h = await fixture(); await h.render(); await h.selectSource()
  await h.wait(() => expect(h.inputs().map(item => item.dataset.inputMessageId)).toEqual(['native:claude:native-archived-0:one', 'native:claude:native-archived-0:two', 'native:claude:native-archived-0:outside', 'captured:captured']))
  expect(h.inputs().filter(item => item.textContent!.includes(BODY))).toHaveLength(3)
  expect(h.inputs().find(item => item.dataset.inputMessageId!.endsWith(':two'))!.textContent).toContain('Time unknown')
  expect(h.markers().map(item => item.dataset.messageId)).toEqual(['native:claude:native-archived-0:one', 'captured:captured'])
  expect(h.element.querySelector('[data-focus-timeline-id="archived-0"]')?.getAttribute('data-history-only')).toBe('true')
  expect(h.element.textContent).toContain('Project not recorded')
  expect(h.element.querySelector('[data-run-id]')).toBeNull()
  expect(h.counts().slice(0, 3)).toEqual([1, 1, 1])
  await act(async () => h.inputs()[1]!.click())
  await h.wait(() => expect(document.querySelector('[data-input-preview-id]')?.getAttribute('data-input-preview-id')).toBe('native:claude:native-archived-0:two'))
  expect(document.querySelector('.recent-focus__message-preview')!.textContent).toContain('Record time unknown')
  const body = document.querySelector('[data-input-preview-id]')!; expect(body.textContent).toContain(BODY)
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!; const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  expect(selection.toString().length).toBeGreaterThan(0)
  const before = h.counts()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.querySelector('[data-input-preview-id]')).toBeNull()
  expect(h.markers().map(item => item.dataset.messageId)).toEqual(['native:claude:native-archived-0:one', 'captured:captured'])
  expect(h.counts()).toEqual(before)
  h.noRuntime()
})

it('discovers metadata once, initially lists 30 sources and shows more without scanning bodies or creating metadata-only tracks', async () => {
  const h = await fixture(undefined, 35); await h.render(); await h.click('View input records')
  await h.wait(() => expect(document.querySelectorAll('[aria-label="Input records Context"] option[value^="archived-"]')).toHaveLength(30))
  expect(h.counts().slice(0, 3)).toEqual([1, 0, 0]); expect(h.element.querySelectorAll('[data-focus-timeline-id]')).toHaveLength(0)
  expect(document.querySelector('.recent-focus__message-preview')!.textContent).toContain('30 of 35 sources listed')
  await h.button('Show more input sources')
  expect(document.querySelectorAll('[aria-label="Input records Context"] option[value^="archived-"]')).toHaveLength(35)
  expect(h.counts().slice(0, 3)).toEqual([1, 0, 0])
  await h.selectSource('archived-34'); await h.wait(() => expect(h.inputs().map(item => item.textContent)).toEqual([expect.stringContaining('Unfocused source 34')]))
  expect(h.calls.page.mock.calls.map(call => call[0])).toEqual([{ hostId: 'private-host', agentSessionId: 'archived-34' }])
  expect(h.markers().map(item => item.dataset.messageId)).toEqual(['native:claude:native-archived-34:other-34']); h.noRuntime()
})

it('uses opaque native continuation in batches of at most three pages and retains at most 90 raw with the inspected record protected', async () => {
  const records = Array.from({ length: 130 }, (_, index) => ({ id: `record-${index}`, body: `Retained record ${index}`, at: NOW - HOUR }))
  const h = await fixture(records); await h.render(); await h.selectSource()
  await h.wait(() => expect(h.inputs().filter(item => item.dataset.inputSource === 'native')).toHaveLength(90))
  expect(h.calls.page.mock.calls).toHaveLength(3)
  expect(h.calls.page.mock.calls.map(call => call[1]?.limit)).toEqual([30, 30, 30])
  const cursor = h.calls.page.mock.calls[1]![1]?.cursor; expect(typeof cursor).toBe('string'); expect(cursor!.length).toBeGreaterThan(0)
  const last = h.inputs().filter(item => item.dataset.inputSource === 'native').at(-1)!
  await act(async () => last.click()); const pin = last.dataset.inputMessageId!
  const body = document.querySelector('[data-input-preview-id]')!; expect(body.textContent!.length).toBeGreaterThan(0)
  const node = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!; const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString()
  const list = document.querySelector<HTMLElement>('.recent-focus__input-list')!; list.scrollTop = 37
  await h.button('Read earlier records')
  await h.wait(() => expect(h.calls.page.mock.calls).toHaveLength(5))
  await h.wait(() => expect(document.querySelector('.recent-focus__input-coverage')?.parentElement!.textContent).toContain('90 native records'))
  const native = h.inputs().filter(item => item.dataset.inputSource === 'native'); expect(native).toHaveLength(90)
  expect(native.map(item => item.dataset.inputMessageId)).toContain(pin)
  expect(document.querySelector('[data-input-preview-id]')).toBe(body); expect(selection.toString()).toBe(selected); expect(list.scrollTop).toBe(37)
  expect(h.calls.timeline.mock.calls).toHaveLength(1); h.noRuntime()
})

it('keeps captured inputs readable when the true retired descriptor has no native identity and reports native coverage failure', async () => {
  const h = await fixture(undefined, 1, { native: false }); await h.render(); await h.selectSource()
  await h.wait(() => expect(h.inputs().map(item => item.dataset.inputMessageId)).toEqual(['captured:captured']))
  await h.wait(() => expect(document.querySelector('.recent-focus__input-error')?.textContent).toMatch(/native|transcript|history/i))
  expect(h.markers().map(item => item.dataset.messageId)).toEqual(['captured:captured']); h.noRuntime()
})

it('does not turn Now-window display ticks or unrelated output into metadata, page, captured or projector work', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const h = await fixture(); await h.render(); await h.selectSource()
  await h.wait(() => expect(h.inputs()).toHaveLength(4)); const before = h.counts()
  vi.mocked(Date.now).mockReturnValue(NOW + 90_000)
  await act(async () => { await vi.advanceTimersByTimeAsync(90_000) })
  expect(h.element.querySelector('.recent-focus__playhead--ruler')?.getAttribute('data-now')).toBe(String(NOW + 90_000))
  const afterTicks = h.counts(); expect(afterTicks.slice(0, 3)).toEqual(before.slice(0, 3))
  // Track viewport filtering can change, but the same canonical facts must not be reprojected.
  expect(afterTicks[3]).toBe(before[3])
  for (let i = 0; i < 20; i++) await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, unrelated: { agentSessionId: 'unrelated', revision: i, items: [] } } })))
  expect(h.counts()).toEqual(before); h.noRuntime()
})


it('retains previously read bodies with honest unavailable coverage after real Store eviction, without restoring the retired Run', async () => {
  const h = await fixture(); await h.render(); await h.selectSource(); await h.wait(() => expect(h.inputs()).toHaveLength(4))
  await act(async () => h.inputs()[0]!.click()); const body = document.querySelector('[data-input-preview-id]')!
  expect((await h.client.sessionHistorySources()).map(source => source.agentSessionId)).toEqual(['archived-0'])
  await h.store.retireRuns(Array.from({ length: 256 }, (_, index) => ({ runId: `extra-retired-${index}` })))
  expect(await h.client.sessionHistorySources()).toEqual([])
  await h.button('Refresh source')
  await h.wait(() => expect(document.querySelector('.recent-focus__input-error')?.textContent).toMatch(/not stored|unknown|unavailable|retained/i))
  expect(h.inputs().filter(item => item.textContent!.includes(BODY))).toHaveLength(3)
  // Explicit refresh clears the selected message, not the previously read canonical records.
  expect(body.isConnected).toBe(false); expect(h.markers()).toHaveLength(2); h.noRuntime()
})

it('keeps the old snapshot and preview Range when a real readonly source changes until explicit refresh', async () => {
  const records = Array.from({ length: 130 }, (_, index) => ({ id: `old-${index}`, body: `Old source ${index}`, at: NOW - HOUR }))
  const h = await fixture(records, 1, { retire: false }); await h.render(); await h.selectSource(); await h.wait(() => expect(h.inputs().filter(item => item.dataset.inputSource === 'native')).toHaveLength(90))
  const pin = h.inputs()[0]!; await act(async () => pin.click()); const body = document.querySelector('[data-input-preview-id]')!
  const text = document.createTreeWalker(body, NodeFilter.SHOW_TEXT).nextNode()!; const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString(); expect(selected.length).toBeGreaterThan(0)
  const original = (await loadAgentSessions(h.store)).find(item => item.agentSessionId === 'archived-0'); expect(original).not.toBeNull()
  const path = join(h.directory, 'new-source.jsonl'); await writeFile(path, JSON.stringify({ sessionId: 'replacement-native', uuid: 'new-record', type: 'user', message: { role: 'user', content: 'Replacement actual body' }, timestamp: new Date(NOW - HOUR).toISOString() }) + '\n')
  await h.store.compareAndSwap(original!, { ...original!, updatedAt: NOW, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'replacement-native', transcriptPath: path } })
  await h.button('Read earlier records'); await h.wait(() => expect(document.querySelector('.recent-focus__input-error')?.textContent).toMatch(/source|cursor/i))
  expect(document.querySelector('[data-input-preview-id]')).toBe(body); expect(selection.toString()).toBe(selected)
  expect(h.inputs().map(item => item.textContent).join(' ')).not.toContain('Replacement actual body')
  await h.button('Refresh source'); await h.wait(() => expect(h.inputs().map(item => item.dataset.inputMessageId)).toEqual(['native:claude:replacement-native:new-record', 'captured:captured']))
  expect(h.inputs()[0]!.textContent).toContain('Replacement actual body'); h.noRuntime()
})

it('abandons a genuinely read but late old Context page after switching Context and never starts that Context next page', async () => {
  const h = await fixture(Array.from({ length: 130 }, (_, index) => ({ id: `old-${index}`, body: `Late original ${index}`, at: NOW - HOUR })), 2)
  const original = h.calls.page.getMockImplementation() ?? api.sessions.historyPage
  // Invoke the real registered IPC/Reader first; only transport delivery is delayed.
  const realPage = bridge.api!.sessions.historyPage.bind(bridge.api!.sessions)
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let actualRead = false
  h.calls.page.mockImplementation(async (reference, options) => { const result = await realPage(reference, options); if (reference.agentSessionId === 'archived-0') { actualRead = true; await gate }; return result })
  await h.render(); await h.selectSource(); await h.wait(() => expect(actualRead).toBe(true))
  await h.selectSource('archived-1'); await h.wait(() => expect(h.inputs().map(item => item.dataset.inputMessageId)).toEqual(['native:claude:native-archived-1:other-1']))
  await act(async () => { release(); await gate })
  await h.wait(() => expect(h.inputs().map(item => item.dataset.inputMessageId)).toEqual(['native:claude:native-archived-1:other-1']))
  expect(h.calls.page.mock.calls.map(call => call[0].agentSessionId)).toEqual(['archived-0', 'archived-1'])
  expect(h.markers().map(item => item.dataset.messageId)).toEqual(['captured:captured', 'native:claude:native-archived-1:other-1']); expect(original).not.toBeNull(); h.noRuntime()
})

it('stops new pages and discards a late actually-read page when hidden, preserving a usable Client', async () => {
  const h = await fixture(Array.from({ length: 130 }, (_, index) => ({ id: `hidden-${index}`, body: `Hidden body ${index}`, at: NOW - HOUR })))
  const realPage = bridge.api!.sessions.historyPage.bind(bridge.api!.sessions)
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); let actualRead = false
  h.calls.page.mockImplementation(async (reference, options) => { const result = await realPage(reference, options); actualRead = true; await gate; return result })
  await h.render(); await h.selectSource(); await h.wait(() => expect(actualRead).toBe(true))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => { release(); await gate })
  expect(h.calls.page.mock.calls).toHaveLength(1); expect(h.inputs()).toEqual([]); expect(h.markers()).toEqual([])
  expect((await h.client.sessionHistorySources()).map(source => source.agentSessionId)).toEqual(['archived-0'])
  h.noRuntime()
})
