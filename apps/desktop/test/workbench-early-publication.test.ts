import { fixtureEpoch as _reshape_fixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { ProviderCatalogObservation, RuntimeEvent, RuntimeSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { projectPersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'

const initial = useAppStore.getState()
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanups.splice(0).reverse()) await dispose()
  useAppStore.setState(initial, true); vi.restoreAllMocks()
})
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }

async function privateSpatialOwner(tabs: ReturnType<typeof createWorkbenchTab>[]) {
  const directory = await mkdtemp(join(tmpdir(), 'amx-workface-owner-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json'))
  const arranged = { ...initial, config: composerConfig, tabs: Object.fromEntries(tabs.map(tab => [tab.id, tab])),
    layouts: { workspace: createWorkspaceLayout('original-group', tabs.map(tab => tab.id)) } }
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(arranged, []) })
  useAppStore.setState({ ...initial, loading: true }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], recoveryCandidates: [], timelines: {} })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  return { owner, arranged }
}

it.each(['failed', 'absent'] as const)('retains the only preference workface while the first Core document is %s and handoff is unconfirmed', async kind => {
  const tab = createWorkbenchTab('saved-pending-tab', { kind: 'terminal', phase: 'launching', regionId: 'saved-pending-region', workspaceId: 'workspace', sessionId: 'unconfirmed-slot' })
  const { owner, arranged } = await privateSpatialOwner([tab])
  useAppStore.setState({ restoredWorkbench: projectPersistedWorkbench(arranged) })
  if (kind === 'failed') vi.mocked(api.spatial.read).mockRejectedValue(new Error('Private storage read is unavailable'))
  else vi.mocked(api.spatial.read).mockResolvedValue(null)
  const committing = deferred<Awaited<ReturnType<typeof api.spatial.commit>>>()
  vi.mocked(api.spatial.commit).mockReturnValue(committing.promise)
  const initialization = useAppStore.getState().initialize()
  await vi.waitFor(() => expect(useAppStore.getState().loading).toBe(false))
  useAppStore.getState().setAgentComposerDraft('original-session', 'New draft while handoff is unknown')
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(saved).toMatchObject({ restoredWorkbench: projectPersistedWorkbench(arranged), agentComposerDrafts: { 'original-session': 'New draft while handoff is unknown' } })
  if (kind === 'failed') expect(api.spatial.commit).not.toHaveBeenCalled()
  else committing.resolve((await owner.read())!)
  cleanups.push(await initialization)
})

it.each(['inspect', 'resource-observation'] as const)('does not publish a late Notes %s failure after its exact consumer was disposed', async kind => {
  const path = 'original.note.json'
  const tab = createWorkbenchTab('original-note-tab', { kind: 'file', regionId: 'original-note-region', workspaceId: 'workspace', path })
  await privateSpatialOwner([tab])
  const originalNotes = await api.notesStorage.inspect(), pending = deferred<typeof originalNotes>()
  let onNotes!: (snapshot: typeof originalNotes) => void
  vi.spyOn(api.notesStorage, 'onChange').mockImplementation(listener => { onNotes = listener; return () => {} })
  vi.spyOn(api.notesStorage, 'inspect').mockReturnValue(kind === 'inspect' ? pending.promise : Promise.resolve(originalNotes))
  const observation = deferred<Awaited<ReturnType<typeof api.files.observe>>>()
  const observe = vi.spyOn(api.files, 'observe').mockReturnValue(observation.promise)
  vi.spyOn(api.files, 'unobserve').mockResolvedValue(undefined)
  const dispose = await useAppStore.getState().initialize()
  if (kind === 'resource-observation') {
    const from = { hostId: 'local', workspaceId: 'workspace', workspacePath: composerConfig.workspaces[0]!.path, path }
    onNotes({ ...originalNotes, resourceChanges: [{ noteId: 'original-note', from, to: { ...from, path: 'moved.note.json' } }], directoryChanges: [] })
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())
  }
  dispose()
  useAppStore.setState({ error: null, lastError: null, errorNoticeContext: null })
  const report = vi.spyOn(useAppStore.getState(), 'reportError')
  if (kind === 'inspect') pending.reject(new Error('Late original Notes reader ended'))
  else observation.reject(new Error('Late original Note file reader ended'))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(report).not.toHaveBeenCalled()
  expect(useAppStore.getState().errorNoticeContext).toBeNull()
})

