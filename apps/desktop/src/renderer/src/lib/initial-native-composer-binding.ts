import type { AgentPromptInputBinding } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'

/** Only a new composer producer may capture this managed target; frozen sends retain their original carrier. */
export function initialNativeComposerBinding(session: Pick<Extract<SessionSnapshot, { kind: 'agent' }>,
  'control' | 'providerId' | 'nativeHandle' | 'terminalFrontend' | 'capabilities' | 'inputEpoch'>,
  body?: string): Extract<AgentPromptInputBinding, { admissionIntent: unknown }> | undefined {
  const frontend = session.terminalFrontend, native = frontend?.initialization?.native, handle = session.nativeHandle
  const text = body?.trimStart()
  const managed = frontend?.state === 'starting' || frontend?.state === 'attached' && frontend.backendState === 'running' &&
    Boolean(text && !text.startsWith('/') && !text.startsWith('!'))
  if (session.capabilities.nativeConversationInput?.managedRuns !== true || !frontend || !managed ||
      frontend.run.runId !== session.control.run.runId || frontend.initialization?.phase !== 'ready' ||
      native?.state !== 'confirmed' || handle?.kind !== 'provider' || handle.providerId !== session.providerId ||
      handle.sessionId !== native.sessionId) return
  return { expectedRun: { ...session.control.run }, ...(session.inputEpoch === undefined ? {} : { inputEpoch: session.inputEpoch }),
    admissionIntent: { kind: 'native-conversation', source: { providerId: handle.providerId, nativeSessionId: handle.sessionId } } }
}
