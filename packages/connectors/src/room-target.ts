import type { AgentMuxSpatialState } from '@agentmux/core/spatial-graph'
import type { RoomBindingTarget } from '@agentmux/core/connections'

/** Borrow the original graph for this exact target; no focus, name or Run inference. */
export async function readRoomTarget(spatial: { read(): Promise<AgentMuxSpatialState | null> }, target: RoomBindingTarget): Promise<{ revision: number } | null> {
  const state = await spatial.read(), region = state?.graph.regions.find(region => region.regionId === target.regionAnchor.regionId)
  return state && region?.kind === 'agent' && region.execution?.hostId === target.executionHostId && region.agentSessionId === target.agentSessionId
    ? { revision: state.revision } : null
}
