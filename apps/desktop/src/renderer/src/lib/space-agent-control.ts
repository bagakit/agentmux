import type { AgentMuxAgentSession } from '@agentmux/core'
import type {
  AgentMuxSpaceAddress, AgentMuxSpaceAgentFact, AgentMuxSpaceCatalog, AgentMuxSpaceControlRequest,
  AgentMuxSpaceControlResult, AgentMuxSpaceDestination, AgentMuxSpaceMutationReport,
  AgentMuxSpaceSelector, AgentMuxSpatialIssue, AgentMuxSpatialSave, AgentMuxZoneFact, AgentMuxSpaceBindingReport, AgentMuxSpaceBindingTarget
} from '@agentmux/core/control'
import { mintAgentSessionId } from '@agentmux/core/agent-session-id'
import { addTabOrThrow, addTabOccurrence, createWorkspaceLayout, findGroupForTab, groupIds, regionIds,
  removeTab, replaceLeaf, type WorkspaceLayout } from '@agentmux/layout'
import type { AgentLaunchInput, AgentLaunchResult, AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { spatialSources, workspaceZoneId, homeZoneId, directoryIdentity, type SpaceZoneBindings, type SpatialRequestBinding,
  type SpaceZoneResourceInput, type SpaceZoneResourceResult } from '../../../shared/space-addresses'
import { addWorkbenchRegion, assertRegionInvariant, createWorkbenchTab, removeWorkbenchRegion,
  type AgentWorkbenchSurface, type WorkbenchTab } from './workbench-tabs'
import { resolveSpatialCommit } from './control-spatial-commit'
import { isSessionSurface } from './workbench-surface-kinds'

export type SpatialWorkbench = {
  config: AppConfig | null
  sessions: SessionSnapshot[]
  tabs: Record<string, WorkbenchTab>
  layouts: Record<string, WorkspaceLayout>
  spaceZoneBindings: SpaceZoneBindings
  spatialRequests: Record<string, SpatialRequestBinding>
}
type SpatialPatch = Partial<Pick<SpatialWorkbench, 'config' | 'tabs' | 'layouts' | 'spaceZoneBindings' | 'spatialRequests'>>
export type SpatialControlPorts = {
  get(): SpatialWorkbench
  patch(patch: SpatialPatch): void
  topics(): Promise<readonly ScratchTopicSnapshot[]>
  createResource(input: SpaceZoneResourceInput): Promise<SpaceZoneResourceResult>
  launch(input: AgentLaunchInput & { agentSessionId: string; createOperationId: string }): Promise<AgentLaunchResult>
  creation(hostId: string, sessionId: string): Promise<AgentMuxAgentSession>
  attach(regionId: string, result: AgentLaunchResult): Promise<void>
  save(layoutApplied: boolean): Promise<AgentMuxSpatialSave>
  focus(address: AgentMuxSpaceAddress): void
  isFocused(address: AgentMuxSpaceAddress): boolean
  notice(issue: AgentMuxSpatialIssue): void
  closing(tabId: string): boolean
  preserveMovedFocus?(from: AgentMuxSpaceAddress): void
}

class SpatialFailure extends Error {
  constructor(readonly issue: AgentMuxSpatialIssue) { super(issue.message) }
}
function failure(code: string, message: string, candidates?: AgentMuxSpaceSelector[]): never {
  throw new SpatialFailure({ step: 'target', code, message,
    recovery: 'Use agentmux space ls, then choose the exact Space/Zone/Tab/Region.',
    ...(candidates ? { candidates } : {}) })
}
function issue(step: string, code: string, error: unknown): AgentMuxSpatialIssue {
  return { step, code, message: error instanceof Error ? error.message : String(error),
    recovery: 'Inspect this request ID and its existing resources; do not repeat creation or send.' }
}
const unsaved = (layoutApplied = false): AgentMuxSpatialSave => ({ layoutApplied, localStorageWritten: false,
  storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'No save has been observed by this read.' })

/** Metadata only; every durable entity is indexed once, independent of display. */
export function spatialCatalog(state: SpatialWorkbench, topics: readonly ScratchTopicSnapshot[]): AgentMuxSpaceCatalog {
  const sources = spatialSources(state.config, topics, state.spaceZoneBindings,
    Object.values(state.tabs).flatMap(tab => tab.space ? [{ workspaceId: tab.workspaceId, space: tab.space }] : []))
  const catalog: AgentMuxSpaceCatalog = { ...sources, tabs: [], regions: [], locations: [] }
  const sessions = new Map(state.sessions.map(session => [session.id, session]))
  const tabs = new Map<string, AgentMuxSpaceCatalog['tabs'][number]>()
  const spacesByZone = new Map<string, string[]>()
  for (const binding of catalog.bindings) {
    const members = spacesByZone.get(binding.zoneId) ?? []
    members.push(binding.spaceId)
    spacesByZone.set(binding.zoneId, members)
  }
  for (const tab of Object.values(state.tabs)) {
    const workspace = state.config?.workspaces.find(workspace => workspace.id === tab.workspaceId)
    const source = tab.topicId ? sources.spaces.find(space => space.topicId === tab.topicId) : undefined
    const referencedZoneId = tab.space?.zoneId ?? (workspace ? tab.topicId
      ? source ? homeZoneId(source.spaceId) : null
      : tab.workspaceId === SCRATCH_WORKSPACE_ID ? homeZoneId(directoryIdentity(workspace.hostId, workspace.path))
        : workspaceZoneId(directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path), workspace.id) : null)
    const resolvedZone = sources.zones.find(zone => zone.zoneId === referencedZoneId)
    const zoneId = resolvedZone?.workspaceId === tab.workspaceId ? referencedZoneId : null
    const contextIssue = zoneId === null ? 'The original Zone membership is unknown or contradicts its resource Workspace; the Tab identity is retained.' : undefined
    const ids = regionIds(tab.layout.root).filter(id => Object.hasOwn(tab.regions, id))
    const fact = { tabId: tab.id, workspaceId: tab.workspaceId, zoneId, name: tab.name ?? null, regionIds: ids, ...(contextIssue ? { issue: contextIssue } : {}) }
    tabs.set(tab.id, fact)
    catalog.tabs.push(fact)
    for (const id of ids) {
      const surface = tab.regions[id]!
      const session = isSessionSurface(surface) ? sessions.get(surface.sessionId) : undefined
      catalog.regions.push({ tabId: tab.id, regionId: id, kind: surface.kind,
        agentSessionId: surface.kind === 'agent' ? surface.sessionId : null,
        runId: session?.control.run.runId ?? null,
        execution: session ? { hostId: session.hostId, cwd: session.workspacePath } : null })
    }
  }
  const locationIds = new Set<string>()
  for (const [displayWorkspaceId, layout] of Object.entries(state.layouts)) {
    const inTree = new Set(groupIds(layout.root))
    for (const group of layout.groups) {
      if (!inTree.has(group.id)) continue
      for (const tabId of group.tabOrder) {
        const tab = tabs.get(tabId)
        if (!tab) continue
        const members = tab.zoneId ? spacesByZone.get(tab.zoneId) ?? [] : []
        for (const spaceId of members.length ? members : [null]) for (const regionId of tab.regionIds) {
          const location = { spaceId, zoneId: tab.zoneId, workspaceId: tab.workspaceId, displayWorkspaceId, groupId: group.id, tabId, regionId }
          const key = JSON.stringify(location)
          if (!locationIds.has(key)) { locationIds.add(key); catalog.locations.push(location) }
        }
      }
    }
  }
  return catalog
}

