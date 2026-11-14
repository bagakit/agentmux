import { parseAgentOpenLaunchFields, parseCoordinatorAgentReference } from '@agentmux/core/agent-open-contract'
import { parseHostRouteAgentTarget } from '@agentmux/core/host-route'
import type { AgentMuxRpcParams, AgentMuxRpcResult, AgentMuxRunRef } from '@agentmux/core'
import type { AgentExecutionRecoveryReference, AgentLaunchInput } from '../../../shared/contracts'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import type { LauncherSourceExecution } from './launcher-source'

type GoalCreationScope = {
  goalId: string; role: 'assignees' | 'related'; operationId: string; submitted: boolean
  project: LauncherSourceExecution['project']; target: SpaceMountRecord; issue?: string
}
type OpenRequest = AgentMuxRpcParams<'agent.open'> & { operationId: string }
type OpenReceipt = AgentMuxRpcResult<'agent.open'>
export type GoalSourceCreationDraft = GoalCreationScope & ({
  kind: 'goal-source-create'; request: OpenRequest; receipt?: OpenReceipt
} | {
  kind: 'goal-coordinator-create'
  request: AgentLaunchInput & { agentSessionId: string; createOperationId: string;
    toolWorkspace: NonNullable<AgentLaunchInput['toolWorkspace']>; sourceCoordinator: NonNullable<AgentLaunchInput['sourceCoordinator']> }
  acknowledged?: { target: AgentExecutionRecoveryReference; run: AgentMuxRunRef }
  association: { operationId: string; submitted: boolean; request?: OpenRequest; receipt?: OpenReceipt; issue?: string }
})

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && !!value && !/[\0\r\n]/u.test(value)
const only = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key))
const optionalText = (value: unknown) => value === undefined || typeof value === 'string'
function originalOpen(value: unknown, target: SpaceMountRecord, operationId: string): value is OpenRequest {
  if (!object(value) || !only(value, ['operationId', 'content', 'destination', 'focus']) || value.operationId !== operationId || value.focus !== false ||
      !object(value.content) || !object(value.destination) || !only(value.destination, ['spaceId', 'zoneId', 'newTab']) ||
      value.destination.spaceId !== target.reference.spaceId || value.destination.zoneId !== target.zoneId || value.destination.newTab !== true) return false
  return true
}

/** A private user intention, not a Core admission or permission cache. Unknown
 * shapes stay opaque in the original leaf and are never dispatched by this reader. */
