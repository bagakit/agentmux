import { AgentMuxError } from './errors.js'
import type { AgentMuxSpatialStateStore } from './spatial-state.js'
import type { SpaceMemberTarget } from './space-member.js'
import type { AdoptedHostRoute } from './host-route.js'
export type ResolvedSpaceMember = { hostId: string; runtimeId: string; createOperationId?: string; adoptedRoute?: AdoptedHostRoute }

/** The original file owner supplies only safe routing selectors. This lookup
 * neither creates a Session nor borrows the creator's input authorization. */
export async function resolveSpaceMember(store: AgentMuxSpatialStateStore, target: SpaceMemberTarget): Promise<ResolvedSpaceMember> {
  const source = await store.readSpaceAgentRegion({ spaceId: target.reference.spaceId, regionId: target.regionId })
  if (!source) throw new AgentMuxError('The original Space document is unavailable. Its member and input are retained.', 'SPACE_MEMBER_UNAVAILABLE')
  const member = source.member
  const pin = target.expectedAdmission
  if (pin && (pin.kind === 'association'
    ? member?.region.association?.operationId !== pin.operationId
    : member?.region.creationOperationId !== pin.operationId || member.admission?.requestId !== pin.operationId ||
      member.admission.agentSessionId !== target.agentSessionId || member.admission.address.spaceId !== target.reference.spaceId ||
      member.admission.address.regionId !== target.regionId || member.admission.address.tabId !== member.region.tabId ||
      member.admission.address.zoneId !== member.zone.zoneId)) throw new AgentMuxError(
    'The original member creation or association changed. Keep its original operation and controls; no same-SID target was substituted.', 'SPACE_MEMBER_ADMISSION_UNCONFIRMED')
  if (member?.region.association) {
    const original = member.association
    if (!original || original.requestId !== member.region.association.operationId || original.reference.runtimeId !== target.runtimeId ||
        original.reference.binding.agentSessionId !== target.agentSessionId || original.address.regionId !== target.regionId || original.address.tabId !== member.region.tabId ||
        original.address.spaceId !== target.reference.spaceId || original.address.zoneId !== member.zone.zoneId || original.placement.runtimeId !== target.reference.runtimeId ||
        original.placement.workspaceId !== member.zone.workspaceId || original.placement.hostId !== member.zone.hostId || original.placement.workspacePath !== member.zone.directoryPath) throw new AgentMuxError(
      'The original external association is unconfirmed. Keep its L and original Coordinator; a local same-SID Session was not substituted.', 'SPACE_MEMBER_ADMISSION_UNCONFIRMED')
    throw new AgentMuxError('This member is controlled by its original independent Coordinator. Use that separately authenticated SDK; Source membership grants no reverse transport or input.', 'SPACE_MEMBER_EXTERNAL_COORDINATOR')
  }
  if (!member || member.region.kind !== 'agent' || member.region.agentSessionId !== target.agentSessionId) throw new AgentMuxError(
    'This Region is no longer a member of the selected original Space and Session. No other Session was substituted.', 'SPACE_MEMBER_NOT_FOUND')
  const { region, zone, admission } = member, hostId = region.execution?.hostId
  const runtimeId = region.execution?.runtimeId ?? (hostId === 'local' ? target.reference.runtimeId : undefined)
  if (!hostId || runtimeId !== target.runtimeId) throw new AgentMuxError('The original member execution identity is unconfirmed or changed. Its Session and original controls are retained.', 'SPACE_MEMBER_TARGET_MISMATCH')
  if (hostId === 'local' && runtimeId === target.reference.runtimeId) return { hostId, runtimeId }
  if (!admission || !region.creationOperationId || admission.requestId !== region.creationOperationId || admission.agentSessionId !== target.agentSessionId ||
      admission.address.tabId !== region.tabId || admission.address.regionId !== region.regionId || admission.address.zoneId !== zone.zoneId ||
      admission.execution.hostId !== hostId || admission.execution.runtimeId !== runtimeId || admission.execution.workspacePath !== region.execution?.cwd ||
      admission.placement?.runtimeId !== target.reference.runtimeId || admission.placement.hostId !== zone.hostId ||
      admission.placement.workspaceId !== zone.workspaceId || admission.placement.workspacePath !== zone.directoryPath) throw new AgentMuxError(
    'The original foreign member admission could not be confirmed. Keep its identity and read its original Space; current Host configuration was not substituted.', 'SPACE_MEMBER_ADMISSION_UNCONFIRMED')
  return { hostId, runtimeId, createOperationId: admission.requestId, ...(admission.execution.adoptedRoute ? { adoptedRoute: admission.execution.adoptedRoute } : {}) }
}
