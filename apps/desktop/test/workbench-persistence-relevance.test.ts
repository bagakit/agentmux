// @vitest-environment happy-dom
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig, BrowserSnapshot, SessionSnapshot } from '../src/shared/contracts.js'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs.js'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'

const storageName = 'agentmux-workbench-v1'
const workspaceId = 'persistence-workspace'
const sessionId = 'persistence-agent'
const runId = 'persistence-run'
const config: AppConfig = {
  version: 9,
  hosts: [{ id: 'local', kind: 'local', label: 'Private persistence fixture' }],
  executors: {},
  workspaces: [{ id: workspaceId, name: 'Private fixture', hostId: 'local', path: _hygiene_fixturePath("private/persistence"), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
const session: SessionSnapshot = {
  id: sessionId, kind: 'agent', providerId: 'codex', executorId: 'probe', hostId: 'local',
  workspacePath: _hygiene_fixturePath("private/persistence"), label: 'Private fixture', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
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
let spatial: AgentMuxSpatialStateStore
let spatialRoot: string
let spatialCommit: MockInstance
let spatialRead: MockInstance

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  spatialRoot = await mkdtemp(join(tmpdir(), 'workbench-persistence-'))
  spatial = new AgentMuxSpatialStateStore(join(spatialRoot, 'spatial.json'))
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
  store.setState({ sessions: [session] })
  api = (await import('../src/renderer/src/lib/api.js')).api
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  // Positions belong to the real Core owner. Local storage retains UI preferences
  // and drafts; it intentionally stops duplicating the workface after Core ACK.
  spatialRead = vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.readForLayout())
  spatialCommit = vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => spatial.retainDisplayLabels(values))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
})

afterEach(async () => {
  try {
    if (store.getState().config) await (await import('../src/renderer/src/store.js')).prepareRendererUpdate('quit')
  }
  finally {
    dispose?.()
    dispose = undefined
    vi.clearAllTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    await rm(spatialRoot, { recursive: true, force: true })
  }
})

