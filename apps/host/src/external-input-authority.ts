import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, connectAgentMuxRpc, parseAgentExternalMessageAuthor, parseAgentExternalInteractionAuthor, agentInteractionIntentDigest, agentQuestionReplyIntentDigest, type AgentExternalInputAuthorityPort } from '@agentmux/core'

import type { ConnectionIngressReadPort } from '@agentmux/core/connections'

type OriginalIngressAuthority = Pick<ConnectionIngressReadPort, 'authority' | 'recordAuthority'>
/** Verify the original ingress owner directly; no client lifetime or recursive admission RPC. */
export function createConnectionExternalInputAuthority(options: { ingress(): Promise<OriginalIngressAuthority>; executionHostId: string }): AgentExternalInputAuthorityPort {
  return { async resolveConversationMessage(input) {
    const ingress = await options.ingress()
    const result = await ingress.recordAuthority(input)
    if (result.message && (result.message.hostId !== options.executionHostId || result.message.agentSessionId !== input.agentSessionId || result.message.ingressId !== input.ingressId)) throw new AgentMuxError('The original group record belongs to another target.', 'EXTERNAL_RECORD_TARGET_UNCONFIRMED')
    return result
  }, async assertCurrent(author, intent): Promise<void> {
    const unavailable = () => new AgentMuxError('The original external input authority is unconfirmed. Retain the original input and reconnect its authority owner. Ordinary Agent input remains available.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
    try {
      const ingress = await options.ingress()
      const result = await ingress.authority({ operationId: intent.operationId })
      const original = result.ingress, input = original?.input
      if (!original || original.kind === 'action' || !input || !('messageId' in input) || input.hostId !== options.executionHostId || input.agentSessionId !== intent.agentSessionId ||
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
      const ingress = await options.ingress()
      const result = await ingress.authority({ operationId: intent.operationId })
      const original = result.ingress, input = original?.kind === 'action' ? original.input : undefined
      if (!input || input.hostId !== options.executionHostId || input.agentSessionId !== intent.agentSessionId ||
          input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId ||
          input.intentDigest !== agentInteractionIntentDigest(intent) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(input.author)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(intent.externalAction)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) || result.authority !== 'current') throw unavailable()
    } catch { throw unavailable() }
  }, async assertQuestionCurrent(author, intent): Promise<void> {
    const unavailable = () => new AgentMuxError('The original external answer authority is unconfirmed. Inspect its original operation; local answers remain available.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
    try {
      const ingress = await options.ingress()
      const result = await ingress.authority({ operationId: intent.operationId })
      const original = result.ingress, input = original?.kind === 'action' ? original.input : undefined
      if (!input || input.responseKind !== 'question' || input.hostId !== options.executionHostId || input.agentSessionId !== intent.agentSessionId ||
          input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId || input.intentDigest !== agentQuestionReplyIntentDigest(intent) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(input.author)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(intent.externalAction)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) || result.authority !== 'current') throw unavailable()
    } catch { throw unavailable() }
  } }
}

/** Client-side owner bridge used until Desktop relinquishes its existing connection owner. */
export function createDesktopExternalInputAuthority(options: { desktopSocketPath: string; executionHostId: string }): AgentExternalInputAuthorityPort {
  const read = async <T>(call: (rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>) => Promise<T>): Promise<T> => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.desktopSocketPath } })
    try { return await call(rpc) } finally { await rpc.dispose() }
  }
  return createConnectionExternalInputAuthority({ executionHostId: options.executionHostId, ingress: async () => ({
    authority: input => read(rpc => rpc.call('connection.ingress.authority', input)),
    recordAuthority: input => read(rpc => rpc.call('connection.ingress.record-authority', input))
  }) })
}
