import { AgentMuxError, type AgentMuxSpatialStateStore } from '@agentmux/core'
import type { MoteChatTarget } from '@agentmux/core/mote-chat'

/** A Region in one of the Mote's own bound zones shows this exact Host Session. A missing spatial record is unknown, not absence. */
export function createHostMoteMembership(spatial: AgentMuxSpatialStateStore) {
  return async (target: MoteChatTarget, agent: { hostId: string; agentSessionId: string }): Promise<boolean> => {
    const graph = (await spatial.read())?.graph
    if (!graph) throw new AgentMuxError('The original spatial record is unavailable, so this Session’s Mote membership is unconfirmed.', 'MOTE_CHAT_MEMBERSHIP_UNCONFIRMED')
    if (graph.spaces.find(space => space.spaceId === target.spaceId)?.kind !== 'mote') return false
    const zones = new Set(graph.bindings.filter(binding => binding.spaceId === target.spaceId).map(binding => binding.zoneId))
    const tabs = new Set(graph.tabs.filter(tab => tab.zoneId !== null && zones.has(tab.zoneId)).map(tab => tab.tabId))
    return graph.regions.some(region => region.kind === 'agent' && region.agentSessionId === agent.agentSessionId && region.execution?.hostId === agent.hostId && tabs.has(region.tabId))
  }
}
