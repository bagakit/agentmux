import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { SpaceSnapshot } from '@agentmux/core'
import type { AgentMuxDesktopSpaceSelection } from '@agentmux/core/control'
import { folderDirectoryFacts } from '@agentmux/core/space-folder-resources'
import type { FolderSpaceResource } from '@agentmux/core/space-folder'
import { createWorkbenchViewLayout, splitWorkbenchRegion, removeTab as removeTabOccurrence, addTabOccurrence, createWorkspaceLayout, activateTab as activateLayoutTab,
  type WorkspaceLayout, type WorkbenchViewLayout } from '@agentmux/layout'
import type { AppConfig, WorkspaceRecord } from '../../../shared/contracts'
import type { SpaceMountRecord, SpaceMountView } from '../../../shared/space-mount'
import { spaceMountKey } from '../../../shared/space-mount'
import { mountedSpaceInput, mountedSpaceInputs, mountedSpaceRegions, mountedSpaceTarget, editMountedSpaceInput, type MountedSpaceInput } from './space-mount-view'
import type { WorkbenchTab, FileWorkbenchSurface } from './workbench-tabs'
import type { LauncherSourceExecution } from './launcher-source'
import type { OrdinaryMemberReference, OrdinarySpaceMember } from './ordinary-space-member'

import type { SourceFilesInputs } from './source-files-workbench'
import { emptySourceFilesInputs } from './source-files-workbench'

export type OriginalSpaceLocation = {
  target: SpaceMountRecord
  resource?: FolderSpaceResource | undefined
  occurrence?: { tabId: string; regionId: string; displayWorkspaceId?: string | undefined; groupId?: string | undefined } | undefined
}
export type OriginalSpaceSelectionState = {
  config: AppConfig | null | undefined
  activeWorkspaceId?: string | null | undefined
  workbenchSpaceSelection?: (AgentMuxDesktopSpaceSelection & { sourceRuntimeId?: string }) | null | undefined
  sourceFilesInputs?: SourceFilesInputs | undefined
  mountedSpaceInputs?: unknown
  mountedSpaceObservations?: Record<string, import('./space-mount-view').MountedSpaceObservation> | undefined
  tabs?: Readonly<Record<string, WorkbenchTab>> | undefined
}
export type OriginalSourceEntry = { key: string; target: SpaceMountRecord; input: MountedSpaceInput | undefined; issue?: string | undefined }

const sourceWorkspacePrefix = 'original-source-workspace:'
const sourceTabPrefix = 'original-source-tab:'
const sourceRegionPrefix = 'original-source-region:'
const sourceGroupPrefix = 'original-source-group:'
const qualified = (prefix: string, target: SpaceMountRecord, id: string) => prefix + JSON.stringify([target.reference.runtimeId, target.reference.spaceId, target.zoneId, id])
export const originalSourceWorkspaceId = (target: SpaceMountRecord) => qualified(sourceWorkspacePrefix, target, target.workspaceId)
export const originalSourceTabProjectionId = (target: SpaceMountRecord, tabId: string) => qualified(sourceTabPrefix, target, tabId)
export const originalSourceRegionProjectionId = (target: SpaceMountRecord, regionId: string) => qualified(sourceRegionPrefix, target, regionId)
export const originalSourceGroupProjectionId = (target: SpaceMountRecord, groupId: string) => qualified(sourceGroupPrefix, target, groupId)
export const isOriginalSourceWorkspaceProjection = (workspaceId: string) => workspaceId.startsWith(sourceWorkspacePrefix)
type SourceProjectionState = { tabs: Record<string, Pick<WorkbenchTab, 'workspaceId' | 'source'>>; layouts: Record<string, WorkspaceLayout> }
export function preserveOriginalSourceProjection<C extends SourceProjectionState, R extends { tabs: C['tabs']; layouts: Record<string, WorkspaceLayout> }>(current: C, restored: R): R {
  const tabs = Object.fromEntries(Object.entries(current.tabs).filter(([, tab]) => tab.source)) as C['tabs']
  const workspaceIds = new Set([...Object.values(tabs).map(tab => tab.workspaceId), ...Object.keys(current.layouts).filter(isOriginalSourceWorkspaceProjection)])
  const layouts = Object.fromEntries(Object.entries(current.layouts).filter(([workspaceId]) => workspaceIds.has(workspaceId)))
  return { ...restored, tabs: { ...restored.tabs, ...tabs }, layouts: { ...restored.layouts, ...layouts } }
}
const sourceAddress = (target: SpaceMountRecord, tabId: string) => ({ reference: { ...target.reference }, zoneId: target.zoneId, workspaceId: target.workspaceId, tabId })

