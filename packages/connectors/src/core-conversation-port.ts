import { AgentMuxError, parseAgentInputJournalCut, forwardConversationInput, readRoutedConversation, type AgentMuxClient } from '@agentmux/core'
import { parseConversationChangesPageForWindow, parseConversationCheckpointPage, parseConversationReadPage } from '@agentmux/core/conversation'
import type { PublicationConversationPort } from './publication-host.js'

type Reader = Pick<AgentMuxClient, 'readAgentConversation' | 'conversationCheckpoint' | 'readConversationChanges' | 'observeConversation' | 'sessionHistoryResource' | 'inspectMessageNotification' | 'readMessage' | 'readAgentInputResource'>
/** Adapt existing execution owners. Every read resolves its frozen Host, never current UI or a replacement Session. */
export function createPublicationConversationPort(clients: () => readonly { hostId: string; client: Reader }[]): PublicationConversationPort {
  const original = (hostId: string): Reader => {
    const found = clients().filter(entry => entry.hostId === hostId)
    if (found.length !== 1) throw new AgentMuxError('The exact original conversation Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
    return found[0]!.client
  }
  return {
    // These original journal APIs cannot cancel an in-flight RPC. PublicationHost owns cancellable waiting and discards late results.
    notification: async (reference, notificationId, signal) => {
      signal.throwIfAborted()
      const result = await original(reference.hostId).inspectMessageNotification({ operationId: notificationId })
      signal.throwIfAborted()
      return { notification: result.notification, inputOrigin: result.inputOrigin === null ? null : parseAgentInputJournalCut(result.inputOrigin) }
    },
    message: async (reference, messageId, notificationId, signal) => {
      signal.throwIfAborted()
      const result = await original(reference.hostId).readMessage({ messageId, ...(notificationId ? { notificationId } : {}) })
      signal.throwIfAborted()
      return result
    },
    checkpoint: async (reference, signal) => {
      const page = await original(reference.hostId).conversationCheckpoint({ ...reference, hostId: 'local' }, { signal })
      return parseConversationCheckpointPage({ ...page, hostId: reference.hostId, checkpoint: { ...page.checkpoint, hostId: reference.hostId } }, reference)
    },
    changes: async (input, signal) => {
      const client = original(input.hostId), forwarded = forwardConversationInput(input)
      return parseConversationChangesPageForWindow(await readRoutedConversation(input, (maxBytes, replay) => client.readConversationChanges({ ...forwarded.input, maxBytes, ...(replay ? { cursor: replay } : {}) }, { signal }), forwarded.sourceHostId), input)
    },
    inspect: async (input, signal) => {
      const client = original(input.hostId), forwarded = forwardConversationInput(input)
      return parseConversationReadPage(await readRoutedConversation(input, (maxBytes, replay) => client.readAgentConversation({ ...forwarded.input, maxBytes, ...(replay ? { cursor: replay } : {}) }, { signal }), forwarded.sourceHostId), input)
    },
    observe: async (reference, listener, signal) => {
      const forwarded = forwardConversationInput(reference)
      const handle = await original(reference.hostId).observeConversation(forwarded.input, value => listener({ ...value, hostId: reference.hostId }), { signal })
      if (forwarded.sourceHostId && forwarded.sourceHostId !== handle.sourceHostId) { handle.dispose(); throw new AgentMuxError('The observation returned another original conversation Host.', 'CONTROL_PROTOCOL_ERROR') }
      return { ...handle, hostId: reference.hostId }
    },
    inputResource: async (reference, input, signal) => {
      signal.throwIfAborted()
      const result = await original(reference.hostId).readAgentInputResource(input)
      signal.throwIfAborted(); return result
    },
    resource: async (reference, input, signal) => await original(reference.hostId).sessionHistoryResource(reference.agentSessionId, { ...input, signal })
  }
}
