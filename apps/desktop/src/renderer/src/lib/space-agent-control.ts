import type { AgentMuxAgentSession } from '@agentmux/core'
import type {
  AgentMuxSpaceAddress, AgentMuxSpaceAgentFact, AgentMuxSpaceCatalog, AgentMuxSpaceControlRequest,
  AgentMuxSpaceControlResult, AgentMuxSpaceDestination, AgentMuxSpaceMutationReport,
  AgentMuxSpaceSelector, AgentMuxSpatialIssue, AgentMuxSpatialSave, AgentMuxZoneFact
} from '@agentmux/core/control'
import { mintAgentSessionId } from '@agentmux/core/agent-session-id'
import { addTabOrThrow, createWorkspaceLayout, findGroupForTab,
  removeTab, replaceLeaf, type WorkspaceLayout } from '@agentmux/layout'
import type { AgentLaunchInput, AgentLaunchResult, AppConfig, ScratchTopicSnapshot, SessionSnapshot } from '../../../shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../../../shared/scratch-topics'
import { spatialSources, workspaceZoneId, type SpaceZoneBindings, type SpatialRequestBinding,
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
  focus(tabId: string, regionId: string): void
  isFocused(tabId: string, regionId: string): boolean
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

/** Metadata only: Session references are indexed once; no terminal, timeline or readiness reads. */
export function spatialCatalog(state: SpatialWorkbench, topics: readonly ScratchTopicSnapshot[]): AgentMuxSpaceCatalog {
  if (!state.config) return { spaces: [], zones: [], tabs: [], regions: [] }
  const sources = spatialSources(state.config, topics, state.spaceZoneBindings)
  const catalog: AgentMuxSpaceCatalog = { ...sources, tabs: [], regions: [] }
  const sessions = new Map(state.sessions.map(session => [session.id, session]))
  for (const tab of Object.values(state.tabs)) {
    let zone = tab.space && sources.zones.find(candidate => candidate.zoneId === tab.space!.zoneId &&
      candidate.spaceId === tab.space!.spaceId && candidate.workspaceId === tab.workspaceId)
    if (!zone && tab.space) {
      // Durable Tab ownership survives a temporarily absent directory/config discovery.
      let identity: unknown
      try { identity = JSON.parse(tab.space.spaceId) } catch { identity = null }
      if (Array.isArray(identity) && typeof identity[0] === 'string' && typeof identity[1] === 'string') {
        if (!catalog.spaces.some(space => space.spaceId === tab.space!.spaceId)) catalog.spaces.push({
          spaceId: tab.space.spaceId, kind: 'container', name: identity[1], hostId: identity[0],
          directoryPath: identity[1], projectId: null, issue: 'Resource discovery is unavailable; durable Tab placement is retained.' })
        zone = { zoneId: tab.space.zoneId, spaceId: tab.space.spaceId, workspaceId: tab.workspaceId,
          kind: 'directory', hostId: identity[0], directoryPath: identity[1], branch: null }
        if (!catalog.zones.some(candidate => candidate.zoneId === zone!.zoneId)) catalog.zones.push(zone)
      }
    }
    if (!zone) zone = sources.zones.find(candidate => candidate.workspaceId === tab.workspaceId &&
      (tab.topicId ? sources.spaces.find(space => space.spaceId === candidate.spaceId)?.topicId === tab.topicId
        : !sources.spaces.find(space => space.spaceId === candidate.spaceId)?.topicId))
    if (!zone) continue
    const group = state.layouts[tab.workspaceId] && findGroupForTab(state.layouts[tab.workspaceId]!, tab.id)
    if (!group) continue
    const parent = { spaceId: zone.spaceId, zoneId: zone.zoneId, workspaceId: tab.workspaceId, tabId: tab.id }
    catalog.tabs.push({ ...parent, groupId: group.id, name: tab.name ?? null, regionIds: Object.keys(tab.regions) })
    for (const surface of Object.values(tab.regions)) {
      const session = isSessionSurface(surface) ? sessions.get(surface.sessionId) : undefined
      catalog.regions.push({ ...parent, regionId: surface.regionId, kind: surface.kind,
        agentSessionId: surface.kind === 'agent' ? surface.sessionId : null,
        runId: session?.control.run.runId ?? null,
        execution: session ? { hostId: session.hostId, cwd: session.workspacePath } : null })
    }
  }
  return catalog
}

type LooseSelector = { [K in keyof AgentMuxSpaceSelector]?: string | undefined }
function match(selector: LooseSelector, address: AgentMuxSpaceSelector): boolean {
  return Object.entries(selector).every(([key, value]) => value === undefined || address[key as keyof AgentMuxSpaceSelector] === value)
}
function checkedParent(selector: LooseSelector, actual: AgentMuxSpaceSelector): void {
  if (!match(selector, actual)) failure('SPACE_PARENT_MISMATCH', 'The supplied parent does not own this exact child.')
}
export function selectSpatialCatalog(catalog: AgentMuxSpaceCatalog, target: AgentMuxSpaceSelector): AgentMuxSpaceCatalog {
  let parent: AgentMuxSpaceSelector | undefined
  if (target.regionId) parent = catalog.regions.find(region => region.regionId === target.regionId)
  else if (target.tabId) parent = catalog.tabs.find(tab => tab.tabId === target.tabId)
  else if (target.zoneId) parent = catalog.zones.find(zone => zone.zoneId === target.zoneId)
  else if (target.spaceId) parent = catalog.spaces.find(space => space.spaceId === target.spaceId)
  if (Object.values(target).some(Boolean) && !parent) failure('SPACE_TARGET_UNKNOWN', 'The exact spatial target is not currently known.')
  if (parent) checkedParent(target, parent)
  const selector: LooseSelector = parent ? { spaceId: parent.spaceId, ...(target.zoneId || target.tabId || target.regionId ? { zoneId: parent.zoneId } : {}),
    ...(target.tabId || target.regionId ? { tabId: parent.tabId } : {}), ...(target.regionId ? { regionId: parent.regionId } : {}) } : {}
  return {
    spaces: catalog.spaces.filter(space => !selector.spaceId || space.spaceId === selector.spaceId),
    zones: catalog.zones.filter(zone => (!selector.spaceId || zone.spaceId === selector.spaceId) && (!selector.zoneId || zone.zoneId === selector.zoneId)),
    tabs: catalog.tabs.filter(tab => match({ spaceId: selector.spaceId, zoneId: selector.zoneId, tabId: selector.tabId }, tab)),
    regions: catalog.regions.filter(region => match(selector, region))
  }
}

type Destination = { address: AgentMuxSpaceAddress; kind: 'new-tab' | 'empty' | 'split'; anchor?: string; split?: AgentMuxSpaceDestination['split'] }
export function spatialDestination(catalog: AgentMuxSpaceCatalog, dest: AgentMuxSpaceDestination, mint: { tabId: string; regionId: string }): Destination {
  let zone: AgentMuxZoneFact | undefined
  if (dest.regionId || dest.tabId) {
    const tab = dest.regionId
      ? catalog.tabs.find(item => item.tabId === catalog.regions.find(region => region.regionId === dest.regionId)?.tabId)
      : catalog.tabs.find(item => item.tabId === dest.tabId)
    if (!tab) failure('SPACE_TARGET_UNKNOWN', 'The target Tab/Region is not open.')
    checkedParent({ spaceId: dest.spaceId, zoneId: dest.zoneId, tabId: dest.tabId }, tab)
    zone = catalog.zones.find(item => item.zoneId === tab.zoneId)
    if (dest.newTab) failure('SPACE_TARGET_CONFLICT', 'A new Tab uses a Space/Zone target, not a Tab/Region anchor.')
    let region = dest.regionId ? catalog.regions.find(item => item.regionId === dest.regionId) : undefined
    if (!region) {
      const empties = catalog.regions.filter(item => item.tabId === tab.tabId && item.kind === 'launcher')
      if (empties.length !== 1 || dest.split) failure('SPACE_REGION_REQUIRED', 'Choose an exact empty Region, or an exact Region with split.',
        catalog.regions.filter(item => item.tabId === tab.tabId).map(({ spaceId, zoneId, tabId, regionId }) => ({ spaceId, zoneId, tabId, regionId })))
      region = empties[0]!
    }
    checkedParent({ spaceId: dest.spaceId, zoneId: dest.zoneId, tabId: dest.tabId, regionId: dest.regionId }, region)
    if (!dest.split && region.kind !== 'launcher') failure('SPACE_REGION_OCCUPIED', 'This Region contains content; use an empty Region or explicit split.')
    return { address: { spaceId: tab.spaceId, zoneId: tab.zoneId, workspaceId: tab.workspaceId, tabId: tab.tabId,
      regionId: dest.split ? mint.regionId : region.regionId }, kind: dest.split ? 'split' : 'empty', anchor: region.regionId, ...(dest.split ? { split: dest.split } : {}) }
  }
  if (dest.split) failure('SPACE_REGION_REQUIRED', 'A split requires an exact Region.')
  if (dest.zoneId) {
    zone = catalog.zones.find(item => item.zoneId === dest.zoneId)
    if (!zone) failure('SPACE_TARGET_UNKNOWN', 'The exact Zone is not known.')
    checkedParent({ spaceId: dest.spaceId, zoneId: dest.zoneId }, zone)
  } else if (dest.spaceId) {
    if (!catalog.spaces.some(space => space.spaceId === dest.spaceId)) failure('SPACE_TARGET_UNKNOWN', 'The exact Space is not known.')
    const zones = catalog.zones.filter(item => item.spaceId === dest.spaceId)
    if (zones.length !== 1) failure('SPACE_ZONE_REQUIRED', 'This Space does not have exactly one Zone; choose an exact Zone.',
      zones.map(({ spaceId, zoneId }) => ({ spaceId, zoneId })))
    zone = zones[0]!
  } else failure('SPACE_TARGET_REQUIRED', 'A target is required. Run agentmux space ls and choose a Space/Zone/Tab/Region.')
  return { kind: 'new-tab', address: { spaceId: zone!.spaceId, zoneId: zone!.zoneId, workspaceId: zone!.workspaceId, ...mint } }
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
      const layout = layouts[source.workspaceId]
      const group = layout && findGroupForTab(layout, source.id)
      if (layout && group) layouts[source.workspaceId] = removeTab(layout, group.id, source.id)
    }
  }
  const address = target.address
  const placed = { ...surface, workspaceId: address.workspaceId, regionId: address.regionId }
  if (target.kind === 'new-tab') {
    if (tabs[address.tabId]) failure('SPACE_TARGET_CHANGED', 'The reserved Tab ID already exists.')
    const space = spatialCatalog(state, topics).spaces.find(item => item.spaceId === address.spaceId)
    tabs[address.tabId] = { ...createWorkbenchTab(address.tabId, placed),
      space: { spaceId: address.spaceId, zoneId: address.zoneId }, ...(space?.topicId ? { topicId: space.topicId } : {}) }
    let layout = layouts[address.workspaceId] ?? createWorkspaceLayout(`group:${crypto.randomUUID()}`)
    const zoneTabs = spatialCatalog({ ...state, tabs, layouts }, topics).tabs.filter(tab => tab.zoneId === address.zoneId)
    const groupId = zoneTabs.at(-1)?.groupId ?? layout.activeGroupId
    const previousLayout = layout
    layout = addTabOrThrow(layout, groupId, address.tabId)
    layout = { ...layout, activeGroupId: previousLayout.activeGroupId, groups: layout.groups.map(group => {
      const previous = previousLayout.groups.find(item => item.id === group.id)
      return previous?.activeTabId ? { ...group, activeTabId: previous.activeTabId, recentTabIds: previous.recentTabIds } : group
    }) }
    layouts[address.workspaceId] = layout
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
      tabs[tab.id] = { ...tab, space: { spaceId: address.spaceId, zoneId: address.zoneId }, regions,
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
function addressOf(catalog: AgentMuxSpaceCatalog, regionId: string): AgentMuxSpaceAddress | null {
  const region = catalog.regions.find(item => item.regionId === regionId)
  return region ? { spaceId: region.spaceId, zoneId: region.zoneId, workspaceId: region.workspaceId, tabId: region.tabId, regionId } : null
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
  const to = region ? addressOf(catalog, region.regionId) : null
  const atTarget = Boolean(region && region.tabId === binding.tabId &&
    (!binding.target.spaceId || region.spaceId === binding.target.spaceId) &&
    (!binding.target.zoneId || region.zoneId === binding.target.zoneId))
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
export async function executeSpatialControl(ports: SpatialControlPorts, request: AgentMuxSpaceControlRequest, signal?: AbortSignal): Promise<AgentMuxSpaceControlResult> {
  let topics: readonly ScratchTopicSnapshot[] = []
  try { topics = await ports.topics() } catch { /* durable bindings remain discoverable with an explicit issue */ }
  let catalog = spatialCatalog(ports.get(), topics)
  if (request.operation === 'space.ls') return { operation: request.operation, catalog: selectSpatialCatalog(catalog, request.target) }
  if (request.operation === 'space.inspect') {
    if ('requestId' in request.target) {
      const binding = ports.get().spatialRequests[request.target.requestId]
      return { operation: request.operation, catalog: { spaces: [], zones: [], tabs: [], regions: [] },
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
      ...(operation === 'agent.open' ? { content: request.content, caller: request.caller } : { fromRegionId: request.fromRegionId, expectedAgentSessionId: request.expectedAgentSessionId }) })
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
    let selfMove = false
    let from: AgentMuxSpaceAddress | undefined
    let sessionId: string
    let sourceSurface: AgentWorkbenchSurface | undefined
    let executorId: string | undefined
    if (operation === 'space.mv') {
      const source = catalog.regions.find(item => item.regionId === request.fromRegionId)
      if (!source || source.kind !== 'agent' || source.agentSessionId !== request.expectedAgentSessionId) failure('SPACE_SOURCE_CHANGED', 'The source Region does not contain the expected Agent Session.')
      from = addressOf(catalog, source.regionId)!
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
      destination = spatialDestination(catalog, request.destination, mint)
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
      ...(from ? { from } : {}), target: destination ? { ...destination.address, ...(destination.anchor ? { regionId: destination.anchor } : {}) } : { spaceId: request.destination.spaceId! },
      ...(resourceReference ? { resource: resourceReference } : {}) }
    ports.patch({ spatialRequests: { ...ports.get().spatialRequests, [request.requestId]: binding } })
    const admitted = await ports.save(false)
    if (!admitted.localStorageWritten) { report.save = admitted; failure('SPACE_INTENT_SAVE_FAILED', 'The request association could not be written; creation has not been dispatched.') }
    if (selfMove) {
      report.outcome = 'unchanged'; report.to = from!; report.save = { ...admitted, layoutApplied: true }
      if (request.focus) { ports.focus(from!.tabId, from!.regionId); report.save = await ports.save(true) }
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
      destination = spatialDestination(catalog, { spaceId: request.destination.spaceId!, zoneId, newTab: true }, mint)
    }
    const target = destination!
    if (ports.closing(target.address.tabId)) failure('SPACE_TARGET_CLOSING', 'The target Tab is closing.')
    const zone = catalog.zones.find(item => item.zoneId === target.address.zoneId)!
    const surface: AgentWorkbenchSurface = sourceSurface ?? { kind: 'agent', phase: binding.createAgent ? 'launching' : 'attached',
      regionId: target.address.regionId, workspaceId: target.address.workspaceId, sessionId }
    const placement = applySpatialPlacement(ports.get(), topics, target, surface, from)
    if (from && !request.focus) ports.preserveMovedFocus?.(from)
    ports.patch(placement)
    report.to = target.address
    report.save = await ports.save(true)
    if (!report.save.localStorageWritten && binding.createAgent) return fail('The target workbench could not be written; Agent creation has not been dispatched.', 'layout-save')
    if (request.focus) ports.focus(target.address.tabId, target.address.regionId)
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
      report.to = landing.kind === 'landed' ? addressOf(spatialCatalog(ports.get(), topics), target.address.regionId) : null
      // The authoritative Session can classify its navigation lane only after attachment.
      // A late launch receipt must not take focus back after the user intentionally navigated away.
      if (request.focus && report.to && ports.isFocused(report.to.tabId, report.to.regionId)) ports.focus(report.to.tabId, report.to.regionId)
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