function projectRegionLayout(layout: WorkbenchViewLayout, target: SpaceMountRecord): WorkbenchViewLayout {
  const region = (regionId: string) => originalSourceRegionProjectionId(target, regionId)
  const node = (current: WorkbenchViewLayout['root']): WorkbenchViewLayout['root'] => current.type === 'leaf'
    ? { ...current, regionId: region(current.regionId) }
    : { ...current, first: node(current.first), second: node(current.second) }
  const activeRegionId = layout.activeRegionId
  return { ...layout, root: node(layout.root), activeRegionId: activeRegionId ? region(activeRegionId) : activeRegionId }
}
function projectWorkspaceLayout(layout: WorkspaceLayout, target: SpaceMountRecord): WorkspaceLayout {
  const tab = (tabId: string) => originalSourceTabProjectionId(target, tabId)
  const group = (groupId: string) => originalSourceGroupProjectionId(target, groupId)
  const node = (current: WorkspaceLayout['root']): WorkspaceLayout['root'] => current.type === 'leaf'
    ? { ...current, groupId: group(current.groupId) }
    : { ...current, first: node(current.first), second: node(current.second) }
  return { ...layout, root: node(layout.root), activeGroupId: group(layout.activeGroupId),
    groups: layout.groups.map(item => ({ ...item, id: group(item.id), activeTabId: item.activeTabId ? tab(item.activeTabId) : null,
      tabOrder: item.tabOrder.map(tab), recentTabIds: item.recentTabIds.map(tab) })) }
}
function sourceViewLayout(snapshot: Pick<SpaceSnapshot, 'scope'>, target: SpaceMountRecord, tabId: string): WorkbenchViewLayout {
  const regionIds = snapshot.scope.tabs.find(tab => tab.tabId === tabId)?.regionIds ?? []
  const first = regionIds[0]
  if (!first) return createWorkbenchViewLayout(originalSourceRegionProjectionId(target, 'unavailable'))
  let layout = createWorkbenchViewLayout(originalSourceRegionProjectionId(target, first))
  for (const regionId of regionIds.slice(1)) layout = splitWorkbenchRegion(layout, layout.activeRegionId, 'right', originalSourceRegionProjectionId(target, regionId))
  return layout
}
function projectedSourceTab(target: SpaceMountRecord, snapshot: Pick<SpaceSnapshot, 'scope'>, tabId: string, layout: WorkbenchViewLayout): WorkbenchTab | undefined {
  const tab = snapshot.scope.tabs.find(candidate => candidate.tabId === tabId && candidate.zoneId === target.zoneId && candidate.workspaceId === target.workspaceId)
  if (!tab) return undefined
  const id = originalSourceTabProjectionId(target, tabId), workspaceId = originalSourceWorkspaceId(target), source = sourceAddress(target, tabId)
  const regions: WorkbenchTab['regions'] = {}
  for (const originalRegionId of tab.regionIds) {
    const region = snapshot.scope.regions.find(candidate => candidate.tabId === tabId && candidate.regionId === originalRegionId)
    if (!region) continue
    const regionId = originalSourceRegionProjectionId(target, originalRegionId), source = { ...sourceAddress(target, tabId), regionId: originalRegionId,
      ...(region.agentSessionId ? { agentSessionId: region.agentSessionId } : {}), ...(region.runId ? { runId: region.runId } : {}) }
    const base = { regionId, workspaceId, source }
    if (region.kind === 'agent' && region.agentSessionId) regions[regionId] = { ...base, kind: 'agent', phase: 'attached',
      sessionId: originalSourceSessionId(target, tabId, originalRegionId, region.agentSessionId) }
    else if (region.kind === 'file' && region.file) regions[regionId] = { ...base, kind: 'file',
      workspaceId: originalSourceFileWorkspaceId(target, region.file.workspaceId), path: region.file.path }
    else if (region.kind === 'launcher') regions[regionId] = { ...base, kind: 'launcher' }
    else regions[regionId] = { ...base, kind: 'launcher', sourceUnavailable: { kind: region.kind,
      issue: 'This original Surface cannot be controlled through the ordinary local owner. Its source reference and private input are retained.' } }
  }
  return { id, workspaceId, titleRegionId: tab.regionIds[0] ? originalSourceRegionProjectionId(target, tab.regionIds[0]) : '', layout, regions,
    source, space: { spaceId: target.reference.spaceId, zoneId: target.zoneId }, ...(tab.name === null ? {} : { name: tab.name }) }
}
function legacyLauncherId(target: SpaceMountRecord) { return 'original-source-launcher:' + JSON.stringify([target.reference.runtimeId, target.reference.spaceId, target.zoneId]) }

