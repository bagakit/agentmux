// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkbenchViewLayout, createWorkspaceLayout } from '@agentmux/layout'
import { sourceFolderFixture } from '../../../packages/core/test/helpers/space-folder-directory-fixture'
import { readSpaceSnapshot } from '../../../packages/core/src/space-authority-stream'
import { folderDirectoryResourceKey } from '@agentmux/core/space-folder-resources'
import { useAppStore, restorePersistedUiState } from '../src/renderer/src/store'
import { initialMountedSpaceView, mountedSpaceInput } from '../src/renderer/src/lib/space-mount-view'
import { spaceMountKey } from '../src/shared/space-mount'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { api } from '../src/renderer/src/lib/api'
import { originalSourceRegionProjectionId, originalSourceScopeFromGraph, originalSourceTabProjectionId, originalSourceWorkspaceId, reconcileOriginalSourceProjection } from '../src/renderer/src/lib/original-space-navigation'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { reducePersistedTab, restorePersistedWorkbench, persistedSessionSurfaceIds } from '../src/renderer/src/lib/workbench-persistence'
import { composerConfig } from './helpers/composer-dom-fixture'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('a confirmed Source snapshot reconciles ordinary qualified workbench state without a second business graph, and an unavailable observation retains it', async () => {
  const f = await sourceFolderFixture(cleanup), observed = await f.rpc.call('space.folder.inspect', { runtimeId: f.source.runtimeId, path: f.directory })
  const saved = await f.rpc.call('space.folder.register', { runtimeId: f.source.runtimeId, directory: observed.resource! })
  const before = (await f.spatial.read())!, graph = structuredClone(before.graph), tabId = 'original-tab', regionId = 'original-region'
  graph.tabs.push({ tabId, zoneId: saved.zoneId, workspaceId: saved.workspaceId, name: 'Original work', regionIds: [regionId] })
  graph.regions.push({ regionId, tabId, kind: 'launcher', agentSessionId: null, runId: null, execution: { hostId: 'local', cwd: f.directory, runtimeId: f.source.runtimeId } })
  graph.resources[`tab:${tabId}`] = {}; graph.resources[`region:${regionId}`] = {}
  graph.layouts[saved.workspaceId] = createWorkspaceLayout('original-group', [tabId]); graph.tabLayouts[tabId] = createWorkbenchViewLayout(regionId)
  await f.spatial.commit({ expectedRevision: before.revision, graph })
  const target = { hostId: 'local', reference: saved.reference, zoneId: saved.zoneId, workspaceId: saved.workspaceId }, key = spaceMountKey(saved.reference)
  const snapshot = await readSpaceSnapshot(f.rpc, saved.reference), view = initialMountedSpaceView(snapshot), pending = { kind: 'future-operation', opaque: { keep: true } }
  const sessions = useAppStore.getState().sessions
  useAppStore.setState({ config: { ...composerConfig, workspaces: [] }, mountedSpaceInputs: { [key]: { target, view, drafts: { keep: 'private bytes' } }, pending }, mountedSpaceObservations: {},
    tabs: {}, layouts: {}, activeWorkspaceId: null, workbenchSpaceSelection: null, spaceZoneBindings: {} })
  useAppStore.getState().mountSpace(target)
  const opened = useAppStore.getState()
  expect(opened.activeWorkspaceId).toBe(originalSourceWorkspaceId(target))
  expect(opened.workbenchSpaceSelection?.tabId).toBeNull()
  const executionOnlyGraph = structuredClone(graph)
  delete executionOnlyGraph.resources[folderDirectoryResourceKey(saved.workspaceId)]
  executionOnlyGraph.tabs.push({ tabId: 'other-runtime-tab', zoneId: saved.zoneId, workspaceId: saved.workspaceId, name: 'Same Zone other Runtime', regionIds: ['other-runtime-region'] })
  executionOnlyGraph.regions.push({ regionId: 'other-runtime-region', tabId: 'other-runtime-tab', kind: 'launcher', agentSessionId: null, runId: null,
    execution: { hostId: 'local', cwd: f.directory, runtimeId: 'another-runtime' } })
  expect(originalSourceScopeFromGraph({ ...target, reference: { ...target.reference, runtimeId: 'missing-runtime' } }, executionOnlyGraph)).toBeUndefined()
  expect(originalSourceScopeFromGraph(target, executionOnlyGraph)).toBeDefined()
  useAppStore.getState().observeSpaceMount(target, { snapshot, reading: false })
  const current = useAppStore.getState(), tab = Object.values(current.tabs).find(tab => tab.source?.reference.runtimeId === target.reference.runtimeId)
  expect(tab, 'The Source snapshot must produce a view-only ordinary Tab projection').toBeDefined()
  expect(tab!.id).not.toBe(tabId)
  expect(tab!.source).toMatchObject({ reference: target.reference, zoneId: target.zoneId, workspaceId: target.workspaceId, tabId })
  const region = tab!.regions[Object.keys(tab!.regions)[0]!]!
  expect(region.source).toMatchObject({ reference: target.reference, zoneId: target.zoneId, workspaceId: target.workspaceId, tabId, regionId })
  const restoredScope = originalSourceScopeFromGraph(target, executionOnlyGraph)
  expect(restoredScope?.reference).toEqual(target.reference)
  expect(restoredScope?.scope.tabs).toContainEqual(expect.objectContaining({ tabId }))
  expect(restoredScope?.scope.tabs).not.toContainEqual(expect.objectContaining({ tabId: 'other-runtime-tab' }))
  expect(restoredScope?.scope.regions).not.toContainEqual(expect.objectContaining({ regionId: 'other-runtime-region' }))
  expect(current.layouts[tab!.workspaceId]).toBeDefined()
  expect(current.workbenchSpaceSelection).toMatchObject({ workspaceId: originalSourceWorkspaceId(target),
    groupId: current.layouts[tab!.workspaceId]!.activeGroupId, tabId: originalSourceTabProjectionId(target, tabId),
    regionId: originalSourceRegionProjectionId(target, regionId) })
  expect(mountedSpaceInput(current.mountedSpaceInputs, key)?.view).toBeUndefined()
  expect(mountedSpaceInput(current.mountedSpaceInputs, key)?.drafts.keep).toBe('private bytes')
  expect((current.mountedSpaceInputs as Record<string, unknown>).pending).toBe(pending)
  expect(current.sessions).toBe(sessions)
  const unrelated = reconcileOriginalSourceProjection({ ...current, activeWorkspaceId: target.workspaceId, workbenchSpaceSelection: null }, target, snapshot)
  expect(Object.hasOwn(unrelated, 'activeWorkspaceId')).toBe(false)
  const graphBefore = (await f.spatial.read())!.graph
  expect((await f.spatial.read())!.graph).toEqual(graphBefore)
  const tabs = current.tabs, layouts = current.layouts
  useAppStore.getState().observeSpaceMount(target, { error: 'Source temporarily unavailable', reading: false })
  expect(useAppStore.getState().tabs).toBe(tabs)
  expect(useAppStore.getState().layouts).toBe(layouts)
})

