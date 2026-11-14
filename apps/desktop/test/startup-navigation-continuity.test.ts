// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { RuntimeSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { initialMountedSpaceView, openSourceFolderInput, editMountedSpaceInput } from '../src/renderer/src/lib/space-mount-view'
import { originalSourceRegionProjectionId, originalSourceWorkspaceId } from '../src/renderer/src/lib/original-space-navigation'
import { spaceMountKey } from '../src/shared/space-mount'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'
import { spaceMountFixture } from './helpers/space-mount-fixture'

const initial = useAppStore.getState(), empty = (): RuntimeSnapshot => ({ sessions: [], recoveryCandidates: [], timelines: {} })
const cleanup: Array<() => unknown | Promise<unknown>> = []
let spatial: AgentMuxSpatialStateStore
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
beforeEach(async () => {
  useAppStore.setState(initial, true)
  vi.spyOn(useAppStore.persist, 'hasHydrated').mockReturnValue(true)
  vi.spyOn(api.config, 'get').mockResolvedValue(composerConfig)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue(empty())
  vi.spyOn(api.sessions, 'notifyInputOccupation').mockResolvedValue(undefined)
  const directory = await mkdtemp(join(tmpdir(), 'amx-navigation-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  spatial = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => spatial.subscribe(listener))
})
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})
async function initialize() { cleanup.push(await useAppStore.getState().initialize()) }
async function sourceInput() {
  const f = await spaceMountFixture(cleanup), source = f.cores[1]!
  const resources = await f.api.call('resources', { hostId: source.id }), workspace = resources.workspaces[0]!
  const registered = await f.api.call('register', { hostId: source.id, registration: { runtimeId: source.identity.runtimeId,
    workspaceId: workspace.workspaceId, expectedResource: { hostId: workspace.hostId, workspacePath: workspace.path, projectRootPath: workspace.repoPath ?? workspace.path } } })
  const target = { hostId: source.id, reference: registered.reference, zoneId: registered.zoneId, workspaceId: registered.workspaceId }
  await f.api.call('apply', { hostId: target.hostId, reference: target.reference, edit: { reference: target.reference, expectedRevision: registered.revision, changes: {
    tabs: [{ tabId: 'original-tab', zoneId: target.zoneId, workspaceId: target.workspaceId, name: 'Original workface', regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'launcher', agentSessionId: null, runId: null,
      execution: { hostId: 'local', cwd: workspace.path, runtimeId: source.identity.runtimeId } }]
  } } })
  const snapshot = await f.api.call('snapshot', { hostId: target.hostId, reference: target.reference }), key = spaceMountKey(target.reference)
  const view = initialMountedSpaceView(snapshot)
  view.selection = { tabId: 'original-tab', regionId: 'original-region', groupId: view.composition.activeGroupId }
  const inputs = editMountedSpaceInput(openSourceFolderInput({}, target), key, current => ({ ...current!, view }))
  // This is a real original Space and saved private view. Native Session membership is absent.
  useAppStore.setState({ mountedSpaceInputs: inputs, activeWorkspaceId: target.workspaceId,
    mainSurface: 'agents', workbenchSpaceSelection: null, selectedSpaceMount: key } as Partial<ReturnType<typeof useAppStore.getState>>)
  return { target, key, snapshot, inputs, view }
}
async function savedLocalWorkface() {
  const session = composerSession('original-session')
  const tab = createWorkbenchTab('local-original-tab', { kind: 'agent', phase: 'attached', sessionId: session.id,
    workspaceId: 'workspace', regionId: 'local-original-region' })
  const layout = createWorkspaceLayout('original-group', [tab.id])
  const graph = desktopSpatialGraph({ ...useAppStore.getState(), config: composerConfig, tabs: { [tab.id]: tab },
    layouts: { workspace: layout }, sessions: [session] }, [])
  const saved = await spatial.commit({ expectedRevision: 0, graph }), projected = desktopWorkbenchFromSpatial(saved.graph)
  const exact = projected.tabs[tab.id]!
  const selection = { spaceId: exact.space!.spaceId, zoneId: exact.space!.zoneId, workspaceId: 'workspace',
    topicId: null, tabId: tab.id, groupId: layout.activeGroupId, regionId: tab.layout.activeRegionId }
  useAppStore.setState({ restoredWorkbench: { tabs: projected.tabs, layouts: { workspace: layout } },
    mainSurface: 'agents', activeWorkspaceId: 'workspace', workbenchSpaceSelection: selection,
    agentComposerDrafts: { [session.id]: 'Keep the original unsent input' } })
  return { session, tabId: tab.id, selection }
}