/** Reconcile only view state. Original Core snapshots never enter the observer Core graph or Session map. */
export function reconcileOriginalSourceProjection<T extends OriginalSpaceSelectionState & {
  tabs: Record<string, WorkbenchTab>; layouts: Record<string, WorkspaceLayout>; activeWorkspaceId?: string | null | undefined
}>(state: T, target: SpaceMountRecord, snapshot: Pick<SpaceSnapshot, 'scope'>): Partial<T> {
  const key = spaceMountKey(target.reference), workspaceId = originalSourceWorkspaceId(target), currentLayout = state.layouts[workspaceId]
  let savedView: SpaceMountView | undefined
  try { savedView = (mountedSpaceInput(state.mountedSpaceInputs, key) as (MountedSpaceInput & { view?: SpaceMountView }) | undefined)?.view } catch { savedView = undefined }
  const sourceTabs = snapshot.scope.tabs.filter(tab => tab.zoneId === target.zoneId && tab.workspaceId === target.workspaceId)
  const wanted = new Set(sourceTabs.map(tab => originalSourceTabProjectionId(target, tab.tabId)))
  const launcherId = originalSourceLauncherTabId(target), retainedLaunchers = Object.values(state.tabs).filter(tab => tab.id === launcherId && tab.source?.tabId.startsWith('new-work:'))
  if (!currentLayout && savedView?.tabLayouts[legacyLauncherId(target)] && !retainedLaunchers.length) {
    const tabId = 'new-work:' + target.zoneId, source = sourceAddress(target, tabId), regionId = 'new-work'
    retainedLaunchers.push({ id: launcherId, workspaceId, titleRegionId: originalSourceRegionProjectionId(target, regionId),
      layout: projectRegionLayout(savedView.tabLayouts[legacyLauncherId(target)]!, target),
      regions: { [originalSourceRegionProjectionId(target, regionId)]: { regionId: originalSourceRegionProjectionId(target, regionId), kind: 'launcher', workspaceId,
        source: { ...source, regionId } } }, source, space: { spaceId: target.reference.spaceId, zoneId: target.zoneId }, name: 'New work' })
  }
  const initialLayout = currentLayout ?? (savedView ? projectWorkspaceLayout(savedView.composition, target) : createWorkspaceLayout(originalSourceGroupProjectionId(target, 'original-group'), sourceTabs.map(tab => originalSourceTabProjectionId(target, tab.tabId))))
  let composition = initialLayout
  const privateIds = new Set(retainedLaunchers.map(tab => tab.id))
  for (const group of initialLayout.groups) for (const tabId of group.tabOrder) if (!wanted.has(tabId) && !privateIds.has(tabId)) composition = removeTabOccurrence(composition, group.id, tabId)
  for (const tab of sourceTabs) {
    const id = originalSourceTabProjectionId(target, tab.tabId)
    if (!composition.groups.some(group => group.tabOrder.includes(id))) composition = addTabOccurrence(composition, composition.activeGroupId, id) ?? composition
  }
  for (const id of privateIds) if (!composition.groups.some(group => group.tabOrder.includes(id))) composition = addTabOccurrence(composition, composition.activeGroupId, id) ?? composition
  const tabs = Object.fromEntries(Object.entries(state.tabs).filter(([, tab]) => !(tab.source && tab.source.reference.runtimeId === target.reference.runtimeId &&
    tab.source.reference.spaceId === target.reference.spaceId && tab.source.zoneId === target.zoneId && tab.source.workspaceId === target.workspaceId && !privateIds.has(tab.id))))
  for (const tab of sourceTabs) {
    const id = originalSourceTabProjectionId(target, tab.tabId), existing = state.tabs[id]
    const layout = existing?.layout ?? (savedView?.tabLayouts[tab.tabId] ? projectRegionLayout(savedView.tabLayouts[tab.tabId]!, target) : sourceViewLayout(snapshot, target, tab.tabId))
    const projected = projectedSourceTab(target, snapshot, tab.tabId, layout)
    if (projected) tabs[id] = projected
  }
  for (const tab of retainedLaunchers) tabs[tab.id] = tab
  const selection = state.workbenchSpaceSelection
  const selectedHere = selection?.sourceRuntimeId === target.reference.runtimeId && selection.spaceId === target.reference.spaceId && selection.zoneId === target.zoneId
  const activeGroup = composition.groups.find(group => group.id === composition.activeGroupId)
  const activeTabId = selection?.tabId == null ? activeGroup?.activeTabId ?? activeGroup?.tabOrder.find(id => tabs[id]) : undefined
  const selectedTab = selectedHere && selection ? selection.tabId ? tabs[selection.tabId] : activeTabId ? tabs[activeTabId] : undefined : undefined
  const selectedGroup = selectedTab ? composition.groups.find(group => group.tabOrder.includes(selectedTab.id)) : undefined
  const selectedRegion = selectedTab && selection ? selection.regionId && selectedTab.regions[selection.regionId] ? selection.regionId : selectedTab.layout.activeRegionId : null
  if (selectedTab && selectedGroup && (composition.activeGroupId !== selectedGroup.id || selectedGroup.activeTabId !== selectedTab.id)) composition = activateLayoutTab(composition, selectedGroup.id, selectedTab.id)
  const nextSelection = selectedHere && selection ? { ...selection, workspaceId, tabId: selectedTab?.id ?? null, groupId: selectedGroup?.id ?? null, regionId: selectedRegion } : selection
  const mountedSpaceInputs = savedView ? editMountedSpaceInput(state.mountedSpaceInputs, key, current => {
    const { view: _migrated, ...retained } = current as MountedSpaceInput & { view?: SpaceMountView }
    return retained
  }) : state.mountedSpaceInputs
  return { tabs, layouts: { ...state.layouts, [workspaceId]: composition }, mountedSpaceInputs,
    ...(selectedHere || state.activeWorkspaceId === target.workspaceId ? { activeWorkspaceId: workspaceId } : {}),
    ...(nextSelection !== selection ? { workbenchSpaceSelection: nextSelection } : {}) } as Partial<T>
}