type LooseSelector = { [K in keyof AgentMuxSpaceSelector]?: string | undefined }
function match(selector: LooseSelector, address: Partial<Record<keyof AgentMuxSpaceSelector, string | null>>): boolean {
  return Object.entries(selector).every(([key, value]) => value === undefined || address[key as keyof AgentMuxSpaceSelector] === value)
}
function checkedParent(selector: LooseSelector, actual: Partial<Record<keyof AgentMuxSpaceSelector, string | null>>): void {
  if (!match(selector, actual)) failure('SPACE_PARENT_MISMATCH', 'The supplied identity does not match this exact reference.')
}
export function selectSpatialCatalog(catalog: AgentMuxSpaceCatalog, target: AgentMuxSpaceSelector): AgentMuxSpaceCatalog {
  if (!Object.values(target).some(Boolean)) return catalog
  if (target.spaceId && !catalog.spaces.some(space => space.spaceId === target.spaceId) ||
    target.zoneId && !catalog.zones.some(zone => zone.zoneId === target.zoneId) ||
    target.tabId && !catalog.tabs.some(tab => tab.tabId === target.tabId) ||
    target.regionId && !catalog.regions.some(region => region.regionId === target.regionId)) {
    failure('SPACE_TARGET_UNKNOWN', 'The exact spatial entity is not currently known.')
  }
  const region = target.regionId ? catalog.regions.find(region => region.regionId === target.regionId) : undefined
  const tabId = target.tabId ?? region?.tabId
  if (target.tabId && region && target.tabId !== region.tabId) failure('SPACE_PARENT_MISMATCH', 'The Region is not a member of this Tab.')
  const tab = tabId ? catalog.tabs.find(tab => tab.tabId === tabId) : undefined
  if (target.zoneId && tab && target.zoneId !== tab.zoneId) failure('SPACE_PARENT_MISMATCH', 'The Tab is not a member of this Zone.')
  const zoneId = target.zoneId ?? tab?.zoneId
  const bindings = catalog.bindings.filter(binding => (!target.spaceId || binding.spaceId === target.spaceId) && (!zoneId || binding.zoneId === zoneId))
  if (target.spaceId && zoneId && !bindings.length) failure('SPACE_PARENT_MISMATCH', 'This Zone is not bound to the specified Space.')
  const zoneIds = zoneId ? new Set([zoneId]) : target.spaceId ? new Set(bindings.map(binding => binding.zoneId)) : null
  const locations = catalog.locations.filter(location => match(target, location) && (!tabId || location.tabId === tabId))
  if ((target.groupId || target.displayWorkspaceId) && !locations.length) failure('SPACE_LOCATION_UNKNOWN', 'The exact display occurrence is not currently known.')
  const locationConstrained = Boolean(target.groupId || target.displayWorkspaceId)
  const locationTabIds = new Set(locations.map(location => location.tabId))
  const selectedTabs = catalog.tabs.filter(tab => (!tabId || tab.tabId === tabId) &&
    (!zoneIds || tab.zoneId !== null && zoneIds.has(tab.zoneId)) && (!locationConstrained || locationTabIds.has(tab.tabId)))
  const selectedIds = new Set(selectedTabs.map(tab => tab.tabId))
  const selectedZoneIds = locationConstrained ? new Set(selectedTabs.flatMap(tab => tab.zoneId ? [tab.zoneId] : []))
    : zoneIds ?? new Set(selectedTabs.flatMap(tab => tab.zoneId ? [tab.zoneId] : []))
  const selectedBindings = bindings.filter(binding => selectedZoneIds.has(binding.zoneId))
  const selectedSpaceIds = new Set(selectedBindings.map(binding => binding.spaceId))
  return {
    spaces: catalog.spaces.filter(space => target.spaceId ? space.spaceId === target.spaceId : selectedSpaceIds.has(space.spaceId)),
    zones: catalog.zones.filter(zone => selectedZoneIds.has(zone.zoneId)),
    tabs: selectedTabs, regions: catalog.regions.filter(region => selectedIds.has(region.tabId) && (!target.regionId || region.regionId === target.regionId)),
    bindings: selectedBindings, locations: locations.filter(location => selectedIds.has(location.tabId))
  }
}

