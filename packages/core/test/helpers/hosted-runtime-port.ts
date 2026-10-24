import { AgentMuxHostedTransferReader, encodeHostedValue } from '../../src/hosted-value.js'
import type { AgentMuxHostedStreamEvent, AgentMuxRuntimeOwnerIdentity } from '../../src/hosted-client-contract.js'
import type { AgentMuxClient } from '../../src/client.js'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { connectHostedAgentMux } from '../../src/hosted-client.js'
import type { AgentMuxHostedRpcPort } from '../../src/hosted-client-contract.js'
import { AgentMuxError } from '../../src/errors.js'

/** Private transport collaborator; the production transfer codec remains real. */
export function hostedTestOwner(client: Pick<AgentMuxClient, 'runtimeIdentity'>): AgentMuxRuntimeOwnerIdentity {
  return { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 2,
    processId: 123, availability: 'connected', ctxmux: client.runtimeIdentity() }
}
export const hostedTestFence = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' }

/** In-memory transport only; SDK, dispatch, owner fences and transfer codec are production code. */
export async function hostedTestClient(client: AgentMuxClient) {
  const owner = (): AgentMuxRuntimeOwnerIdentity => {
    try { return hostedTestOwner(client) }
    catch (error) {
      if (!(error instanceof AgentMuxError) || error.code !== 'CTXMUX_DISCONNECTED') throw error
      return { ...hostedTestFence, protocolVersion: 2, processId: 123, availability: 'connected', ctxmux: null }
    }
  }
  const service = new AgentMuxHostedRuntimeService(client, null, owner)
  let projected!: () => void
  const initialProjection = new Promise<void>(resolve => { projected = resolve })
  const port: AgentMuxHostedRpcPort = {
    call: async (method, params, options) => {
      try { return await service.call(method, structuredClone(params), options) as never }
      finally {
        if (method === 'runtime.invoke' && 'invocation' in params && params.invocation.method === 'runtimeProjection') projected()
      }
    },
    subscribe: async (method: string, params: unknown, handlers: {
      onInitial(value: unknown): void; onEvent(value: unknown): void
    }) => {
      if (method === 'agent.output') throw new AgentMuxError('This fixture exposes Hosted streams only.', 'RPC_METHOD_NOT_FOUND')
      const subscription = await service.subscribe(method, structuredClone(params), event => handlers.onEvent(structuredClone(event)))
      handlers.onInitial(structuredClone(subscription.initial)); await subscription.start?.()
      return { dispose: () => subscription.dispose() }
    }
  }
  const sdk = await connectHostedAgentMux({ rpc: port })
  await initialProjection // Separate the SDK's initial read from the operation being tested.
  return { sdk, service, port, dispose: async () => { await sdk.dispose(); await service.dispose() } }
}
export function logicalHostedEvents(emit: (value: unknown) => void | Promise<void>) {
  const reader = new AgentMuxHostedTransferReader()
  return (event: AgentMuxHostedStreamEvent): void | Promise<void> => {
    if (event.type !== 'snapshot') return emit(event)
    const value = reader.accept(event.data) as { kind: string; event?: unknown; observation?: unknown } | undefined
    if (!value || value.kind === 'initial') return
    if (value.kind === 'event') return emit(encodeHostedValue({ type: 'snapshot', data: { event: value.event } }))
    if (value.kind === 'history') return emit(encodeHostedValue({ type: 'snapshot', data: { observation: value.observation } }))
    throw new Error('Unexpected production Hosted transfer kind')
  }
}
