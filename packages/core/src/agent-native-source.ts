import { sameNativeHandle, sameRun } from './agent-session-identity.js'
import type { AgentMuxAgentSession, AgentNativeSessionHandle, AgentProviderNativeSessionDiscovery } from './types.js'

type NativeTarget = Pick<AgentMuxAgentSession, 'run' | 'nativeHandle' | 'nativeBinding'>
const NATIVE_STARTED_BINDING_SOURCES: ReadonlySet<NonNullable<AgentMuxAgentSession['nativeBinding']>['source']> = new Set(['native-hook', 'process-witness', 'user-confirmed'])

/** An authenticated Hook that identifies the main native conversation of this Run. */
export function currentNativeMainHook(session: Pick<AgentMuxAgentSession, 'agentSessionId' | 'providerId' | 'run' | 'nativeHandle' | 'hookReceipt'>) {
  const { hookReceipt: receipt, nativeHandle } = session
  if (nativeHandle?.kind === 'provider' && nativeHandle.providerId === session.providerId &&
      receipt?.providerId === session.providerId && receipt.agentSessionId === session.agentSessionId &&
      sameRun(receipt.run, session.run) && receipt.subject?.kind === 'main' &&
      (receipt.subject.basis === 'provider-protocol' || receipt.subject.basis === 'process-native-record') &&
      receipt.subject.nativeSessionId === nativeHandle.sessionId) return receipt
}

/** This Run already confirmed its main native conversation. A later optional
 * history observation cannot turn that positive start fact into initialization. */
export function hasCurrentNativeMainBinding(session: NativeTarget & Pick<AgentMuxAgentSession, 'agentSessionId' | 'providerId' | 'hookReceipt'>): boolean {
  if (session.nativeHandle?.kind !== 'provider' || session.nativeHandle.providerId !== session.providerId || !session.nativeBinding ||
      !sameRun(session.nativeBinding.run, session.run)) return false
  if (NATIVE_STARTED_BINDING_SOURCES.has(session.nativeBinding.source)) return true
  // An earlier Core may have retained the exact main receipt without promoting
  // its semantic target. Consume that original fact, not a Hook name or lifecycle.
  return session.nativeBinding.source === 'semantic-resume-target' && currentNativeMainHook(session) !== undefined
}

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