export function zoneContext(state: SpatialWorkbench, topics: readonly ScratchTopicSnapshot[], zone: AgentMuxZoneFact): string {
  const saved = state.spaceZoneBindings[zone.zoneId]
  if (saved) {
    if (saved.workspaceId !== zone.workspaceId) failure('SPACE_CONTEXT_UNKNOWN', 'The saved Zone context contradicts its resource Workspace; its original facts are retained.')
    if (zone.kind === 'home' && zone.hostId && zone.directoryPath && saved.spaceId !== directoryIdentity(zone.hostId, zone.directoryPath)) {
      failure('SPACE_CONTEXT_UNKNOWN', 'The saved home context contradicts its confirmed resource; its original facts are retained.')
    }
    return saved.spaceId
  }
  const original = spatialSources(state.config, topics).bindings.find(binding => binding.zoneId === zone.zoneId)
  if (original) return original.spaceId
  const retained = new Set(Object.values(state.tabs).flatMap(tab => tab.space?.zoneId === zone.zoneId ? [tab.space.spaceId] : []))
  if (retained.size === 1) return [...retained][0]!
  return failure('SPACE_CONTEXT_UNKNOWN', 'The original Zone resource context cannot currently be confirmed. Its entity and bindings are retained.')
}

export async function createSpatialZone(ports: Pick<SpatialControlPorts, 'get' | 'patch' | 'topics' | 'save' | 'notice'>,
  input: { workspaceId: string; spaceIds: readonly string[] }): Promise<{ zone: AgentMuxZoneFact; save: AgentMuxSpatialSave; issues: AgentMuxSpatialIssue[] }> {
  const notices: AgentMuxSpatialIssue[] = []
  let topics: readonly ScratchTopicSnapshot[] = []
  try { topics = await ports.topics() } catch (error) { const notice = issue('discovery', 'SPACE_DISCOVERY_UNCONFIRMED', error); notices.push(notice); ports.notice(notice) }
  const workspace = ports.get().config?.workspaces.find(workspace => workspace.id === input.workspaceId)
  if (!workspace) failure('SPACE_RESOURCE_UNKNOWN', 'Choose an existing resource Workspace before creating a Zone.')
  const catalog = spatialCatalog(ports.get(), topics)
  for (const spaceId of input.spaceIds) if (!catalog.spaces.some(space => space.spaceId === spaceId)) failure('SPACE_TARGET_UNKNOWN', 'The exact initial Space is not known.')
  const spaceId = directoryIdentity(workspace.hostId, workspace.repoPath ?? workspace.path)
  const zoneId = `zone:${crypto.randomUUID()}`
  ports.patch({ spaceZoneBindings: { ...ports.get().spaceZoneBindings, [zoneId]: {
    workspaceId: workspace.id, spaceId, relations: { [spaceId]: false, ...Object.fromEntries(input.spaceIds.map(id => [id, true])) }
  } } })
  const zone = spatialCatalog(ports.get(), topics).zones.find(zone => zone.zoneId === zoneId)!
  let saved: AgentMuxSpatialSave
  try { saved = await ports.save(true) }
  catch (error) { saved = { ...unsaved(true), reason: error instanceof Error ? error.message : String(error) } }
  if (saved.reason) { const notice = issue('save', 'SPACE_SAVE_UNCONFIRMED', saved.reason); notices.push(notice); ports.notice(notice) }
  return { zone, save: saved, issues: notices }
}

async function executeBinding(ports: SpatialControlPorts, topics: readonly ScratchTopicSnapshot[], request: Extract<AgentMuxSpaceControlRequest, { binding: AgentMuxSpaceBindingTarget }>): Promise<AgentMuxSpaceControlResult> {
  const linked = request.operation === 'space.bind', target = request.binding
  let catalog = spatialCatalog(ports.get(), topics)
  const result: AgentMuxSpaceBindingReport = { requestId: request.requestId, binding: target, outcome: 'unknown', catalog, save: unsaved(), issues: [] }
  try {
    if (target.kind === 'zone-space') {
      const zone = catalog.zones.find(zone => zone.zoneId === target.zoneId)
      if (!zone || !catalog.spaces.some(space => space.spaceId === target.spaceId)) failure('SPACE_TARGET_UNKNOWN', 'Choose the exact existing Zone and Space.')
      const exists = catalog.bindings.some(binding => binding.zoneId === target.zoneId && binding.spaceId === target.spaceId)
      if (exists === linked) { result.outcome = 'unchanged'; return { operation: request.operation, ...result } }
      const state = ports.get(), previous = state.spaceZoneBindings[target.zoneId]
      ports.patch({ spaceZoneBindings: { ...state.spaceZoneBindings, [target.zoneId]: {
        ...(previous ?? { workspaceId: zone.workspaceId, spaceId: zoneContext(state, topics, zone) }),
        relations: { ...previous?.relations, [target.spaceId]: linked }
      } } })
    } else {
      const state = ports.get(), layout = state.layouts[target.displayWorkspaceId]
      if (!state.tabs[target.tabId] || !layout || !groupIds(layout.root).includes(target.groupId) || !layout.groups.some(group => group.id === target.groupId)) failure('SPACE_LOCATION_UNKNOWN', 'Choose an existing Tab and exact display Group.')
      const exists = layout.groups.find(group => group.id === target.groupId)!.tabOrder.includes(target.tabId)
      if (exists === linked) { result.outcome = 'unchanged'; return { operation: request.operation, ...result } }
      const next = linked ? addTabOccurrence(layout, target.groupId, target.tabId)! : removeTab(layout, target.groupId, target.tabId)
      // Removing a display reference never calls closeTab or deletes the entity.
      ports.patch({ layouts: { ...state.layouts, [target.displayWorkspaceId]: next } })
    }
    catalog = spatialCatalog(ports.get(), topics)
    result.catalog = selectSpatialCatalog(catalog, target.kind === 'zone-space' ? { zoneId: target.zoneId } : { tabId: target.tabId })
    result.outcome = linked ? 'linked' : 'unlinked'
    try { result.save = await ports.save(true) } catch (error) { result.save = { ...unsaved(true), reason: error instanceof Error ? error.message : String(error) } }
    if (result.save.reason) { const notice = issue('save', 'SPACE_SAVE_UNCONFIRMED', result.save.reason); result.issues.push(notice); ports.notice(notice) }
  } catch (error) {
    const notice = error instanceof SpatialFailure ? error.issue : issue('binding', 'SPACE_BINDING_UNCONFIRMED', error)
    result.issues.push(notice); ports.notice(notice)
  }
  return { operation: request.operation, ...result }
}

