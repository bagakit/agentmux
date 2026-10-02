import { AgentMuxHostedTransferReader, encodeHostedValue } from '../../src/hosted-value.js'
import type { AgentMuxHostedStreamEvent, AgentMuxRuntimeOwnerIdentity } from '../../src/hosted-client-contract.js'
import type { AgentMuxClient } from '../../src/client.js'

/** Private transport collaborator; the production transfer codec remains real. */
export function hostedTestOwner(client: Pick<AgentMuxClient, 'runtimeIdentity'>): AgentMuxRuntimeOwnerIdentity {
  return { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', protocolVersion: 1,
    processId: 123, availability: 'connected', ctxmux: client.runtimeIdentity() }
}
export const hostedTestFence = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner' }
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
