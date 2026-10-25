import { sessionInputOperationResult } from '../shared/session-input-result.js'
import type { IpcMainInvokeEvent } from 'electron'
import { AgentMuxError, type AgentMuxRpcParams } from '@agentmux/core'
import { isConnectionMethod, type ConnectionMethod, type ChannelMetadataChange } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../shared/contracts.js'
import { connectionHostTarget, type ConnectionHostIpc } from './connection-host-ipc.js'

export type ConnectorIpcChannel = 'connections:call' | 'connections:storeCredential' | 'connections:inspectCredential' |
  'connections:hostingTarget' | 'connections:metadataStart' | 'connections:metadataStop'

/** Trusted presentation borrows the original Host transport; it never owns a connection database. */
export function registerConnectorIpc(options: {
  handleWithEvent(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>): void
  assertTrusted(channel: ConnectorIpcChannel, event: IpcMainInvokeEvent): void
  runtime: ConnectionHostIpc
  metadata: {
    publish(watchId: string, change: ChannelMetadataChange): void
    observation(watchId: string, state: 'ready' | 'unavailable'): void
  }
}): { releaseReaders(): void; dispose(): void } {
  const readers = new Map<string, AbortController>()
  let closed = false
  options.handleWithEvent('connections:hostingTarget', async (event, source?: string | { runtimeId: string }) => {
    options.assertTrusted('connections:hostingTarget', event)
    return await options.runtime.connectionHostingTarget(source)
  })
  options.handleWithEvent('connections:call', async (event, method: ConnectionMethod, params: unknown, target?: ConnectionHostingTarget) => {
    options.assertTrusted('connections:call', event)
    if (!isConnectionMethod(method)) throw new Error('Unsupported connection operation.')
    return await sessionInputOperationResult(async () => options.runtime.callConnectionHost(
      await connectionHostTarget(options.runtime, target), method, params as AgentMuxRpcParams<ConnectionMethod>))
  })
  options.handleWithEvent('connections:storeCredential', async (event, input: { operationId: string; secret: string }, target?: ConnectionHostingTarget) => {
    options.assertTrusted('connections:storeCredential', event)
    return await options.runtime.callConnectionHost(await connectionHostTarget(options.runtime, target), 'connection.credential.store', input)
  })
  options.handleWithEvent('connections:inspectCredential', async (event, operationId: string, target?: ConnectionHostingTarget) => {
    options.assertTrusted('connections:inspectCredential', event)
    return (await options.runtime.callConnectionHost(await connectionHostTarget(options.runtime, target), 'connection.credential.inspect', { operationId })).receipt
  })
  options.handleWithEvent('connections:metadataStart', async (event, watchId: string, target?: ConnectionHostingTarget) => {
    options.assertTrusted('connections:metadataStart', event)
    if (closed || typeof watchId !== 'string' || !watchId || watchId.length > 256 || readers.has(watchId))
      throw new AgentMuxError('This metadata reader is not available. Saved profiles and Agents are retained.', 'CONTROL_UNAVAILABLE')
    const lifetime = new AbortController()
    readers.set(watchId, lifetime)
    const current = () => readers.get(watchId) === lifetime && !lifetime.signal.aborted
    try {
      const original = await connectionHostTarget(options.runtime, target)
      if (!current()) return
      const subscription = await options.runtime.watchConnectionMetadata(original, { signal: lifetime.signal,
        onInitial: () => { if (current()) options.metadata.observation(watchId, 'ready') },
        onEvent: event => { if (current() && event.type === 'change') options.metadata.publish(watchId, event.data) },
        onEnd: () => { if (current()) { options.metadata.observation(watchId, 'unavailable'); readers.delete(watchId); lifetime.abort() } }
      })
      if (!current()) await subscription.dispose()
    } catch (error) {
      if (current()) { options.metadata.observation(watchId, 'unavailable'); readers.delete(watchId); lifetime.abort() }
      throw error
    }
  })
  options.handleWithEvent('connections:metadataStop', async (event, watchId: string) => {
    options.assertTrusted('connections:metadataStop', event)
    const reader = readers.get(watchId)
    readers.delete(watchId)
    reader?.abort()
  })
  const releaseReaders = () => { for (const reader of readers.values()) reader.abort(); readers.clear() }
  return { releaseReaders, dispose: () => { closed = true; releaseReaders() } }
}