async function initialize(): Promise<void> {
  dispose = await store.getState().initialize()
  expect(store.getState().loading).toBe(false)
  // Runtime observation is intentionally released after durable publication.
  await vi.waitFor(() => expect(store.getState().sessions.map(value => value.id)).toContain(sessionId))
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

async function savedWorkbench() {
  await (await import('../src/renderer/src/store.js')).prepareRendererUpdate()
  const saved = await spatial.readForLayout()
  expect(saved).not.toBeNull()
  return (await import('../src/renderer/src/lib/desktop-spatial-state.js')).desktopWorkbenchFromSpatial(saved!.graph)
}

describe('actual Store persistence relevance', () => {
  it.each([1, 32, 100])('reuses the local projection across real Browser events beside %i independent file Tabs', async count => {
    await initialize()
    const browser: BrowserSnapshot = {
      id: 'cost-browser', mode: 'normal', navigationId: 'cost-navigation', profileId: 'cost-profile',
      url: 'https://example.test/cost', title: 'Cost page', loading: false,
      canGoBack: false, canGoForward: false, viewport: 'desktop', error: null, driving: false, appLinkPrompt: null
    }
    const browserTab = createWorkbenchTab('cost-browser-tab', { ...browser, regionId: 'cost-browser-region', kind: 'browser', workspaceId, browserId: browser.id })
    const tabs = Object.fromEntries(Array.from({ length: count }, (_, index) => {
      const id = `independent-file-${index}`
      const tab = createWorkbenchTab(id, { regionId: `${id}-region`, kind: 'file', workspaceId,
        path: _hygiene_fixturePath(`private/persistence/${id}.txt`) })
      return [id, tab]
    }))
    tabs[browserTab.id] = browserTab
    store.setState({ tabs, layouts: { [workspaceId]: createWorkspaceLayout('cost-group', Object.keys(tabs)) } })
    store.getState().setAgentComposerDraft(sessionId, 'Private unsent content '.repeat(8192))
    await savedWorkbench()
    vi.advanceTimersByTime(400)
    const partialize = store.persist.getOptions().partialize!, before = partialize(store.getState())
    const durableBefore = backing.get(storageName)
    projection.mockClear()
    vi.mocked(localStorage.getItem).mockClear()
    writes.length = 0
    const stringify = vi.spyOn(JSON, 'stringify')
    for (let index = 0; index < 16; index += 1) {
      store.getState().applyBrowserEvent({ type: 'updated', browser: { ...browser, loading: index % 2 === 0,
        driving: true, canGoBack: index % 2 === 1 } })
      expect(partialize(store.getState())).toBe(before)
    }
    // The real Core subscription still observes spatial changes. This assertion
    // isolates the synchronous local UI projection, before its async ACK work.
    expect(projection).not.toHaveBeenCalled()
    expect(stringify.mock.calls.filter(([value]) => value && typeof value === 'object' && 'state' in value && 'version' in value)).toEqual([])
    expect(localStorage.getItem).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(backing.get(storageName)).toBe(durableBefore)
    expect(store.getState().tabs[browserTab.id]?.regions['cost-browser-region']).toMatchObject({ loading: false, driving: true, canGoBack: true })

    const current = store.getState()
    store.setState({ tabs: { ...current.tabs }, layouts: { ...current.layouts },
      projectGroups: [...current.projectGroups], spaceZoneBindings: { ...current.spaceZoneBindings } })
    expect(partialize(store.getState())).toBe(before)
    expect(projection).not.toHaveBeenCalled()
    stringify.mockRestore()
    // A genuine preference change rebuilds its own projection, but still must
    // not build the Core-owned workbench only to discard it afterwards.
    store.setState({ toolsOpen: !current.toolsOpen })
    expect(partialize(store.getState())).not.toBe(before)
    expect(projection).not.toHaveBeenCalled()
    const next = { ...browser, url: 'https://example.test/durable', title: 'Durable page' }
    store.getState().applyBrowserEvent({ type: 'updated', browser: next })
    const savedGraph = await savedWorkbench()
    expect(Object.keys(savedGraph.tabs)).toHaveLength(count + 1)
    expect(savedGraph.tabs[browserTab.id]?.regions['cost-browser-region']).toMatchObject({ url: next.url, title: next.title })
    expect(saved().state.agentComposerDrafts?.[sessionId]).toHaveLength('Private unsent content '.length * 8192)
    expect(saved().state.toolsOpen).toBe(!current.toolsOpen)
  })

  it('invalidates the projection in both Core readiness directions while keeping the entire unready handoff', async () => {
    const tab = agentTab('handoff-tab')
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('handoff-group', [tab.id]) } })
    const partialize = store.persist.getOptions().partialize!
    const unready = partialize(store.getState())
    expect(unready.restoredWorkbench?.tabs[tab.id]).toBeDefined()
    expect(unready).toHaveProperty('projectGroups')
    expect(unready).toHaveProperty('spaceZoneBindings')
    await initialize()
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('handoff-group', [tab.id]) } })
    const ready = partialize(store.getState())
    expect(ready).not.toHaveProperty('restoredWorkbench')
    expect(ready).not.toHaveProperty('projectGroups')
    expect(ready).not.toHaveProperty('spaceZoneBindings')
    const { DesktopSpatialPersistence } = await import('../src/renderer/src/lib/desktop-spatial-state.js')
    const readyGetter = vi.spyOn(DesktopSpatialPersistence.prototype, 'ready', 'get').mockReturnValue(false)
    const sameState = store.getState()
    try {
      const unreadyAgain = partialize(sameState)
      expect(unreadyAgain).not.toBe(ready)
      expect(unreadyAgain.restoredWorkbench?.tabs[tab.id]).toBeDefined()
      expect(unreadyAgain.projectGroups).toBe(sameState.projectGroups)
      expect(unreadyAgain.spaceZoneBindings).toBe(sameState.spaceZoneBindings)
    } finally { readyGetter.mockRestore() }
    expect(partialize(sameState)).not.toHaveProperty('restoredWorkbench')
  })

  it('keeps acknowledged names and unrelated name handoffs on their original durable owners', async () => {
    await initialize()
    const tab = agentTab('name-tab')
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('name-group', [tab.id]) },
      agentNames: { 'waiting-session': 'Unacknowledged handoff' } })
    await savedWorkbench()
    vi.spyOn(api.spatial, 'renameLabel').mockImplementation(input => spatial.mutateDisplayLabel(input,
      { actor: { kind: 'device', id: 'private-device', verified: true }, source: 'desktop-ui',
        entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-window' } }))
    expect(await store.getState().renameAgent(sessionId, 'Explicit name', 0)).toBe(true)
    vi.advanceTimersByTime(400)
    expect(saved().state.agentNames).toEqual({ 'waiting-session': 'Unacknowledged handoff' })
    expect(store.getState().agentNames[sessionId]).toBe('Explicit name')
    const { displayLabel } = await import('@agentmux/core/spatial-graph')
    expect(displayLabel((await spatial.readForLayout())!.graph, { kind: 'agent-session', id: sessionId })?.value).toBe('Explicit name')
    store.setState({ agentNames: { 'waiting-session': 'New handoff' } })
    vi.advanceTimersByTime(400)
    expect(saved().state.agentNames).toEqual({ 'waiting-session': 'New handoff' })
    await store.persist.rehydrate()
    expect(store.getState().agentNames['waiting-session']).toBe('New handoff')
  })

  it('encodes and rehydrates pending note input and attempts even when their document is not marked dirty', async () => {
    await initialize()
    const path = _hygiene_fixturePath('private/persistence/note.md'), key = `${workspaceId}\0${path}`
    const resource = { hostId: 'local', workspaceId, workspacePath: config.workspaces[0]!.path, path }
    const document = { path, revision: 'note-base', content: 'Current private note', noteEditing: {
      input: { baseContent: 'Original note', observedContent: 'Concurrent note', proposedContent: 'Unconsumed editor input', resource, phase: 'conflict' as const },
      attempt: { operationId: 'private-note-attempt', noteId: null, content: 'Unconfirmed write', expectedRevision: 'note-base',
        generation: 1, resource, phase: 'unknown' as const }
    } }
    store.setState({ documents: { [key]: document }, dirtyDocuments: {}, retainedDocumentDrafts: { [key]: [document] } })
    vi.advanceTimersByTime(400)
    expect(saved().state.documents?.[key]).toEqual(document)
    expect(saved().state.retainedDocumentDrafts?.[key]).toEqual([document])
    store.setState({ documents: {}, retainedDocumentDrafts: {} })
    await store.persist.rehydrate()
    expect(store.getState().documents[key]).toEqual(document)
    expect(store.getState().retainedDocumentDrafts[key]).toEqual([document])
  })

  it('consumes semantic events and external transient updates without projecting or encoding unrelated Tabs', async () => {
    await initialize()
    const tabs = Object.fromEntries(Array.from({ length: 64 }, (_, index) => {
      const tab = agentTab(`agent-tab-${index}`)
      return [tab.id, tab]
    }))
    store.setState({ tabs, layouts: { [workspaceId]: createWorkspaceLayout('fixture-group', Object.keys(tabs)) } })
    store.getState().setViewMode(sessionId, 'activity')
    vi.advanceTimersByTime(400)
    expect(Object.keys((await savedWorkbench()).tabs)).toHaveLength(64)
    expect(saved().state).not.toHaveProperty('restoredWorkbench')
    expect(saved().state.viewModes).toEqual({ [sessionId]: 'activity' })
    const before = backing.get(storageName)
    projection.mockClear()
    spatialCommit.mockClear()
    spatialRead.mockClear()
    const stringify = vi.spyOn(JSON, 'stringify')
    const read = vi.mocked(localStorage.getItem)
    read.mockClear()
    for (let index = 0; index < 200; index += 1) status(index + 2)
    for (let index = 0; index < 200; index += 1) store.setState({ startupProgress: { step: 'runtime' } })
    expect(store.getState().sessions[0]?.status.observedAt).toBe(201)
    expect(projection).not.toHaveBeenCalled()
    expect(spatialCommit).not.toHaveBeenCalled()
    expect(spatialRead).not.toHaveBeenCalled()
    // The Run service owner keys the exact changed Session once per event.
    // No Tab, layout or persisted state is encoded, and unrelated transient
    // updates add no work. Keep this bounded independently of the 64 Tabs.
    expect(stringify.mock.calls).toEqual(Array.from({ length: 200 }, () => [[
      session.hostId, session.control.hostId, sessionId, runId
    ]]))
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
    vi.advanceTimersByTime(400)
    await savedWorkbench()
    const original = store.getState(), modes = { [sessionId]: 'activity', [readerId]: 'terminal' }
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
    const path = _hygiene_fixturePath("private/persistence/edit.txt"), key = `${workspaceId}\0${path}`
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
      id: 'private-browser', mode: 'normal', navigationId: 'private-navigation', profileId: 'private-profile',
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
    expect((await savedWorkbench()).tabs[tab.id]?.regions['browser-region']).toEqual({
      regionId: 'browser-region', kind: 'browser', workspaceId, browserId: browser.id, profileId: browser.profileId, url: next.url, title: next.title
    })
    expect(store.getState().tabs[tab.id]?.regions['browser-region']).toMatchObject({ loading: false, driving: true })
  })

  it('admits real run removal without treating Runtime retirement as deletion of the durable workface', async () => {
    await initialize()
    const tab = agentTab()
    store.setState({ tabs: { [tab.id]: tab }, layouts: { [workspaceId]: createWorkspaceLayout('agent-group', [tab.id]) } })
    vi.advanceTimersByTime(400)
    expect(Object.keys((await savedWorkbench()).tabs)).toEqual([tab.id])
    store.getState().applyEvent({ type: 'core', hostId: 'local', event: {
      type: 'run-removed', agentSessionId: sessionId, run: { runId }, evidence: { source: 'run-process', observedAt: 2, run: { runId } }
    } })
    vi.advanceTimersByTime(400)
    expect(store.getState().sessions).toEqual([])
    expect(store.getState().tabs).toEqual({})
    // A Run event withdraws its live projection. Deleting the Core-owned entity
    // requires an explicit view close, rather than absence from a Runtime list.
    expect((await savedWorkbench()).tabs[tab.id]?.regions[`${tab.id}-region`]).toMatchObject({ sessionId })
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
    expect(Object.keys((await savedWorkbench()).tabs)).toEqual([tab.id])
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
    expect(Object.keys(saved().state.restoredWorkbench!.tabs)).toEqual([tab.id])
  })
})
