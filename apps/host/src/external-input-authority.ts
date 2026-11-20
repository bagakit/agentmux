import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, parseAgentExternalMessageAuthor, parseAgentExternalInteractionAuthor, agentInteractionIntentDigest, agentQuestionReplyIntentDigest, type AgentExternalInputAuthorityPort } from '@agentmux/core'

import { originalConnectorRuntime, type ConnectionIngressPort } from '@agentmux/core/connections'
import type { AgentExternalAuthoritySource } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'

type OriginalIngressAuthority = Pick<ConnectionIngressPort, 'authority' | 'recordAuthority'>
/** Verify the original ingress owner directly; no client lifetime or recursive admission RPC. */
export function createConnectionExternalInputAuthority(options: { ingress(): Promise<OriginalIngressAuthority>; executionHostId: string;
  runtimeId?(): string | undefined; signal?: AbortSignal;
  clients?(): readonly { hostId: string; client: Pick<AgentMuxHostedClient, 'runtimeOwnerIdentity' | 'forwardRpc'> }[]
}): AgentExternalInputAuthorityPort {
  const sourceIngress = async (source?: AgentExternalAuthoritySource): Promise<OriginalIngressAuthority> => {
    const unavailable = () => new AgentMuxError('The original hosting Runtime authority is unavailable. Retain the original input and its source; local Agent input remains available.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
    const runtimeId = options.runtimeId?.()
    if (source && source.executionRuntimeId !== runtimeId) throw unavailable()
    if (!source || source.hostingRuntimeId === runtimeId) return await options.ingress()
    const route = await originalConnectorRuntime(options.clients ?? (() => []), source.hostingRuntimeId, unavailable, options.signal)
    return {
      authority: async input => { const result = await route.call('connection.ingress.authority', input); await route.assertCurrent(); return result },
      recordAuthority: async input => { const result = await route.call('connection.ingress.record-authority', input); await route.assertCurrent(); return result }
    }
  }
  return { async resolveConversationMessage(input) {
    const ingress = await sourceIngress(input.authoritySource)
    const result = await ingress.recordAuthority(input)
    if (result.message && (result.message.agentSessionId !== input.agentSessionId || result.message.ingressId !== input.ingressId ||
      !isDeepStrictEqual(result.message.authoritySource, input.authoritySource) ||
      (!input.authoritySource && result.message.hostId !== options.executionHostId))) throw new AgentMuxError('The original group record belongs to another target.', 'EXTERNAL_RECORD_TARGET_UNCONFIRMED')
    if (result.message && input.authoritySource) return { ...result, message: { ...result.message, hostId: options.executionHostId } }
    return result
  }, async assertCurrent(author, intent): Promise<void> {
    const unavailable = () => new AgentMuxError('The original external input authority is unconfirmed. Retain the original input and reconnect its authority owner. Ordinary Agent input remains available.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
    try {
      const ingress = await sourceIngress(author.authoritySource)
      const result = await ingress.authority({ operationId: intent.operationId })
      const original = result.ingress, input = original?.input
      if (!original || original.kind === 'action' || !input || !('messageId' in input) || (!author.authoritySource && input.hostId !== options.executionHostId) || input.agentSessionId !== intent.agentSessionId ||
        input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId || input.messageId !== intent.messageId || original.body !== intent.body ||
        !isDeepStrictEqual(input.channelQuote, intent.channelQuote) || !isDeepStrictEqual(input.admissionIntent, intent.admissionIntent) ||
        JSON.stringify(parseAgentExternalMessageAuthor(input.author)) !== JSON.stringify(parseAgentExternalMessageAuthor(author))) throw unavailable()
      if (result.authority !== 'current') {
        if (result.code === 'INGRESS_SERVICE_DISABLED' || result.code === 'INGRESS_SERVICE_UNCONFIRMED') throw new AgentMuxError('The original Connector service cannot authorize this external input. Retain its original waiting reference; restore service policy and explicitly rejoin. Local Agent input remains available.', result.code)
        throw unavailable()
      }
    } catch (error) {
      if (error instanceof AgentMuxError && (error.code === 'INGRESS_SERVICE_DISABLED' || error.code === 'INGRESS_SERVICE_UNCONFIRMED')) throw error
      throw unavailable()
    }
  }, async assertInteractionCurrent(author, intent): Promise<void> {
    const unavailable = () => new AgentMuxError('The original external permission authority is unconfirmed. Inspect its original operation; local responses remain available.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
    try {
      const ingress = await sourceIngress(author.authoritySource)
      const result = await ingress.authority({ operationId: intent.operationId })
      const original = result.ingress, input = original?.kind === 'action' ? original.input : undefined
      if (!input || (!author.authoritySource && input.hostId !== options.executionHostId) || input.agentSessionId !== intent.agentSessionId ||
          input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId ||
          input.intentDigest !== agentInteractionIntentDigest(intent) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(input.author)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(intent.externalAction)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) || result.authority !== 'current') throw unavailable()
    } catch { throw unavailable() }
  }, async assertQuestionCurrent(author, intent): Promise<void> {
    const unavailable = () => new AgentMuxError('The original external answer authority is unconfirmed. Inspect its original operation; local answers remain available.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
    try {
      const ingress = await sourceIngress(author.authoritySource)
      const result = await ingress.authority({ operationId: intent.operationId })
      const original = result.ingress, input = original?.kind === 'action' ? original.input : undefined
      if (!input || input.responseKind !== 'question' || (!author.authoritySource && input.hostId !== options.executionHostId) || input.agentSessionId !== intent.agentSessionId ||
          input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId || input.intentDigest !== agentQuestionReplyIntentDigest(intent) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(input.author)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(intent.externalAction)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) || result.authority !== 'current') throw unavailable()
    } catch { throw unavailable() }
  } }
}