it('merges only unchanged Goals from a late filesystem read while preserving a newly edited or created Goal', async () => {
  await privateSpatialOwner([])
  const goals = deferred<Awaited<ReturnType<typeof api.demands.list>>>()
  vi.mocked(api.demands.list).mockReturnValue(goals.promise)
  const original = { id: 'original-goal', title: 'Old title', description: '', status: 'backlog' as const, priority: 'normal' as const,
    projectId: null, projectName: null, sessionIds: [], createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), source: 'default-topic' as const }
  useAppStore.setState({ demands: { [original.id]: original } })
  cleanups.push(await useAppStore.getState().initialize())
  const edited = { ...original, title: 'Current user title', updatedAt: _reshape_fixtureEpoch(0, 0, 2) }, created = { ...original, id: 'new-goal', title: 'Current new Goal' }
  useAppStore.setState({ demands: { [edited.id]: edited, [created.id]: created } })
  const filesystem = (id: string) => ({ id, title: 'Earlier filesystem title', description: '', status: 'backlog' as const, priority: 'normal' as const,
    projectId: null, projectName: null, assigneeSessionIds: [], supervisorSessionId: null, participations: [], tags: [], plannedStartAt: null,
    targetAt: null, parentDemandId: null, createdAt: _reshape_fixtureEpoch(0, 0, 1), updatedAt: _reshape_fixtureEpoch(0, 0, 1), phaseIndex: 0, activities: [], decisions: [], sessionIds: [], executorId: null })
  goals.resolve([filesystem(original.id), filesystem(created.id), filesystem('observed-neighbor')])
  await vi.waitFor(() => expect(useAppStore.getState().demands['observed-neighbor']).toBeDefined())
  expect(useAppStore.getState().demands[edited.id]).toBe(edited)
  expect(useAppStore.getState().demands[created.id]).toBe(created)
})

it('publishes original Core workfaces while Native/catalog/demand/notes readers wait and preserves later focus, draft and input intent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-workface-publication-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json'))
  const tab = createWorkbenchTab('original-pending-tab', { kind: 'terminal', phase: 'launching', regionId: 'original-pending-region',
    workspaceId: 'workspace', sessionId: 'original-unconfirmed-slot' })
  const neighbor = createWorkbenchTab('original-agent-tab', { kind: 'agent', phase: 'attached', regionId: 'original-agent-region',
    workspaceId: 'workspace', sessionId: 'original-session' })
  const tabs = { [tab.id]: tab, [neighbor.id]: neighbor }, layouts = { workspace: createWorkspaceLayout('original-group', [tab.id, neighbor.id]) }
  const session = composerSession('original-session')
  const intent = { operationId: 'original-input-operation', text: 'Private pending body', runId: session.control.run.runId,
    promptCondition: null, status: 'deferred' as const, errorCode: 'ORIGINAL_ACK_UNKNOWN', error: 'Original ACK unconfirmed.', execution: 'default' as const,
    preparationWait: { reason: 'native-busy' as const, state: 'waiting' as const, attempt: 1, maxAttempts: 3 as const, nextAttemptAt: _reshape_fixtureEpoch(0, 0, 1) } }
  const arranged = { ...initial, config: composerConfig, tabs, layouts, sessions: [session] }
  await spatial.commit({ expectedRevision: 0, graph: desktopSpatialGraph(arranged, []) })
  useAppStore.setState({ ...initial, loading: true, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    agentComposerDrafts: { 'original-session': 'Private original draft' }, agentSteerQueues: { 'original-session': [intent] } }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(async () => (await spatial.read())!)
  const runtime = deferred<RuntimeSnapshot>(), catalog = deferred<ProviderCatalogObservation>(),
    demands = deferred<Awaited<ReturnType<typeof api.demands.list>>>(), notes = deferred<Awaited<ReturnType<typeof api.notesStorage.inspect>>>()
  const originalNotes = await api.notesStorage.inspect()
  let event!: (value: RuntimeEvent) => void
  vi.spyOn(api.sessions, 'onEvent').mockImplementation(listener => { event = listener; return () => {} })
  vi.spyOn(api.sessions, 'snapshot').mockReturnValue(runtime.promise)
  vi.spyOn(api.providers, 'list').mockImplementation((() => catalog.promise) as unknown as typeof api.providers.list)
  vi.spyOn(api.demands, 'list').mockReturnValue(demands.promise)
  vi.spyOn(api.notesStorage, 'inspect').mockReturnValue(notes.promise)
  const start = vi.spyOn(api.sessions, 'launchTerminal'), recover = vi.spyOn(api.sessions, 'recover'), submit = vi.spyOn(api.sessions, 'submitPrompt')
  const initialization = useAppStore.getState().initialize()
  cleanups.push(async () => { runtime.resolve({ sessions: [session], recoveryCandidates: [], timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [] } } }); catalog.resolve({ catalog: [], warnings: [] }); demands.resolve([]); notes.resolve(originalNotes); (await initialization)() })
  const published = await Promise.race([initialization.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))])
  expect(published, 'only durable workface/config may hold first publication').toBe(true)
  expect(useAppStore.getState().loading).toBe(false)
  expect(Object.keys(useAppStore.getState().tabs).sort()).toEqual(Object.keys(tabs).sort())
  expect(useAppStore.getState().layouts).toEqual(layouts)
  expect(useAppStore.getState().tabs[tab.id]!.regions['original-pending-region']).toMatchObject({ phase: 'launching', sessionId: 'original-unconfirmed-slot' })
  const { preparationWait: _oldTimer, ...originalIntent } = intent
  expect(useAppStore.getState().agentSteerQueues['original-session']).toEqual([{ ...originalIntent, awaitingExplicitSend: true }])
  useAppStore.getState().focusRegion('workspace', neighbor.id, 'original-agent-region', 'pointer', 'original-group')
  useAppStore.getState().setAgentComposerDraft('original-session', 'Private newly edited draft')
  const currentLayout = useAppStore.getState().layouts
  event({ type: 'core', hostId: 'local', event: { type: 'connection-state', state: 'retrying',
    observationOrigin: { kind: 'runtime-connection', boundary: 'core-ctxmux' }, evidence: { source: 'agentmux', observedAt: _reshape_fixtureEpoch(0, 0, 1) } } })
  runtime.resolve({ sessions: [session], recoveryCandidates: [], timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [] } } })
  catalog.resolve(await providerCatalogReader()({ observation: true }))
  demands.resolve([]); notes.resolve(originalNotes)
  await vi.waitFor(() => expect(useAppStore.getState().sessions.some(value => value.id === session.id)).toBe(true))
  expect(useAppStore.getState().layouts).toEqual(currentLayout)
  expect(useAppStore.getState().agentComposerDrafts['original-session']).toBe('Private newly edited draft')
  expect(useAppStore.getState().agentSteerQueues['original-session']).toEqual([{ ...originalIntent, awaitingExplicitSend: true }])
  expect(start).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled()
})

