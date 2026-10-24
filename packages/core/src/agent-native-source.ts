import { sameNativeHandle, sameRun } from './agent-session-identity.js'
import type { AgentMuxAgentSession, AgentNativeSessionHandle, AgentProviderNativeSessionDiscovery } from './types.js'

type NativeTarget = Pick<AgentMuxAgentSession, 'run' | 'nativeHandle' | 'nativeBinding'>

/** A user's durable semantic target is independent of the terminal's selected conversation. */
export function hasSelectedNativeTarget(session: NativeTarget): boolean {
  return session.nativeHandle?.kind === 'provider' && session.nativeBinding?.source === 'user-selected' &&
    sameRun(session.nativeBinding.run, session.run)
}

/** Scope for attributing observed activity, never an input or permission admission. */
export function nativeTargetSourceUnconfirmed(session: NativeTarget & Pick<AgentMuxAgentSession, 'nativeSourceObservation'>): boolean {
  const observation = session.nativeSourceObservation
  return observation !== undefined && sameRun(observation.run, session.run) &&
    !(hasSelectedNativeTarget(session) && observation.state === 'ambiguous' &&
      observation.candidates?.some(candidate => sameNativeHandle(candidate, session.nativeHandle)))
}

/** Select the proof before checking it; failed uniqueness never downgrades to membership. */
export function resolveNativeSessionWitness(discovery: AgentProviderNativeSessionDiscovery | null | undefined,
  selectedTarget?: AgentNativeSessionHandle) {
  if (!discovery) return undefined
  if (selectedTarget) {
    const member = discovery.candidates?.find(candidate => sameNativeHandle(candidate.handle, selectedTarget)) ??
      (sameNativeHandle(discovery.handle, selectedTarget) ? discovery : undefined)
    return member?.assertPresent ? { handle: member.handle!, childSessionIds: member.childSessionIds,
      assertValid: () => member.assertPresent!() } : undefined
  }
  return discovery.handle ? { handle: discovery.handle, childSessionIds: discovery.childSessionIds,
    assertValid: () => discovery.assertCurrent() } : undefined
}