type Destination = { address: AgentMuxSpaceAddress; kind: 'new-tab' | 'empty' | 'split'; anchor?: string; split?: AgentMuxSpaceDestination['split'] }
function exactDisplayLayout(layouts: Readonly<Record<string, WorkspaceLayout>>, displayWorkspaceId: string, groupId?: string): WorkspaceLayout {
  const layout = layouts[displayWorkspaceId]
  if (!layout || groupId && (!groupIds(layout.root).includes(groupId) || !layout.groups.some(group => group.id === groupId))) {
    failure('SPACE_LOCATION_UNKNOWN', 'The requested display Workspace or Group is not available.')
  }
  return layout
}
export function spatialDestination(catalog: AgentMuxSpaceCatalog, dest: AgentMuxSpaceDestination,
  mint: { tabId: string; regionId: string }, layouts: Readonly<Record<string, WorkspaceLayout>>): Destination {
  const selected = selectSpatialCatalog(catalog, { ...(dest.spaceId ? { spaceId: dest.spaceId } : {}),
    ...(dest.zoneId ? { zoneId: dest.zoneId } : {}), ...(dest.tabId ? { tabId: dest.tabId } : {}), ...(dest.regionId ? { regionId: dest.regionId } : {}) })
  if (dest.regionId || dest.tabId) {
    if (dest.newTab) failure('SPACE_TARGET_CONFLICT', 'A new Tab cannot also target an existing Tab/Region.')
    const tab = dest.tabId ? selected.tabs.find(tab => tab.tabId === dest.tabId)
      : selected.tabs.find(tab => tab.tabId === selected.regions.find(region => region.regionId === dest.regionId)?.tabId)
    if (!tab) failure('SPACE_TARGET_UNKNOWN', 'The exact Tab is not known.')
    const regions = selected.regions.filter(region => region.tabId === tab.tabId)
    const region = dest.regionId ? regions.find(region => region.regionId === dest.regionId) : regions.filter(region => region.kind === 'launcher').length === 1 && !dest.split ? regions.find(region => region.kind === 'launcher') : undefined
    if (!region) failure('SPACE_REGION_REQUIRED', 'Choose one exact Region.', regions.map(region => ({ tabId: tab.tabId, regionId: region.regionId })))
    if (!dest.split && region.kind !== 'launcher') failure('SPACE_REGION_OCCUPIED', 'Use an empty Region or an explicit split.')
    const candidates = selected.locations.filter(location => location.tabId === tab.tabId && location.regionId === region.regionId &&
      (!dest.displayWorkspaceId || location.displayWorkspaceId === dest.displayWorkspaceId) && (!dest.groupId || location.groupId === dest.groupId))
    if (candidates.length !== 1) failure('SPACE_LOCATION_REQUIRED', 'Choose the exact display Workspace, Group and Space reference.',
      candidates.map(({ spaceId, zoneId, tabId, regionId, displayWorkspaceId, groupId }) => ({ ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), tabId, regionId, displayWorkspaceId, groupId })))
    return { address: { ...candidates[0]!, regionId: dest.split ? mint.regionId : region.regionId },
      kind: dest.split ? 'split' : 'empty', anchor: region.regionId, ...(dest.split ? { split: dest.split } : {}) }
  }
  if (dest.split) failure('SPACE_REGION_REQUIRED', 'A split requires an exact Region.')
  if (selected.zones.length !== 1) failure('SPACE_ZONE_REQUIRED', 'Choose one exact Zone.', selected.zones.map(zone => ({ ...(dest.spaceId ? { spaceId: dest.spaceId } : {}), zoneId: zone.zoneId })))
  const zone = selected.zones[0]!
  const members = selected.bindings.filter(binding => binding.zoneId === zone.zoneId)
  if (!dest.spaceId && members.length > 1) failure('SPACE_LOCATION_REQUIRED', 'Choose the exact Space reference for this Zone.', members.map(binding => binding))
  const displayWorkspaceId = dest.displayWorkspaceId ?? zone.workspaceId
  const layout = dest.displayWorkspaceId ? exactDisplayLayout(layouts, displayWorkspaceId, dest.groupId) : layouts[displayWorkspaceId]
  if (dest.groupId && (!layout || !groupIds(layout.root).includes(dest.groupId))) failure('SPACE_LOCATION_UNKNOWN', 'The requested Group is not available.')
  const groupId = dest.groupId ?? layout?.activeGroupId ?? `group:${crypto.randomUUID()}`
  return { kind: 'new-tab', address: { spaceId: dest.spaceId ?? members[0]?.spaceId ?? null, zoneId: zone.zoneId,
    workspaceId: zone.workspaceId, displayWorkspaceId, groupId, ...mint } }
}

