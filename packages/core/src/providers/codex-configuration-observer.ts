import type { AgentProvider } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'
import { CODEX_NATIVE_INPUT_PROTOCOL } from '@agentmux/providers/codex/input-protocol'
import { observeCodexConfigurationControl } from './codex-managed-frontend.js'
import { codexConfigurationSourceId, codexConfigurationSnapshot, type CodexConfigurationPacket } from './codex-configuration-source.js'

/** The producer already owns the subscription. Observing never resumes, launches or sends input. */
export const observeCodexConfiguration: NonNullable<AgentProvider['observeConfiguration']> = async (context, nativeSessionId) => {
  const { nativeActor, nativeHandle } = context
  if (!nativeActor?.configurationObservation || !nativeActor.frontendControl || nativeActor.protocolId !== CODEX_NATIVE_INPUT_PROTOCOL) throw new AgentMuxError(
    'The original producer does not declare native configuration observation. Existing reads, settings and terminal input remain available.', 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED')
  if (nativeHandle?.kind !== 'provider' || nativeHandle.providerId !== 'codex' || nativeHandle.sessionId !== nativeSessionId) throw new AgentMuxError(
    'The original native configuration observation target is unconfirmed.', 'AGENT_CONFIGURATION_OBSERVATION_UNAVAILABLE')
  let sequence = 0, disposed = false
  const receive = (packet: CodexConfigurationPacket): void => {
    if (disposed || context.signal.aborted || packet.sequence <= sequence) return
    const expected = codexConfigurationSourceId({ actorId: nativeActor.actorId, lifecycleOperationId: nativeActor.lifecycleOperationId,
      nativeSessionId, nativeRuntimeSessionId: packet.nativeRuntimeSessionId, modelProvider: packet.modelProvider })
    if (packet.sourceId !== expected) {
      context.onUnavailable('AGENT_CONFIGURATION_OBSERVATION_UNAVAILABLE', 'The original configuration source identity is unconfirmed. Existing capabilities remain available.')
      return
    }
    sequence = packet.sequence
    if (packet.state === 'unconfirmed') {
      context.onUnavailable(packet.code, packet.message, { sourceId: packet.sourceId, sequence: packet.sequence }); return
    }
    const retained = context.getConfiguration(), observation = retained?.observation
    const model = retained?.options.find(option => option.id === 'model' && option.category === 'model')
    const choices = observation?.nativeSessionId === nativeSessionId && observation.sourceId === packet.sourceId && model?.type === 'select'
      ? model.choices : []
    context.onConfiguration(codexConfigurationSnapshot(packet, packet.model, choices))
  }
  const control = await observeCodexConfigurationControl({ ...context, nativeActor }, nativeSessionId, receive,
    () => context.onUnavailable('AGENT_CONFIGURATION_OBSERVATION_UNAVAILABLE',
      'The original native configuration observer disconnected. Its retained sample keeps its original time; existing input and reads remain available.'))
  return { dispose() { disposed = true; control.dispose() } }
}
