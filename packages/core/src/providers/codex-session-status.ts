import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { AgentMuxError } from '../errors.js'
import { observeNativeJsonlHistory } from '../native-history-source-observer.js'
import type { AgentProviderSessionStatusContext, AgentProviderSessionStatusObservationContext } from '../agent-provider.js'
import type { AgentPromptExecutionEvidence, AgentProviderSessionStatus } from '../types.js'
import { codexNativeSourceId, codexTurnRecordEvidence, readCodexPromptExecutionEvidence } from './codex-prompt-execution-evidence.js'

const READ_BYTES = 512 * 1024

function status(evidence: AgentPromptExecutionEvidence | null, context: AgentProviderSessionStatusContext): AgentProviderSessionStatus | null {
  if (!evidence?.nativeTurnId || evidence.state === 'idle' || context.nativePromptPredecessor?.evidenceId === evidence.id) return null
  return { recordId: evidence.id, nativeTurnId: evidence.nativeTurnId,
    ...(evidence.nativeOrdinal === undefined ? {} : { sequence: evidence.nativeOrdinal }),
    state: evidence.state === 'working' ? 'working' : evidence.endReason === 'failed' ? 'error' : evidence.endReason === 'completed' ? 'done' : 'unknown',
    ...(evidence.endReason ? { endReason: evidence.endReason } : {}),
    ...(evidence.observedAt === undefined ? {} : { nativeObservedAt: evidence.observedAt }),
    ...(evidence.failure ? { failure: evidence.failure } : {}) }
}

