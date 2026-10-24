import type { AgentMuxAgentSession } from '@agentmux/core'
import { nativeTargetSourceUnconfirmed } from '@agentmux/core/agent-status'

/** Exact Core facts. Projection never discovers or adopts a native source. */
export type AgentNativeSourceFacts = Pick<AgentMuxAgentSession,
  'nativeHandle' | 'nativeHandlePersistence' | 'nativeBinding' | 'observedNativeHandle' | 'nativeSourceObservation' | 'nativeConfirmation'>

export function projectNativeSourceFacts(source: AgentNativeSourceFacts): AgentNativeSourceFacts {
  return {
    ...(source.nativeHandle ? { nativeHandle: structuredClone(source.nativeHandle) } : {}),
    ...(source.nativeBinding ? { nativeBinding: structuredClone(source.nativeBinding) } : {}),
    ...(source.nativeHandlePersistence ? { nativeHandlePersistence: source.nativeHandlePersistence } : {}),
    ...(source.observedNativeHandle ? { observedNativeHandle: structuredClone(source.observedNativeHandle) } : {}),
    ...(source.nativeSourceObservation ? { nativeSourceObservation: structuredClone(source.nativeSourceObservation) } : {}),
    ...(source.nativeConfirmation ? { nativeConfirmation: structuredClone(source.nativeConfirmation) } : {})
  }
}

/** Identity of readable native content, independent of confirmation operation or basis. */
export function nativeSourceKey(source: AgentNativeSourceFacts): string {
  const handle = source.nativeHandle
  return JSON.stringify([handle?.kind, handle?.kind === 'provider' ? handle.providerId : handle?.adapterId,
    handle?.sessionId, handle?.kind === 'provider' ? handle.transcriptPath : undefined])
}

/** Authority epoch, including A → B → A; a new operation never inherits old authority. */
export function nativeBindingKey(source: AgentNativeSourceFacts): string {
  return JSON.stringify([nativeSourceKey(source), source.nativeConfirmation?.operationId])
}

/** Adapt the Desktop control address to Core's source scope; input admission stays in Core. */
export function nativeSourceUnconfirmed(session: Pick<AgentNativeSourceFacts, 'nativeHandle' | 'nativeBinding' | 'nativeSourceObservation'> &
  { control: { run: AgentMuxAgentSession['run'] } }): boolean {
  return nativeTargetSourceUnconfirmed({ ...session, run: session.control.run })
}
