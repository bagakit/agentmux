import { AgentMuxError, connectAgentMuxRpc, parseAgentExternalMessageAuthor, type AgentExternalInputAuthorityPort } from '@agentmux/core'

/** Original local Desktop business owner, separate from the semantic Host and its input journal. */
export function createDesktopExternalInputAuthority(options: { desktopSocketPath: string; executionHostId: string }): AgentExternalInputAuthorityPort {
  return { async assertCurrent(author, intent): Promise<void> {
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    const unavailable = () => new AgentMuxError('The original external input authority is unconfirmed. Retain the original input and reconnect its authority owner. Ordinary Agent input remains available.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
    try {
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.desktopSocketPath } })
      const result = await rpc.call('connection.ingress.authority', { operationId: intent.operationId })
      const original = result.ingress, input = original?.input
      if (result.authority !== 'current' || !original || !input || input.hostId !== options.executionHostId || input.agentSessionId !== intent.agentSessionId ||
        input.expectedRun.runId !== intent.expectedRun.runId || input.operationId !== intent.operationId || input.messageId !== intent.messageId || original.body !== intent.body ||
        JSON.stringify(parseAgentExternalMessageAuthor(input.author)) !== JSON.stringify(parseAgentExternalMessageAuthor(author))) throw unavailable()
    } catch { throw unavailable() }
    finally { try { await rpc?.dispose() } catch { /* Releasing this read cannot replace its safe authority outcome. */ } }
  } }
}
