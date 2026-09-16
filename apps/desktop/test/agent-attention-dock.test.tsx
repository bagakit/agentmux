// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { AgentDisplayState } from '@agentmux/core'
import type { RuntimeController } from '../src/main/runtime-controller'
import type { ConfigStore } from '../src/main/config-store'
import type { ScratchTopics } from '../src/main/scratch-topics'
import type { WorkspaceFiles } from '../src/main/workspace-files'
import type { SessionSnapshot } from '../src/shared/contracts'

// The canonical test config defaults to a web preview. This test exercises the
// actual preload/registered Main path, so choose Desktop before api.ts is loaded.
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', false))

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown>(),
  listeners: new Map<string, Set<(...values: unknown[]) => void>>(),
  invokes: [] as Array<{ channel: string; values: unknown[] }>,
  sender: { id: 1, isDestroyed: () => false, send: vi.fn(), session: { flushStorageData: vi.fn() } },
  labels: [] as string[], rejectDock: 0,
  beforeBadge: undefined as Promise<void> | undefined,
  dock: { setBadge: vi.fn(function (this: unknown, label: string) {
    if (this !== fixture.dock) throw new TypeError('Native Dock receiver was detached')
    if (fixture.rejectDock > 0) { fixture.rejectDock -= 1; throw new Error('Private Dock setter failed') }
    fixture.labels.push(label)
  }) }
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/isolated-dock-test', dock: fixture.dock },
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => Object.assign(window, { [key]: value }) },
  webFrame: { getZoomFactor: () => 1 },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown) => fixture.handlers.set(channel, handler),
    removeHandler: (channel: string) => fixture.handlers.delete(channel), on: vi.fn(), removeListener: vi.fn()
  },
  ipcRenderer: {
    async invoke(channel: string, ...values: unknown[]) {
      fixture.invokes.push({ channel, values })
      if (channel === 'ui:setAgentAttentionCount') await fixture.beforeBadge
      const handler = fixture.handlers.get(channel)
      if (!handler) throw new Error(`No registered Main handler: ${channel}`)
      return await handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, ...values)
    },
    on(channel: string, listener: (...values: unknown[]) => void) {
      const listeners = fixture.listeners.get(channel) ?? new Set()
      listeners.add(listener); fixture.listeners.set(channel, listeners)
    },
    off: (channel: string, listener: (...values: unknown[]) => void) => fixture.listeners.get(channel)?.delete(listener),
    send: vi.fn()
  },
  clipboard: {}, dialog: {}, nativeImage: {}, shell: {}
}))
vi.mock('@agentmux/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@agentmux/core')>(),
  AgentMuxControlServer: class { async start() {} async stop() {} }
}))
// Only native/unrelated owners are isolated. App, Store, rollup, preload and registered Main run.
vi.mock('@agentmux/demand', () => ({ openDemandStore: () => ({ list: async () => [] }) }))
vi.mock('../src/main/browser-profile-manager', () => ({ BrowserProfileManager: class { async initialize() {} async dispose() {} } }))
vi.mock('../src/main/browser-operation-journal', () => ({ BROWSER_OPERATION_JOURNAL_FILE: 'isolated-journal.json',
  BrowserOperationFileStore: class {}, BrowserOperationJournal: class { async ready() {} } }))
