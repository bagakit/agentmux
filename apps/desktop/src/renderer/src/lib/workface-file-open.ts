import type { AgentMuxSpaceControlRequest, AgentMuxSpaceControlResult, AgentMuxSpatialIssue, AgentMuxSpatialSave } from '@agentmux/core/control'
import type { ScratchTopicSnapshot } from '../../../shared/contracts'
import { fileTabId, initialWorkbenchRegionId } from './workbench-tabs'
import type { FileOpenPlacement, FileOpenResult, FileWorkbenchState } from './file-workbench-state'
import { spatialCatalog, spatialDestination, selectSpatialCatalog, zoneContext, type SpatialWorkbench } from './space-agent-control'
import { zoneFileResource } from './zone-file-resource'
import { awaitDesktopPresentation, captureDesktopInput, desktopInputPreserved } from './desktop-presentation'

export type WorkfaceFileOpenPorts = {
  get(): SpatialWorkbench & FileWorkbenchState
  topics(): Promise<readonly ScratchTopicSnapshot[]>
  openFile(path: string, groupId: string, location: undefined, workspaceId: string, openAsText: true, placement: FileOpenPlacement): Promise<boolean>
  closing(tabId: string): boolean
  save(layoutApplied: boolean): Promise<AgentMuxSpatialSave>
}

/** Resource resolution and the original File owner's same-call receipt stay separate from display selection. */
export async function executeWorkfaceFileOpen(ports: WorkfaceFileOpenPorts,
  request: Extract<AgentMuxSpaceControlRequest, { operation: 'open.file' }>
): Promise<Extract<AgentMuxSpaceControlResult, { operation: 'open.file' }>> {
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
    const mapped = zoneFileResource(workspace, zone, request.path)
    report.resource = { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path,
      zoneId: zone.zoneId, zonePath: mapped.directoryPath, path: mapped.path }
    const tabId = fileTabId(workspace.id, mapped.path), regionId = initialWorkbenchRegionId(tabId)
    const target = spatialDestination(catalog, { zoneId: zone.zoneId, ...(request.spaceId ? { spaceId: request.spaceId } : {}),
      ...(request.displayWorkspaceId ? { displayWorkspaceId: request.displayWorkspaceId, groupId: request.groupId } : {}), newTab: true },
      { tabId, regionId }, state.layouts).address
    if (ports.closing(tabId)) throw new Error('The original File Tab is closing; its content is retained.')
    const originalContext = zoneContext(state, topics, zone)
    const beforeTab = Object.hasOwn(state.tabs, tabId) ? state.tabs[tabId] : undefined
    if (beforeTab && beforeTab.space?.zoneId !== zone.zoneId) {
      report.outcome = 'refused'
      report.issues.push(issue('placement', 'SPACE_PARENT_MISMATCH', 'The canonical File Tab already has another Zone context; no replacement or duplicate was created.'))
      return report
    }
    const beforeMember = state.layouts[target.displayWorkspaceId]?.groups.find(group => group.id === target.groupId)?.tabOrder.includes(tabId) ?? false
    const input = request.focus ? captureDesktopInput(state.tabs) : null
    let actual: FileOpenResult | undefined
    await ports.openFile(mapped.path, target.groupId, undefined, workspace.id, true, {
      displayWorkspaceId: target.displayWorkspaceId,
      space: { spaceId: originalContext, zoneId: zone.zoneId }, resource: { hostId: workspace.hostId, path: workspace.path },
      focus: request.focus, fileOnly: true,
      ...(request.focus ? { selection: { spaceId: target.spaceId, zoneId: zone.zoneId, workspaceId: target.displayWorkspaceId,
        groupId: target.groupId, tabId, regionId, topicId: catalog.spaces.find(space => space.spaceId === target.spaceId)?.topicId ?? null } } : {}),
      onResult: result => { actual = result }
    })
    if (!actual) throw new Error('The original File owner did not confirm a same-call result.')
    report.data = actual.data
    report.navigation = actual.navigation
    const applied = ports.get(), afterCatalog = spatialCatalog(applied, topics)
    report.placement = { ...actual.placement, locations: actual.placement.regionId ? afterCatalog.locations.filter(location =>
      location.regionId === actual!.placement.regionId && location.tabId === actual!.placement.tabId) : [] }
    const afterMember = applied.layouts[target.displayWorkspaceId]?.groups.find(group => group.id === target.groupId)?.tabOrder.includes(tabId) ?? false
    report.changed = !beforeTab && actual.placement.status === 'created' || !beforeMember && afterMember
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
    if (actual.data.kind === 'not-file') {
      report.outcome = 'refused'
      report.issues.push(issue('read', 'WORKSPACE_PATH_IS_DIRECTORY', actual.data.reason ?? 'The requested path is a directory. No File or Explorer navigation was created.'))
    } else {
      const unconfirmed = actual.placement.status === 'unconfirmed' || actual.placement.status === 'none' || actual.data.kind === 'unconfirmed'
      const partial = actual.data.kind === 'failed' || actual.navigation === 'cancelled' || actual.navigation === 'unconfirmed' || report.issues.length > 0
      report.outcome = unconfirmed ? report.changed ? 'partial' : 'unknown' : partial ? 'partial' : report.changed ? 'opened' : 'unchanged'
      if (actual.data.kind === 'failed' || unconfirmed) report.issues.push(issue('read', 'FILE_OPEN_UNCONFIRMED', actual.data.reason ?? 'File data or its exact original placement is unconfirmed.'))
      if (actual.navigation === 'cancelled' || actual.navigation === 'unconfirmed') report.issues.push(issue('navigation', 'NAVIGATION_UNCONFIRMED',
        'The original File data is retained; a later navigation or changed target owns the current display.'))
    }
  } catch (error) { report.issues.push(issue('open', 'FILE_OPEN_UNCONFIRMED', error)) }
  return report
}