it('an unrelated name ACK before startup retention cannot erase the only durable alias or block saving a new draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amx-workface-label-handoff-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json'))
  const tab = createWorkbenchTab('original-name-tab', { kind: 'agent', phase: 'attached', regionId: 'original-name-region',
    workspaceId: 'workspace', sessionId: 'original-session' })
  const session = composerSession('original-session')
  const arranged = { ...initial, config: composerConfig, tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('original-name-group', [tab.id]) }, sessions: [session] }
  await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(arranged, []) })
  useAppStore.setState({ ...initial, loading: true, agentNames: { 'original-session': 'Original name', 'waiting-session': 'Unacknowledged original alias' } }, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], recoveryCandidates: [], timelines: {} })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.spatial, 'renameLabel').mockImplementation(input => owner.mutateDisplayLabel(input,
    { actor: { kind: 'device', id: 'private-device', verified: true }, source: 'desktop-ui',
      entryPoint: 'spatial:renameLabel', transport: 'electron-ipc', location: { windowId: 'private-window' } }))
  const release = deferred<void>()
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(async values => { await release.promise; return await owner.retainDisplayLabels(values) })
  const initialization = useAppStore.getState().initialize()
  cleanups.push(async () => { release.resolve(); (await initialization)(); await useAppStore.getState().retryWorkbenchSave() })
  await vi.waitFor(() => expect(useAppStore.getState().loading).toBe(false))
  const renamed = await useAppStore.getState().renameAgent('original-session', 'New explicit name', 0)
  expect(renamed, JSON.stringify(useAppStore.getState().nameEditFailure)).toBe(true)
  useAppStore.getState().setAgentComposerDraft('original-session', 'New private unsent draft')
  const current = useAppStore.getState(), saved = useAppStore.persist.getOptions().partialize!(current) as {
    agentNames?: Record<string, string>; agentComposerDrafts: Record<string, string>
  }
  expect(current.agentNames['waiting-session'], 'a different exact target ACK cannot confirm the old alias handoff').toBe('Unacknowledged original alias')
  expect(saved.agentNames).toEqual({ 'waiting-session': 'Unacknowledged original alias' })
  expect(saved.agentComposerDrafts['original-session']).toBe('New private unsent draft')
  release.resolve(); cleanups.push(await initialization)
  expect(useAppStore.getState().agentNames['original-session']).toBe('New explicit name')
  expect(useAppStore.getState().agentNames['waiting-session']).toBe('Unacknowledged original alias')
  expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState())).not.toHaveProperty('agentNames')
})