vi.mock('../src/main/browser-ref-ledger-store', () => ({ BrowserRefLedgerStore: class {} }))
vi.mock('../src/main/browser-view-manager', () => ({ BrowserViewManager: class { dispose() {} } }))
vi.mock('../src/main/agent-notifier', () => ({ createAgentNotifier: () => ({ notify: () => ({ status: 'shown', presentation: 'as-requested' }), dispose() {} }) }))
vi.mock('../src/renderer/src/components/TerminalView.js', () => ({ TerminalView: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceWorkbench', () => ({ WorkspaceWorkbench: () => null }))
vi.mock('../src/renderer/src/components/SurfaceToolDock', () => ({ SurfaceToolDock: () => null }))

// Real desktop API must be exposed before api.ts chooses its existing platform binding.
import '../src/preload/index'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { AGENT_DISPLAY_STATES } from '../src/renderer/src/lib/attention-vocabulary'
import { registerIpc } from '../src/main/ipc'
import { DEFAULT_CONFIG } from '../src/main/config-store'

const initial = useAppStore.getState(), originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let mounted: { root: Root; element: HTMLDivElement } | undefined
let dispose: (() => Promise<void>) | undefined
let sessions: SessionSnapshot[]
const submit = vi.fn()
function agent(id: string, state: AgentDisplayState): SessionSnapshot {
  return { id, kind: 'agent', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: '/repo',
    label: id, createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running',
    status: { state, source: 'native-hook', observedAt: Date.now() },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } } }
}
function terminal(): SessionSnapshot {
  return { id: 'terminal', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: '/repo', label: 'terminal',
    createdAt: 1, updatedAt: 1, latestOutputBytes: 0, processState: 'running',
    status: { state: 'waiting', source: 'run-process', observedAt: Date.now() },
    control: { kind: 'terminal', hostId: 'local', runId: 'terminal-run', run: { runId: 'terminal-run' } } }
}
const badgeRequests = () => fixture.invokes.filter(value => value.channel === 'ui:setAgentAttentionCount').map(value => value.values)
async function settle() { await act(async () => { await new Promise(done => setTimeout(done, 0)) }) }
async function mountApp() {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element); mounted = { root, element }
  await act(async () => { root.render(<App />) })
  for (let n = 0; n < 30 && useAppStore.getState().loading; n += 1) await settle()
  expect(useAppStore.getState().loading).toBe(false)
  expect(element.querySelector('main.main-shell')).not.toBeNull()
  await settle()
  return element
}
async function update(next: SessionSnapshot[]) {
  await act(async () => { useAppStore.setState({ sessions: next }) })
  await settle()
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' })
  fixture.handlers.clear(); fixture.listeners.clear(); fixture.invokes.length = 0; fixture.labels.length = 0
  fixture.rejectDock = 0; fixture.beforeBadge = undefined; fixture.dock.setBadge.mockClear(); submit.mockReset().mockResolvedValue(undefined)
  sessions = [agent('waiting', 'waiting'), agent('blocked', 'blocked'), agent('healthy', 'working'), terminal()]
  useAppStore.setState({ ...initial, loading: true, agentComposerDrafts: { healthy: 'Keep my draft' } }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  const runtime = { resourceSampler: { setObservationSources: () => () => {} },
    setTerminalViewColors: () => {}, prepare: async () => ({}), commit: () => {}, attach: () => () => {},
    providerCatalog: () => [], snapshot: async () => ({ sessions, timelines: {}, recoveryCandidates: [] }), submitPrompt: submit
  } as unknown as RuntimeController
  dispose = await registerIpc({ window: { webContents: fixture.sender } as unknown as BrowserWindow, runtime,
    configStore: { get: async () => ({ ...structuredClone(DEFAULT_CONFIG), notifications: { mode: 'off' } }) } as unknown as ConfigStore,
    scratchTopics: { listTopics: async () => [] } as unknown as ScratchTopics,
    workspaceFiles: { dispose: async () => {} } as unknown as WorkspaceFiles })
  expect(fixture.handlers.has('ui:setAgentAttentionCount')).toBe(true)
})
afterEach(async () => {
  if (mounted) { await act(async () => mounted!.root.unmount()); mounted.element.remove(); mounted = undefined }
  await dispose?.(); dispose = undefined
  useAppStore.setState(initial, true); vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', originalPlatform)
})

it('projects the actual App collection through real preload and registered Main for 2 -> 1 -> 0', async () => {
  const element = await mountApp()
  expect(useAppStore.getState().sessions.map(value => value.id)).toEqual(['waiting', 'blocked', 'healthy', 'terminal'])
  expect(fixture.labels).toEqual(['', '2'])
  expect(badgeRequests()).toEqual([[0], [2]])
  expect(element.querySelector('[data-attention="needs-you"] .agent-status-bar__count')?.textContent).toBe('2')
  await update([agent('waiting', 'working'), agent('blocked', 'blocked'), agent('healthy', 'working'), terminal()])
  expect(fixture.labels).toEqual(['', '2', '1'])
  expect(element.querySelector('[data-attention="needs-you"] .agent-status-bar__count')?.textContent).toBe('1')
  await update([agent('waiting', 'done'), agent('blocked', 'working'), agent('healthy', 'error'), terminal()])
  expect(fixture.labels).toEqual(['', '2', '1', ''])
  expect(badgeRequests()).toEqual([[0], [2], [1], [0]])
  expect(element.querySelector('[data-attention="needs-you"] .agent-status-bar__count')?.textContent).toBe('0')
})

it('uses the shared whole state vocabulary and publishes neither unchanged counts nor unrelated writes', async () => {
  sessions = [...AGENT_DISPLAY_STATES.map(state => agent(state, state)), terminal()]
  await mountApp()
  expect(useAppStore.getState().sessions.map(value => value.id)).toEqual([...AGENT_DISPLAY_STATES, 'terminal'])
  expect(fixture.labels).toEqual(['', '2'])
  const published = badgeRequests()
  await act(async () => { useAppStore.getState().setAgentComposerDraft('healthy', 'A changed draft') })
  await update([...sessions])
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
  await settle()
  expect(badgeRequests()).toEqual(published)
  expect(fixture.labels).toEqual(['', '2'])
})

