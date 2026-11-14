import type { SpaceSnapshot } from '@agentmux/core'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import type { AppConfig, WorkspaceRecord } from '../../../shared/contracts'
import type { FocusContext } from './focus-context'
import type { FocusContextAccess } from './focus-context-access'
import type { AgentFocusHistoryEntry } from './agent-focus'
import type { MountedSpaceRegion } from './space-mount-view'

/** Stable semantic identity; presentation, Run and access route never mint another task. */
export const focusSourceKey = (runtimeId: string, agentSessionId: string) => JSON.stringify([runtimeId, agentSessionId])
export const focusSourceContextId = (runtimeId: string, agentSessionId: string) => JSON.stringify(['source-agent', runtimeId, agentSessionId])
export const focusSourceHostId = (runtimeId: string) => JSON.stringify(['source-runtime', runtimeId])

/** Existing visit observations supply display names, never current access or Run facts. */
export function focusSourceHistoryNames(history: readonly AgentFocusHistoryEntry[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const { identity } of history) {
    const source = identity?.source
    if (identity?.kind !== 'agent' || !source?.runtimeId || !identity.name.trim()) continue
    const key = focusSourceKey(source.runtimeId, source.agentSessionId)
    if (!names.has(key)) names.set(key, identity.name)
  }
  return names
}
const resourceIndexes = new WeakMap<AppConfig, Map<string, WorkspaceRecord[]>>()

/** These resources are the answering Source's own facts, never a path-name guess. */
export function focusSourceWorkspace(target: SpaceMountRecord, member: MountedSpaceRegion, snapshot: SpaceSnapshot | undefined,
  config: AppConfig | null, runtimeByHost: ReadonlyMap<string, string> = new Map()): WorkspaceRecord | undefined {
  const zone = member.zone, space = snapshot?.scope.space
  if (!zone?.directoryPath || !zone.hostId || !space || space.kind !== 'folder') return
  // A local alias here belongs to the original Source; its confirmed carrier is
  // the observer's route for that same project, not another execution hop.
  const hostId = JSON.stringify(['source-host', target.reference.runtimeId, zone.hostId])
  let index = config && resourceIndexes.get(config)
  if (config && !index) {
    index = new Map()
    for (const workspace of config.workspaces) {
      const key = JSON.stringify([workspace.id, workspace.path]), members = index.get(key) ?? []
      members.push(workspace); index.set(key, members)
    }
    resourceIndexes.set(config, index)
  }
  const matches = index?.get(JSON.stringify([zone.workspaceId, zone.directoryPath]))?.filter(workspace =>
    zone.hostId === 'local' && runtimeByHost.get(workspace.hostId) === target.reference.runtimeId) ?? []
  const configured = matches.length === 1 ? matches[0] : undefined
  if (configured) return configured
  return { id: JSON.stringify(['source-workspace', target.reference.runtimeId, zone.workspaceId]), name: space.name, hostId, path: zone.directoryPath, kind: 'folder',
    ...(space.directoryPath && space.directoryPath !== zone.directoryPath ? { repoPath: space.directoryPath } : {}),
    ...(zone.branch ? { branch: zone.branch } : {}) }
}

/** Existing Contexts can be reused only through the original Runtime witness. */
export function matchingFocusContext(contexts: readonly FocusContext[], runtimeByHost: ReadonlyMap<string, string>, runtimeId: string, sid: string): FocusContext | undefined {
  const matches = contexts.filter(context => context.kind === 'agent' && !context.access &&
    (context.control?.agentSessionId ?? context.id) === sid && runtimeByHost.get(context.control?.hostId ?? context.hostId) === runtimeId)
  return matches.length === 1 ? matches[0] : undefined
}

/** An unobserved task is still a Context, never a fabricated Session or recovery decision. */
export function unobservedFocusContext(runtimeId: string, sid: string, workspace: WorkspaceRecord | undefined, name: string | undefined,
  issue: string | undefined, access: FocusContextAccess): FocusContext {
  const observation = issue ?? 'The original Agent observation has not arrived.'
  const detail = !runtimeId && access.locations.length === 1 ? `Position ${access.locations[0]!.regionId} · ${observation}` : observation
  return { id: focusSourceContextId(runtimeId, sid), hostId: focusSourceHostId(runtimeId), name: name ?? `Agent · ${sid}`,
    kind: 'agent', providerId: null, workspace, workspaceId: workspace?.id ?? '', workspaceName: workspace?.name ?? 'Project unconfirmed',
    workspacePath: workspace?.path ?? '', topicId: null, runId: '', runUnobserved: true, processState: 'interrupted',
    state: 'running', stateLabel: 'Activity unknown', activitySemantic: 'unknown', bucket: 'idle', liveAgent: false,
    actionable: false, lastActivityAt: null, workingEnteredAt: null, detail,
    detailIsRecap: false, detailKind: 'observation', recap: null, access }
}
