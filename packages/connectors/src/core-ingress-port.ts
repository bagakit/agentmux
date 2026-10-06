import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { DurableIngressCore } from './durable-ingress.js'

type HostedInput = Pick<AgentMuxHostedClient, 'readAgentSessions' | 'submitAgentMessage' | 'inspectAgentInput' | 'rejoinAgentInputWaiting'>
/** Borrow the exact Host transport. Its semantic service must resolve original external authority in process. */
export function createHostedIngressCorePort(clients: () => readonly { hostId: string; client: HostedInput }[]): (hostId: string) => DurableIngressCore | undefined {
  return hostId => {
    const exact = clients().filter(entry => entry.hostId === hostId)
    if (exact.length !== 1) return undefined
    const client = exact[0]!.client
    // A private callback is not serializable. The original semantic Host restores it from the saved claim;
    // without that registered resolver, Core refuses external admission and the original claim is retained.
    return {
      readAgentSessions: () => client.readAgentSessions(),
      inspectAgentInput: input => client.inspectAgentInput(input),
      submitAgentMessage: input => client.submitAgentMessage(input),
      rejoinAgentInputWaiting: input => client.rejoinAgentInputWaiting(input)
    }
  }
}