it('Source active identity remains qualified through UI restore', () => {
  const target = { hostId: 'local', reference: { runtimeId: 'private-source-runtime', spaceId: 'source-space' }, zoneId: 'source-zone', workspaceId: 'source-workspace' }
  const workspaceId = originalSourceWorkspaceId(target)
  const restored = restorePersistedUiState(composerConfig, { activeWorkspaceId: '__scratch__', workbenchSpaceSelection: {
    spaceId: target.reference.spaceId, zoneId: target.zoneId, workspaceId, sourceRuntimeId: target.reference.runtimeId,
    topicId: null, tabId: null, groupId: null, regionId: null } })
  expect(restored.activeWorkspaceId).toBe(workspaceId)
  expect(restored.workbenchSpaceSelection).toMatchObject({ workspaceId, sourceRuntimeId: target.reference.runtimeId })
  const raw = restorePersistedUiState(composerConfig, { activeWorkspaceId: target.workspaceId, workbenchSpaceSelection: {
    spaceId: target.reference.spaceId, zoneId: target.zoneId, workspaceId: target.workspaceId, sourceRuntimeId: target.reference.runtimeId,
    topicId: null, tabId: null, groupId: null, regionId: null } })
  expect(raw.activeWorkspaceId).toBe(workspaceId)
  expect(raw.workbenchSpaceSelection).toMatchObject({ workspaceId, sourceRuntimeId: target.reference.runtimeId })
})