it.each([false, true])('restores a legacy original Source view without revealing Space over saved Focus; cached source=%s and explicit View in Space still reveals it', async cached => {
  const f = await sourceInput()
  if (cached) useAppStore.setState({ mountedSpaceObservations: { [f.key]: { snapshot: f.snapshot, reading: false } } })
  await initialize()
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId,
    sourceRuntimeId: f.target.reference.runtimeId })
  useAppStore.getState().observeSpaceMount(f.target, { snapshot: f.snapshot, reading: false })
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().workbenchSpaceSelection?.regionId).toBe(originalSourceRegionProjectionId(f.target, 'original-region'))
  const layout = useAppStore.getState().layouts[originalSourceWorkspaceId(f.target)]
  expect(layout?.groups[0]?.tabOrder).toHaveLength(1)
  useAppStore.getState().openOriginalSpaceLocation({ target: f.target })
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().layouts[originalSourceWorkspaceId(f.target)]).toEqual(layout)
})

it('a late initialization cannot let an old Source selection replace a later exact workface', async () => {
  const source = await sourceInput(), local = await savedLocalWorkface(), config = deferred<typeof composerConfig>()
  vi.mocked(api.config.get).mockReturnValue(config.promise)
  const ready = useAppStore.getState().initialize()
  await vi.waitFor(() => expect(api.config.get).toHaveBeenCalled())
  useAppStore.setState({ mainSurface: 'agents', workbenchSpaceSelection: local.selection, activeWorkspaceId: 'workspace' })
  config.resolve(composerConfig); cleanup.push(await ready)
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(local.selection)
  expect(useAppStore.getState().activeWorkspaceId).toBe('workspace')
  expect(useAppStore.getState().agentComposerDrafts[local.session.id]).toBe('Keep the original unsent input')
  expect(useAppStore.getState().mountedSpaceInputs).toEqual(source.inputs)
})

it('a delayed startup candidate does not reveal or attach a temporarily unattached original Region', async () => {
  const f = await savedLocalWorkface(), snapshot = deferred<RuntimeSnapshot>()
  vi.mocked(api.sessions.snapshot).mockReturnValue(snapshot.promise)
  const recover = vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('No background recovery is authorized without its attached view'))
  await initialize()
  await vi.waitFor(() => expect(api.sessions.snapshot).toHaveBeenCalled())
  useAppStore.setState(state => ({ tabs: { ...state.tabs, [f.tabId]: { ...state.tabs[f.tabId]!, regions: {
    ...state.tabs[f.tabId]!.regions, 'local-original-region': { kind: 'agent', phase: 'launching', workspaceId: 'workspace',
      regionId: 'local-original-region', sessionId: f.session.id }
  } } } }))
  const before = useAppStore.getState(), tabs = before.tabs, layouts = before.layouts
  snapshot.resolve({ ...empty(), sessions: [f.session], timelines: { [f.session.id]: { agentSessionId: f.session.id, revision: 1, items: [] } } })
  await vi.waitFor(() => expect(useAppStore.getState().sessions.some(session => session.id === f.session.id)).toBe(true))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(f.selection)
  expect(useAppStore.getState().tabs).toEqual(tabs)
  expect(useAppStore.getState().layouts).toEqual(layouts)
  expect(recover).not.toHaveBeenCalled()
})

it('background recovery keeps the exact original control and later Focus choice while retaining its attached view', async () => {
  const f = await savedLocalWorkface(), snapshot = deferred<RuntimeSnapshot>(), result = deferred<Awaited<ReturnType<typeof api.sessions.recover>>>()
  vi.mocked(api.sessions.snapshot).mockReturnValue(snapshot.promise)
  const recover = vi.spyOn(api.sessions, 'recover').mockReturnValue(result.promise)
  await initialize()
  await vi.waitFor(() => expect(api.sessions.snapshot).toHaveBeenCalled())
  snapshot.resolve({ ...empty(), sessions: [f.session], timelines: { [f.session.id]: { agentSessionId: f.session.id, revision: 1, items: [] } } })
  await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
  expect(recover.mock.calls[0]?.[0]).toEqual(f.session.control)
  expect(recover.mock.calls[0]?.[3]).toEqual({ trigger: 'startup' })
  const before = useAppStore.getState(), tabs = before.tabs, layouts = before.layouts
  const focus = { execution: { sessionId: 'later-focus', history: [] }, pmo: { sessionId: null } }
  useAppStore.setState({ mainSurface: 'agents', agentFocus: focus })
  result.resolve({ kind: 'reattachable', session: f.session })
  await vi.waitFor(() => expect(useAppStore.getState().sessions[0]?.control).toEqual(f.session.control))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().workbenchSpaceSelection).toEqual(f.selection)
  expect(useAppStore.getState().agentFocus).toEqual(focus)
  expect(useAppStore.getState().tabs).toEqual(tabs)
  expect(useAppStore.getState().layouts).toEqual(layouts)
  expect(useAppStore.getState().agentComposerDrafts[f.session.id]).toBe('Keep the original unsent input')
})
