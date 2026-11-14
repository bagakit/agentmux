import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { AgentMuxHostedTransferReader } from './hosted-value.js'
import { parseSpaceSessionsStreamOpening, parseSpaceSessionsObservation, type SpaceSessionsStreamOpening } from './space-session-codec.js'
import type { SpaceAuthorityRef } from './space-authority.js'
import type { SpaceSessionsOpening, SpaceSessionsObservation } from './space-sessions.js'
import type { AgentMuxRpcClient, AgentMuxRpcSubscription } from './public-rpc-client.js'

/** Read only original membership and related metadata. A consumer owns no Run,
 * provider history or persistent Session state by opening this observation. */
export async function observeSpaceSessionStates(rpc: Pick<AgentMuxRpcClient, 'subscribe'>, input: { reference: SpaceAuthorityRef }, options: {
  signal?: AbortSignal
  onObservation(value: SpaceSessionsObservation): void
  onError?(error: Error): void
}) {
  let opening: SpaceSessionsStreamOpening | undefined, initial: SpaceSessionsOpening | undefined, closed = false, subscription: AgentMuxRpcSubscription | undefined
  const transfer = new AgentMuxHostedTransferReader()
  let resolve!: (value: SpaceSessionsOpening) => void, reject!: (error: unknown) => void
  const ready = new Promise<SpaceSessionsOpening>((yes, no) => { resolve = yes; reject = no }); void ready.catch(() => {})
  const failure = (value: unknown) => {
    if (closed) return; closed = true
    const error = value instanceof Error ? value : new Error(String(value))
    void subscription?.dispose().catch(() => {})
    if (initial) options.onError?.(error); else reject(error)
  }
  try {
    subscription = await rpc.subscribe('space.sessions.watch', input, { ...(options.signal ? { signal: options.signal } : {}),
      onInitial: value => { opening = value }, onEnd: error => failure(error ?? new AgentMuxError('The original Space Session reader ended. Membership, Run references and input are retained.', 'SPACE_SESSION_SOURCE_UNAVAILABLE')),
      onEvent: event => {
        if (closed) return
        try {
          if (event.type === 'error') throw new AgentMuxError(event.error.message, event.error.code)
          if (event.type === 'end') { failure(new AgentMuxError('The original Space Session observation ended.', 'SPACE_SESSION_SOURCE_UNAVAILABLE')); return }
          if (!opening || !initial && event.data.transferId !== opening.transferId) throw new AgentMuxError('The Space Session initial transfer belongs to another reader.', 'CONTROL_PROTOCOL_ERROR')
          const decoded = transfer.accept(event.data)
          if (decoded === undefined) return
          const value = rpcRecord(decoded, ['kind', 'value', 'event'], 'CONTROL_PROTOCOL_ERROR')
          if (value.kind === 'initial') {
            if (initial) throw new AgentMuxError('The original Space Session opening was repeated.', 'CONTROL_PROTOCOL_ERROR')
            const observed = parseSpaceSessionsStreamOpening({ ...rpcRecord(value.value), transferId: opening.transferId }, input.reference)
            if (observed.source.ownerInstanceId !== opening.source.ownerInstanceId || observed.revision !== opening.revision) throw new AgentMuxError('The Space Session opening changed its original source cut.', 'CONTROL_PROTOCOL_ERROR')
            initial = { reference: observed.reference, source: observed.source, revision: observed.revision }; resolve(initial)
          } else if (value.kind === 'event' && initial) options.onObservation(parseSpaceSessionsObservation(value.event, initial))
          else throw new AgentMuxError('The original Space Session event preceded its opening.', 'CONTROL_PROTOCOL_ERROR')
        } catch (error) { failure(error) }
      }
    })
    if (closed) await subscription.dispose()
    const observed = await ready
    return { initial: observed, dispose: async () => { if (closed) return; closed = true; await subscription!.dispose() } }
  } catch (error) { failure(error); throw error }
}
