import { AgentMuxError, connectAgentMuxRpc, parseAgentInputContextCaptureRead,
  type AgentInputContextCaptureReader } from '@agentmux/core'

/** Lazy read of the exact local capture owner; neither construction nor recovery recaptures a page. */
export function createDesktopInputContextCaptureReader(options: {
  desktopSocketPath: string; captureHostId: string; executionHostId: string
}): AgentInputContextCaptureReader {
  return { async read(reference, context) {
    if (reference.hostId !== options.captureHostId || options.captureHostId !== 'local' || options.executionHostId !== 'local') {
      throw new AgentMuxError('The original capture Host has no exact local reader route. Retain its reference and message.', 'AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED')
    }
    context?.signal?.throwIfAborted()
    const observation = new AbortController()
    // Match the ordinary short readonly RPC observation budget; never time out an input transaction.
    const deadline = setTimeout(() => observation.abort(new AgentMuxError('The original capture owner did not answer within its read observation budget. Retain the original input reference.', 'AGENT_INPUT_CONTEXT_CAPTURE_UNCONFIRMED')), 2_000)
    const signal = context?.signal ? AbortSignal.any([context.signal, observation.signal]) : observation.signal
    let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
    try {
      rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.desktopSocketPath } })
      const read = parseAgentInputContextCaptureRead(await rpc.call('browser.input.inspect', reference, { signal }), reference)
      if (read.record && read.record.binding.executionHostId !== options.executionHostId) {
        throw new AgentMuxError('The original capture belongs to another execution Host. Retain its reference and message.', 'AGENT_INPUT_CONTEXT_CAPTURE_CONFLICT')
      }
      return read
    } finally { clearTimeout(deadline); try { await rpc?.dispose() } catch { /* Releasing this reader cannot replace the original result. */ } }
  } }
}
