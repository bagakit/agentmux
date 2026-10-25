import { AgentMuxError, mintObjectId } from '@agentmux/core'
import { encodeHostedValue, decodeHostedValue } from '@agentmux/core/public-rpc-http'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { DurableIngressCore } from './durable-ingress.js'

type HostedInput = Pick<AgentMuxHostedClient, 'recordExternalConversationMessage' | 'readAgentSession' | 'submitAgentMessage' | 'inspectAgentInput' | 'readAgentInputChanges' | 'rejoinAgentInputWaiting' | 'agentSession' | 'onEvent' | 'respondAgentInteraction' | 'inspectAgentInteractionOperation' | 'replySessionQuestion' | 'inspectAgentPromptSubmission' | 'providers'> & Partial<Pick<AgentMuxHostedClient, 'runtimeOwnerIdentity' | 'forwardRpc' | 'runtimeSubject'>>
/** Borrow the exact Host transport. Its semantic service must resolve original external authority in process. */
export function createHostedIngressCorePort(clients: () => readonly { hostId: string; client: HostedInput }[]): (hostId: string, executionRuntimeId?: string) => DurableIngressCore | undefined {
  return (hostId, originalRuntimeId) => {
    const exact = clients().filter(entry => entry.hostId === hostId)
    if (exact.length !== 1) return undefined
    const client = exact[0]!.client, consumerId = mintObjectId()
    const target = async (executionRuntimeId = originalRuntimeId) => {
      if (!executionRuntimeId) return
      if (!client.forwardRpc) throw new AgentMuxError('The original execution Runtime cannot be confirmed. Retain this intake and its source.', 'INGRESS_TARGET_UNCONFIRMED')
      const { owner } = await client.forwardRpc('runtime.owner.identity', { expectedRuntimeId: executionRuntimeId })
      const current = clients().filter(entry => entry.hostId === hostId)
      if (owner.runtimeId !== executionRuntimeId || current.length !== 1 || current[0]!.client !== client) throw new AgentMuxError('The original execution Runtime changed. No conversation or input was rerouted.', 'INGRESS_TARGET_UNCONFIRMED')
      return { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
    }
    const invoke = async <T>(method: 'readAgentSession' | 'recordExternalConversationMessage' | 'submitAgentMessage' | 'inspectAgentInput' | 'readAgentInputChanges' | 'rejoinAgentInputWaiting' | 'runtimeSubject' | 'respondAgentInteraction' | 'inspectAgentInteractionOperation' | 'replySessionQuestion' | 'inspectAgentPromptSubmission', args: unknown[], fence: NonNullable<Awaited<ReturnType<typeof target>>>): Promise<T> => {
      const response = await client.forwardRpc!('runtime.invoke', { consumerId, fence,
        invocation: encodeHostedValue({ method, args }) as import('@agentmux/core/hosted').AgentMuxHostedInvocation }, {}, fence)
      return decodeHostedValue(response.value) as T
    }
    // A private callback is not serializable. The original semantic Host restores it from the saved claim;
    // without that registered resolver, Core refuses external admission and the original claim is retained.
    return {
      recordExternalConversationMessage: async input => {
        const fence = await target(input.authoritySource?.executionRuntimeId)
        return fence ? await invoke('recordExternalConversationMessage', [input], fence) : await client.recordExternalConversationMessage(input)
      },
      agentSession: id => client.agentSession(id),
      onEvent: listener => client.onEvent(listener),
      respondAgentInteraction: async input => {
        const fence = await target(input.externalAction?.authoritySource?.executionRuntimeId)
        return fence ? await invoke('respondAgentInteraction', [input], fence) : await client.respondAgentInteraction(input)
      },
      inspectAgentInteractionOperation: async input => {
        const fence = await target()
        return fence ? await invoke('inspectAgentInteractionOperation', [input], fence) : await client.inspectAgentInteractionOperation(input)
      },
      replySessionQuestion: async input => {
        const fence = await target(input.externalAction?.authoritySource?.executionRuntimeId)
        return fence ? await invoke('replySessionQuestion', [input], fence) : await client.replySessionQuestion(input)
      },
      inspectAgentPromptSubmission: async input => {
        const fence = await target()
        return fence ? await invoke('inspectAgentPromptSubmission', [input], fence) : await client.inspectAgentPromptSubmission(input)
      },
      providers: client.providers,
      runtimeSubject: async input => {
        const fence = await target()
        if (fence) return await invoke('runtimeSubject', [input], fence)
        if (!client.runtimeSubject) throw new AgentMuxError('The original Runtime cannot be observed.', 'INGRESS_TARGET_UNCONFIRMED')
        return await client.runtimeSubject(input)
      },
      readAgentSession: async (id, expectedRuntimeId) => {
        const fence = await target(expectedRuntimeId)
        const session = fence ? await invoke<Awaited<ReturnType<HostedInput['readAgentSession']>>>('readAgentSession', [id], fence) : await client.readAgentSession(id)
        // The selected semantic endpoint owns local metadata; hostId is its configured route alias.
        if (session && session.hostId !== 'local' && session.hostId !== hostId) throw new AgentMuxError(
          'The original Session metadata belongs to another Host. Existing Runs are retained.', 'INGRESS_TARGET_UNCONFIRMED')
        return session ? { ...session, hostId } : null
      },
      readAgentInputChanges: async input => {
        const fence = await target()
        return fence ? await invoke('readAgentInputChanges', [input], fence) : await client.readAgentInputChanges(input)
      },
      inspectAgentInput: async input => {
        const fence = await target()
        return fence ? await invoke('inspectAgentInput', [input], fence) : await client.inspectAgentInput(input)
      },
      submitAgentMessage: async input => {
        const fence = await target(input.envelope.sender.kind === 'external' ? input.envelope.sender.authoritySource?.executionRuntimeId : undefined)
        return fence ? await invoke('submitAgentMessage', [input], fence) : await client.submitAgentMessage(input)
      },
      rejoinAgentInputWaiting: async input => {
        const fence = await target()
        return fence ? await invoke('rejoinAgentInputWaiting', [input], fence) : await client.rejoinAgentInputWaiting(input)
      }
    }
  }
}
