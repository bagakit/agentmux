import type { AgentMuxSpaceAgentTarget } from '@agentmux/core'
import { parseHostRouteAgentTarget } from '@agentmux/core/host-route'
import type { WorkspaceRecord } from '../../../shared/contracts'
import type { SpaceMountRecord } from '../../../shared/space-mount'

/** A private selection, not a Source registration, Session or permission fact. */
export type LauncherSourceExecution = {
  project: { id: string; hostId: string; path: string; repoPath?: string }
  target: SpaceMountRecord
  agentTarget: AgentMuxSpaceAgentTarget
  executorId?: string
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
export function launcherSourceExecution(value: unknown): LauncherSourceExecution | undefined {
  if (value === undefined) return undefined
  if (!object(value) || !object(value.project) || !object(value.target) || !object(value.target.reference) || !object(value.agentTarget) ||
    ![value.project.id, value.project.hostId, value.project.path, value.target.hostId, value.target.zoneId, value.target.workspaceId,
      value.agentTarget.hostId, value.agentTarget.runtimeId, value.target.reference.runtimeId, value.target.reference.spaceId].every(text) || value.project.repoPath !== undefined && typeof value.project.repoPath !== 'string' ||
    value.executorId !== undefined && !text(value.executorId))
    throw Error('The original project and Agent selection is unreadable. Its input is retained; choose its original entry to review it.')
  if (value.agentTarget.adoptedRoute !== undefined) parseHostRouteAgentTarget(value.agentTarget)
  return value as LauncherSourceExecution
}
export function launcherSourceMatches(source: LauncherSourceExecution, project: WorkspaceRecord | undefined) {
  return !!project && source.project.id === project.id && source.project.hostId === project.hostId && source.project.path === project.path &&
    source.project.repoPath === project.repoPath && source.target.hostId === project.hostId
}