export function readGoalSourceCreationDraft(value: unknown, goalId: string, role: string): GoalSourceCreationDraft | undefined {
  if (!object(value) || !only(value, ['kind', 'goalId', 'role', 'operationId', 'submitted', 'project', 'target', 'issue', 'request', 'receipt', 'acknowledged', 'association']) ||
      value.goalId !== goalId || value.role !== role || !['assignees', 'related'].includes(role) || !text(value.operationId) || typeof value.submitted !== 'boolean' ||
      !optionalText(value.issue) || !object(value.project) || !only(value.project, ['id', 'hostId', 'path', 'repoPath']) ||
      ![value.project.id, value.project.hostId, value.project.path].every(text) || !optionalText(value.project.repoPath) ||
      !object(value.target) || !only(value.target, ['hostId', 'reference', 'zoneId', 'workspaceId']) || !object(value.target.reference) ||
      !only(value.target.reference, ['runtimeId', 'spaceId']) || ![value.target.hostId, value.target.zoneId, value.target.workspaceId,
        value.target.reference.runtimeId, value.target.reference.spaceId].every(text) || value.target.hostId !== value.project.hostId || !object(value.request)) return
  const draft = value as GoalSourceCreationDraft
  try {
    if (draft.kind === 'goal-source-create') {
      if (value.acknowledged !== undefined || value.association !== undefined || !originalOpen(value.request, draft.target, draft.operationId)) return
      const content = value.request.content
      if (content.kind !== 'new-agent' || !only(content, ['kind', 'executorId', 'agentTarget', 'launchOptions', 'agentMuxNote', 'inputEpoch', 'inputRuntimeId', 'cols', 'rows']) ||
          !text(content.executorId) || !object(content.agentTarget) ||
          !only(content.agentTarget, ['hostId', 'runtimeId', 'adoptedRoute']) || !text(content.agentTarget.hostId) || !text(content.agentTarget.runtimeId) ||
          !optionalText(content.agentMuxNote)) return
      if (content.agentTarget.adoptedRoute !== undefined) parseHostRouteAgentTarget(content.agentTarget)
      parseAgentOpenLaunchFields(content)
      if (value.receipt !== undefined && (!object(value.receipt) || value.receipt.operationId !== draft.operationId)) return
    } else if (draft.kind === 'goal-coordinator-create') {
      const request = value.request
      if (value.receipt !== undefined || !only(request, ['executorId', 'executorRevision', 'hostId', 'workspacePath', 'agentSessionId', 'createOperationId', 'toolWorkspace', 'sourceCoordinator', 'launchOptions', 'agentMuxNote', 'inputEpoch', 'inputRuntimeId', 'cols', 'rows']) ||
          ![request.executorId, request.executorRevision, request.agentSessionId, request.workspacePath].every(text) || request.hostId !== 'local' || request.createOperationId !== draft.operationId ||
          !optionalText(request.agentMuxNote) || !optionalText(request.inputEpoch) || !optionalText(request.inputRuntimeId) || !object(request.toolWorkspace) || !only(request.toolWorkspace, ['id', 'hostId', 'path']) ||
          request.toolWorkspace.id !== draft.project.id || request.toolWorkspace.hostId !== draft.project.hostId || request.toolWorkspace.path !== draft.project.path ||
          !object(request.sourceCoordinator) || !only(request.sourceCoordinator, ['hostId', 'runtimeId', 'resourceRuntimeId', 'workingDirectory']) ||
          request.sourceCoordinator.hostId !== request.hostId || !text(request.sourceCoordinator.runtimeId) ||
          request.sourceCoordinator.resourceRuntimeId !== draft.target.reference.runtimeId || request.sourceCoordinator.workingDirectory !== 'device-home' ||
          !object(value.association) || !only(value.association, ['operationId', 'submitted', 'request', 'receipt', 'issue']) || !text(value.association.operationId) ||
          typeof value.association.submitted !== 'boolean' || !optionalText(value.association.issue)) return
      parseAgentOpenLaunchFields(request)
      if (value.acknowledged !== undefined) {
        if (!draft.acknowledged) return
        if (!object(value.acknowledged) || !only(value.acknowledged, ['target', 'run']) || !object(value.acknowledged.run) ||
            !only(value.acknowledged.run, ['runId']) || !text(value.acknowledged.run.runId) || !object(value.acknowledged.target) ||
            !object(value.acknowledged.target.coordinator)) return
        const target = draft.acknowledged.target
        parseCoordinatorAgentReference({ kind: 'coordinator-agent', runtimeId: target.coordinator.runtimeId, binding: target.reference })
        if (target.coordinator.hostId !== request.hostId || target.coordinator.runtimeId !== request.sourceCoordinator.runtimeId ||
            target.reference.agentSessionId !== request.agentSessionId || target.reference.createOperationId !== draft.operationId) return
      }
      if (draft.association.request) {
        const link = draft.association.request
        if (!draft.acknowledged || !originalOpen(link, draft.target, draft.association.operationId) || link.content.kind !== 'agent-session' ||
            !only(link.content, ['kind', 'reference', 'expectedResource']) || !link.content.reference || !link.content.expectedResource) return
        const reference = parseCoordinatorAgentReference(link.content.reference), expected = link.content.expectedResource
        if (reference.runtimeId !== request.sourceCoordinator.runtimeId || reference.binding.bindingId !== draft.acknowledged.target.reference.bindingId ||
            reference.binding.agentSessionId !== request.agentSessionId || reference.binding.createOperationId !== draft.operationId ||
            expected.runtimeId !== draft.target.reference.runtimeId || expected.workspaceId !== draft.target.workspaceId || expected.workspacePath !== draft.project.path) return
      }
      if (draft.association.receipt && draft.association.receipt.operationId !== draft.association.operationId) return
    } else return
    return draft
  } catch { return }
}
