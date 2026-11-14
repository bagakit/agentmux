import { AgentMuxError, type AgentMuxSpatialStateStore } from '@agentmux/core'
import type { MoteChatTarget } from '@agentmux/core/mote-chat'

/** A Region in one of the Mote's own bound zones shows this exact Host Session. A missing spatial record is unknown, not absence. */
export function createHostMoteMembership(spatial: AgentMuxSpatialStateStore) {
  return async (target: MoteChatTarget, agent: { hostId: string; agentSessionId: string }): Promise<boolean> => {
    const membership = await spatial.readSpaceAgentMembership({ spaceId: target.spaceId, ...agent })
    if (!membership) throw new AgentMuxError('The original spatial record is unavailable, so this Session’s Mote membership is unconfirmed.', 'MOTE_CHAT_MEMBERSHIP_UNCONFIRMED')
    return membership.spaceKind === 'mote' && membership.member
  }
}
