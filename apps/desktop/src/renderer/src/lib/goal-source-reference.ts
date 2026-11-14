import type { AgentMuxRpcParams, AgentMuxRpcResult, SpaceSnapshot } from '@agentmux/core'
import type { DemandSpaceMemberReference } from '@agentmux/demand/relations'
import { parseGoalAgentReference } from '@agentmux/core/goal-agent-reference'
import type { SpaceMountRecord } from '../../../shared/space-mount'
import { acceptsMountedSnapshot } from './space-mount-view'

/** A Source admission is a relationship locator, never a Native or input receipt.
 * No chosen Agent target or observer-local namesake contributes identity here. */
export function goalSourceReference(target: SpaceMountRecord, operationId: string,
  report: AgentMuxRpcResult<'agent.open'>, snapshot: SpaceSnapshot, originalRequest?: AgentMuxRpcParams<'agent.open'>): DemandSpaceMemberReference {
  const unavailable = (): never => { throw Error('The original project occurrence is not confirmed. Its Agent, request and relationship draft are retained.') }
  const address = report.to
  if (report.operationId !== operationId || !address || address.spaceId !== target.reference.spaceId || address.zoneId !== target.zoneId ||
      !acceptsMountedSnapshot(target, snapshot)) return unavailable()
  const region = snapshot.scope.regions.find(value => value.regionId === address.regionId && value.tabId === address.tabId)
  const tab = snapshot.scope.tabs.find(value => value.tabId === address.tabId && value.regionIds.includes(address.regionId))
  const zone = snapshot.scope.zones.find(value => value.zoneId === address.zoneId)
  if (!region || tab?.zoneId !== target.zoneId || zone?.workspaceId !== target.workspaceId ||
      !snapshot.scope.bindings.some(value => value.zoneId === target.zoneId && value.spaceId === target.reference.spaceId)) return unavailable()
  let reference: DemandSpaceMemberReference
  if (report.association) {
    const association = report.association
    const content = originalRequest?.content
    if (originalRequest?.operationId !== operationId || content?.kind !== 'agent-session' || !content.expectedResource ||
        association.reference.runtimeId !== content.reference.runtimeId || association.reference.binding.bindingId !== content.reference.binding.bindingId ||
        association.reference.binding.agentSessionId !== content.reference.binding.agentSessionId || association.reference.binding.createOperationId !== content.reference.binding.createOperationId ||
        association.resource.runtimeId !== content.expectedResource.runtimeId || association.resource.workspaceId !== content.expectedResource.workspaceId ||
        association.resource.workspacePath !== content.expectedResource.workspacePath) return unavailable()
    if (association.operationId !== operationId || region.association?.operationId !== operationId || region.agentSessionId !== null || region.execution !== null ||
        association.resource.runtimeId !== target.reference.runtimeId || association.resource.workspaceId !== target.workspaceId ||
        association.resource.workspacePath !== zone.directoryPath) return unavailable()
    reference = { kind: 'space-member', source: { ...target.reference, regionId: region.regionId, admission: { kind: 'association', operationId } },
      execution: { runtimeId: association.reference.runtimeId, agentSessionId: association.reference.binding.agentSessionId } }
  } else {
    if (region.creationOperationId !== operationId || !region.agentSessionId || !region.execution?.runtimeId ||
        report.agent && (report.agent.createOperationId !== operationId || report.agent.agentSessionId !== region.agentSessionId)) return unavailable()
    reference = { kind: 'space-member', source: { ...target.reference, regionId: region.regionId, admission: { kind: 'creation', operationId } },
      execution: { runtimeId: region.execution.runtimeId, agentSessionId: region.agentSessionId } }
  }
  // The public relationship parser owns wire identifiers and the C/L union.
  const parsed = parseGoalAgentReference(reference)
  if (typeof parsed === 'string') return unavailable()
  return parsed
}
