import { spatialDestination, selectSpatialCatalog } from '@agentmux/core/spatial-graph'
import type { AgentMuxSpaceAddress, AgentMuxSpaceCatalog, AgentMuxSpaceDestination, AgentMuxSpaceControlRequest, AgentMuxSpaceControlResult, AgentMuxSpatialIssue, AgentMuxSpatialSave } from '@agentmux/core/control'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { fileWorkbenchIdentity } from './file-workbench-state'
import type { FileOpenPlacement, FileOpenResult, FileWorkbenchState } from './file-workbench-state'
import { spatialCatalog, zoneContext, type SpatialWorkbench, type SpatialControlOptions } from './space-agent-control'
import { zoneFileResource } from '../../../shared/zone-file-resource'
import { awaitDesktopPresentation, captureDesktopInput, desktopInputPreserved } from './desktop-presentation'

export type WorkfaceFileOpenPorts = {
  get(): SpatialWorkbench & FileWorkbenchState
  navigationSelection(): string
  topics(): Promise<readonly ScratchTopicSnapshot[]>
  openFile(path: string, groupId: string, location: undefined, workspaceId: string, openAsText: boolean, placement: FileOpenPlacement): Promise<boolean>
  closing(tabId: string): boolean
  save(layoutApplied: boolean): Promise<AgentMuxSpatialSave>
}

/** Resolve resource ownership and a display destination once, before any file read or reuse. */
export function resolveFileOpenTarget(state: SpatialWorkbench & FileWorkbenchState, topics: readonly ScratchTopicSnapshot[],
  catalog: AgentMuxSpaceCatalog, workspaceId: string, path: string, destination: AgentMuxSpaceDestination,
  origin?: FileOpenPlacement['reference']
): { address: AgentMuxSpaceAddress; placement: FileOpenPlacement } {
  const zone = catalog.zones.find(item => item.zoneId === destination.zoneId)
  const workspace = state.config?.workspaces.find(item => item.id === workspaceId)
  if (!zone || zone.workspaceId !== workspaceId || !workspace || zone.hostId !== workspace.hostId)
    throw new Error('The original file resource and Zone are unconfirmed. Its workface and content are kept.')
  const space = { spaceId: zoneContext(state, topics, zone), zoneId: zone.zoneId }
  const topicId = state.spaceZoneBindings[zone.zoneId]?.topicId ?? catalog.spaces.find(item => item.spaceId === space.spaceId)?.topicId ?? null
  const identity = fileWorkbenchIdentity(state, workspaceId, path, { space, selection: { topicId } })
  // An exact local occurrence can be reused while its Category relationship is
  // unknown. Collapse parent-binding copies of the same physical position;
  // neither resource equality nor list order chooses among different positions.
  const references = new Map<string, NonNullable<FileOpenPlacement['reference']>>()
  if (origin && destination.newTab && !destination.tabId && !destination.regionId && !destination.split) for (const location of catalog.locations) {
    const tab = state.tabs[location.tabId], surface = tab?.regions[location.regionId]
    if (location.zoneId !== zone.zoneId || location.displayWorkspaceId !== (destination.displayWorkspaceId ?? origin.displayWorkspaceId) || location.groupId !== (destination.groupId ?? origin.groupId) ||
      tab?.space?.spaceId !== space.spaceId || surface?.kind !== 'file' || surface.workspaceId !== workspaceId || surface.path !== path) continue
    const value = { displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }
    references.set(JSON.stringify(value), value)
  }
  const candidates = [...references.values()], sameTab = candidates.filter(item => item.tabId === origin?.tabId)
  const reference = candidates.find(item => item.tabId === origin?.tabId && item.regionId === origin?.regionId)
    ?? (sameTab.length === 1 ? sameTab[0] : candidates.length === 1 ? candidates[0] : undefined)
  let target: AgentMuxSpaceAddress
  if (reference) {
    const selected = selectSpatialCatalog(catalog, { zoneId: zone.zoneId, ...(destination.spaceId ? { spaceId: destination.spaceId } : {}), ...reference })
    const surface = state.tabs[reference.tabId]?.regions[reference.regionId]
    if (!selected.locations.length || surface?.kind !== 'file' || surface.workspaceId !== workspaceId || surface.path !== path)
      throw new Error('The original File occurrence is unconfirmed. Its workface and content are kept.')
    target = { ...reference, workspaceId, zoneId: zone.zoneId, spaceId: destination.spaceId ?? null }
  } else target = spatialDestination(catalog, destination, identity, state.layouts).address
  return { address: target, placement: {
    displayWorkspaceId: target.displayWorkspaceId, space, resource: { hostId: workspace.hostId, path: workspace.path },
    ...(reference ? { reference } : {}),
    selection: { spaceId: target.spaceId, zoneId: zone.zoneId, workspaceId: target.displayWorkspaceId,
      groupId: target.groupId, tabId: target.tabId, regionId: target.regionId,
      topicId }
  } }
}