/** One workbench snapshot. Moves detach precisely one leaf; neither Session nor Runtime is touched. */
export function applySpatialPlacement(state: SpatialWorkbench, topics: readonly ScratchTopicSnapshot[], target: Destination,
  surface: AgentWorkbenchSurface, from?: AgentMuxSpaceAddress): Pick<SpatialWorkbench, 'tabs' | 'layouts'> {
  let tabs = { ...state.tabs }
  let layouts = { ...state.layouts }
  if (from) {
    const source = tabs[from.tabId]
    if (!source || source.regions[from.regionId]?.kind !== 'agent' ||
      (source.regions[from.regionId] as AgentWorkbenchSurface).sessionId !== surface.sessionId) failure('SPACE_SOURCE_CHANGED', 'The exact source binding changed before move.')
    const remainder = removeWorkbenchRegion(source, from.regionId)
    if (remainder) tabs[source.id] = remainder
    else {
      delete tabs[source.id]
      for (const [workspaceId, layout] of Object.entries(layouts)) {
        let next = layout
        for (const group of layout.groups) if (group.tabOrder.includes(source.id)) next = removeTab(next, group.id, source.id)
        layouts[workspaceId] = next
      }
    }
  }
  const address = target.address
  const placed = { ...surface, workspaceId: address.workspaceId, regionId: address.regionId }
  if (target.kind === 'new-tab') {
    if (tabs[address.tabId]) failure('SPACE_TARGET_CHANGED', 'The reserved Tab ID already exists.')
    const catalog = spatialCatalog(state, topics), zone = catalog.zones.find(zone => zone.zoneId === address.zoneId)!
    const sourceSpaceId = zoneContext(state, topics, zone)
    const sourceTopic = zone.kind === 'home' ? catalog.spaces.find(item => item.spaceId === sourceSpaceId)?.topicId : undefined
    tabs[address.tabId] = { ...createWorkbenchTab(address.tabId, placed),
      space: { spaceId: sourceSpaceId, zoneId: address.zoneId! }, ...(sourceTopic ? { topicId: sourceTopic } : {}) }
    let layout = layouts[address.displayWorkspaceId] ?? createWorkspaceLayout(address.groupId)
    const groupId = address.groupId
    const previousLayout = layout
    layout = addTabOrThrow(layout, groupId, address.tabId)
    layout = { ...layout, activeGroupId: previousLayout.activeGroupId, groups: layout.groups.map(group => {
      const previous = previousLayout.groups.find(item => item.id === group.id)
      return previous?.activeTabId ? { ...group, activeTabId: previous.activeTabId, recentTabIds: previous.recentTabIds } : group
    }) }
    layouts[address.displayWorkspaceId] = layout
  } else {
    const tab = tabs[address.tabId]
    if (!tab || !target.anchor || !tab.regions[target.anchor]) failure('SPACE_TARGET_CHANGED', 'The target Region disappeared before placement.')
    if (target.kind === 'split') {
      const oldActive = tab.layout.activeRegionId
      const direction = target.split === 'above' ? 'up' : target.split === 'below' ? 'down' : target.split!
      const next = addWorkbenchRegion(tab, target.anchor, direction, placed)
      if (next === tab) failure('SPACE_TARGET_CHANGED', 'The split could not be applied.')
      tabs[tab.id] = { ...next, layout: { ...next.layout, activeRegionId: oldActive } }
    } else {
      if (tab.regions[target.anchor]!.kind !== 'launcher') failure('SPACE_REGION_OCCUPIED', 'The target is now occupied; its content was preserved.')
      const regions = { ...tab.regions }
      delete regions[target.anchor]
      regions[address.regionId] = placed
      tabs[tab.id] = { ...tab, regions,
        titleRegionId: tab.titleRegionId === target.anchor ? address.regionId : tab.titleRegionId,
        layout: { root: replaceLeaf(tab.layout.root, leaf => leaf.regionId, target.anchor, { type: 'leaf', regionId: address.regionId }),
          activeRegionId: tab.layout.activeRegionId === target.anchor ? address.regionId : tab.layout.activeRegionId } }
    }
  }
  for (const id of new Set([from?.tabId, address.tabId])) if (id && tabs[id]) assertRegionInvariant(tabs[id]!)
  return { tabs, layouts }
}

