import type { AgentMuxAgentSession } from '@agentmux/core'

/** Exact Core facts. Projection never discovers or adopts a native source. */
export type AgentNativeSourceFacts = Pick<AgentMuxAgentSession,
  'nativeHandle' | 'observedNativeHandle' | 'nativeSourceObservation' | 'nativeConfirmation'>

export function projectNativeSourceFacts(source: AgentNativeSourceFacts): AgentNativeSourceFacts {
  return {
    ...(source.nativeHandle ? { nativeHandle: structuredClone(source.nativeHandle) } : {}),
    ...(source.observedNativeHandle ? { observedNativeHandle: structuredClone(source.observedNativeHandle) } : {}),
    ...(source.nativeSourceObservation ? { nativeSourceObservation: structuredClone(source.nativeSourceObservation) } : {}),
    ...(source.nativeConfirmation ? { nativeConfirmation: structuredClone(source.nativeConfirmation) } : {})
  }
}

/** A source epoch is independent of the live terminal's Run lifetime, including A → B → A. */
export function nativeBindingKey(source: AgentNativeSourceFacts): string {
  const handle = source.nativeHandle
  return JSON.stringify([handle?.kind, handle?.kind === 'provider' ? handle.providerId : handle?.adapterId,
    handle?.sessionId, source.nativeConfirmation?.operationId])
}