it('Source Sessions stay out of the local Runtime missing-fact startup warning', () => {
  const reference = { runtimeId: 'source-runtime', spaceId: 'source-space' }, source = { reference, zoneId: 'source-zone', workspaceId: 'source-workspace', tabId: 'source-tab' }
  const sourceTab = { ...createWorkbenchTab('source-tab', { regionId: 'source-region', kind: 'agent', phase: 'attached', sessionId: 'source-agent', workspaceId: 'source-workspace' }), source }
  sourceTab.regions['source-region']!.source = { ...source, regionId: 'source-region' }
  const localTab = createWorkbenchTab('local-tab', { regionId: 'local-region', kind: 'agent', phase: 'attached', sessionId: 'local-agent', workspaceId: 'local-workspace' })
  const ids = persistedSessionSurfaceIds({ tabs: { 'source-tab': reducePersistedTab(sourceTab), 'local-tab': reducePersistedTab(localTab) }, layouts: {} })
  expect(ids.has('local-agent')).toBe(true)
  expect(ids.has('source-agent')).toBe(false)
})

it('a folder-confirmed empty Source remains restorable while an empty graph without Runtime evidence stays unknown', async () => {
  const f = await sourceFolderFixture(cleanup), observed = await f.rpc.call('space.folder.inspect', { runtimeId: f.source.runtimeId, path: f.directory })
  const saved = await f.rpc.call('space.folder.register', { runtimeId: f.source.runtimeId, directory: observed.resource! })
  const graph = (await f.spatial.read())!.graph, target = { hostId: 'local', reference: saved.reference, zoneId: saved.zoneId, workspaceId: saved.workspaceId }
  expect(graph.tabs).toHaveLength(0)
  const restored = originalSourceScopeFromGraph(target, graph)
  expect(restored?.scope.space).toMatchObject({ spaceId: saved.reference.spaceId })
  expect(restored?.scope.tabs).toEqual([])
  expect(restored?.scope.regions).toEqual([])
  const projection = reconcileOriginalSourceProjection({ config: composerConfig, mountedSpaceInputs: {}, tabs: {}, layouts: {}, activeWorkspaceId: null,
    workbenchSpaceSelection: { spaceId: saved.reference.spaceId, zoneId: saved.zoneId, workspaceId: originalSourceWorkspaceId(target), sourceRuntimeId: saved.reference.runtimeId,
      topicId: null, tabId: null, groupId: null, regionId: null } }, target, restored!)
  expect(Object.hasOwn(projection.layouts ?? {}, originalSourceWorkspaceId(target))).toBe(true)
  const noEvidence = structuredClone(graph)
  delete noEvidence.resources[folderDirectoryResourceKey(saved.workspaceId)]
  expect(originalSourceScopeFromGraph(target, noEvidence)).toBeUndefined()
})

it('a saved split Source view remains readable for cold restoration', () => {
  const target = { hostId: 'local', reference: { runtimeId: 'private-source-runtime', spaceId: 'source-space' }, zoneId: 'source-zone', workspaceId: 'source-workspace' }
  const key = spaceMountKey(target.reference), tabId = 'private-original-tab', regionId = 'private-original-region', initial = createWorkspaceLayout('private-source-view-group', [tabId])
  const view = { composition: { ...initial, root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .32, first: initial.root, second: { type: 'leaf' as const, groupId: 'private-source-view-split' } },
    groups: [...initial.groups, { id: 'private-source-view-split', tabOrder: [], activeTabId: null, recentTabIds: [] }] }, tabLayouts: { [tabId]: createWorkbenchViewLayout(regionId) },
    selection: { groupId: 'private-source-view-group', tabId, regionId } }
  const input = mountedSpaceInput({ [key]: { target, view, drafts: {} } }, key)
  expect(input?.target).toEqual(target)
  expect(input?.view?.selection).toEqual({ groupId: 'private-source-view-group', tabId, regionId })
})

