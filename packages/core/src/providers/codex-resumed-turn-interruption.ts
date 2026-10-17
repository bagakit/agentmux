import { createHash } from 'node:crypto'
import type { AgentProvider } from '../agent-provider.js'
import { nativeProcessBirth, nativeProcessTcpListeners } from '../agent-native-process.js'
import { readCodexPromptExecutionEvidence } from './codex-prompt-execution-evidence.js'
import { connectCodexNativeActor } from './codex-native-rpc.js'
import { codexFailure } from './codex-errors.js'

/** The resumed actor can close a saved in-progress turn without appending turn_aborted.
 * A separate history helper cannot establish whether this actor is still active.
 */
export const readCodexResumedTurnInterruption: NonNullable<AgentProvider['readResumedTurnInterruption']> = async context => {
  const { processId, nativeActor, nativeHandle, previousTurn, signal } = context
  if (nativeActor.protocolId !== 'codex-app-server-v2-0.163' || nativeHandle.kind !== 'provider' ||
    nativeHandle.providerId !== 'codex' || !previousTurn.nativeTurnId || !previousTurn.sourceId || !previousTurn.id) return null
  const readOriginalSource = () => readCodexPromptExecutionEvidence({ args: [], workspacePath: context.workspacePath, nativeHandle, signal })
  const matchesOriginalSource = (evidence: Awaited<ReturnType<typeof readOriginalSource>>) =>
    evidence?.sourceId === previousTurn.sourceId && evidence.nativeTurnId === previousTurn.nativeTurnId
  let connection: Awaited<ReturnType<typeof connectCodexNativeActor>> | undefined
  try {
    signal.throwIfAborted()
    const birth = await nativeProcessBirth(processId, signal)
    if (!matchesOriginalSource(await readOriginalSource())) return null
    const listeners = await nativeProcessTcpListeners(processId, signal)
    if (listeners.length !== 1) return null
    const listener = listeners[0]!, listenerBirth = await nativeProcessBirth(listener.processId, signal)
    connection = await connectCodexNativeActor(listener.endpoint, nativeActor.token, signal, 'agentmux_resumed_turn_read')
    const value = await connection.request('thread/read', { threadId: nativeHandle.sessionId, includeTurns: false })
    const thread = value?.thread
    if (thread?.id !== nativeHandle.sessionId || typeof thread.sessionId !== 'string' || !thread.sessionId ||
      thread.canAcceptDirectInput !== true || thread.status?.type !== 'idle') return null
    // Read only the latest turn's outcome, independent of retained message/tool volume.
    const page = await connection.request('thread/turns/list', { threadId: nativeHandle.sessionId,
      limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })
    if (!Array.isArray(page?.data) || page.data.length !== 1) return null
    const turn = page.data[0]
    if (turn?.id !== previousTurn.nativeTurnId) return null
    const endReason = turn.status === 'interrupted' ? 'interrupted' : turn.status === 'completed' ? 'completed'
      : turn.status === 'failed' ? 'failed' : undefined
    if (!endReason) return null
    const afterListeners = await nativeProcessTcpListeners(processId, signal)
    if (await nativeProcessBirth(processId, signal) !== birth ||
      await nativeProcessBirth(listener.processId, signal) !== listenerBirth ||
      afterListeners.length !== 1 || afterListeners[0]!.processId !== listener.processId || afterListeners[0]!.endpoint !== listener.endpoint ||
      !matchesOriginalSource(await readOriginalSource())) return null
    signal.throwIfAborted()
    return { sourceId: previousTurn.sourceId, nativeTurnId: previousTurn.nativeTurnId,
      id: createHash('sha256').update(JSON.stringify(['resumed-turn', nativeActor.actorId, nativeActor.lifecycleOperationId,
        nativeHandle.sessionId, previousTurn.sourceId, previousTurn.id, previousTurn.nativeTurnId, turn.status])).digest('base64url'),
      state: 'ended', endReason,
      ...(previousTurn.observedAt === undefined ? {} : { observedAt: previousTurn.observedAt }),
      ...(endReason === 'failed' ? { failure: codexFailure(turn.error, previousTurn.nativeTurnId) } : {}) }
  } catch {
    // Read failure removes no existing Agent capability and never authorizes continuation.
    return null
  } finally { connection?.dispose() }
}
