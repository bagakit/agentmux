import { AgentMuxError, forwardConversationInput, readRoutedConversation, type AgentMuxClient } from '@agentmux/core'
import { parseConversationChangesPage, parseConversationCheckpointPage, parseConversationReadPage } from '@agentmux/core/conversation'
import type { PublicationConversationPort } from './publication-host.js'

type Reader = Pick<AgentMuxClient, 'readAgentConversation' | 'conversationCheckpoint' | 'readConversationChanges' | 'observeConversation' | 'sessionHistoryResource'>
/** Adapt existing execution owners. Every read resolves its frozen Host, never current UI or a replacement Session. */
export function createPublicationConversationPort(clients: () => readonly { hostId: string; client: Reader }[]): PublicationConversationPort {
  const original = (hostId: string): Reader => {
    const found = clients().filter(entry => entry.hostId === hostId)
    if (found.length !== 1) throw new AgentMuxError('The exact original conversation Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
    return found[0]!.client
  }
  return {
    checkpoint: async (reference, signal) => {
      const page = await original(reference.hostId).conversationCheckpoint({ ...reference, hostId: 'local' }, { signal })
      return parseConversationCheckpointPage({ ...page, hostId: reference.hostId, checkpoint: { ...page.checkpoint, hostId: reference.hostId } }, reference)
    },
    changes: async (input, signal) => {
      const client = original(input.hostId), forwarded = forwardConversationInput(input)
      return parseConversationChangesPage(await readRoutedConversation(input, sized => client.readConversationChanges({ ...forwarded.input, maxBytes: sized.maxBytes! }, { signal }), forwarded.sourceHostId), input)
    },
    inspect: async (input, signal) => {
      const client = original(input.hostId), forwarded = forwardConversationInput(input)
      return parseConversationReadPage(await readRoutedConversation(input, sized => client.readAgentConversation({ ...forwarded.input, maxBytes: sized.maxBytes! }, { signal }), forwarded.sourceHostId), input)
    },
    observe: async (reference, listener, signal) => {
      const handle = await original(reference.hostId).observeConversation({ ...reference, hostId: 'local' }, value => listener({ ...value, hostId: reference.hostId }), { signal })
      return { ...handle, hostId: reference.hostId }
    },
    resource: async (reference, input, signal) => await original(reference.hostId).sessionHistoryResource(reference.agentSessionId, { ...input, signal })
  }
}