const readableEntryCache = new WeakMap<object, Map<string, OriginalSourceEntry | undefined>>()
const selectionEntryCache = new WeakMap<object, Map<string, OriginalSourceEntry | undefined>>()
function cached<T extends object>(store: WeakMap<object, Map<string, OriginalSourceEntry | undefined>>, value: T, key: string, read: () => OriginalSourceEntry | undefined) {
  let values = store.get(value)
  if (!values) { values = new Map(); store.set(value, values) }
  if (values!.has(key)) return values!.get(key)
  const result = read()
  values!.set(key, result)
  return result
}
function readableEntry(value: unknown, key: string): OriginalSourceEntry | undefined {
  if (value && typeof value === 'object') return cached(readableEntryCache, value, key, () => {
    try {
      const target = mountedSpaceTarget(value, key)
      if (!target) return undefined
      try { return { key, target, input: mountedSpaceInput(value, key) } }
      catch (cause) { return { key, target, input: undefined, issue: cause instanceof Error ? cause.message : String(cause) } }
    } catch { return undefined }
  })
  try {
    const target = mountedSpaceTarget(value, key)
    if (!target) return undefined
    try { return { key, target, input: mountedSpaceInput(value, key) } }
    catch (cause) { return { key, target, input: undefined, issue: cause instanceof Error ? cause.message : String(cause) } }
  } catch { return undefined }
}
export function originalSourceEntryForSelection(state: OriginalSpaceSelectionState, workspaceId = state.workbenchSpaceSelection?.workspaceId): OriginalSourceEntry | undefined {
  const choice = state.workbenchSpaceSelection
  if (!choice?.spaceId || !choice.zoneId || !workspaceId) return undefined
  try {
    const cacheKey = JSON.stringify([choice.spaceId, choice.zoneId, workspaceId, choice.sourceRuntimeId ?? null])
    const read = () => {
      const matches = Object.keys(mountedSpaceInputs(state.mountedSpaceInputs)).flatMap(key => {
        const entry = readableEntry(state.mountedSpaceInputs, key)
        return entry && entry.target.reference.runtimeId !== '' && (!choice.sourceRuntimeId || entry.target.reference.runtimeId === choice.sourceRuntimeId) &&
          entry.target.reference.spaceId === choice.spaceId && entry.target.zoneId === choice.zoneId &&
          (entry.target.workspaceId === workspaceId || originalSourceWorkspaceId(entry.target) === workspaceId) ? [entry] : []
      })
      return matches.length === 1 ? matches[0] : undefined
    }
    return state.mountedSpaceInputs && typeof state.mountedSpaceInputs === 'object'
      ? cached(selectionEntryCache, state.mountedSpaceInputs, cacheKey, read) : read()
  } catch { return undefined }
}
export function originalSourceEntryByKey(state: Pick<OriginalSpaceSelectionState, 'mountedSpaceInputs'>, key: string): OriginalSourceEntry | undefined {
  return readableEntry(state.mountedSpaceInputs, key)
}
function graphFolder(target: SpaceMountRecord, graph: AgentMuxSpatialGraph | null | undefined, workspaceId: string): FolderSpaceResource | undefined {
  if (!graph) return undefined
  const scope = originalSourceScopeFromGraph(target, graph)
  const direct = scope ? snapshotResource(target, scope, workspaceId) : undefined
  if (direct) return direct
  const matches = folderDirectoryFacts(graph).folders.filter(fact => fact.runtimeId === target.reference.runtimeId && fact.spaceId === target.reference.spaceId &&
    fact.zoneId === target.zoneId && fact.resource.id === workspaceId)
  return matches.length === 1 ? matches[0]!.resource : undefined
}
export function originalSourceScopeFromGraph(target: SpaceMountRecord, graph: AgentMuxSpatialGraph): Pick<SpaceSnapshot, 'reference' | 'scope'> | undefined {
  const space = graph.spaces.find(candidate => candidate.spaceId === target.reference.spaceId)
  const bindings = graph.bindings.filter(binding => binding.spaceId === target.reference.spaceId), zoneIds = new Set(bindings.map(binding => binding.zoneId))
  if (!space || !zoneIds.has(target.zoneId)) return undefined
  const zones = graph.zones.filter(zone => zoneIds.has(zone.zoneId))
  if (!zones.some(zone => zone.zoneId === target.zoneId && zone.workspaceId === target.workspaceId)) return undefined
  const tabs = graph.tabs.filter(tab => tab.zoneId !== null && zoneIds.has(tab.zoneId)), tabIds = new Set(tabs.map(tab => tab.tabId))
  return { reference: { ...target.reference }, scope: { space, zones, tabs, regions: graph.regions.filter(region => tabIds.has(region.tabId)), bindings } }
}
function snapshotResource(target: SpaceMountRecord, snapshot: Pick<SpaceSnapshot, 'reference' | 'scope'> | undefined, workspaceId = target.workspaceId): FolderSpaceResource | undefined {
  if (!snapshot || snapshot.reference.runtimeId !== target.reference.runtimeId || snapshot.reference.spaceId !== target.reference.spaceId) return undefined
  const space = snapshot.scope.space, zones = snapshot.scope.zones.filter(zone => zone.workspaceId === workspaceId && snapshot.scope.bindings.some(binding => binding.spaceId === target.reference.spaceId && binding.zoneId === zone.zoneId))
  const zone = zones.length === 1 ? zones[0] : undefined
  if (!space || space.kind !== 'folder' || !zone || zone.hostId === null || zone.directoryPath === null) return undefined
  return { id: workspaceId, hostId: zone.hostId, path: zone.directoryPath, name: space.name, kind: zone.kind === 'worktree' ? 'worktree' : 'folder',
    ...(space.directoryPath !== zone.directoryPath ? { repoPath: space.directoryPath } : {}), ...(zone.branch ? { branch: zone.branch } : {}) }
}
export function originalSpaceResource(state: OriginalSpaceSelectionState, target: SpaceMountRecord, workspaceId = target.workspaceId, graph?: AgentMuxSpatialGraph | null): FolderSpaceResource | undefined {
  const entry = originalSourceEntryByKey(state, spaceMountKey(target.reference))
  const resource = graphFolder(target, graph, workspaceId)
  if (resource) return resource
  const observation = state.mountedSpaceObservations?.[spaceMountKey(target.reference)]
  const observed = snapshotResource(target, observation?.snapshot ?? observation?.lastPresentSnapshot, workspaceId)
  if (observed) return observed
  return entry?.input?.resource && entry.input.resource.id === workspaceId ? entry.input.resource : undefined
}
const sourceFilePrefix = 'original-source-file:'
export function originalSourceFileWorkspaceId(target: SpaceMountRecord, workspaceId = target.workspaceId): string {
  return sourceFilePrefix + JSON.stringify([target.reference.runtimeId, target.reference.spaceId, workspaceId])
}
export function isOriginalSourceFileWorkspace(workspaceId: string): boolean { return workspaceId.startsWith(sourceFilePrefix) }
function rawSourceFileWorkspaceId(workspaceId: string): string | undefined {
  if (!workspaceId.startsWith(sourceFilePrefix)) return undefined
  try { const parsed = JSON.parse(workspaceId.slice(sourceFilePrefix.length)); return Array.isArray(parsed) && parsed.length === 3 && parsed.every(value => typeof value === 'string') ? parsed[2] : undefined }
  catch { return undefined }
}
export function originalSourceFileSurface(state: OriginalSpaceSelectionState, tabId: string, regionId?: string): FileWorkbenchSurface | undefined {
  if (!regionId) return undefined
  const surface = state.tabs?.[tabId]?.regions[regionId]
  return surface?.kind === 'file' && surface.source ? surface : undefined
}
export function hasOriginalSourceFileSurface(state: OriginalSpaceSelectionState, workspaceId: string, path: string): boolean {
  return Object.values(state.tabs ?? {}).some(tab => tab.source && Object.values(tab.regions).some(surface =>
    surface.kind === 'file' && surface.workspaceId === workspaceId && surface.path === path))
}
/** Presentation resource only. The original Core owns the path and every file authority. */
export function originalSpaceWorkspace(state: OriginalSpaceSelectionState, workspaceId: string | null, graph?: AgentMuxSpatialGraph | null): WorkspaceRecord | undefined {
  if (!workspaceId) return undefined
  const selected = originalSourceEntryForSelection(state)
  if (selected) {
    const projected = workspaceId === originalSourceWorkspaceId(selected.target)
    const rawWorkspaceId = rawSourceFileWorkspaceId(workspaceId) ?? (projected ? selected.target.workspaceId : workspaceId)
    const resource = originalSpaceResource(state, selected.target, rawWorkspaceId, graph)
    if (!resource) return undefined
    const configured = state.config?.workspaces.find(workspace => workspace.id === resource.id && workspace.path === resource.path &&
      (workspace.repoPath ?? workspace.path) === (resource.repoPath ?? resource.path) && (workspace.hostId === resource.hostId || workspace.hostId === selected.target.hostId))
    if (configured && !projected) return configured
    return { ...resource, id: projected ? workspaceId : resource.id, kind: resource.kind === 'worktree' ? 'worktree' : 'folder', hostId: selected.target.hostId }
  }
  if (rawSourceFileWorkspaceId(workspaceId)) return undefined
  return state.config?.workspaces.find(workspace => workspace.id === workspaceId)
}
export function ensureOriginalSourceFilesInput(state: OriginalSpaceSelectionState, workspaceId: string, graph?: AgentMuxSpatialGraph | null): SourceFilesInputs {
  const current = state.sourceFilesInputs ?? emptySourceFilesInputs()
  const rawWorkspaceId = rawSourceFileWorkspaceId(workspaceId)
  if (!rawWorkspaceId) return current
  const selected = originalSourceEntryForSelection(state)
  if (!selected) return current
  if (current.selections[workspaceId]) return current
  const resource = originalSpaceResource(state, selected.target, rawWorkspaceId, graph)
  if (!resource) return current
  return { ...current, selections: { ...current.selections, [workspaceId]: {
    workspace: { id: rawWorkspaceId, hostId: selected.target.hostId, path: resource.path }, target: { hostId: selected.target.hostId, reference: selected.target.reference },
    selection: { kind: 'directory', path: resource.path, registration: { hostId: selected.target.hostId, reference: selected.target.reference,
      zoneId: selected.target.zoneId, workspaceId: selected.target.workspaceId } } } } }
}

