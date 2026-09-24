import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, BrowserSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'

const storageName = 'agentmux-workbench-v1'
const workspaceId = 'persistence-workspace'
const sessionId = 'persistence-agent'
const runId = 'persistence-run'
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'Private persistence fixture' }],
  executors: {},
  workspaces: [{ id: workspaceId, name: 'Private fixture', hostId: 'local', path: '/private/persistence', kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const session: SessionSnapshot = {
  id: sessionId, kind: 'agent', providerId: 'codex', executorId: 'probe', hostId: 'local',
  workspacePath: '/private/persistence', label: 'Private fixture', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
  processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 },
  latestOutputBytes: 0,
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
  control: { kind: 'agent', hostId: 'local', agentSessionId: sessionId, run: { runId } }
}

let store: typeof import('../src/renderer/src/store.js').useAppStore
let api: typeof import('../src/renderer/src/lib/api.js').api
let projection: MockInstance<typeof import('../src/renderer/src/lib/workbench-persistence.js').projectPersistedWorkbench>
let backing: Map<string, string>
let writes: Array<{ name: string; value: string; at: number }>
let localStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
let dispose: (() => void) | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  backing = new Map()
  writes = []
  localStorage = {
    getItem: vi.fn((name: string) => backing.get(name) ?? null),
    setItem: (name, value) => { backing.set(name, value); writes.push({ name, value, at: Date.now() }) },
    removeItem: (name) => { backing.delete(name) }
  }
  vi.stubGlobal('window', { localStorage, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const persistence = await import('../src/renderer/src/lib/workbench-persistence.js')
  projection = vi.spyOn(persistence, 'projectPersistedWorkbench')
  store = (await import('../src/renderer/src/store.js')).useAppStore
  api = (await import('../src/renderer/src/lib/api.js')).api
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function initialize(): Promise<void> {
  dispose = await store.getState().initialize()
  expect(store.getState().loading).toBe(false)
}

function agentTab(id = 'agent-tab') {
  return createWorkbenchTab(id, { regionId: `${id}-region`, kind: 'agent', phase: 'attached', workspaceId, sessionId })
}

function status(observedAt: number): void {
  store.getState().applyEvent({ type: 'core', hostId: 'local', event: {
    type: 'agent-status', agentSessionId: sessionId, state: 'working',
    evidence: { source: 'native-hook', observedAt, run: { runId } }
  } })
}

function saved() {
  const raw = backing.get(storageName)
  expect(raw).toBeTypeOf('string')
  return JSON.parse(raw!) as { state: ReturnType<NonNullable<ReturnType<typeof store.persist.getOptions>['partialize']>>; version: number }
}

describe('actual Store persistence relevance', () => {
  it('consumes semantic events and external transient updates without projecting or encoding unrelated Tabs', async () => {
    await initialize()
    const tabs = Object.fromEntries(Array.from({ length: 64 }, (_, index) => {
      const tab = agentTab(`agent-tab-${index}`)
      return [tab.id, tab]
    }))
    store.setState({ tabs, layouts: { [workspaceId]: createWorkspaceLayout('fixture-group', Object.keys(tabs)) } })
    store.getState().setViewMode(sessionId, 'activity')
    vi.advanceTimersByTime(400)
    expect(Object.keys(saved().state.restoredWorkbench.tabs)).toHaveLength(64)
    expect(saved().state.viewModes).toEqual({ [sessionId]: 'activity' })
    const before = backing.get(storageName)
    projection.mockClear()
    const stringify = vi.spyOn(JSON, 'stringify')
    const read = vi.mocked(localStorage.getItem)
    read.mockClear()
    for (let index = 0; index < 200; index += 1) status(index + 2)
    for (let index = 0; index < 200; index += 1) store.setState({ startupProgress: { step: 'runtime' } })
    expect(store.getState().sessions[0]?.status.observedAt).toBe(201)
    expect(projection).not.toHaveBeenCalled()
    expect(stringify).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(backing.get(storageName)).toBe(before)
  })

  it('persists explicit Session modes through the existing writer and real rehydrate without changing Runtime or diff ownership', async () => {
    await initialize()
    const tab = agentTab(), readerId = 'persistence-reader'
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('mode-group', [tab.id]) },
      viewModes: {}, editorRegionModes: { 'file-region': 'diff' } })
    vi.advanceTimersByTime(400)
    expect(store.getState().viewModes).toEqual({})
    store.getState().setViewMode(sessionId, 'activity')
    store.getState().setViewMode(readerId, 'terminal')
    const original = store.getState(), modes = { [sessionId]: 'activity', [readerId]: 'terminal' }
    vi.advanceTimersByTime(400)
    expect(saved().state.viewModes).toEqual(modes)
    expect(saved().state).not.toHaveProperty('sessions')
    expect(saved().state).not.toHaveProperty('editorRegionModes')
    store.setState({ viewModes: {} })
    await store.persist.rehydrate()
    expect(store.getState().viewModes).toEqual(modes)
    expect(store.getState().sessions).toBe(original.sessions)
    expect(store.getState().sessions[0]?.control).toBe(original.sessions[0]?.control)
    expect(store.getState().tabs).toBe(original.tabs)
    expect(store.getState().layouts).toBe(original.layouts)
    expect(store.getState().agentFocus).toEqual(original.agentFocus)
    expect(store.getState().editorRegionModes).toBe(original.editorRegionModes)
    store.setState({ startupProgress: { step: 'runtime' } })
    vi.advanceTimersByTime(400)
    expect(saved().state.viewModes).toEqual(modes)
  })

  it('saves a real composer draft by its deadline while accepted Agent events continue', async () => {
    await initialize()
    vi.advanceTimersByTime(400)
    writes.length = 0
    const start = Date.now()
    store.getState().setAgentComposerDraft(sessionId, 'New unsent draft')
    for (let index = 0; index < 20; index += 1) {
      vi.advanceTimersByTime(100)
      status(index + 2)
    }
    expect(store.getState().sessions[0]?.status.observedAt).toBe(21)
    expect(writes.map(({ at }) => at - start)).toEqual([400])
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'New unsent draft' })
  })

  it('persists actual dirty document edits and stops saving the buffer when it becomes clean', async () => {
    await initialize()
    const path = '/private/persistence/edit.txt', key = `${workspaceId}\0${path}`
    const tab = createWorkbenchTab('file-tab', { regionId: 'file-region', kind: 'file', workspaceId, path })
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('file-group', [tab.id]) },
      documents: { [key]: { path, content: 'Clean content', revision: 'base-revision' } }, dirtyDocuments: {} })
    vi.advanceTimersByTime(400)
    expect(saved().state.documents).toEqual({})
    store.getState().updateDocument(tab.id, 'First unsaved content')
    vi.advanceTimersByTime(400)
    expect(saved().state.documents).toEqual({ [key]: { path, content: 'First unsaved content', revision: 'base-revision' } })
    expect(saved().state.dirtyDocuments).toEqual({ [key]: true })
    store.getState().updateDocument(tab.id, 'Newest unsaved content')
    vi.advanceTimersByTime(400)
    expect(saved().state.documents?.[key]?.content).toBe('Newest unsaved content')
    store.setState({ dirtyDocuments: { [key]: false } })
    vi.advanceTimersByTime(400)
    expect(saved().state.documents).toEqual({})
    expect(saved().state.dirtyDocuments).toEqual({})
  })

  it('preserves Browser URL/title and layout edits while transient Browser snapshots keep arriving', async () => {
    await initialize()
    const browser: BrowserSnapshot = {
      id: 'private-browser', navigationId: 'private-navigation', profileId: 'private-profile',
      url: 'https://example.test/first', title: 'First page', loading: false, canGoBack: false, canGoForward: false,
      viewport: 'desktop', error: null, driving: false, appLinkPrompt: null
    }
    const tab = createWorkbenchTab('browser-tab', { ...browser, regionId: 'browser-region', kind: 'browser', workspaceId, browserId: browser.id })
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('browser-group', [tab.id]) } })
    vi.advanceTimersByTime(400)
    writes.length = 0
    const start = Date.now()
    const next = { ...browser, url: 'https://example.test/next', title: 'Next page' }
    store.getState().applyBrowserEvent({ type: 'updated', browser: next })
    store.setState({ toolsOpen: false })
    for (let index = 0; index < 20; index += 1) {
      vi.advanceTimersByTime(100)
      store.getState().applyBrowserEvent({ type: 'updated', browser: { ...next, loading: index % 2 === 0,
        driving: true, appLinkPrompt: { url: 'generic-app://private-fixture', scheme: 'generic-app' } } })
    }
    expect(writes.map(({ at }) => at - start)).toEqual([400])
    expect(saved().state.toolsOpen).toBe(false)
    expect(saved().state.restoredWorkbench.tabs[tab.id]?.regions['browser-region']).toEqual({
      regionId: 'browser-region', kind: 'browser', workspaceId, browserId: browser.id, url: next.url, title: next.title
    })
    expect(store.getState().tabs[tab.id]?.regions['browser-region']).toMatchObject({ loading: false, driving: true })
  })

  it('admits a real run-removal topology change through the semantic event path', async () => {
    await initialize()
    const tab = agentTab()
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('agent-group', [tab.id]) } })
    vi.advanceTimersByTime(400)
    expect(Object.keys(saved().state.restoredWorkbench.tabs)).toEqual([tab.id])
    store.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'run-removed', agentSessionId: sessionId, run: { runId }, evidence: { source: 'run-process', observedAt: 2, run: { runId } }
    } })
    vi.advanceTimersByTime(400)
    expect(store.getState().sessions).toEqual([])
    expect(saved().state.restoredWorkbench.tabs).toEqual({})
  })

  it('never queues startup defaults and explicitly saves the restored shell after opening the fence', async () => {
    const tab = agentTab('restored-agent-tab')
    const seed = { version: 1, state: { agentComposerDrafts: { [sessionId]: 'Saved user draft' },
      restoredWorkbench: { tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('restored-group', [tab.id]) } } } }
    backing.set(storageName, JSON.stringify(seed))
    store.setState({ error: 'Transient startup notice' })
    vi.advanceTimersByTime(400)
    expect(writes).toEqual([])
    expect(backing.get(storageName)).toBe(JSON.stringify(seed))
    await initialize()
    vi.advanceTimersByTime(400)
    expect(writes).toHaveLength(1)
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'Saved user draft' })
    expect(Object.keys(saved().state.restoredWorkbench.tabs)).toEqual([tab.id])
  })

  it('keeps the fence closed after failed hydration and preserves the unread durable record', async () => {
    backing.set(storageName, '{unreadable durable record')
    await initialize()
    store.getState().setAgentComposerDraft(sessionId, 'Still usable in memory')
    vi.advanceTimersByTime(800)
    expect(store.getState().error).toContain('Saved workspace state could not be restored')
    expect(store.getState().agentComposerDrafts[sessionId]).toBe('Still usable in memory')
    expect(writes).toEqual([])
    expect(backing.get(storageName)).toBe('{unreadable durable record')
  })

  it('public clearStorage allows the same projected state to be saved again', async () => {
    await initialize()
    store.getState().setAgentComposerDraft(sessionId, 'User draft survives an intentional fresh save')
    vi.advanceTimersByTime(400)
    expect(saved().state.agentComposerDrafts?.[sessionId]).toBe('User draft survives an intentional fresh save')
    store.persist.clearStorage()
    expect(backing.has(storageName)).toBe(false)
    store.setState({ startupProgress: { step: 'runtime' } })
    vi.advanceTimersByTime(400)
    expect(saved().state.agentComposerDrafts?.[sessionId]).toBe('User draft survives an intentional fresh save')
  })

  it('public rehydrate rereads a new durable record after the writer has settled', async () => {
    await initialize()
    vi.advanceTimersByTime(400)
    const durable = saved()
    durable.state.agentComposerDrafts = { [sessionId]: 'Externally restored draft' }
    backing.set(storageName, JSON.stringify(durable))
    await store.persist.rehydrate()
    expect(store.getState().agentComposerDrafts).toEqual({ [sessionId]: 'Externally restored draft' })
    store.setState({ startupProgress: { step: 'runtime' } })
    vi.advanceTimersByTime(400)
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'Externally restored draft' })
  })

  it('admits the visible restored shell after a non-hydration startup failure', async () => {
    const tab = agentTab('offline-agent-tab')
    backing.set(storageName, JSON.stringify({ version: 1, state: {
      agentComposerDrafts: { [sessionId]: 'Offline saved draft' }, restoredWorkbench: {
        tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('offline-group', [tab.id]) }
      }
    } }))
    vi.spyOn(api.config, 'get').mockRejectedValue(new Error('Private config endpoint unavailable'))
    await initialize()
    expect(store.getState().error).toContain('Private config endpoint unavailable')
    expect(Object.keys(store.getState().tabs)).toEqual([tab.id])
    store.getState().setAgentComposerDraft(sessionId, 'Intentional draft edit while offline')
    vi.advanceTimersByTime(400)
    expect(saved().state.agentComposerDrafts).toEqual({ [sessionId]: 'Intentional draft edit while offline' })
    expect(Object.keys(saved().state.restoredWorkbench.tabs)).toEqual([tab.id])
  })
})
