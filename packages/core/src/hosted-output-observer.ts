import { AgentMuxError } from './errors.js'
import { AgentMuxClientEventPublisher } from './client-event-publisher.js'
import { decodeHostedValue } from './hosted-value.js'
import type { AgentMuxClient } from './client.js'
import type { AgentMuxHostedOutputRpcPort, AgentMuxHostedSubscription } from './hosted-client-contract.js'
import type { AgentMuxRpcOutputInitial } from './public-rpc.js'
import type { AgentMuxRunDataEvent, AgentMuxEvidence } from './types.js'

/** One existing public output lease; its callback never joins the SDK's global event publisher. */
export function createHostedOutputObservation(rpc: AgentMuxHostedOutputRpcPort,
  ...[agentSessionId, afterByte, listener]: Parameters<AgentMuxClient['observeAgentOutput']>) {
  const controller = new AbortController(), publisher = new AgentMuxClientEventPublisher()
  publisher.onEvent(listener)
  const replay: AgentMuxRunDataEvent[] = [], decoder = new TextDecoder()
  let initial: AgentMuxRpcOutputInitial | undefined, cursor = afterByte
  let closed = false, semanticEnd = false, replayFinished = false
  let subscription: AgentMuxHostedSubscription | undefined
  let resolveReplay!: () => void, rejectReplay!: (error: unknown) => void
  const replayComplete = new Promise<void>((resolve, reject) => { resolveReplay = resolve; rejectReplay = reject })
  void replayComplete.catch(() => {})
  const close = async () => {
    if (closed) return
    closed = true; controller.abort(); publisher.dispose()
    rejectReplay(new AgentMuxError('This output reader was closed before its replay was confirmed.', 'CONTROL_CANCELLED'))
    await subscription?.dispose()
  }
  const fail = (error: Error, evidence?: AgentMuxEvidence) => {
    if (closed) return
    rejectReplay(error)
    if (initial) publisher.publish({ type: 'agent-error', agentSessionId,
      code: error instanceof AgentMuxError ? error.code : 'CONTROL_UNAVAILABLE', message: error.message,
      evidence: evidence ?? { source: 'terminal-output', observedAt: Date.now(), run: { runId: initial.run.runId } } })
    void close().catch(() => {})
  }
  const complete = () => {
    if (initial && cursor >= initial.run.latestOutputBytes && !replayFinished) {
      replayFinished = true; resolveReplay()
    }
  }
  const ready = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      subscription = await rpc.subscribe('agent.output', { agentSessionId, afterByte, follow: true }, {
        signal: controller.signal,
        onInitial(value) {
          if (closed) return
          if (initial || value.session.agentSessionId !== agentSessionId || value.run.agentSessionId !== agentSessionId
            || value.run.runId !== value.session.run.runId || !Number.isSafeInteger(value.run.latestOutputBytes)
            || value.run.latestOutputBytes < 0) {
            fail(new AgentMuxError('The output observation belongs to another Session or Run.', 'STALE_AGENT_SESSION_BINDING')); return
          }
          initial = structuredClone(value)
          cursor = Math.max(afterByte, value.gap?.firstAvailableByte ?? afterByte)
          complete()
        },
        onEvent(event) {
          if (closed) return
          try {
            if (!initial) throw new AgentMuxError('Output arrived before its original attachment identity.', 'CONTROL_PROTOCOL_ERROR')
            if (event.type === 'error') {
              if (event.error.evidence?.run && event.error.evidence.run.runId !== initial.run.runId) {
                throw new AgentMuxError('Output diagnostic belongs to another Run.', 'CONTROL_PROTOCOL_ERROR')
              }
              fail(new AgentMuxError(event.error.message, event.error.code,
                event.error.detail ?? (typeof event.error.details === 'string' ? event.error.details : undefined), event.error.controlFailure), event.error.evidence); return
            }
            if (event.type === 'output') {
              const output = event.data
              const dataBytes = decodeHostedValue({ $agentmuxValue: 'bytes', data: output.dataBase64 }) as Uint8Array
              if (output.runId !== initial.run.runId || output.startByte !== cursor
                || output.endByte - output.startByte !== dataBytes.byteLength
                || output.replay && (replayFinished || output.endByte > initial.run.latestOutputBytes)
                || !output.replay && !replayFinished) {
                throw new AgentMuxError('The output reader did not receive its original contiguous replay fence.', 'CONTROL_PROTOCOL_ERROR')
              }
              const data: AgentMuxRunDataEvent = { type: 'data', runId: output.runId,
                startByte: output.startByte, endByte: output.endByte, dataBytes,
                data: decoder.decode(dataBytes, { stream: true }) }
              cursor = output.endByte
              if (output.replay) { replay.push(data); complete() }
              else publisher.publishRunEvent(data, initial.session)
              return
            }
            const end = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
            if (end.runId !== initial.run.runId || end.state !== 'exited' && end.state !== 'interrupted') {
              throw new AgentMuxError('This output stream ended without a confirmed process exit. The original Run remains unknown.', 'CONTROL_UNAVAILABLE')
            }
            if (!replayFinished) throw new AgentMuxError('This output stream ended before its original replay fence was received.', 'CONTROL_PROTOCOL_ERROR')
            semanticEnd = true
            publisher.publish({ type: 'process-state', agentSessionId, run: { runId: initial.run.runId },
              state: end.state, pid: initial.run.pid,
              ...(typeof end.exitCode === 'number' ? { exitCode: end.exitCode } : {}),
              ...(typeof end.exitSignal === 'string' ? { exitSignal: end.exitSignal } : {}),
              evidence: { source: 'run-process', observedAt: Date.now(), run: { runId: initial.run.runId } } })
          } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
        },
        onEnd(error) {
          if (!closed && !semanticEnd) fail(error ?? new AgentMuxError(
            'This output reader lost its connection. The original process state is unknown; reconnect from its original byte cursor.', 'CONTROL_UNAVAILABLE'))
        }
      })
      if (closed) {
        await subscription.dispose()
        // Keep the original admission/identity error. A late handle needs cleanup,
        // but cleanup cannot replace that fact with a generic cancellation.
        await replayComplete
        throw new AgentMuxError('The output reader closed while its subscription was being admitted.', 'CONTROL_CANCELLED')
      }
      if (!initial) throw new AgentMuxError('Output subscription has no original attachment identity.', 'CONTROL_PROTOCOL_ERROR')
      timer = setTimeout(() => fail(new AgentMuxError(
        'This output reader has not received the original replay fence. Its observation is closed; the Run and other readers are retained.', 'CONTROL_TIMEOUT')), 30_000)
      await replayComplete
      if (closed) throw new AgentMuxError('The output reader closed before its observation receipt was returned.', 'CONTROL_CANCELLED')
      return { initial, replay, close }
    } catch (error) { await close().catch(() => {}); throw error }
    finally { clearTimeout(timer) }
  })()
  return { ready, close }
}
