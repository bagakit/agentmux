import { describe, expect, it } from 'vitest'
import { addTabOccurrence, createWorkspaceLayout, moveTabToNewGroup } from '@agentmux/layout'
import { parseAgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { fixturePath, fixtureTime } from '../scripts/lib/fixture-values.mjs'
import type { AppConfig, SessionSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { directoryIdentity, workspaceZoneId } from '../src/shared/space-addresses'
import { closeWorktreeGraph } from '../src/shared/worktree-closeout'
import { desktopBindingsFromSpatial, desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { rehomeClosedWorkspaces } from '../src/renderer/src/lib/worktree-closeout-state'
import type { SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'

function fixture() {
  const target: WorkspaceRecord = { id: 'default', name: 'Project', hostId: 'host', path: fixturePath('project'), kind: 'folder' }
  const source: WorkspaceRecord = { id: 'topic', name: 'Topic', hostId: 'host', path: fixturePath('project-topic'), repoPath: target.path, kind: 'worktree', branch: 'feature' }
  const foreign: WorkspaceRecord = { id: 'foreign', name: 'Other', hostId: 'host', path: fixturePath('other'), kind: 'folder' }
  const config: AppConfig = { version: 9, hosts: [{ id: 'host', kind: 'local', label: 'Local' }], executors: {},
    workspaces: [target, source, foreign], appearance: { terminalTheme: 'graphite' },
    browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: SessionSnapshot = { id: 'original-session', kind: 'agent', providerId: 'codex', executorId: 'fixture', hostId: 'host', workspacePath: source.path, label: 'Original',
    capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
    createdAt: fixtureTime(), updatedAt: fixtureTime(), agentSessionUpdatedAt: fixtureTime(), latestOutputBytes: 0, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: fixtureTime() },
    control: { kind: 'agent', agentSessionId: 'original-session', hostId: 'host', run: { runId: 'original-run' } } }
  const mixed = addWorkbenchRegion(createWorkbenchTab('mixed', { regionId: 'agent', kind: 'agent', phase: 'attached', workspaceId: source.id, sessionId: session.id }, 'User title'), 'agent', 'right',
    { regionId: 'file', kind: 'file', workspaceId: source.id, path: 'draft.md' })
  const duplicate = createWorkbenchTab('duplicate', { regionId: 'same-session', kind: 'agent', phase: 'attached', workspaceId: source.id, sessionId: session.id })
  const existing = createWorkbenchTab('existing', { regionId: 'default-file', kind: 'file', workspaceId: target.id, path: 'default.md' })
  const sourceLayout = addTabOccurrence(moveTabToNewGroup(createWorkspaceLayout('source-first', ['mixed', 'duplicate']), 'duplicate', 'source-first', 'source-first', 'right', 'source-second'), 'source-first', 'duplicate')!
  sourceLayout.activeGroupId = 'source-second'
  const state: SpatialWorkbench & { activeWorkspaceId: string | null } = { config, sessions: [session], tabs: { mixed, duplicate, existing },
    layouts: { [source.id]: sourceLayout, [target.id]: createWorkspaceLayout('default-group', ['existing']), [foreign.id]: createWorkspaceLayout('foreign-group', ['mixed']) },
    spaceZoneBindings: {}, spatialRequests: {}, activeWorkspaceId: source.id }
  const closedConfig: AppConfig = { ...config, workspaces: config.workspaces.map(workspace => workspace.id === source.id ? { ...workspace,
    closeout: { targetWorkspaceId: target.id, operationId: 'close-operation', cleanup: 'pending' as const, reason: 'Original resource remains in use' } } : workspace) }
  return { state, source, target, foreign, config, closedConfig, session }
}

function expectSourceRetired(graph: ReturnType<typeof desktopSpatialGraph>, source: WorkspaceRecord, hasOriginalResource = true) {
  const oldZone = workspaceZoneId(directoryIdentity(source.hostId, source.repoPath!), source.id)
  expect(graph.layouts).not.toHaveProperty(source.id)
  expect(graph.zones.some(zone => zone.workspaceId === source.id)).toBe(false)
  expect(graph.bindings.some(binding => binding.zoneId === oldZone)).toBe(false)
  if (hasOriginalResource) expect(graph.resources['zone:' + oldZone]).toMatchObject({ originalZone: { zoneId: oldZone, workspaceId: source.id } })
  expect(graph.tabs.some(tab => tab.workspaceId === source.id || tab.zoneId === oldZone)).toBe(false)
}

describe('worktree closeout moves the workface without moving execution resources', () => {
  it('retains every Tab, Region, split, repeated SID and foreign occurrence beside existing destination content', () => {
    const { state, source, target, foreign } = fixture()
    const original = desktopSpatialGraph(state, []), before = structuredClone(original)
    const result = closeWorktreeGraph(original, source, target)
    const graph = parseAgentMuxSpatialGraph(result.graph)
    expect(result.movedTabIds).toEqual(['mixed', 'duplicate'])
    expect(original).toEqual(before)
    expectSourceRetired(graph, source)
    expect(graph.tabs.map(tab => tab.tabId)).toEqual(original.tabs.map(tab => tab.tabId))
    expect(graph.regions).toEqual(original.regions)
    expect(graph.regions.filter(region => region.agentSessionId === 'original-session')).toHaveLength(2)
    expect(graph.tabLayouts).toEqual(original.tabLayouts)
    expect(graph.layouts[target.id]!.root).toMatchObject({ type: 'split', first: original.layouts[target.id]!.root, second: original.layouts[source.id]!.root })
    expect(graph.layouts[target.id]!.groups).toEqual([...original.layouts[target.id]!.groups, ...original.layouts[source.id]!.groups])
    expect(graph.layouts[foreign.id]).toEqual(original.layouts[foreign.id])
    expect(graph.layouts[target.id]!.activeGroupId).toBe('default-group')
    expect(graph.tabs.find(tab => tab.tabId === 'mixed')!.name).toBe('User title')
    expect(graph.resources['region:file']).toEqual(original.resources['region:file'])
    expect(graph.resources['region:agent']).toEqual(original.resources['region:agent'])
    expect(graph.regions.find(region => region.regionId === 'agent')).toMatchObject({ runId: 'original-run', execution: { hostId: source.hostId, cwd: source.path } })
    expect(graph.resources['tab:existing']).toEqual(original.resources['tab:existing'])
  })

  it('keeps the original resource context when restoring the moved graph', () => {
    const { state, source, target } = fixture()
    const graph = closeWorktreeGraph(desktopSpatialGraph(state, []), source, target).graph
    const restored = desktopWorkbenchFromSpatial(graph)
    expect(restored.tabs.mixed).toMatchObject({ workspaceId: target.id, regions: state.tabs.mixed!.regions, layout: state.tabs.mixed!.layout })
    expect(restored.tabs.mixed!.regions.file).toEqual({ regionId: 'file', kind: 'file', workspaceId: source.id, path: 'draft.md' })
    expect(restored.tabs.duplicate!.regions['same-session']).toEqual(state.tabs.duplicate!.regions['same-session'])
    expect(restored.tabs.existing).toEqual(desktopWorkbenchFromSpatial(desktopSpatialGraph(state, [])).tabs.existing)
  })

  it('moves a source-owned Zone Tab even when its recorded workspace differs', () => {
    const { state, source, target, foreign } = fixture()
    const original = desktopSpatialGraph(state, [])
    original.tabs.find(tab => tab.tabId === 'mixed')!.workspaceId = foreign.id
    const { graph, movedTabIds } = closeWorktreeGraph(original, source, target)
    expect(movedTabIds).toContain('mixed')
    expect(graph.tabs.find(tab => tab.tabId === 'mixed')!.workspaceId).toBe(target.id)
    expectSourceRetired(graph, source)
  })

  it('preserves source topology directly when the destination has no layout and is idempotent', () => {
    const { state, source, target } = fixture()
    const original = desktopSpatialGraph(state, [])
    delete original.layouts[target.id]
    const first = closeWorktreeGraph(original, source, target)
    expect(first.graph.layouts[target.id]).toEqual(original.layouts[source.id])
    const second = closeWorktreeGraph(first.graph, source, target)
    expect(second).toEqual({ graph: first.graph, movedTabIds: [] })
  })

  it('creates an absent destination Zone while retaining unrelated resources and bindings', () => {
    const { state, source, target, foreign } = fixture()
    const original = desktopSpatialGraph(state, [])
    const targetZone = workspaceZoneId(directoryIdentity(target.hostId, target.path), target.id)
    const foreignZone = workspaceZoneId(directoryIdentity(foreign.hostId, foreign.path), foreign.id)
    original.zones = original.zones.filter(zone => zone.zoneId !== targetZone)
    original.bindings = original.bindings.filter(binding => binding.zoneId !== targetZone)
    delete original.resources['zone:' + targetZone]
    original.resources['unrelated-draft'] = { text: 'Keep my draft' }
    const { graph } = closeWorktreeGraph(original, source, target)
    expect(graph.zones.filter(zone => zone.zoneId === targetZone)).toHaveLength(1)
    expect(graph.zones.find(zone => zone.zoneId === targetZone)).toMatchObject({ workspaceId: target.id, directoryPath: target.path, hostId: target.hostId })
    expect(graph.bindings.filter(binding => binding.zoneId === targetZone)).toEqual([{ zoneId: targetZone, spaceId: directoryIdentity(target.hostId, target.path) }])
    expect(graph.bindings.filter(binding => binding.zoneId === foreignZone)).toEqual(original.bindings.filter(binding => binding.zoneId === foreignZone))
    expect(graph.resources['unrelated-draft']).toEqual(original.resources['unrelated-draft'])
    expectSourceRetired(graph, source)
  })

  it('refuses colliding Group identities without mutating either original workface', () => {
    const { state, source, target } = fixture()
    state.layouts[target.id] = createWorkspaceLayout('source-first', ['existing'])
    const original = desktopSpatialGraph(state, []), before = structuredClone(original)
    expect(() => closeWorktreeGraph(original, source, target)).toThrow('Group identity')
    expect(original).toEqual(before)
  })

  it('reconciles live local state without replacing Region objects or execution snapshots and keeps source focus', () => {
    const { state, source, target, closedConfig } = fixture()
    const patch = rehomeClosedWorkspaces(state, closedConfig)
    expect(patch.tabs!.mixed!.workspaceId).toBe(target.id)
    expect(patch.tabs!.mixed!.regions).toBe(state.tabs.mixed!.regions)
    expect(patch.tabs!.mixed!.layout).toBe(state.tabs.mixed!.layout)
    expect(patch.tabs!.duplicate!.regions).toBe(state.tabs.duplicate!.regions)
    expect(patch.tabs!.existing).toBe(state.tabs.existing)
    expect(patch.layouts![target.id]!.activeGroupId).toBe(state.layouts[source.id]!.activeGroupId)
    expect(patch.layouts![target.id]!.groups).toEqual([...state.layouts[target.id]!.groups, ...state.layouts[source.id]!.groups])
    expect(patch).not.toHaveProperty('sessions')
    expect(state.sessions[0]).toMatchObject({ id: 'original-session', workspacePath: source.path, control: { run: { runId: 'original-run' } } })
    const next = { ...state, ...patch, config: closedConfig, activeWorkspaceId: target.id }
    expect(rehomeClosedWorkspaces(next, closedConfig)).toEqual({})
  })

  it('does not steal the active Group when the user is working outside the source', () => {
    const { state, target, foreign, closedConfig } = fixture()
    const patch = rehomeClosedWorkspaces({ ...state, activeWorkspaceId: foreign.id }, closedConfig)
    expect(patch.layouts![target.id]!.activeGroupId).toBe('default-group')
    expect(patch.layouts![foreign.id]).toEqual(state.layouts[foreign.id])
    expect(patch).not.toHaveProperty('activeWorkspaceId')
  })

  it.each([0, 600])('does not amplify idle reconciliation across %i historical closeouts', historyCount => {
    const { state, config, source, target } = fixture()
    let tabEnumerations = 0
    const tabs = new Proxy(state.tabs, { ownKeys(value) { tabEnumerations++; return Reflect.ownKeys(value) } })
    const configWithHistory: AppConfig = { ...config, workspaces: [...config.workspaces,
      ...Array.from({ length: historyCount }, (_, index): WorkspaceRecord => ({ ...source, id: 'closed-' + index,
        closeout: { targetWorkspaceId: target.id, operationId: 'past-operation-' + index, cleanup: 'pending', reason: 'Retained original resources' } }))] }
    expect(rehomeClosedWorkspaces({ ...state, tabs }, configWithHistory)).toEqual({})
    expect(tabEnumerations).toBe(historyCount === 0 ? 0 : 1)
  })

  it('still moves the retained durable workface when the current client has not loaded it', () => {
    const { state, source, target, closedConfig } = fixture()
    const previous = desktopSpatialGraph(state, [])
    const graph = desktopSpatialGraph({ ...state, config: closedConfig, tabs: {}, layouts: {} }, [], previous)
    expectSourceRetired(graph, source)
    expect(graph.tabs.map(tab => tab.tabId)).toEqual(previous.tabs.map(tab => tab.tabId))
    expect(graph.regions).toEqual(previous.regions)
    expect(graph.layouts[target.id]!.groups).toEqual([...previous.layouts[target.id]!.groups, ...previous.layouts[source.id]!.groups])
    expect(graph.tabLayouts).toEqual(previous.tabLayouts)
  })

  it('restores the moved layout without inventing an empty Group for a retained resource record', () => {
    const { state, source, target, closedConfig } = fixture()
    const graph = closeWorktreeGraph(desktopSpatialGraph(state, []), source, target).graph
    const restored = restorePersistedWorkbench({ config: closedConfig, sessions: state.sessions,
      persisted: desktopWorkbenchFromSpatial(graph), createTabGroupId: () => { throw new Error('Must not invent a closed layout') },
      preserveEntityIds: new Set(graph.tabs.map(tab => tab.tabId)) })
    expect(restored.layouts).toEqual(graph.layouts)
    const repeated = desktopSpatialGraph({ ...state, ...restored, config: closedConfig }, [], graph)
    expect(repeated.layouts).toEqual(graph.layouts)
  })

  it('does not resurrect a closed Zone or layout from config, old bindings, or a previous durable graph', () => {
    const { state, source, target, closedConfig } = fixture()
    const previous = desktopSpatialGraph(state, [])
    const patch = rehomeClosedWorkspaces(state, closedConfig)
    const next = { ...state, ...patch, config: closedConfig, activeWorkspaceId: target.id, spaceZoneBindings: desktopBindingsFromSpatial(previous) }
    const graph = desktopSpatialGraph(next, [], previous, new Set([workspaceZoneId(directoryIdentity(source.hostId, source.repoPath!), source.id)]))
    expectSourceRetired(graph, source)
    expect(graph.layouts[target.id]!.groups.map(group => group.id)).toEqual(['default-group', 'source-first', 'source-second'])
    const repeated = desktopSpatialGraph({ ...next, spaceZoneBindings: desktopBindingsFromSpatial(graph) }, [], graph)
    expectSourceRetired(repeated, source)
    expect(repeated).toEqual(graph)
    const closedOnly = desktopSpatialGraph({ ...next, tabs: {}, layouts: {}, spaceZoneBindings: {} }, [])
    expectSourceRetired(closedOnly, source, false)
    expect(closedOnly.zones.some(zone => zone.workspaceId === target.id)).toBe(true)
  })
})