it('reports a native setter failure without changing healthy status or drafts and retries the same count later', async () => {
  const element = await mountApp(), before = useAppStore.getState()
  fixture.rejectDock = 1
  const waiting = [agent('waiting', 'working'), agent('blocked', 'blocked'), before.sessions.find(value => value.id === 'healthy')!, terminal()]
  await update(waiting)
  expect(fixture.labels).toEqual(['', '2'])
  expect(element.querySelector('.error-notice')?.textContent).toContain('Updating the Dock badge did not complete')
  expect(element.querySelector('.error-notice')?.getAttribute('aria-live')).toBe('polite')
  expect(useAppStore.getState().sessions).toBe(waiting)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  await act(async () => {
    expect(useAppStore.getState().send('healthy', 'Explicit healthy prompt')).toBe(true)
    await useAppStore.getState().flushAgentSteerQueue('healthy')
  })
  expect(submit).toHaveBeenCalledWith(waiting[2]!.control, 'Explicit healthy prompt', expect.any(String), undefined, undefined, undefined)
  await update([...waiting])
  expect(fixture.labels).toEqual(['', '2', '1'])
  expect(badgeRequests()).toEqual([[0], [2], [1], [1]])
})

it('coalesces related changes during pending IPC from the current Store and disposes the actual subscriber and handler', async () => {
  await mountApp()
  let release!: () => void
  fixture.beforeBadge = new Promise<void>(done => { release = done })
  await update([agent('waiting', 'working'), agent('blocked', 'blocked'), agent('healthy', 'working'), terminal()])
  await update([agent('waiting', 'working'), agent('blocked', 'working'), agent('healthy', 'working'), terminal()])
  expect(badgeRequests()).toEqual([[0], [2], [1]])
  fixture.beforeBadge = undefined
  await act(async () => { release() }); await settle()
  expect(badgeRequests()).toEqual([[0], [2], [1], [0]])
  expect(fixture.labels).toEqual(['', '2', '1', ''])
  const requests = badgeRequests()
  await act(async () => { mounted!.root.unmount() }); mounted!.element.remove(); mounted = undefined
  await update(sessions)
  expect(badgeRequests()).toEqual(requests)
  await dispose?.(); dispose = undefined
  expect(fixture.handlers.has('ui:setAgentAttentionCount')).toBe(false)
})

it('ignores an in-flight failure after the actual App owner unmounts', async () => {
  await mountApp()
  let release!: () => void
  fixture.beforeBadge = new Promise<void>(done => { release = done })
  await update([agent('waiting', 'working'), agent('blocked', 'blocked'), agent('healthy', 'working'), terminal()])
  expect(badgeRequests()).toEqual([[0], [2], [1]])
  await act(async () => { mounted!.root.unmount() }); mounted!.element.remove(); mounted = undefined
  fixture.beforeBadge = undefined; fixture.rejectDock = 1
  await act(async () => { release() }); await settle()
  expect(useAppStore.getState().error).toBeNull()
  expect(fixture.labels).toEqual(['', '2'])
  await update(sessions)
  expect(badgeRequests()).toEqual([[0], [2], [1]])
})

it('skips a platform without Dock explicitly and keeps its native receiver untouched', async () => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' })
  const handler = fixture.handlers.get('ui:setAgentAttentionCount')!
  expect(await handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, 2)).toBe(false)
  await mountApp()
  expect(badgeRequests()).toEqual([[0], [2]])
  expect(fixture.dock.setBadge).not.toHaveBeenCalled()
  expect(fixture.labels).toEqual([])
  expect(useAppStore.getState().error).toBeNull()
})

it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2'])('rejects malformed count %j before a native side effect', async count => {
  const handler = fixture.handlers.get('ui:setAgentAttentionCount')!
  expect(() => handler({ sender: fixture.sender } as unknown as IpcMainInvokeEvent, count)).toThrow('nonnegative safe integer')
  expect(fixture.dock.setBadge).not.toHaveBeenCalled()
})

it('rejects another sender before validating its number or reaching the native Dock', () => {
  const handler = fixture.handlers.get('ui:setAgentAttentionCount')!
  expect(() => handler({ sender: { ...fixture.sender, id: 2 } } as unknown as IpcMainInvokeEvent, 2)).toThrow('Untrusted Dock badge sender')
  expect(fixture.dock.setBadge).not.toHaveBeenCalled()
})
