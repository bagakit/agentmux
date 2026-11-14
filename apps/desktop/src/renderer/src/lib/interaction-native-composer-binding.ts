import type { AgentPromptInputBinding } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

/** A fresh explicit Send may select this carrier; existing queue entries keep their own binding. */
export function interactionNativeComposerBinding(session: Pick<Extract<SessionSnapshot, { kind: 'agent' }>,
  'control' | 'providerId' | 'nativeHandle' | 'capabilities' | 'pendingInteraction' | 'processState' | 'inputEpoch'>): Extract<AgentPromptInputBinding, { admissionIntent: unknown }> | undefined {
  const handle = session.nativeHandle
  if (!session.pendingInteraction || session.processState !== 'running' ||
      session.capabilities.nativeConversationInput?.interactionQueue !== true ||
      handle?.kind !== 'provider' || handle.providerId !== session.providerId) return
  return { expectedRun: { ...session.control.run }, ...(session.inputEpoch === undefined ? {} : { inputEpoch: session.inputEpoch }),
    admissionIntent: { kind: 'native-conversation', source: { providerId: handle.providerId, nativeSessionId: handle.sessionId } } }
}