/** Resource resolution and the original File owner's same-call receipt stay separate from display selection. */
export async function executeWorkfaceFileOpen(ports: WorkfaceFileOpenPorts,
  request: Extract<AgentMuxSpaceControlRequest, { operation: 'open.file' }>,
  fileOpenIntent: NonNullable<SpatialControlOptions['fileOpenIntent']> = 'source',
  inputPolicy: NonNullable<SpatialControlOptions['fileInputPolicy']> = 'preserve'
): Promise<Extract<AgentMuxSpaceControlResult, { operation: 'open.file' }>> {
  const originalNavigation = ports.navigationSelection()
  const report: Extract<AgentMuxSpaceControlResult, { operation: 'open.file' }> = {
    operation: 'open.file', requestedPath: request.path, resource: null,
    placement: { status: 'unconfirmed', tabId: null, regionId: null, locations: [] },
    data: { kind: 'unconfirmed', reason: null }, navigation: 'unconfirmed', changed: false,
    outcome: 'unknown', save: null, issues: []
  }
  const issue = (step: string, code: string, error: unknown): AgentMuxSpatialIssue =>
    (error as { issue?: AgentMuxSpatialIssue })?.issue ?? { step, code,
      message: error instanceof Error ? error.message : String(error),
      recovery: 'Inspect the original Zone and File placement; an unknown request result must not be replayed automatically.' }
  let topics: readonly ScratchTopicSnapshot[] = []
  try { topics = await ports.topics() } catch (error) { report.issues.push(issue('discovery', 'SPACE_DISCOVERY_UNCONFIRMED', error)) }
  try {
    // Discovery may await. Resolve from the current original Store snapshot afterwards.
    const state = ports.get(), catalog = spatialCatalog(state, topics)
    const selected = selectSpatialCatalog(catalog, { zoneId: request.zoneId, ...(request.spaceId ? { spaceId: request.spaceId } : {}) })
    const zone = selected.zones[0]
    if (selected.zones.length !== 1 || !zone) throw new Error('Choose one exact existing Zone.')
    const workspace = state.config?.workspaces.find(workspace => workspace.id === zone.workspaceId)
    if (!workspace) throw new Error('The original Files Workspace is unconfirmed.')
    const mapped = zoneFileResource(workspace, zone, request.path, topics)
    report.resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path,
      zoneId: zone.zoneId, zonePath: mapped.directoryPath, path: mapped.path }
    const resolved = resolveFileOpenTarget(state, topics, catalog, workspace.id, mapped.path, { zoneId: zone.zoneId, ...(request.spaceId ? { spaceId: request.spaceId } : {}),
      ...(request.displayWorkspaceId ? { displayWorkspaceId: request.displayWorkspaceId, groupId: request.groupId } : {}),
      ...(request.tabId ? { tabId: request.tabId, ...(request.regionId ? { regionId: request.regionId } : {}), ...(request.split ? { split: request.split } : {}) } : { newTab: true }) })
    const target = resolved.address
    const { tabId, regionId } = target
    if (ports.closing(request.tabId ?? tabId)) throw new Error('The original File Tab is closing; its content is retained.')
    const destinationTabId = request.tabId ?? tabId
    const beforeTab = Object.hasOwn(state.tabs, destinationTabId) ? state.tabs[destinationTabId] : undefined
    if (!request.tabId && beforeTab && beforeTab.space?.zoneId !== zone.zoneId) {
      report.outcome = 'refused'
      report.issues.push(issue('placement', 'SPACE_PARENT_MISMATCH', 'The canonical File Tab already has another Zone context; no replacement or duplicate was created.'))
      return report
    }
    const beforeMember = state.layouts[target.displayWorkspaceId]?.groups.find(group => group.id === target.groupId)?.tabOrder.includes(tabId) ?? false
    const focus = request.focus && ports.navigationSelection() === originalNavigation
    const input = focus && inputPolicy === 'target' ? null : captureDesktopInput(state.tabs)
    let actual: FileOpenResult | undefined
    await ports.openFile(mapped.path, target.groupId, undefined, workspace.id, fileOpenIntent === 'source', {
      ...resolved.placement,
      focus, inputPolicy, fileOnly: fileOpenIntent === 'source',
      ...(request.tabId && request.regionId && request.split ? { split: { tabId: request.tabId, regionId: request.regionId, direction: request.split } } : {}),
      onResult: result => { actual = result }
    })
    if (!actual) throw new Error('The original File owner did not confirm a same-call result.')
    report.data = actual.data
    report.navigation = request.focus && !focus ? 'cancelled' : actual.navigation
    const applied = ports.get(), afterCatalog = spatialCatalog(applied, topics)
    report.placement = { ...actual.placement, locations: actual.placement.regionId ? afterCatalog.locations.filter(location =>
      location.regionId === actual!.placement.regionId && location.tabId === actual!.placement.tabId) : [] }
    const surface = actual.placement.tabId && actual.placement.regionId
      ? applied.tabs[actual.placement.tabId]?.regions[actual.placement.regionId] : undefined
    const bookmarkOpened = fileOpenIntent === 'default' && surface?.kind === 'browser' &&
      surface.workspaceId === workspace.id && surface.bookmarkOrigin?.path === mapped.path
    const afterMember = applied.layouts[target.displayWorkspaceId]?.groups.find(group => group.id === target.groupId)?.tabOrder.includes(tabId) ?? false
    report.changed = actual.placement.status === 'created' || !beforeMember && afterMember
    if (actual.placement.status === 'created' || actual.placement.status === 'reused') {
      report.save = await ports.save(report.changed)
      if (report.save.reason) report.issues.push(issue('save', 'SPACE_SAVE_UNCONFIRMED', report.save.reason))
    }
    if (input && desktopInputPreserved(input, input)) {
      await awaitDesktopPresentation(() => true)
      if (!desktopInputPreserved(input, captureDesktopInput(ports.get().tabs))) report.issues.push({ step: 'input',
        code: 'INPUT_PRESERVATION_UNCONFIRMED', message: 'The previous input is no longer confirmed eligible in its original presentation.',
        recovery: 'The opened File and applied selection are retained; choose the current input explicitly.' })
    }
    if (actual.data.kind === 'not-file' && !bookmarkOpened) {
      report.outcome = 'refused'
      report.issues.push(issue('read', 'WORKSPACE_PATH_IS_DIRECTORY', actual.data.reason ?? 'The requested path is a directory. No File or Explorer navigation was created.'))
    } else {
      const unconfirmed = actual.placement.status === 'unconfirmed' || actual.placement.status === 'none' || actual.data.kind === 'unconfirmed'
      const partial = actual.data.kind === 'failed' || report.navigation === 'cancelled' || report.navigation === 'unconfirmed' || report.issues.length > 0
      report.outcome = unconfirmed ? report.changed ? 'partial' : 'unknown' : partial ? 'partial' : report.changed ? 'opened' : 'unchanged'
      if (actual.data.kind === 'failed' || unconfirmed) report.issues.push(issue('read', 'FILE_OPEN_UNCONFIRMED', actual.data.reason ?? 'File data or its exact original placement is unconfirmed.'))
      if (report.navigation === 'cancelled' || report.navigation === 'unconfirmed') report.issues.push(issue('navigation', 'NAVIGATION_UNCONFIRMED',
        'The original File data is retained; a later navigation or changed target owns the current display.'))
    }
  } catch (error) { report.issues.push(issue('open', 'FILE_OPEN_UNCONFIRMED', error)) }
  return report
}
