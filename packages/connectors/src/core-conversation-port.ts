import { AgentMuxError, type AgentMuxClient } from '@agentmux/core'
import type { PublicationConversationPort } from './publication-host.js'

type Reader = Pick<AgentMuxClient, 'readConversationChanges' | 'observeSessionHistory' | 'sessionHistoryResource'>
/** Adapt existing execution owners. Every read resolves its frozen Host, never current UI or a replacement Session. */
export function createPublicationConversationPort(clients: () => readonly { hostId: string; client: Reader }[]): PublicationConversationPort {
  const original = (hostId: string): Reader => {
    const found = clients().filter(entry => entry.hostId === hostId)
    if (found.length !== 1) throw new AgentMuxError('The exact original conversation Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
    return found[0]!.client
  }
  return {
    changes: async (input, signal) => ({ ...await original(input.hostId).readConversationChanges(input.agentSessionId,
      { checkpoint: input.checkpoint, ...(input.limit === undefined ? {} : { limit: input.limit }), signal }), hostId: input.hostId }),
    observe: async (reference, listener, signal) => await original(reference.hostId).observeSessionHistory(reference.agentSessionId, listener, { signal }),
    resource: async (reference, input, signal) => await original(reference.hostId).sessionHistoryResource(reference.agentSessionId, { ...input, signal })
  }
}
