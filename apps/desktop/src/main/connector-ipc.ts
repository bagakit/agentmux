import { sessionInputOperationResult } from '../shared/session-input-result.js'
import type { IpcMainInvokeEvent } from 'electron'
import { AgentMuxError, connectAgentMuxRpc, type AgentMuxRpcParams, type AgentMuxRpcResult } from '@agentmux/core'
import { isConnectionMethod, type ConnectionMethod, type ChannelMetadataChange } from '@agentmux/core/connections'
import type { ConnectionSecrets } from '@agentmux/connectors'
import type { ConnectionHostingTarget } from '../shared/contracts.js'

export type ConnectorIpcChannel = 'connections:call' | 'connections:storeCredential' | 'connections:inspectCredential'
/** Settings calls the same public service as CLI; only local credential entry stays off public wire. */
export function registerConnectorIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>): void
  assertTrusted(channel: ConnectorIpcChannel, event: IpcMainInvokeEvent): void
  socketPath: string
  secrets: Pick<ConnectionSecrets, 'store' | 'inspect'>
  callHost?<M extends ConnectionMethod>(target: ConnectionHostingTarget, method: M, params: AgentMuxRpcParams<M>): Promise<AgentMuxRpcResult<M>>
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
  const hostTarget = (value: ConnectionHostingTarget): ConnectionHostingTarget => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['hostId', 'runtimeId'].includes(key)) ||
      [value.hostId, value.runtimeId].some(id => typeof id !== 'string' || !id.trim() || /[\0\r\n]/u.test(id))) throw new AgentMuxError('The original connector hosting target is unconfirmed.', 'RUNTIME_OWNER_MISMATCH')
    return { hostId: value.hostId, runtimeId: value.runtimeId }
  }
  const callHost = async <M extends ConnectionMethod>(target: ConnectionHostingTarget, method: M, params: AgentMuxRpcParams<M>) => {
    const original = hostTarget(target)
    if (!options.callHost) throw new AgentMuxError('The selected connector Host transport is unavailable. Original connections and Agents are retained.', 'CONTROL_UNAVAILABLE')
    return await options.callHost(original, method, params)
  }
  options.handleWithEvent('connections:call', async (event, method: ConnectionMethod, params: unknown, target?: ConnectionHostingTarget) => {
    options.assertTrusted('connections:call', event)
    if (!isConnectionMethod(method)) throw new Error('Unsupported connection operation.')
    if (target !== undefined) return await sessionInputOperationResult(() => callHost(target, method, params as AgentMuxRpcParams<ConnectionMethod>))
    void observeMetadata().catch(() => { metadataOpening = undefined; if (!metadataAbort.signal.aborted) options.metadata?.observation('unavailable') })
    const client = await (options.connect ?? connectAgentMuxRpc)({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await sessionInputOperationResult(async () => await client.call(method, params as AgentMuxRpcParams<ConnectionMethod>) as AgentMuxRpcResult<ConnectionMethod>) }
    finally { await client.dispose() }
  })
  options.handleWithEvent('connections:storeCredential', async (event, input: { operationId: string; secret: string }, target?: ConnectionHostingTarget) => {
    options.assertTrusted('connections:storeCredential', event)
    return target === undefined ? await options.secrets.store(input) : await callHost(target, 'connection.credential.store', input)
  })
  options.handleWithEvent('connections:inspectCredential', async (event, operationId: string, target?: ConnectionHostingTarget) => {
    options.assertTrusted('connections:inspectCredential', event)
    return target === undefined ? await options.secrets.inspect(operationId) : (await callHost(target, 'connection.credential.inspect', { operationId })).receipt
  })
  return () => { metadataAbort.abort() }
}