it('Core-ready persistence retains a qualified empty Source layout for the next ordinary restore', async () => {
  const f = await sourceFolderFixture(cleanup), observed = await f.rpc.call('space.folder.inspect', { runtimeId: f.source.runtimeId, path: f.directory })
  const saved = await f.rpc.call('space.folder.register', { runtimeId: f.source.runtimeId, directory: observed.resource! })
  const target = { hostId: 'local', reference: saved.reference, zoneId: saved.zoneId, workspaceId: saved.workspaceId }, workspaceId = originalSourceWorkspaceId(target)
  const config = { ...composerConfig, workspaces: [{ id: saved.workspaceId, name: 'Empty original', hostId: 'local', path: f.directory, kind: 'folder' as const }] }
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.spatial, 'read').mockImplementation(() => f.spatial.read())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => f.spatial.commit(input))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => f.spatial.subscribe(listener))
  cleanup.push(await useAppStore.getState().initialize())
  const layout = createWorkspaceLayout(originalSourceWorkspaceId(target) + ':group', [])
  useAppStore.setState({ config, tabs: {}, layouts: { [workspaceId]: layout }, activeWorkspaceId: workspaceId,
    mountedSpaceInputs: { [spaceMountKey(target.reference)]: { target, drafts: {} } },
    workbenchSpaceSelection: { spaceId: saved.reference.spaceId, zoneId: saved.zoneId, workspaceId, sourceRuntimeId: saved.reference.runtimeId,
      topicId: null, tabId: null, groupId: null, regionId: null } })
  const persisted = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  expect(persisted.restoredWorkbench?.layouts[workspaceId]).toEqual(layout)
  expect(persisted.restoredWorkbench?.tabs).toEqual({})
  const restored = restorePersistedWorkbench({ config, sessions: [], persisted: persisted.restoredWorkbench ?? null, createTabGroupId: () => 'restored-group' })
  expect(restored.layouts[workspaceId]).toEqual(layout)
})

it('Core spatial capture excludes every Source projection while preserving its ordinary user-state restore', () => {
  const target = { runtimeId: 'source-runtime', spaceId: 'source-space' }, workspaceId = 'original-source:workspace', tabId = 'original-source:tab', regionId = 'original-source:region'
  const tab = { ...createWorkbenchTab(tabId, { regionId, kind: 'file', workspaceId, path: 'source.txt' }), space: { spaceId: target.spaceId, zoneId: 'source-zone' },
    source: { reference: target, zoneId: 'source-zone', workspaceId: 'raw-workspace', tabId: 'raw-tab' } }
  tab.regions[regionId]!.source = { reference: target, zoneId: 'source-zone', workspaceId: 'raw-workspace', tabId: 'raw-tab', regionId: 'raw-region' }
  const layout = createWorkspaceLayout('original-source:group', [tabId])
  useAppStore.setState({ config: { ...composerConfig, workspaces: [] }, tabs: { [tabId]: tab }, layouts: { [workspaceId]: layout }, sessions: [], scratchTopicSnapshots: {} })
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  expect(graph.tabs).toHaveLength(0)
  expect(graph.regions).toHaveLength(0)
  expect(graph.layouts).not.toHaveProperty(workspaceId)
  expect(graph.resources).not.toHaveProperty(`tab:${tabId}`)
  const restored = restorePersistedWorkbench({ config: useAppStore.getState().config!, sessions: [], createTabGroupId: () => 'ordinary-group',
    persisted: { tabs: { [tabId]: reducePersistedTab(tab) }, layouts: { [workspaceId]: layout } } })
  expect(restored.tabs[tabId]).toBeDefined()
  expect(restored.layouts[workspaceId]).toBeDefined()
})
