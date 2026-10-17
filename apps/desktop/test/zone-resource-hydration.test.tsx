// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AgentMuxZoneFact } from '@agentmux/core/control'
import type { SpaceZoneBindings } from '../src/shared/space-addresses'
import { directoryIdentity } from '../src/shared/space-addresses'
import { desktopBindingsFromSpatial, desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { workspaceZoneContext } from '../src/renderer/src/lib/workspace-zone-context'
import { openWorkspaceZoneFile, openWorkspaceZoneTerminal } from '../src/renderer/src/lib/workspace-zone-file-actions'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig } from './helpers/composer-dom-fixture'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshTopicSpatial } from '../src/renderer/src/lib/topic-knowledge-actions'

const workspace = { id: 'resource', hostId: 'local', name: 'Project', kind: 'folder' as const, path: fixturePath('zone-hydration/repo') }
const spaceId = directoryIdentity(workspace.hostId, workspace.path)
const zoneId = 'original-explicit-directory-zone'
const directoryPath = `${workspace.path}/nested`

describe('Core Zone resources through Desktop hydration and original consumers', () => {
  const initial = useAppStore.getState()
  beforeEach(() => {
    const tab = { ...createWorkbenchTab('original-tab', { kind: 'launcher', workspaceId: workspace.id, regionId: 'original-region' }),
      space: { spaceId, zoneId } }
    useAppStore.setState({ config: { ...composerConfig, workspaces: [workspace] }, sessions: [],
      tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('original-group', [tab.id]) },
      spaceZoneBindings: { [zoneId]: { workspaceId: workspace.id, spaceId, directoryPath } }, spatialRequests: {},
      scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [], activeWorkspaceId: workspace.id,
      workbenchSpaceSelection: { workspaceId: workspace.id, spaceId, zoneId, groupId: 'original-group',
        tabId: tab.id, regionId: 'original-region', topicId: null },
      agentComposerDrafts: { 'original-session': 'Keep the unsent draft' } })
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  })
  afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

  function hydrate(graph = desktopSpatialGraph(useAppStore.getState(), [])) {
    useAppStore.setState({ spaceZoneBindings: desktopBindingsFromSpatial(graph, useAppStore.getState().config) })
    return workspaceZoneContext(useAppStore.getState(), workspace)
  }

  it.each(['folder', 'worktree'] as const)('keeps an explicit non-Home %s directory, public facts and Files target after hydration', async kind => {
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ ...workspace, kind, branch: 'registered' }] } }))
    const before = useAppStore.getState(), context = hydrate()
    expect(context.zones.find(zone => zone.zoneId === zoneId)).toMatchObject({ hostId: workspace.hostId, directoryPath,
      kind: kind === 'worktree' ? 'worktree' : 'directory' })
    expect(context.files).toMatchObject({ rootPath: 'nested', directoryPath })
    expect(context.resource).toBeNull()
    const publicRead = await useAppStore.getState().executeControl({ schemaVersion: 5, requestId: crypto.randomUUID(),
      operation: 'space.inspect', target: { spaceId, zoneId } })
    expect(publicRead.operation).toBe('space.inspect')
    if (publicRead.operation !== 'space.inspect') throw new Error('Original space.inspect receipt missing')
    expect(publicRead.catalog.zones).toHaveLength(1)
    expect(publicRead.catalog.zones[0]).toMatchObject({ zoneId, hostId: workspace.hostId, directoryPath })
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().workbenchSpaceSelection).toBe(before.workbenchSpaceSelection)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
    const read = vi.spyOn(api.files, 'read').mockResolvedValue({ status: 'read', document: { path: 'nested/note.md', content: 'Original source', revision: 'original' } })
    await openWorkspaceZoneFile(workspace, 'nested/note.md')
    expect(read).toHaveBeenCalledExactlyOnceWith(workspace.id, 'nested/note.md')
  })

  it('launches through the original Terminal consumer at the preserved directory', async () => {
    hydrate()
    const launcher = vi.spyOn(useAppStore.getState(), 'openLauncher').mockReturnValue('original-tab')
    const launch = vi.spyOn(useAppStore.getState(), 'launchTerminal').mockResolvedValue(undefined)
    await openWorkspaceZoneTerminal(workspace, 'nested/sub')
    expect(launcher).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: workspace.id, zoneId }))
    expect(launch).toHaveBeenCalledExactlyOnceWith('original-group', { tabId: 'original-tab', regionId: 'original-region' }, `${directoryPath}/sub`)
  })

  it('uses effective Core facts ahead of a stale explicit descriptor and does not persist the read projection', () => {
    const graph = desktopSpatialGraph(useAppStore.getState(), [])
    graph.zones.find(zone => zone.zoneId === zoneId)!.directoryPath = `${workspace.path}/updated`
    const context = hydrate(graph)
    expect(context.files?.directoryPath).toBe(`${workspace.path}/updated`)
    const encoded = desktopSpatialGraph(useAppStore.getState(), [], graph)
    expect(encoded.zones.find(zone => zone.zoneId === zoneId)?.directoryPath).toBe(`${workspace.path}/updated`)
    expect(encoded.resources[`zone:${zoneId}`]).not.toHaveProperty('resource')
    expect(encoded.resources[`zone:${zoneId}`]).toMatchObject({ directoryPath: `${workspace.path}/updated` })
  })

  it.each([false, true])('keeps a Core nested update ahead of an old default descriptor (anchor=%s)', anchored => {
    const graph = desktopSpatialGraph(useAppStore.getState(), [])
    graph.resources[`zone:${zoneId}`] = { spaceId, workspaceId: workspace.id,
      ...(anchored ? { workspacePath: workspace.path } : {}) }
    expect(hydrate(graph).files?.directoryPath).toBe(directoryPath)
    expect(useAppStore.getState().spaceZoneBindings[zoneId]!.directoryPath).toBe(directoryPath)
  })

  it.each([
    { kind: 'unknown', hostId: null, directoryPath: null, branch: null, issue: 'Resource observation unavailable' },
    { kind: 'directory', hostId: 'original-remote-host', directoryPath, branch: null },
    { kind: 'directory', hostId: 'local', directoryPath: null, branch: null },
  ] satisfies Omit<AgentMuxZoneFact, 'zoneId' | 'workspaceId'>[])('keeps unavailable or original foreign Host facts: %j', async resource => {
    const graph = desktopSpatialGraph(useAppStore.getState(), [])
    Object.assign(graph.zones.find(zone => zone.zoneId === zoneId)!, resource)
    const context = hydrate(graph), before = useAppStore.getState()
    expect(context.zones.find(zone => zone.zoneId === zoneId)).toMatchObject(resource)
    expect(context.files).toBeNull()
    expect(context.resource).toBeNull()
    expect(context.issue).toBeTruthy()
    const launch = vi.spyOn(before, 'launchTerminal'), report = vi.spyOn(before, 'reportError')
    await openWorkspaceZoneTerminal(workspace, 'nested/sub')
    expect(launch).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  })

  it('moves default roots with the original Workspace rebind while explicit paths remain fixed', () => {
    const state = useAppStore.getState(), graph = desktopSpatialGraph(state, [])
    const bindings = desktopBindingsFromSpatial(graph)
    const moved = { ...workspace, path: `${workspace.path}-moved` }
    useAppStore.setState({ config: { ...state.config!, workspaces: [moved] }, spaceZoneBindings: bindings })
    const after = desktopSpatialGraph(useAppStore.getState(), [], graph)
    expect(after.zones.find(zone => zone.zoneId === zoneId)?.directoryPath).toBe(directoryPath)
    const defaultZone = graph.zones.find(zone => zone.zoneId !== zoneId)!
    expect(defaultZone.directoryPath).toBe(workspace.path)
    expect(after.zones.find(zone => zone.zoneId === defaultZone.zoneId)?.directoryPath).toBe(moved.path)
  })

  it.each(['folder', 'worktree'] as const)('does not freeze an older default %s ACK across a path rebind', kind => {
    const original = { ...workspace, kind, repoPath: fixturePath('zone-hydration/primary') }
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [original] }, spaceZoneBindings: {} }))
    const graph = desktopSpatialGraph(useAppStore.getState(), []), zone = graph.zones[0]!
    expect(graph.resources[`zone:${zone.zoneId}`]).toMatchObject({ workspacePath: original.path })
    const moved = { ...original, path: `${original.path}-moved` }
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [moved] } }))
    hydrate(graph)
    const encoded = desktopSpatialGraph(useAppStore.getState(), [], graph)
    expect(encoded.zones.find(value => value.zoneId === zone.zoneId)?.directoryPath).toBe(moved.path)
    expect(encoded.resources[`zone:${zone.zoneId}`]).toMatchObject({ workspacePath: moved.path })
    const next = desktopBindingsFromSpatial(encoded, useAppStore.getState().config)
    expect(next[zone.zoneId]!.directoryPath).toBeUndefined()
    expect(desktopSpatialGraph({ ...useAppStore.getState(), spaceZoneBindings: next }, [], encoded).zones
      .find(value => value.zoneId === zone.zoneId)?.directoryPath).toBe(moved.path)
  })

  it.each(['explicit', 'default-worktree', 'later-bindings'] as const)('runs config-null Store startup and save ACK against a Core owner: %s', async mode => {
    const directory = await mkdtemp(join(tmpdir(), 'amux-zone-store-'))
    let dispose: (() => void) | undefined
    try {
      const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
      if (mode === 'default-worktree') useAppStore.setState(state => ({
        config: { ...state.config!, workspaces: [{ ...workspace, kind: 'worktree', repoPath: fixturePath('zone-hydration/primary') }] },
        spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: workspace.id } }
      }))
      const startupConfig = useAppStore.getState().config!
      const graph = desktopSpatialGraph(useAppStore.getState(), [])
      graph.resources[`zone:${zoneId}`] = { spaceId, workspaceId: workspace.id }
      await owner.commit({ expectedRevision: 0, graph })
      vi.spyOn(api.config, 'get').mockImplementation(async () => {
        if (mode === 'later-bindings') useAppStore.setState(state => ({ spaceZoneBindings: { ...state.spaceZoneBindings,
          'later-local-zone': { workspaceId: workspace.id, spaceId, directoryPath: `${workspace.path}/later` } } }))
        return startupConfig
      })
      vi.spyOn(api.providers, 'list').mockResolvedValue({ catalog: [], warnings: [] })
      vi.spyOn(api.demands, 'list').mockResolvedValue([])
      vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
      vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
      const commit = vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
      vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
      vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
      useAppStore.setState({ config: null })
      dispose = await useAppStore.getState().initialize()
      if (mode === 'later-bindings') expect(useAppStore.getState().spaceZoneBindings['later-local-zone']?.directoryPath).toBe(`${workspace.path}/later`)
      let expectedPath = mode === 'default-worktree' ? workspace.path : directoryPath
      expect(workspaceZoneContext(useAppStore.getState(), workspace).files?.directoryPath).toBe(expectedPath)
      if (mode === 'default-worktree') {
        expect(useAppStore.getState().spaceZoneBindings[zoneId]!.directoryPath).toBeUndefined()
        expectedPath = `${workspace.path}-moved`
        useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(value => ({ ...value, path: expectedPath })) } }))
      }
      const before = useAppStore.getState()
      useAppStore.setState({ spaceZoneBindings: { ...before.spaceZoneBindings } })
      await useAppStore.getState().retryWorkbenchSave()
      expect(commit).toHaveBeenCalled()
      expect((await owner.read())!.graph.zones.find(zone => zone.zoneId === zoneId)?.directoryPath).toBe(expectedPath)
      expect(workspaceZoneContext(useAppStore.getState(), workspace).files?.directoryPath).toBe(expectedPath)
      expect(useAppStore.getState().tabs['original-tab']!.layout).toEqual(before.tabs['original-tab']!.layout)
      expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
      expect(useAppStore.getState().workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
    } finally { dispose?.(); await rm(directory, { recursive: true, force: true }) }
  })

  it('refreshes Topic spatial state through its original whole-graph consumer without freezing old default worktrees', async () => {
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: [{ ...workspace, kind: 'worktree',
      repoPath: fixturePath('zone-hydration/primary') }] }, spaceZoneBindings: { [zoneId]: { spaceId, workspaceId: workspace.id } } }))
    const graph = desktopSpatialGraph(useAppStore.getState(), [])
    graph.resources[`zone:${zoneId}`] = { spaceId, workspaceId: workspace.id }
    vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
    await refreshTopicSpatial()
    expect(useAppStore.getState().spaceZoneBindings[zoneId]!.directoryPath).toBeUndefined()
    useAppStore.setState(state => ({ config: { ...state.config!, workspaces: state.config!.workspaces.map(value => ({ ...value, path: `${workspace.path}-moved` })) } }))
    expect(desktopSpatialGraph(useAppStore.getState(), [], graph).zones.find(zone => zone.zoneId === zoneId)?.directoryPath).toBe(`${workspace.path}-moved`)
  })

  it('preserves an accurate directory supplied directly by Core without a Desktop descriptor', () => {
    const graph = desktopSpatialGraph(useAppStore.getState(), [])
    delete graph.resources[`zone:${zoneId}`]
    const bindings: SpaceZoneBindings = desktopBindingsFromSpatial(graph)
    expect(bindings[zoneId]!.directoryPath).toBe(directoryPath)
    expect(hydrate(graph).files?.directoryPath).toBe(directoryPath)
  })
})
