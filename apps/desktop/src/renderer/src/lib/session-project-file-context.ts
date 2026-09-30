import { groupIds, type WorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { directoryIdentity, workspaceZoneId } from '../../../shared/space-addresses'
import type { DemandRecord } from './global-demand-board'
import { goalProjectContext, type GoalProjectContext } from './goal-project-context'
import type { FileOpenPlacement } from './file-workbench-state'
import type { OpenHttpLinkOrigin } from './open-destination'
import { sessionPresentationById } from './session-presentation'
import { workspaceRootForPath, type WorkbenchTab } from './workbench-tabs'

type Facts = {
  config: AppConfig | null
  localHome: string
  demandPmoTabIds: Readonly<Record<string, string>>
  demands: Readonly<Record<string, DemandRecord>>
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
}

export type SessionProjectFileContext = {
  kind: 'session' | 'goal' | 'unconfirmed'
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
  return (state) => {
    const ids = mappedGoals(state.demandPmoTabIds, origin.tabId)
    seenGoal ||= ids.length > 0
    const goalId = ids.length === 1 ? ids[0] : undefined
    const goal = goalId ? state.demands[goalId] : undefined
    const session = sessionPresentationById(state.sessions).get(sessionId)
    const tab = origin.tabId ? state.tabs[origin.tabId] : undefined
    const region = origin.regionId ? tab?.regions[origin.regionId] : undefined
    const layout = state.layouts[origin.workspaceId]
    const group = layout?.groups.find(candidate => candidate.id === origin.tabGroupId)
    const occurrence = Boolean(origin.sessionId === sessionId && group?.tabOrder.includes(origin.tabId ?? '') &&
      layout && groupIds(layout.root).includes(origin.tabGroupId) &&
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
        : !project ? 'The associated Project, Workspace or Host is unconfirmed.' : undefined
    }
    const kind = seenGoal ? issue ? 'unconfirmed' : 'goal' : 'session'
    const root = kind === 'goal' ? project!.path : kind === 'session' && session
      ? workspaceRootForPath(state.config, session) ?? '' : ''
    const hostId = kind === 'goal' ? project!.hostId : session?.hostId
    const hosts = state.config?.hosts.filter(host => host.id === hostId) ?? []
    const homeDir = hosts.length === 1 && hosts[0]?.kind === 'local' ? state.localHome : ''
    const key = JSON.stringify([kind, goalId, goal?.projectId, project, root, homeDir, issue,
      session?.id, session?.hostId, session?.workspacePath, occurrence])
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
      ...(issue ? { issue } : {})
    }
    return previous
  }
}
