import type { AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import type { RoomBindingTarget } from '@agentmux/core/connections'

export type RoomTargetOwner = {
  spatial: { read(): Promise<AgentMuxSpatialState | null> }
  /** Read the original execution endpoint, retaining its exact Host route. */
  session?(reference: { hostId: string; agentSessionId: string }): Promise<{ hostId: string; agentSessionId: string } | null>
}
/** Region is an optional exact presentation check, never a substitute execution identity. */
export async function readRoomTarget(owner: RoomTargetOwner, target: RoomBindingTarget): Promise<boolean> {
  if (!target.regionAnchor) {
    const session = await owner.session?.({ hostId: target.executionHostId, agentSessionId: target.agentSessionId })
    return session?.hostId === target.executionHostId && session.agentSessionId === target.agentSessionId
  }
  const state = await owner.spatial.read(), region = state?.graph.regions.find(region => region.regionId === target.regionAnchor!.regionId)
  return !!state && region?.kind === 'agent' && region.execution?.hostId === target.executionHostId && region.agentSessionId === target.agentSessionId
}
