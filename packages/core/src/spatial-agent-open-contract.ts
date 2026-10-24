import type { AgentMuxAgentSession } from './types.js'
import type { AgentMuxSpaceAgentFact, AgentMuxSpaceAddress, AgentMuxSpaceControlRequest } from './space-control.js'
import type { AgentMuxSpatialGraph } from './spatial-graph.js'

export const AGENTMUX_SPATIAL_AGENT_OPEN_RESOURCE = 'core:agent-open'
export type AgentMuxSpatialAgentOpenRequest = Extract<AgentMuxSpaceControlRequest, { operation: 'agent.open' }>
/** A background local creation has no native focus, resource creation or cross-Workspace launch effect.
 * Only a confirmed foreign Zone retains its Desktop owner; an observation gap never changes owner. */
export function isBackgroundLocalAgentOpen(request: { operation: string; content?: unknown; destination?: unknown; focus?: unknown }, graph?: Pick<AgentMuxSpatialGraph, 'zones'> | null): request is
  Omit<AgentMuxSpatialAgentOpenRequest, 'content'> & { content: Extract<AgentMuxSpatialAgentOpenRequest['content'], { kind: 'new-agent' }> } {
  if (request.operation !== 'agent.open' || request.focus !== false || !request.content || typeof request.content !== 'object' ||
      !request.destination || typeof request.destination !== 'object') return false
  const content = request.content as Record<string, unknown>, destination = request.destination as Record<string, unknown>
  return !graph?.zones.some(zone => zone.zoneId === destination.zoneId && zone.hostId && zone.hostId !== 'local') &&
    content.kind === 'new-agent' && content.executionWorkspaceId === undefined && content.nativeResumeSource === undefined &&
    typeof destination.spaceId === 'string' && typeof destination.zoneId === 'string' && destination.newZone === undefined && destination.split === undefined &&
    destination.displayWorkspaceId === undefined && destination.groupId === undefined &&
    (destination.newTab === true && destination.tabId === undefined && destination.regionId === undefined ||
      destination.newTab === undefined && typeof destination.tabId === 'string' && typeof destination.regionId === 'string')
}
/** Spatial intent only. Creation, input and Run facts remain with the original Core Session. */
export type AgentMuxSpatialAgentOpenRecord = {
  requestId: string; digest: string; agentSessionId: string; executorId: string; address: AgentMuxSpaceAddress
  execution: { hostId: string; workspacePath: string; workspaceId: string }
}

export function spatialAgentFact(session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'run' | 'providerId' | 'executorId' | 'workspacePath' | 'creation' | 'forkedFrom'>, hostId: string): AgentMuxSpaceAgentFact {
  return { agentSessionId: session.agentSessionId, runId: session.run.runId, providerId: session.providerId,
    executorId: session.executorId, hostId, cwd: session.workspacePath,
    createOperationId: session.creation?.createOperationId ?? null, initialPrompt: session.creation?.initialPrompt ?? 'unknown',
    ...(session.creation?.executorRevision ? { executorRevision: session.creation.executorRevision } : {}),
    ...(session.creation?.initialMessageOrigin ? { initialMessageOrigin: session.creation.initialMessageOrigin } : {}),
    ...(session.creation?.createdBy ? { createdBy: session.creation.createdBy } : {}),
    ...(session.creation?.createdRun ? { createdRun: session.creation.createdRun } : {}),
    ...(session.creation?.initialMessageId ? { initialMessageId: session.creation.initialMessageId } : {}),
    ...(session.creation?.agentMuxContext ? { agentMuxContext: session.creation.agentMuxContext } : {}),
    ...(session.creation?.persistence ? { creationPersistence: session.creation.persistence } : {}),
    ...(session.creation?.failure ? { creationFailure: session.creation.failure } : {}),
    ...(session.forkedFrom ? { forkedFrom: session.forkedFrom } : {}) }
}