function agentFact(session: AgentMuxAgentSession): AgentMuxSpaceAgentFact {
  return { agentSessionId: session.agentSessionId, runId: session.run.runId, providerId: session.providerId,
    executorId: session.executorId, hostId: session.hostId, cwd: session.workspacePath,
    createOperationId: session.creation?.createOperationId ?? null, initialPrompt: session.creation?.initialPrompt ?? 'unknown' }
}
function snapshotFact(session: Extract<SessionSnapshot, { kind: 'agent' }>): AgentMuxSpaceAgentFact {
  return { agentSessionId: session.id, runId: session.control.run.runId, providerId: session.providerId,
    executorId: session.executorId, hostId: session.hostId, cwd: session.workspacePath,
    createOperationId: session.creation?.createOperationId ?? null, initialPrompt: session.creation?.initialPrompt ?? 'unknown' }
}
function addressOf(catalog: AgentMuxSpaceCatalog, regionId: string, target: LooseSelector = {}): AgentMuxSpaceAddress | null {
  const locations = catalog.locations.filter(location => location.regionId === regionId && match(target, location))
  return locations.length === 1 ? locations[0]! : null
}
async function digest(input: unknown): Promise<string> {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical(input))))
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
async function reconcile(ports: SpatialControlPorts, topics: readonly ScratchTopicSnapshot[], binding: SpatialRequestBinding): Promise<AgentMuxSpaceMutationReport> {
  const state = ports.get()
  const catalog = spatialCatalog(state, topics)
  const region = catalog.regions.find(item => item.regionId === binding.regionId && item.agentSessionId === binding.agentSessionId)
  const requestedLocation = region ? addressOf(catalog, region.regionId, binding.target) : null
  const to = requestedLocation ?? (region ? addressOf(catalog, region.regionId) : null)
  const atTarget = Boolean(requestedLocation && requestedLocation.tabId === binding.tabId)
  const snapshot = state.sessions.find((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.id === binding.agentSessionId && session.kind === 'agent')
  let agent: AgentMuxSpaceAgentFact | null = snapshot ? snapshotFact(snapshot) : null
  const issues: AgentMuxSpatialIssue[] = []
  if (binding.createAgent) {
    const hostId = snapshot?.hostId ?? binding.executionHostId ?? binding.resource?.hostId ?? catalog.zones.find(item => item.zoneId === binding.target.zoneId)?.hostId
    if (hostId) try { agent = agentFact(await ports.creation(hostId, binding.agentSessionId)) }
    catch (error) { issues.push(issue('creation-read', 'AGENT_CREATION_UNKNOWN', error)) }
  }
  const workspace = binding.resource && state.config?.workspaces.find(item => item.hostId === binding.resource!.hostId && item.path === binding.resource!.path)
  const resource = binding.resource ? { hostId: binding.resource.hostId, path: binding.resource.path,
    kind: binding.resource.kind, branch: binding.resource.branch, workspaceId: workspace?.id ?? null } : null
  if (!atTarget) issues.push(issue('layout-read', 'SPACE_PLACEMENT_UNKNOWN', 'The request has a durable correlation, but its reserved target placement is not observed. Its current Region location is returned without claiming completion.'))
  if (agent?.initialPrompt === 'unconfirmed' || agent?.initialPrompt === 'unknown' && binding.createAgent) {
    issues.push(issue('first-prompt', 'INITIAL_PROMPT_UNCONFIRMED', 'Core has not confirmed the original first prompt protocol.'))
  }
  const unchanged = binding.from && binding.target.tabId === binding.from.tabId && binding.target.regionId === binding.from.regionId
  return { requestId: binding.requestId, outcome: atTarget && agent && issues.length === 0 ? binding.operation === 'space.mv' ? unchanged ? 'unchanged' : 'moved' : 'opened' : 'unknown',
    from: binding.from ?? null, to, agent, resource, save: unsaved(Boolean(to)), issues }
}

const activeRequests = new Set<string>()
/** Scoped intent correlation: repeated IDs and request inspection only read owners, never resume side effects. */
export async function executeSpatialControl(ports: SpatialControlPorts,
  request: Extract<AgentMuxSpaceControlRequest, { operation: 'space.ls' | 'space.inspect' | 'agent.open' | 'space.mv' | 'space.bind' | 'space.unbind' }>,
  signal?: AbortSignal): Promise<AgentMuxSpaceControlResult> {
  let topics: readonly ScratchTopicSnapshot[] = []
  try { topics = await ports.topics() } catch { /* durable bindings remain discoverable with an explicit issue */ }
  let catalog = spatialCatalog(ports.get(), topics)
  if (request.operation === 'space.bind' || request.operation === 'space.unbind') return await executeBinding(ports, topics, request)
  if (request.operation === 'space.ls') return { operation: request.operation, catalog: selectSpatialCatalog(catalog, request.target) }
  if (request.operation === 'space.inspect') {
    if ('requestId' in request.target) {
      const binding = ports.get().spatialRequests[request.target.requestId]
      return { operation: request.operation, catalog: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], locations: [] },
        request: { requestId: request.target.requestId, known: Boolean(binding), report: binding ? await reconcile(ports, topics, binding) : null } }
    }
    return { operation: request.operation, catalog: selectSpatialCatalog(catalog, request.target) }
  }
  const operation = request.operation
  let ownsAdmission = false
  const report: AgentMuxSpaceMutationReport = { requestId: request.requestId, outcome: 'unknown', from: null, to: null,
    agent: null, resource: null, save: unsaved(), issues: [] }
  const finish = (): AgentMuxSpaceControlResult => ({ operation, ...report })
  const fail = (error: unknown, step: string) => {
    const notice = error instanceof SpatialFailure ? error.issue : issue(step, 'SPACE_OPERATION_UNCONFIRMED', error)
    report.issues.push(notice)
    report.outcome = report.agent || report.resource || report.save.layoutApplied ? 'partial' : 'unknown'
    ports.notice(notice)
    return finish()
  }
  try {
    const inputDigest = await digest({ operation, destination: request.destination, focus: request.focus,
      ...(operation === 'agent.open' ? { content: request.content, caller: request.caller } : { fromRegionId: request.fromRegionId, expectedAgentSessionId: request.expectedAgentSessionId, fromLocation: request.fromLocation }) })
    const existing = ports.get().spatialRequests[request.requestId]
    if (existing) {
      if (existing.inputDigest !== inputDigest) failure('SPACE_REQUEST_CONFLICT', 'This request ID is already bound to different input.')
      return { operation, ...await reconcile(ports, topics, existing) }
    }
    if (activeRequests.has(request.requestId)) failure('SPACE_REQUEST_PENDING', 'This request ID is already being admitted; inspect it instead of replaying.')
    activeRequests.add(request.requestId)
    ownsAdmission = true
    if (signal?.aborted) failure('CONTROL_CANCELLED', 'The request ended before any side effect.')
    if (!ports.get().config) failure('SPACE_CONFIG_UNAVAILABLE', 'The client configuration is not yet available.')
    if (request.destination.displayWorkspaceId) exactDisplayLayout(ports.get().layouts, request.destination.displayWorkspaceId, request.destination.groupId)
    let selfMove = false
    let from: AgentMuxSpaceAddress | undefined
    let sessionId: string
    let sourceSurface: AgentWorkbenchSurface | undefined
    let executorId: string | undefined
    if (operation === 'space.mv') {
      const source = catalog.regions.find(item => item.regionId === request.fromRegionId)
      if (!source || source.kind !== 'agent' || source.agentSessionId !== request.expectedAgentSessionId) failure('SPACE_SOURCE_CHANGED', 'The source Region does not contain the expected Agent Session.')
      const occurrences = catalog.locations.filter(location => location.regionId === source.regionId)
      if (new Set(occurrences.map(location => JSON.stringify([location.displayWorkspaceId, location.groupId, location.tabId, location.regionId]))).size > 1) {
        failure('SPACE_MOVE_MULTIPLE_OCCURRENCES_UNSUPPORTED',
          'Moving one occurrence of a shared Tab Region is unavailable. Every existing reference and the healthy Agent are retained; remove a display binding separately.',
          occurrences.map(({ spaceId, zoneId, tabId, regionId, displayWorkspaceId, groupId }) => ({ ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), tabId, regionId, displayWorkspaceId, groupId })))
      }
      from = addressOf(catalog, source.regionId, request.fromLocation)
        ?? failure('SPACE_LOCATION_REQUIRED', 'Choose the exact source reference before moving this Region.',
          catalog.locations.filter(location => location.regionId === source.regionId).map(({ spaceId, zoneId, tabId, regionId, displayWorkspaceId, groupId }) => ({ ...(spaceId ? { spaceId } : {}), ...(zoneId ? { zoneId } : {}), tabId, regionId, displayWorkspaceId, groupId })))
      report.from = from
      sessionId = request.expectedAgentSessionId
      sourceSurface = ports.get().tabs[from.tabId]!.regions[from.regionId] as AgentWorkbenchSurface
      if (request.destination.regionId === from.regionId) {
        checkedParent({ spaceId: request.destination.spaceId, zoneId: request.destination.zoneId, tabId: request.destination.tabId }, from)
        if (request.destination.split) failure('SPACE_SELF_SPLIT', 'An exact Region cannot be split beside itself by a move.')
        selfMove = true
      }
    } else {
      sessionId = request.content.kind === 'agent-session' ? request.content.agentSessionId : mintAgentSessionId()
      if (request.content.kind === 'new-agent') {
        executorId = request.content.executorId
        if (!ports.get().config!.executors[executorId]) failure('AGENT_EXECUTOR_NOT_CONFIGURED', 'Choose the exact configured Executor ID.')
      } else {
        const existingSession = ports.get().sessions.find((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent' && session.id === sessionId)
        if (!existingSession) failure('AGENT_SESSION_UNKNOWN', 'The existing Agent Session is not currently observed.')
        report.agent = snapshotFact(existingSession)
      }
    }
    const mint = { tabId: `view:${crypto.randomUUID()}`, regionId: from?.regionId ?? `region:${crypto.randomUUID()}` }
    let destination: Destination | undefined
    const resourceInput = request.destination.newZone
    let resourceReference: SpatialRequestBinding['resource']
    if (resourceInput) {
      const space = catalog.spaces.find(item => item.spaceId === request.destination.spaceId)
      if (!space || !request.destination.spaceId || request.destination.zoneId || request.destination.tabId || request.destination.regionId || request.destination.split) failure('SPACE_NEW_ZONE_TARGET', 'A new Zone requires one exact Space and no child target.')
      const sourceWorkspace = ports.get().config!.workspaces.find(workspace => workspace.hostId === space.hostId && (workspace.repoPath ?? workspace.path) === space.directoryPath)
      if (resourceInput.kind === 'worktree' && (space.kind !== 'folder' || !sourceWorkspace)) failure('SPACE_WORKTREE_REQUIRES_PROJECT', 'A Git worktree Zone requires a Folder Space backed by the existing Git owner.')
      resourceReference = { hostId: space.hostId, path: resourceInput.path, kind: resourceInput.kind,
        branch: resourceInput.kind === 'worktree' ? resourceInput.branch : null, sourceWorkspaceId: sourceWorkspace?.id ?? SCRATCH_WORKSPACE_ID }
    } else if (selfMove) destination = { kind: 'empty', address: from!, anchor: from!.regionId }
    else {
      destination = spatialDestination(catalog, request.destination, mint, ports.get().layouts)
      if (from) destination = { ...destination, address: { ...destination.address, regionId: from.regionId } }
    }
    if (destination && ports.closing(destination.address.tabId) || from && ports.closing(from.tabId)) failure('SPACE_TARGET_CLOSING', 'An involved Tab is closing; existing contents were preserved.')
    const executionHostId = operation === 'agent.open' && request.content.kind === 'new-agent'
      ? resourceReference?.hostId ?? catalog.zones.find(zone => zone.zoneId === destination?.address.zoneId)?.hostId
      : ports.get().sessions.find(session => session.kind === 'agent' && session.id === sessionId)?.hostId
    const binding: SpatialRequestBinding = { requestId: request.requestId, inputDigest, operation,
      tabId: destination?.address.tabId ?? mint.tabId, regionId: destination?.address.regionId ?? mint.regionId,
      agentSessionId: sessionId, createAgent: operation === 'agent.open' && request.content.kind === 'new-agent',
      ...(executionHostId ? { executionHostId } : {}),
      ...(from ? { from } : {}), target: destination ? { ...(destination.address.spaceId ? { spaceId: destination.address.spaceId } : {}), ...(destination.address.zoneId ? { zoneId: destination.address.zoneId } : {}), tabId: destination.address.tabId, regionId: destination.anchor ?? destination.address.regionId, displayWorkspaceId: destination.address.displayWorkspaceId, groupId: destination.address.groupId } : { spaceId: request.destination.spaceId! },
      ...(resourceReference ? { resource: resourceReference } : {}) }
    ports.patch({ spatialRequests: { ...ports.get().spatialRequests, [request.requestId]: binding } })
    const admitted = await ports.save(false)
    if (!admitted.localStorageWritten) { report.save = admitted; failure('SPACE_INTENT_SAVE_FAILED', 'The request association could not be written; creation has not been dispatched.') }
    if (selfMove) {
      report.outcome = 'unchanged'; report.to = from!; report.save = { ...admitted, layoutApplied: true }
      if (request.focus) { ports.focus(from!); report.save = await ports.save(true) }
      const snapshot = ports.get().sessions.find((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.id === sessionId && session.kind === 'agent')
      report.agent = snapshot ? snapshotFact(snapshot) : null
      return finish()
    }
    if (signal?.aborted) return fail('The caller disconnected after intent admission; inspect this request without replaying.', 'control')
    if (resourceInput) {
      const result = await ports.createResource({ spaceId: request.destination.spaceId!, resource: resourceInput })
      report.resource = result.resource
      ports.patch({ config: result.config })
      if (!result.workspace) {
        report.issues.push(issue('resource-registration', result.issue?.code ?? 'SPACE_RESOURCE_UNKNOWN', result.issue?.message ?? 'The resource registration is unknown.'))
        report.outcome = 'partial'; return finish()
      }
      const zoneId = workspaceZoneId(request.destination.spaceId!, result.workspace.id)
      ports.patch({ spaceZoneBindings: { ...ports.get().spaceZoneBindings, [zoneId]: { spaceId: request.destination.spaceId!, workspaceId: result.workspace.id } },
        spatialRequests: { ...ports.get().spatialRequests, [request.requestId]: { ...binding, target: { spaceId: request.destination.spaceId!, zoneId } } } })
      catalog = spatialCatalog(ports.get(), topics)
      destination = spatialDestination(catalog, { spaceId: request.destination.spaceId!, zoneId, newTab: true }, mint, ports.get().layouts)
    }
    const target = destination!
    if (ports.closing(target.address.tabId)) failure('SPACE_TARGET_CLOSING', 'The target Tab is closing.')
    const zone = catalog.zones.find(item => item.zoneId === target.address.zoneId)
    if (!zone || !zone.hostId || !zone.directoryPath) failure('SPACE_RESOURCE_UNKNOWN', 'The original Zone resource is unavailable; its entity is retained.')
    const surface: AgentWorkbenchSurface = sourceSurface ?? { kind: 'agent', phase: binding.createAgent ? 'launching' : 'attached',
      regionId: target.address.regionId, workspaceId: target.address.workspaceId, sessionId }
    const placement = applySpatialPlacement(ports.get(), topics, target, surface, from)
    if (from && !request.focus) ports.preserveMovedFocus?.(from)
    ports.patch(placement)
    report.to = target.address
    report.save = await ports.save(true)
    if (!report.save.localStorageWritten && binding.createAgent) return fail('The target workbench could not be written; Agent creation has not been dispatched.', 'layout-save')
    if (request.focus) ports.focus(target.address)
    if (binding.createAgent && operation === 'agent.open' && request.content.kind === 'new-agent') {
      const space = catalog.spaces.find(item => item.spaceId === target.address.spaceId)
      const launched = await ports.launch({ executorId: executorId!, hostId: zone.hostId, workspacePath: space?.topicId && target.address.workspaceId === SCRATCH_WORKSPACE_ID
          ? ports.get().config!.workspaces.find(workspace => workspace.id === SCRATCH_WORKSPACE_ID)!.path : zone.directoryPath,
        agentSessionId: sessionId, createOperationId: request.requestId,
        ...(space?.topicId && target.address.workspaceId === SCRATCH_WORKSPACE_ID ? { scratchTopicId: space.topicId } : {}),
        ...(request.content.prompt === undefined ? {} : { prompt: request.content.prompt }),
        ...(request.caller ? { authorAgentSessionId: request.caller.agentSessionId } : {}) })
      report.agent = agentFact({ ...launched.created, ...(launched.creation ? { creation: launched.creation } : {}) })
      if (launched.created.agentSessionId !== sessionId) return fail('Core returned another Session; its healthy Run has been retained for inspection.', 'creation')
      await ports.attach(target.address.regionId, launched)
      const landing = resolveSpatialCommit(ports.get().tabs, target.address.regionId, { kind: 'agent', sessionId })
      report.to = landing.kind === 'landed' ? addressOf(spatialCatalog(ports.get(), topics), target.address.regionId, { ...(target.address.spaceId ? { spaceId: target.address.spaceId } : {}), ...(target.address.zoneId ? { zoneId: target.address.zoneId } : {}), displayWorkspaceId: target.address.displayWorkspaceId, groupId: target.address.groupId }) : null
      // The authoritative Session can classify its navigation lane only after attachment.
      // A late launch receipt must not take focus back after the user intentionally navigated away.
      if (request.focus && report.to && ports.isFocused(report.to)) ports.focus(report.to)
      if (!report.to) report.issues.push(issue('layout', 'SPACE_PLACEMENT_UNKNOWN', 'The Agent is healthy, but its exact Region is no longer observed.'))
      for (const projection of launched.projectionFailures) report.issues.push(issue(projection.step, 'AGENT_DISPLAY_UNCONFIRMED', projection.message))
      if (report.agent.initialPrompt === 'unconfirmed' || report.agent.initialPrompt === 'unknown') report.issues.push(issue('first-prompt', 'INITIAL_PROMPT_UNCONFIRMED', 'Core has not confirmed the original first prompt protocol.'))
      if (signal?.aborted) report.issues.push(issue('control', 'CONTROL_RECEIPT_INTERRUPTED', 'The caller ended while the healthy Agent continued. Inspect the request ID.'))
      report.save = await ports.save(Boolean(report.to))
    } else if (!report.agent) {
      const snapshot = ports.get().sessions.find((session): session is Extract<SessionSnapshot, { kind: 'agent' }> => session.kind === 'agent' && session.id === sessionId)
      report.agent = snapshot ? snapshotFact(snapshot) : null
    }
    if (report.save.reason) report.issues.push(issue('save', 'SPACE_SAVE_UNCONFIRMED', report.save.reason))
    report.outcome = report.issues.length ? 'partial' : operation === 'space.mv' ? 'moved' : 'opened'
    for (const notice of report.issues) ports.notice(notice)
    return finish()
  } catch (error) { return fail(error, 'owner') }
  finally { if (ownsAdmission) activeRequests.delete(request.requestId) }
}
