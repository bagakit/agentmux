import { sessionInputOperationResult } from '../shared/session-input-result.js'
import type { IpcMainInvokeEvent } from 'electron'
import { connectAgentMuxRpc, type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'
import { isConnectionMethod, type ConnectionMethod, type ChannelMetadataChange } from '@agentmux/core/connections'
import type { ConnectionSecrets } from '@agentmux/connectors'

export type ConnectorIpcChannel = 'connections:call' | 'connections:storeCredential' | 'connections:inspectCredential'
/** Settings calls the same public service as CLI; only local credential entry stays off public wire. */
export function registerConnectorIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>): void
  assertTrusted(channel: ConnectorIpcChannel, event: IpcMainInvokeEvent): void
  socketPath: string
  secrets: Pick<ConnectionSecrets, 'store' | 'inspect'>
  connect?: typeof connectAgentMuxRpc
  metadata?: {
    publish(change: ChannelMetadataChange): void
    observation(state: 'ready' | 'unavailable'): void
  }
}): () => void {
  const metadataAbort = new AbortController()
  let metadataOpening: Promise<void> | undefined
  const observeMetadata = async () => {
    if (!options.metadata || metadataAbort.signal.aborted) return
    if (!metadataOpening) metadataOpening = (async () => {
      const client = await (options.connect ?? connectAgentMuxRpc)({ endpoint: { transport: 'unix', path: options.socketPath } })
      const closed = () => { metadataAbort.signal.removeEventListener('abort', closed); void client.dispose().catch(() => {}) }
      metadataAbort.signal.addEventListener('abort', closed, { once: true })
      try {
        await client.subscribe('connection.metadata.watch', {}, { signal: metadataAbort.signal,
          onInitial: () => options.metadata!.observation('ready'), onEvent: event => { if (event.type === 'change') options.metadata!.publish(event.data) },
          onEnd: () => { metadataOpening = undefined; if (!metadataAbort.signal.aborted) options.metadata!.observation('unavailable'); closed() } })
      } catch {
        metadataOpening = undefined; closed()
        // Notification failure cannot block an independent saved-profile read or management operation.
        if (!metadataAbort.signal.aborted) options.metadata!.observation('unavailable')
      } finally { if (metadataAbort.signal.aborted) closed() }
    })()
    await metadataOpening
  }
  options.handleWithEvent('connections:call', async (event, method: ConnectionMethod, params: unknown) => {
    options.assertTrusted('connections:call', event)
    if (!isConnectionMethod(method)) throw new Error('Unsupported connection operation.')
    void observeMetadata().catch(() => { metadataOpening = undefined; if (!metadataAbort.signal.aborted) options.metadata?.observation('unavailable') })
    const client = await (options.connect ?? connectAgentMuxRpc)({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await sessionInputOperationResult(async () => await client.call(method, params as AgentMuxRpcParams<ConnectionMethod>) as AgentMuxRpcResult<ConnectionMethod>) }
    finally { await client.dispose() }
  })
  options.handleWithEvent('connections:storeCredential', async (event, input: { operationId: string; secret: string }) => {
    options.assertTrusted('connections:storeCredential', event)
    return await options.secrets.store(input)
  })
  options.handleWithEvent('connections:inspectCredential', async (event, operationId: string) => {
    options.assertTrusted('connections:inspectCredential', event)
    return await options.secrets.inspect(operationId)
  })
  return () => { metadataAbort.abort() }
}