export const originalSourceLauncherRegionId = 'new-work'
export function originalSourceLauncherTabId(target: SpaceMountRecord): string {
  return originalSourceTabProjectionId(target, 'new-work:' + target.zoneId)
}
export function originalSourceLauncherExecution(state: OriginalSpaceSelectionState, tabId: string | undefined, regionId: string | undefined, graph?: AgentMuxSpatialGraph | null): LauncherSourceExecution | undefined {
  const entry = originalSourceEntryForSelection(state)
  if (!entry || !tabId || !regionId) return undefined
  const tab = state.tabs?.[tabId], surface = tab?.regions[regionId], source = tab?.source
  if (!source || !surface?.source || source.reference.runtimeId !== entry.target.reference.runtimeId || source.reference.spaceId !== entry.target.reference.spaceId ||
    source.zoneId !== entry.target.zoneId || source.workspaceId !== entry.target.workspaceId || surface.kind !== 'launcher') return undefined
  const resource = originalSpaceResource(state, entry.target, source.workspaceId, graph)
  if (!resource) return undefined
  const synthetic = source.tabId === 'new-work:' + source.zoneId && surface.source.regionId === originalSourceLauncherRegionId
  if (!synthetic) {
    const key = entry.key, snapshot = state.mountedSpaceObservations?.[key]?.snapshot ?? state.mountedSpaceObservations?.[key]?.lastPresentSnapshot
    const originalTab = snapshot?.scope.tabs.find(tab => tab.tabId === source.tabId && tab.zoneId === source.zoneId && tab.workspaceId === source.workspaceId && tab.regionIds.includes(surface.source!.regionId))
    const region = snapshot?.scope.regions.find(region => region.tabId === source.tabId && region.regionId === surface.source!.regionId)
    if (!snapshot || !originalTab || region?.kind !== 'launcher') return undefined
  }
  return { project: { id: originalSourceWorkspaceId(entry.target), hostId: entry.target.hostId, path: resource.path, ...(resource.repoPath ? { repoPath: resource.repoPath } : {}) }, target: entry.target,
    agentTarget: { hostId: resource.hostId, runtimeId: entry.target.reference.runtimeId } }
}