/** One exact source watch and bounded incremental bytes, independent of other Sessions/PTY traffic. */
export async function observeCodexSessionStatus(context: AgentProviderSessionStatusObservationContext): Promise<{ dispose(): void }> {
  const handle = context.nativeHandle
  if (handle?.kind !== 'provider' || handle.providerId !== 'codex' || !handle.transcriptPath || !isAbsolute(handle.transcriptPath)) {
    throw new AgentMuxError('The native status source has not been established.', 'AGENT_NATIVE_STATUS_UNAVAILABLE')
  }
  const file = await open(handle.transcriptPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let observer: { dispose(): void } | undefined
  let disposed = false, reading = false, queued = false, offset = 0, carry = '', latest = '', activeTurn = ''
  let decoder = new TextDecoder('utf8', { fatal: true })
  const dispose = (): void => {
    if (disposed) return
    disposed = true; observer?.dispose(); context.signal.removeEventListener('abort', dispose)
    void file.close()
  }
  const unavailable = (error: unknown): void => {
    if (disposed) return
    context.onUnavailable(error instanceof AgentMuxError ? error.code : 'AGENT_NATIVE_STATUS_UNAVAILABLE',
      error instanceof Error ? error.message : 'Native status observation failed. Inspect the Session to retry.')
    dispose()
  }
  try {
    context.signal.throwIfAborted()
    const stat = await file.stat({ bigint: true })
    const sourceId = codexNativeSourceId(handle.sessionId, stat)
    const header = Buffer.alloc(Math.min(Number(stat.size), READ_BYTES))
    await file.read(header, 0, header.length, 0)
    const end = header.indexOf(10)
    if (!stat.isFile() || end < 0) throw new AgentMuxError('Native status source identity is unknown.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
    const meta = JSON.parse(header.subarray(0, end).toString('utf8')) as { type?: string; payload?: { session_id?: string; id?: string } }
    if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId ||
      (context.nativePromptPredecessor && context.nativePromptPredecessor.sourceId !== sourceId)) {
      throw new AgentMuxError('Native status source does not match the original conversation.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    }
    const emit = (evidence: AgentPromptExecutionEvidence | null, initialSnapshot = false): void => {
      if (disposed || context.signal.aborted) return
      const next = status(evidence, context)
      if (!next || next.recordId === latest) return
      if (activeTurn && next.state !== 'working' && next.nativeTurnId !== activeTurn) return
      activeTurn = next.nativeTurnId; latest = next.recordId; context.onStatus({ ...next, ...(initialSnapshot ? { initialSnapshot: true as const } : {}) })
    }
    const initial = await readCodexPromptExecutionEvidence(context)
    if (!initial) throw new AgentMuxError('The current native turn status is unknown. No completion was inferred.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
    if (initial && initial.sourceId !== sourceId) throw new AgentMuxError('Native status source changed during the read.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    emit(initial, true)
    offset = Number(stat.size)
    // Do not join an incomplete pre-watch suffix to an unrelated subsequent line.
    const lastByte = Buffer.alloc(1)
    if (offset) await file.read(lastByte, 0, 1, offset - 1)
    if (offset && lastByte[0] !== 10) {
      const tail = Buffer.alloc(Math.min(offset, READ_BYTES)); await file.read(tail, 0, tail.length, offset - tail.length)
      const newline = tail.lastIndexOf(10)
      carry = newline >= 0 ? decoder.decode(tail.subarray(newline + 1), { stream: true }) : ''
    }
    const check = (): void => {
      queued = true
      if (reading || disposed) return
      reading = true
      void (async () => {
        try {
          while (queued && !disposed) {
            queued = false
            const current = await file.stat({ bigint: true })
            if (current.size < BigInt(offset)) throw new AgentMuxError('Native status source was truncated.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
            const size = Number(current.size)
            if (size === offset) continue
            const start = Math.max(offset, size - READ_BYTES)
            const gap = start > offset
            const bytes = Buffer.alloc(size - start); await file.read(bytes, 0, bytes.length, start)
            if (gap) {
              carry = ''; decoder = new TextDecoder('utf8', { fatal: true })
              context.onUnavailable('AGENT_NATIVE_STATUS_GAP', 'Native status exceeded the observation window. The retained state and input remain available; inspect the current Session.')
            }
            const data = gap ? bytes.subarray(bytes.indexOf(10) + 1) : bytes
            const text = carry + decoder.decode(data, { stream: true }), lines = text.split('\n')
            carry = lines.pop()!; offset = size
            if (carry.length > READ_BYTES) {
              carry = ''
              context.onUnavailable('AGENT_NATIVE_STATUS_GAP', 'A native status record exceeded the observation window. The retained state and input remain available.')
            }
            for (const line of lines) {
              if (!line) continue
              const record = JSON.parse(line) as { type?: string; payload?: { type?: string; thread_id?: string } }
              // Ordinary tool records are not semantic transitions; Hook activity keeps its owner.
              if (record.type === 'turn_context' || (record.type === 'event_msg' &&
                ['task_started', 'task_complete', 'turn_aborted'].includes(record.payload?.type ?? ''))) {
                if (record.payload?.thread_id !== undefined && record.payload.thread_id !== handle.sessionId) continue
                const evidence = codexTurnRecordEvidence(record, sourceId, handle.sessionId)
                if (!evidence) throw new AgentMuxError('The appended native turn status is unknown. No completion was inferred.', 'AGENT_NATIVE_STATUS_UNCONFIRMED')
                emit(evidence)
              }
            }
          }
        } catch (error) { unavailable(error) }
        finally { reading = false }
      })()
    }
    observer = await observeNativeJsonlHistory({ source: { providerId: 'codex', nativeSessionId: handle.sessionId },
      transcriptPath: handle.transcriptPath, workspacePath: context.workspacePath, command: '', args: context.args, env: {}, signal: context.signal,
      onChange: observation => observation.kind === 'invalidated' ? check() : unavailable(new AgentMuxError(observation.message, observation.code)) })
    const currentPath = await lstat(handle.transcriptPath, { bigint: true })
    if (!currentPath.isFile() || currentPath.dev !== stat.dev || currentPath.ino !== stat.ino) {
      throw new AgentMuxError('Native status source changed during watch setup.', 'AGENT_NATIVE_STATUS_SOURCE_CHANGED')
    }
    context.signal.addEventListener('abort', dispose, { once: true })
    context.signal.throwIfAborted()
    check() // Close the initial read -> watch setup gap.
    return { dispose }
  } catch (error) { dispose(); throw error }
}
