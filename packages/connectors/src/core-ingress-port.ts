import { AgentMuxError } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { DurableIngressCore } from './durable-ingress.js'

type HostedInput = Pick<AgentMuxHostedClient, 'recordExternalConversationMessage' | 'readAgentSession' | 'submitAgentMessage' | 'inspectAgentInput' | 'rejoinAgentInputWaiting' | 'agentSession' | 'onEvent' | 'respondAgentInteraction' | 'inspectAgentInteractionOperation' | 'replySessionQuestion' | 'inspectAgentPromptSubmission' | 'providers'>
/** Borrow the exact Host transport. Its semantic service must resolve original external authority in process. */
export function createHostedIngressCorePort(clients: () => readonly { hostId: string; client: HostedInput }[]): (hostId: string) => DurableIngressCore | undefined {
  return hostId => {
    const exact = clients().filter(entry => entry.hostId === hostId)
    if (exact.length !== 1) return undefined
    const client = exact[0]!.client
    // A private callback is not serializable. The original semantic Host restores it from the saved claim;
    // without that registered resolver, Core refuses external admission and the original claim is retained.
    return {
      recordExternalConversationMessage: input => client.recordExternalConversationMessage(input),
      agentSession: id => client.agentSession(id),
      onEvent: listener => client.onEvent(listener),
      respondAgentInteraction: input => client.respondAgentInteraction(input),
      inspectAgentInteractionOperation: input => client.inspectAgentInteractionOperation(input),
      replySessionQuestion: input => client.replySessionQuestion(input),
      inspectAgentPromptSubmission: input => client.inspectAgentPromptSubmission(input),
      providers: client.providers,
      readAgentSession: async id => {
        const session = await client.readAgentSession(id)
        // The selected semantic endpoint owns local metadata; hostId is its configured route alias.
        if (session && session.hostId !== 'local' && session.hostId !== hostId) throw new AgentMuxError(
          'The original Session metadata belongs to another Host. Existing Runs are retained.', 'INGRESS_TARGET_UNCONFIRMED')
        return session ? { ...session, hostId } : null
      },
      inspectAgentInput: input => client.inspectAgentInput(input),
      submitAgentMessage: input => client.submitAgentMessage(input),
      rejoinAgentInputWaiting: input => client.rejoinAgentInputWaiting(input)
    }
  }
}
