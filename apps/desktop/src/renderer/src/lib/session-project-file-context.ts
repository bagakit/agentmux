import { groupIds, regionIds, type WorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { directoryIdentity, workspaceZoneId, type SpaceZoneBindings, type SpatialRequestBinding } from '../../../shared/space-addresses'
import type { DemandRecord } from './global-demand-board'
import { goalProjectContext, type GoalProjectContext } from './goal-project-context'
import type { FileOpenPlacement } from './file-workbench-state'
import type { OpenHttpLinkOrigin } from './open-destination'
import { sessionPresentationById } from './session-presentation'
import { scratchTopicsForWorkspace, type ScratchTopicsSnapshot } from './scratch-topic-snapshots'
import { spatialCatalog, zoneContext } from './space-agent-control'
import { workspaceRootForPath, type WorkbenchTab } from './workbench-tabs'

type Facts = {
  config: AppConfig | null
  localHome: string
  demandPmoTabIds: Readonly<Record<string, string>>
  demands: Readonly<Record<string, DemandRecord>>
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
  spaceZoneBindings: SpaceZoneBindings
  spatialRequests: Record<string, SpatialRequestBinding>
  scratchTopicSnapshots: Readonly<Record<string, ScratchTopicsSnapshot>>
}

export type SessionProjectFileContext = {
  kind: 'session' | 'goal' | 'unassigned' | 'unconfirmed'
  workspaceRoot: string
  homeDir: string
  goalId?: string
  project?: GoalProjectContext
  placement?: FileOpenPlacement
  issue?: string
}

// This is an index of the immutable mapping, not another mapping owner. Unrelated Session
// output never scans Goals; replacing the mapping naturally releases the old index.
const goalIdsByTab = new WeakMap<Facts['demandPmoTabIds'], ReadonlyMap<string, readonly string[]>>()
function mappedGoals(mapping: Facts['demandPmoTabIds'], tabId: string | undefined): readonly string[] {
  if (!tabId) return []
  let index = goalIdsByTab.get(mapping)
  if (!index) {
    const next = new Map<string, string[]>()
    for (const [goalId, tab] of Object.entries(mapping)) {
      const ids = next.get(tab) ?? []
      ids.push(goalId)
      next.set(tab, ids)
    }
    index = next
    goalIdsByTab.set(mapping, index)
  }
  return index.get(tabId) ?? []
}

/** One Pane's current parsing scope. It makes no claim about earlier messages' origins. */
export function createSessionProjectFileContextSelector(sessionId: string, origin: OpenHttpLinkOrigin): (state: Facts) => SessionProjectFileContext {
  let seenGoal = false
  let previous: SessionProjectFileContext | undefined
  let previousKey = ''
  let projectConfig: AppConfig | null | undefined
  let assignedProjectId: string | null | undefined
  let project: GoalProjectContext | null = null
  let metadataInputs: readonly unknown[] | undefined
  let originalSpace: FileOpenPlacement['space'] | undefined
  return (state) => {
    const ids = mappedGoals(state.demandPmoTabIds, origin.tabId)
    seenGoal ||= ids.length > 0
    const goalId = ids.length === 1 ? ids[0] : undefined
    const goal = goalId ? state.demands[goalId] : undefined
    const session = sessionPresentationById(state.sessions).get(sessionId)
    const tab = origin.tabId ? state.tabs[origin.tabId] : undefined
    const region = origin.regionId ? tab?.regions[origin.regionId] : undefined
    const resourceWorkspace = state.config?.workspaces.find(workspace => workspace.id === tab?.workspaceId)
    const layout = state.layouts[origin.workspaceId]
    const group = layout?.groups.find(candidate => candidate.id === origin.tabGroupId)
    const occurrence = Boolean(origin.sessionId === sessionId && group?.tabOrder.includes(origin.tabId ?? '') &&
      layout && groupIds(layout.root).includes(origin.tabGroupId) &&
      tab && origin.regionId && regionIds(tab.layout.root).includes(origin.regionId) &&
      (region?.kind === 'agent' || region?.kind === 'terminal') && region.sessionId === sessionId)
    if (projectConfig !== state.config || assignedProjectId !== goal?.projectId) {
      projectConfig = state.config
      assignedProjectId = goal?.projectId
      project = goalId && goal ? goalProjectContext(state.config, goal.projectId) : null
    }
    let issue: string | undefined
    if (seenGoal) {
      issue = ids.length > 1 ? 'More than one Goal refers to this PMO Tab.'
        : !goal ? 'The Goal association for this PMO Tab is unavailable.'
        : !occurrence || !session ? 'The original PMO Region or display occurrence is unconfirmed.'
        : goal.projectId && !project ? 'The associated Project, Workspace or Host is unconfirmed.' : undefined
    }
    if (!seenGoal) {
      const topics = scratchTopicsForWorkspace(state.scratchTopicSnapshots, resourceWorkspace)
      const inputs = [state.config, state.tabs, state.layouts, state.spaceZoneBindings, topics,
        resourceWorkspace, session?.id, session?.hostId, session?.workspacePath, session?.control.run.runId, occurrence]
      if (!metadataInputs || inputs.some((input, index) => input !== metadataInputs![index])) {
        metadataInputs = inputs
        originalSpace = undefined
        if (occurrence && session && resourceWorkspace?.hostId === session.hostId && tab) {
          const spatialState = { config: state.config, tabs: state.tabs, layouts: state.layouts,
            spaceZoneBindings: state.spaceZoneBindings, spatialRequests: state.spatialRequests, sessions: [...state.sessions] }
          const catalog = spatialCatalog(spatialState, topics ?? [])
          const originalTab = catalog.tabs.find(candidate => candidate.tabId === tab.id)
          const zone = catalog.zones.find(candidate => candidate.zoneId === originalTab?.zoneId)
          const confirmed = zone?.workspaceId === resourceWorkspace.id && zone.hostId === resourceWorkspace.hostId &&
            catalog.locations.some(location => location.zoneId === zone.zoneId && location.workspaceId === resourceWorkspace.id &&
              location.displayWorkspaceId === origin.workspaceId && location.groupId === origin.tabGroupId &&
              location.tabId === tab.id && location.regionId === origin.regionId)
          if (zone && confirmed) {
            try {
              const spaceId = zoneContext(spatialState, topics ?? [], zone)
              if (!tab.space || tab.space.zoneId === zone.zoneId && tab.space.spaceId === spaceId) {
                originalSpace = { zoneId: zone.zoneId, spaceId }
              }
            } catch { /* Keep the original resource and prose visible while its context is unconfirmed. */ }
          }
        }
      }
    }
    const sessionPlacement: FileOpenPlacement | undefined = !seenGoal && occurrence && session &&
      resourceWorkspace?.hostId === session.hostId && originalSpace
      ? { displayWorkspaceId: origin.workspaceId, space: originalSpace,
          resource: { hostId: resourceWorkspace.hostId, path: resourceWorkspace.path } }
      : undefined
    if (!seenGoal && !sessionPlacement) issue = 'The original Session file resource, Space or display occurrence is unconfirmed.'
    const kind = seenGoal ? issue ? 'unconfirmed' : project ? 'goal' : 'unassigned' : issue ? 'unconfirmed' : 'session'
    const root = kind === 'goal' ? project!.path : kind === 'session' && session
      ? workspaceRootForPath(state.config, session) ?? '' : ''
    const hostId = kind === 'goal' ? project!.hostId : session?.hostId
    const hosts = state.config?.hosts.filter(host => host.id === hostId) ?? []
    const homeDir = hosts.length === 1 && hosts[0]?.kind === 'local' ? state.localHome : ''
    const key = JSON.stringify([kind, goalId, goal?.projectId, project, root, homeDir, issue,
      session?.id, session?.hostId, session?.workspacePath, occurrence, sessionPlacement])
    if (previous && key === previousKey) return previous
    previousKey = key
    previous = {
      kind, workspaceRoot: root, homeDir,
      ...(goalId ? { goalId } : {}),
      ...(kind === 'goal' ? { project: project!, placement: {
        displayWorkspaceId: origin.workspaceId,
        space: { spaceId: directoryIdentity(project!.hostId, project!.repoPath),
          zoneId: workspaceZoneId(directoryIdentity(project!.hostId, project!.repoPath), project!.workspaceId) },
        resource: { hostId: project!.hostId, path: project!.path }
      } } : {}),
      ...(kind === 'session' && sessionPlacement ? { placement: sessionPlacement } : {}),
      ...(issue ? { issue } : {})
    }
    return previous
  }
}
