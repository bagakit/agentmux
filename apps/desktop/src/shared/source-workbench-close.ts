import type { SpaceAuthorityRef, SpaceCloseApply, SpaceCloseInspect, SpaceClosePrepare, SpaceCloseReceipt, SpaceCloseTarget, SpaceCloseSurfaceOwner } from '@agentmux/core'

export type SourceWorkbenchCloseMember = { tabId: string; regionId: string; kind: SpaceCloseSurfaceOwner['kind']; agentSessionId: string | null; scope: 'tab' | 'region' }
export type SourceWorkbenchCloseDestination = { hostId: string; reference: SpaceAuthorityRef }
export type SourceWorkbenchCloseLocations = { kind: SpaceCloseTarget['kind']; locations: Array<{ displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }> }
export type SourceWorkbenchCloseCall = SourceWorkbenchCloseDestination & (
  | { method: 'space.close.prepare'; request: SpaceClosePrepare; member: SourceWorkbenchCloseMember }
  | { method: 'space.close.apply'; request: SpaceCloseApply }
  | { method: 'space.close.inspect'; request: SpaceCloseInspect }
)
export type SourceWorkbenchCloseResult = { operation: SpaceCloseReceipt | null }

/** A recovered receipt must still describe the member that opened this review. */
export function sourceWorkbenchCloseMemberMatches(record: SpaceCloseReceipt, member: SourceWorkbenchCloseMember): boolean {
  return record.plan.target.tabId === member.tabId && record.plan.projection.surfaces.some(({ owner, binding }) =>
    owner.regionId === member.regionId && owner.kind === member.kind &&
    (owner.kind !== 'agent' ? member.agentSessionId === null : (binding?.agentSessionId ?? owner.sessionId) === member.agentSessionId))
}
