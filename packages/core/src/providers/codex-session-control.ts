import { createHash } from 'node:crypto'
import { CODEX_NATIVE_INPUT_PROTOCOL, isCodexLoadedThread } from '@agentmux/providers/codex/input-protocol'
import { connectCodexNativeActor } from '@agentmux/providers/codex/native-rpc'
import { nativeProcessBirth, nativeProcessTcpListeners } from '../agent-native-process.js'
import type { AgentProviderNativeInputPreparationContext } from '../agent-provider.js'
import { AgentMuxError } from '../errors.js'

const unavailable = () => new AgentMuxError('The original native Session control is unconfirmed. Existing terminal input remains available.', 'AGENT_CONFIGURATION_UNAVAILABLE')
export type CodexControlledThread = { id: string; sessionId: string; model: unknown; modelProvider: unknown }

/** Reuse the original actor. A readable unloaded thread or another helper is never its writer. */
export async function connectCodexSessionControl(context: AgentProviderNativeInputPreparationContext, nativeSessionId: string) {
  const { nativeActor, processId, signal, nativeHandle } = context
  if (!nativeActor || nativeActor.protocolId !== CODEX_NATIVE_INPUT_PROTOCOL || !nativeSessionId ||
      nativeHandle && (nativeHandle.kind !== 'provider' || nativeHandle.providerId !== 'codex' || nativeHandle.sessionId !== nativeSessionId)) throw unavailable()
  signal.throwIfAborted()
  const birth = await nativeProcessBirth(processId, signal), listeners = await nativeProcessTcpListeners(processId, signal)
  if (listeners.length !== 1) throw unavailable()
  const listener = listeners[0]!, actorBirth = await nativeProcessBirth(listener.processId, signal)
  const connection = await connectCodexNativeActor(listener.endpoint, nativeActor.token, signal, 'agentmux_native_input')
  let runtimeSessionId: string | undefined
  const readThread = async (): Promise<CodexControlledThread> => {
    const value = await connection.request('thread/read', { threadId: nativeSessionId, includeTurns: false })
    const thread = value?.thread
    // Direct-input eligibility is a separate native capability. Loaded settings remain readable
    // when a thread cannot accept a turn; notLoaded only carries its last persisted model.
    if (!isCodexLoadedThread(value, nativeSessionId) || typeof thread.sessionId !== 'string' || !thread.sessionId ||
        runtimeSessionId !== undefined && thread.sessionId !== runtimeSessionId) throw unavailable()
    runtimeSessionId ??= thread.sessionId
    return thread
  }
  const assertCurrent = async () => {
    signal.throwIfAborted()
    const current = await nativeProcessTcpListeners(processId, signal)
    if (await nativeProcessBirth(processId, signal) !== birth || await nativeProcessBirth(listener.processId, signal) !== actorBirth ||
        current.length !== 1 || current[0]!.processId !== listener.processId || current[0]!.endpoint !== listener.endpoint) throw unavailable()
    return await readThread()
  }
  try {
    await readThread()
    const sourceId = createHash('sha256').update(JSON.stringify([nativeActor.actorId, nativeActor.lifecycleOperationId,
      nativeSessionId, runtimeSessionId, birth, actorBirth])).digest('base64url')
    return { ...connection, sourceId, readThread, assertCurrent }
  } catch (error) { connection.dispose(); throw error }
}