const sourceSessionPrefix = 'original-source-member:'
export function originalSourceSessionId(target: SpaceMountRecord, tabId: string, regionId: string, agentSessionId: string): string {
  return sourceSessionPrefix + JSON.stringify([target.reference.runtimeId, target.reference.spaceId, tabId, regionId, agentSessionId])
}
function sourceObservation(state: OriginalSpaceSelectionState, key: string): SpaceSnapshot | undefined {
  const observation = state.mountedSpaceObservations?.[key]
  return observation?.snapshot?.scope.space === null ? observation.lastPresentSnapshot ?? observation.snapshot : observation?.snapshot
}
const unconfirmedSourceMember: OrdinarySpaceMember = Object.freeze({ kind: 'unconfirmed', issue: 'The original Source member occurrence is not confirmed. Its Region and unsent input are retained; no local Session was selected.' })
const sourceMemberCache = new WeakMap<SpaceSnapshot, Map<string, OrdinarySpaceMember>>()
export function originalSourceMember(state: OriginalSpaceSelectionState, reference: OrdinaryMemberReference): OrdinarySpaceMember | undefined {
  if (!reference.sessionId.startsWith(sourceSessionPrefix)) return undefined
  let parsed: unknown
  try { parsed = JSON.parse(reference.sessionId.slice(sourceSessionPrefix.length)) } catch { return unconfirmedSourceMember }
  if (!Array.isArray(parsed) || parsed.length !== 5 || !parsed.every(value => typeof value === 'string' && value.length > 0)) return unconfirmedSourceMember
  const [runtimeId, spaceId, tabId, regionId, agentSessionId] = parsed as [string, string, string, string, string]
  const key = spaceMountKey({ runtimeId, spaceId }), entry = originalSourceEntryByKey(state, key), snapshot = sourceObservation(state, key)
  if (!snapshot) return unconfirmedSourceMember
  let cache = sourceMemberCache.get(snapshot)
  if (!cache) { cache = new Map(); sourceMemberCache.set(snapshot, cache) }
  const cacheKey = JSON.stringify([entry?.target.hostId, entry?.target.zoneId, entry?.target.workspaceId, reference])
  const prior = cache.get(cacheKey)
  if (prior) return prior
  const project = (): OrdinarySpaceMember => {
    const tab = snapshot.scope.tabs.find(tab => tab.tabId === tabId), region = snapshot.scope.regions.find(region => region.tabId === tabId && region.regionId === regionId)
    const projectedTab = state.tabs?.[reference.tabId], projectedRegion = projectedTab?.regions[reference.regionId]
    const occurrenceMatches = projectedTab?.source && projectedRegion?.source
      ? projectedTab.source.tabId === tabId && projectedRegion.source.regionId === regionId && projectedRegion.source.agentSessionId === agentSessionId
      : reference.tabId === tabId && reference.regionId === regionId
    if (!entry || entry.target.reference.runtimeId !== runtimeId || entry.target.reference.spaceId !== spaceId || !tab || !region || region.kind !== 'agent' ||
      !occurrenceMatches || region.agentSessionId !== agentSessionId || !region.creationOperationId ||
      !region.execution?.runtimeId || tab.zoneId !== entry.target.zoneId || tab.workspaceId !== entry.target.workspaceId) return unconfirmedSourceMember
    const presentation = mountedSpaceRegions(snapshot).find(member => member.tab.tabId === tabId && member.region.regionId === regionId)
    if (!presentation) return unconfirmedSourceMember
    return { kind: 'foreign', source: entry.target, creationOperationId: region.creationOperationId, presentation,
      metadataMember: { hostId: region.execution.hostId, runtimeId: region.execution.runtimeId, agentSessionId },
      member: { hostId: entry.target.hostId, target: { reference: entry.target.reference, regionId, runtimeId: region.execution.runtimeId, agentSessionId, expectedRun: { runId: region.runId ?? '' } } } }
  }
  const result = project(); cache.set(cacheKey, result); return result
}

export function originalSourceActionUnavailable(state: OriginalSpaceSelectionState, workspaceId: string, action: string): Error | undefined {
  return originalSourceEntryForSelection(state, workspaceId)
    ? Error(`The original Source ${action} is unavailable here. Use the original Core controls; the local workface was not changed.`)
    : undefined
}

/** Initial Source window data only; ordinary WorkspaceWorkbench owns the actual Region tree. */
export function sourceTabLayout(regionIds: readonly string[]) {
  const first = regionIds[0]
  if (!first) return undefined
  let layout = createWorkbenchViewLayout(first)
  for (const id of regionIds.slice(1)) layout = splitWorkbenchRegion(layout, layout.activeRegionId, 'right', id)
  return layout
}
