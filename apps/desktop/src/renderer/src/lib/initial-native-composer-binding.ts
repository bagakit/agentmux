import type { AgentPromptInputBinding } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

/** Only a new composer producer may capture this target; frozen sends retain their original carrier. */
export function initialNativeComposerBinding(session: Pick<Extract<SessionSnapshot, { kind: 'agent' }>,
  'control' | 'providerId' | 'nativeHandle' | 'terminalFrontend' | 'capabilities'>): Extract<AgentPromptInputBinding, { admissionIntent: unknown }> | undefined {
  const frontend = session.terminalFrontend, native = frontend?.initialization?.native, handle = session.nativeHandle
  if (session.capabilities.nativeConversationInput?.managedRuns !== true || frontend?.state !== 'starting' ||
      frontend.run.runId !== session.control.run.runId || frontend.initialization?.phase !== 'ready' ||
      native?.state !== 'confirmed' || handle?.kind !== 'provider' || handle.providerId !== session.providerId ||
      handle.sessionId !== native.sessionId) return
  return { expectedRun: { ...session.control.run },
    admissionIntent: { kind: 'native-conversation', source: { providerId: handle.providerId, nativeSessionId: handle.sessionId } } }
}
