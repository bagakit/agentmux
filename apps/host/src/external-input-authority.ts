import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, connectAgentMuxRpc, parseAgentExternalMessageAuthor, parseAgentExternalInteractionAuthor, agentInteractionIntentDigest, agentQuestionReplyIntentDigest, type AgentExternalInputAuthorityPort } from '@agentmux/core'

/** Original local Desktop business owner, separate from the semantic Host and its input journal. */
export function createDesktopExternalInputAuthority(options: { desktopSocketPath: string; executionHostId: string }): AgentExternalInputAuthorityPort {
  return { async resolveConversationMessage(input) {
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    try {
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.desktopSocketPath } })
      const result = await rpc.call('connection.ingress.record-authority', input)
      if (result.message && (result.message.hostId !== options.executionHostId || result.message.agentSessionId !== input.agentSessionId || result.message.ingressId !== input.ingressId)) throw new AgentMuxError('The original group record belongs to another target.', 'EXTERNAL_RECORD_TARGET_UNCONFIRMED')
      return result
    } finally { try { await rpc?.dispose() } catch { /* Release this read only. */ } }
  }, async assertCurrent(author, intent): Promise<void> {
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    const unavailable = () => new AgentMuxError('The original external input authority is unconfirmed. Retain the original input and reconnect its authority owner. Ordinary Agent input remains available.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
    try {
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.desktopSocketPath } })
      const result = await rpc.call('connection.ingress.authority', { operationId: intent.operationId })
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
    finally { try { await rpc?.dispose() } catch { /* Releasing this read cannot replace its safe authority outcome. */ } }
  }, async assertInteractionCurrent(author, intent): Promise<void> {
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    const unavailable = () => new AgentMuxError('The original external permission authority is unconfirmed. Inspect its original operation; local responses remain available.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
    try {
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.desktopSocketPath } })
      const result = await rpc.call('connection.ingress.authority', { operationId: intent.operationId })
      const original = result.ingress, input = original?.kind === 'action' ? original.input : undefined
      if (!input || input.hostId !== options.executionHostId || input.agentSessionId !== intent.agentSessionId ||
          input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId ||
          input.intentDigest !== agentInteractionIntentDigest(intent) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(input.author)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(intent.externalAction)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) || result.authority !== 'current') throw unavailable()
    } catch { throw unavailable() }
    finally { try { await rpc?.dispose() } catch { /* This read never controls the original permission operation. */ } }
  }, async assertQuestionCurrent(author, intent): Promise<void> {
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    const unavailable = () => new AgentMuxError('The original external answer authority is unconfirmed. Inspect its original operation; local answers remain available.', 'EXTERNAL_INTERACTION_AUTHORITY_UNCONFIRMED')
    try {
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.desktopSocketPath } })
      const result = await rpc.call('connection.ingress.authority', { operationId: intent.operationId })
      const original = result.ingress, input = original?.kind === 'action' ? original.input : undefined
      if (!input || input.responseKind !== 'question' || input.hostId !== options.executionHostId || input.agentSessionId !== intent.agentSessionId ||
          input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId || input.intentDigest !== agentQuestionReplyIntentDigest(intent) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(input.author)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) ||
          JSON.stringify(parseAgentExternalInteractionAuthor(intent.externalAction)) !== JSON.stringify(parseAgentExternalInteractionAuthor(author)) || result.authority !== 'current') throw unavailable()
    } catch { throw unavailable() }
    finally { try { await rpc?.dispose() } catch { /* This read never resubmits the original answer. */ } }
  } }
}
